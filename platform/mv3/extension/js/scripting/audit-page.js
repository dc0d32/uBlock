/*******************************************************************************

    uBlock Origin Lite - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2025-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

// Annotation (audit) mode — page-global mirror (MAIN world).
//
// Exposes `window.__ubolAudit` so page scripts / an external DOM-walk can read
// what uBOL *would* have filtered:
//   - `.network`  : array of would-be-blocked network records (mirrored from the
//                   background dataset, which survives navigations/redirects).
//   - `.getElements()` : the elements tagged with `data-ubol-*` audit
//                   attributes, including those inside open shadow roots and
//                   same-origin iframes.
//   - `.report(entry)` : used by audit-aware scriptlets to record a network
//                   request they would have suppressed (relayed to background).
//
// Because a page-global is lost on navigation, `.network` is re-hydrated from
// the background (via the isolated `audit-bridge.js`) on every document.

(( ) => {
    if ( window.__ubolAudit !== undefined ) { return; }

    // Canonical set of DOM-annotation "action" attributes uBOL writes in place
    // of hiding/removing/mutating a node. Kept in one place so the element
    // selector, the MutationObserver filter, and the record builder all agree —
    // including the scriptlet-written ones (set-attr / sanitize-href / etc.).
    const ACTION_ATTRS = [
        'data-ubol-hide',
        'data-ubol-remove',
        'data-ubol-remove-attr',
        'data-ubol-remove-class',
        'data-ubol-remove-node-text',
        'data-ubol-set-attr',
        'data-ubol-sanitize-href',
        'data-ubol-derived',
    ];
    const FILTER_ATTR = 'data-ubol-filter';
    const OBSERVED_ATTRS = ACTION_ATTRS.concat(FILTER_ATTR);
    const ELEMENT_SELECTOR = ACTION_ATTRS.map(a => `[${a}]`).join(',');

    // Tagged nodes can live inside open shadow roots (e.g. web-component ad
    // containers) or same-origin iframes. The audit hooks tag those nodes just
    // fine — they operate on Node/Element.prototype — but a plain
    // `document.querySelectorAll` stops at shadow/frame boundaries and would
    // silently miss them. This walker pierces open shadow roots and descends
    // into same-origin iframe documents so the getters see every tagged node.
    // Closed shadow roots and cross-origin iframes remain inaccessible by
    // design (no API exposes them).
    const queryAllDeep = (root, seen) => {
        let els;
        try {
            els = root.querySelectorAll(ELEMENT_SELECTOR);
        } catch {
            els = [];
        }
        for ( const el of els ) {
            seen.add(el);
        }
        let all;
        try {
            all = root.querySelectorAll('*');
        } catch {
            all = [];
        }
        for ( const el of all ) {
            if ( el.shadowRoot ) {
                queryAllDeep(el.shadowRoot, seen);
            }
            if ( el.localName === 'iframe' || el.localName === 'frame' ) {
                let doc = null;
                try {
                    doc = el.contentDocument;
                } catch {
                }
                if ( doc ) {
                    queryAllDeep(doc, seen);
                }
            }
        }
        return seen;
    };

    const collectTagged = ( ) => {
        return Array.from(queryAllDeep(document, new Set()));
    };

    window.__ubolAudit = {
        network: [],
        // Return the raw tagged elements (backward compatible).
        getElements() {
            return collectTagged();
        },
        // Return, for each tagged element, the element plus what would have
        // acted on it: the action(s) (hide/remove/remove-attr/remove-class) and
        // the exact filters that matched, e.g.
        //   { element, actions:{hide:['specific']},
        //     filters:[{source:'specific', filter:'.ad-banner'}] }
        getElementDetails() {
            const out = [];
            for ( const el of collectTagged() ) {
                const actions = {};
                for ( const name of [ 'hide', 'remove', 'remove-attr', 'remove-class' ] ) {
                    const v = el.getAttribute(`data-ubol-${name}`);
                    if ( v !== null ) { actions[name] = v.split(/\s+/); }
                }
                let filters = [];
                try {
                    filters = JSON.parse(el.getAttribute('data-ubol-filter') || '[]');
                } catch {
                }
                const derivedFrom = el.getAttribute('data-ubol-derived');
                const entry = { element: el, actions, filters };
                if ( derivedFrom !== null ) { entry.derivedFrom = derivedFrom; }
                out.push(entry);
            }
            return out;
        },
        // Convenience: the filter attribution for a single element.
        getFilters(el) {
            try {
                return JSON.parse(el.getAttribute('data-ubol-filter') || '[]');
            } catch {
                return [];
            }
        },
        // Elements inserted by a would-be-blocked script (DOM derivation).
        getDerivedElements() {
            return collectTagged()
                .filter(el => el.hasAttribute('data-ubol-derived'))
                .map(el => ({ element: el, derivedFrom: el.getAttribute('data-ubol-derived') }));
        },
        report(entry) {
            try {
                window.postMessage({ __ubolAudit: 'report', entry }, '*');
            } catch {
            }
        },
    };

    // Set of would-be-blocked script URLs, mirrored from the network audit and
    // used to attribute DOM nodes to the script that inserted them. The DOM
    // derivation hooks live in a separate content script (audit-derive.js) that
    // is injected only when the "DOM derivation" setting is on; we publish the
    // set and a list of resolver callbacks for it to use.
    const wouldBlockScripts = new Set();
    self.__ubolAuditShared = { wouldBlockScripts, resolvers: new Set() };
    const refreshWouldBlockScripts = network => {
        for ( const r of network ) {
            if ( r && r.type === 'script' && r.url ) {
                wouldBlockScripts.add(r.url);
            }
        }
        // Runs each network poll (~1s): lets the derivation hooks (if present)
        // attribute nodes inserted before their script was known to be blocked
        // (closes the race) and expire stale buffered entries.
        for ( const resolve of self.__ubolAuditShared.resolvers ) {
            try { resolve(); } catch {}
        }
    };

    window.addEventListener('message', ev => {
        if ( ev.source !== window ) { return; }
        const data = ev.data;
        if ( data instanceof Object === false ) { return; }
        if ( data.__ubolAudit !== 'data' ) { return; }
        window.__ubolAudit.network = Array.isArray(data.network)
            ? data.network
            : [];
        refreshWouldBlockScripts(window.__ubolAudit.network);
    });

    // Element sink (A/B/C/D).
    //
    // Every tagged node is reported AT TAG TIME to two sinks so nothing is lost
    // to a late external DOM walk:
    //   - B: window.__ubolSink(batch), a function a CDP driver injects
    //        (Playwright `expose_binding`); the call is delivered synchronously
    //        to the driver, so even a frame torn down immediately is captured.
    //   - A/C: window.postMessage({__ubolAudit:'elements'}) which the isolated
    //        bridge relays to the background durable per-tab store + WAL.
    // A MutationObserver is the single emit point (covers every current and
    // future tag site uniformly); a periodic deep sweep (pierces open shadow
    // roots + same-origin iframes) is the safety net for tags the observer's
    // own document couldn't see. Removed tagged nodes are serialized before they
    // detach (D).
    (( ) => {
        const frameUid = (( ) => {
            try {
                if ( self.crypto && self.crypto.randomUUID ) {
                    return self.crypto.randomUUID();
                }
            } catch {
            }
            return `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
        })();
        let seqCounter = 0;
        // Per-node signature of the last emitted 'tag' state, so re-observing an
        // unchanged node is a no-op. A WeakMap lets removed nodes be GC'd.
        const emittedSig = new WeakMap();
        const outbox = [];
        let flushTimer;

        const ubolAttrsOf = el => {
            const out = {};
            let names;
            try {
                names = el.getAttributeNames ? el.getAttributeNames() : [];
            } catch {
                names = [];
            }
            for ( const name of names ) {
                if ( name.startsWith('data-ubol-') ) {
                    out[name] = el.getAttribute(name);
                }
            }
            return out;
        };

        const hasActionAttr = ubol => {
            for ( const a of ACTION_ATTRS ) {
                if ( a in ubol ) { return true; }
            }
            return false;
        };

        const shortSelector = el => {
            const parts = [];
            let node = el;
            while ( node && node.nodeType === 1 && parts.length < 8 ) {
                let seg = node.localName;
                if ( node.id ) { parts.unshift(`${seg}#${node.id}`); break; }
                const p = node.parentNode;
                if ( p && p.children ) {
                    const sibs = Array.from(p.children)
                        .filter(c => c.localName === node.localName);
                    if ( sibs.length > 1 ) {
                        seg += `:nth-of-type(${sibs.indexOf(node) + 1})`;
                    }
                }
                parts.unshift(seg);
                node = (p && p.host) ? p.host : p;
            }
            return parts.join(' > ');
        };

        const describe = (el, event) => {
            const ubol = ubolAttrsOf(el);
            const actions = {};
            for ( const name of ACTION_ATTRS ) {
                if ( name === 'data-ubol-derived' ) { continue; }
                if ( name in ubol ) { actions[name.slice('data-ubol-'.length)] = ubol[name]; }
            }
            let filters = [];
            try {
                filters = JSON.parse(ubol[FILTER_ATTR] || '[]');
            } catch {
            }
            seqCounter += 1;
            let classes = null;
            try { classes = el.getAttribute('class'); } catch {}
            let outerHTMLHead = '';
            try { outerHTMLHead = (el.outerHTML || '').slice(0, 240); } catch {}
            return {
                uid: `${frameUid}:${seqCounter}`,
                frameUid,
                event,
                ts: Date.now(),
                frameUrl: location.href,
                tag: el.localName || null,
                id: el.id || null,
                classes,
                selector: shortSelector(el),
                ubolAttrs: ubol,
                actions,
                filters,
                derivedFrom: ubol['data-ubol-derived'] !== undefined
                    ? ubol['data-ubol-derived']
                    : null,
                outerHTMLHead,
            };
        };

        const flushNow = ( ) => {
            if ( flushTimer !== undefined ) {
                self.clearTimeout(flushTimer);
                flushTimer = undefined;
            }
            if ( outbox.length === 0 ) { return; }
            const records = outbox.splice(0, outbox.length);
            // B: real-time CDP stream (present only when a driver attached it).
            const sink = window.__ubolSink;
            if ( typeof sink === 'function' ) {
                try { sink({ records }); } catch {}
            }
            // A/C: durable background store + WAL, via the isolated bridge.
            try {
                window.postMessage({ __ubolAudit: 'elements', records }, '*');
            } catch {
            }
        };

        const scheduleFlush = ( ) => {
            if ( outbox.length >= 64 ) { flushNow(); return; }
            if ( flushTimer !== undefined ) { return; }
            flushTimer = self.setTimeout(flushNow, 250);
        };

        const emit = (el, event) => {
            if ( el instanceof Element === false ) { return; }
            const ubol = ubolAttrsOf(el);
            if ( hasActionAttr(ubol) === false ) { return; }
            if ( event !== 'remove' ) {
                const sig = JSON.stringify(ubol);
                if ( emittedSig.get(el) === sig ) { return; }
                emittedSig.set(el, sig);
            }
            outbox.push(describe(el, event));
            scheduleFlush();
        };

        // D: a removed subtree is serialized before it detaches for good.
        const handleRemoved = node => {
            if ( node instanceof Element === false ) { return; }
            emit(node, 'remove');
            let matches;
            try {
                matches = node.querySelectorAll(ELEMENT_SELECTOR);
            } catch {
                matches = [];
            }
            for ( const el of matches ) { emit(el, 'remove'); }
        };

        const observer = new MutationObserver(mutations => {
            for ( const mu of mutations ) {
                if ( mu.type === 'attributes' ) {
                    emit(mu.target, 'tag');
                } else if ( mu.type === 'childList' ) {
                    for ( const node of mu.removedNodes ) {
                        handleRemoved(node);
                    }
                }
            }
        });

        const observeRoot = root => {
            try {
                observer.observe(root, {
                    subtree: true,
                    childList: true,
                    attributes: true,
                    attributeFilter: OBSERVED_ATTRS,
                });
            } catch {
            }
        };
        observeRoot(document);

        // MutationObserver does not cross shadow boundaries. Observe each shadow
        // root as it is created (we get the root even for `mode:'closed'`, since
        // we capture attachShadow's return value), so tags/removals inside web
        // components are streamed too. Open roots are additionally covered by the
        // deep sweep below; closed ones are reachable only through this hook.
        try {
            const origAttachShadow = Element.prototype.attachShadow;
            if ( typeof origAttachShadow === 'function' ) {
                Element.prototype.attachShadow = function(init) {
                    const root = origAttachShadow.call(this, init);
                    observeRoot(root);
                    return root;
                };
            }
        } catch {
        }

        // Safety net: emit any tagged node the observer's own document tree
        // couldn't see (open shadow roots, same-origin iframes). collectTagged
        // pierces those; the WeakMap dedup makes repeated sweeps idempotent.
        const deepSweep = ( ) => {
            for ( const el of collectTagged() ) { emit(el, 'tag'); }
        };
        // Runs on each network poll (~1s) alongside the derivation resolvers.
        self.__ubolAuditShared.resolvers.add(deepSweep);
        // A few early passes to catch tags applied before the first poll.
        deepSweep();
        for ( const t of [ 250, 1000, 2500 ] ) {
            self.setTimeout(deepSweep, t);
        }

        // Expose the raw durable records this frame emitted (mostly for parity /
        // debugging; the authoritative copy is the background store + WAL).
        window.__ubolAudit.getEmittedElementCount = ( ) => seqCounter;
    })();
})();

