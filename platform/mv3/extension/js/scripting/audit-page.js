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
//   - `.getElements()` : the elements tagged with `data-ubol-*` audit attributes.
//   - `.report(entry)` : used by audit-aware scriptlets to record a network
//                   request they would have suppressed (relayed to background).
//
// Because a page-global is lost on navigation, `.network` is re-hydrated from
// the background (via the isolated `audit-bridge.js`) on every document.

(( ) => {
    if ( window.__ubolAudit !== undefined ) { return; }

    const ELEMENT_SELECTOR = [
        '[data-ubol-hide]',
        '[data-ubol-remove]',
        '[data-ubol-remove-attr]',
        '[data-ubol-remove-class]',
        '[data-ubol-derived]',
    ].join(',');

    window.__ubolAudit = {
        network: [],
        // Return the raw tagged elements (backward compatible).
        getElements() {
            return Array.from(document.querySelectorAll(ELEMENT_SELECTOR));
        },
        // Return, for each tagged element, the element plus what would have
        // acted on it: the action(s) (hide/remove/remove-attr/remove-class) and
        // the exact filters that matched, e.g.
        //   { element, actions:{hide:['specific']},
        //     filters:[{source:'specific', filter:'.ad-banner'}] }
        getElementDetails() {
            const out = [];
            for ( const el of document.querySelectorAll(ELEMENT_SELECTOR) ) {
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
            return Array.from(document.querySelectorAll('[data-ubol-derived]'))
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
})();

