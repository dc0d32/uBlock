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

// Annotation (audit) mode - DOM derivation (MAIN world), opt-in.
//
// Injected only when the "DOM derivation" setting is enabled. When a
// would-be-blocked script is allowed to run and inserts DOM nodes, tag those
// nodes `data-ubol-derived="<script-url>"`. There is no browser API that reports
// which script mutated the DOM, so we wrap the common node-insertion methods
// and, at insertion time, walk the current JS call stack (`Error().stack`) for
// script URLs. If any is already known to be would-be-blocked, we tag
// immediately; otherwise the insertion's stack URLs are held in a short-lived
// rolling buffer and re-checked whenever the network audit learns a new
// would-be-blocked script (closes the early-load race). Wrappers always call
// through to the native method and never throw, so page behavior is unchanged.
//
// The shared state (the would-be-blocked script set and the resolver list) is
// published by audit-page.js on `self.__ubolAuditShared`.

function installDomDerivation(wouldBlockScripts, resolvers) {
    const DERIVED_ATTR = 'data-ubol-derived';
    const reStackUrl = /(https?:\/\/[^\s()]+?):\d+:\d+/g;

    // Rolling buffer of recent insertions not yet attributed: each entry holds
    // the inserted nodes plus the script URLs seen in the insertion's call
    // stack. Bounded in size and age so memory stays flat; a blocked script is
    // learned within ~1 network-poll of its request, well inside the window.
    const pending = [];
    const PENDING_MAX = 6000;
    const PENDING_TTL = 10000;

    // All script URLs in the current call stack (may be empty).
    const scriptUrlsInStack = () => {
        let stack;
        try { stack = new Error().stack || ''; } catch { return []; }
        const urls = [];
        reStackUrl.lastIndex = 0;
        let m;
        while ( (m = reStackUrl.exec(stack)) !== null ) {
            urls.push(m[1]);
        }
        return urls;
    };

    // The first would-be-blocked URL among a list, or ''.
    const firstBlocking = urls => {
        for ( const u of urls ) {
            if ( wouldBlockScripts.has(u) ) { return u; }
        }
        return '';
    };

    const tagOne = (node, url) => {
        if ( node instanceof Element === false ) { return; }
        try {
            if ( node.hasAttribute(DERIVED_ATTR) === false ) {
                node.setAttribute(DERIVED_ATTR, url);
            }
        } catch {
        }
    };

    // Tag an inserted node (Element) or the element children of a fragment.
    const tagInserted = (node, url) => {
        if ( node instanceof DocumentFragment ) {
            for ( const child of node.children ) { tagOne(child, url); }
        } else {
            tagOne(node, url);
        }
    };

    // Handle an insertion of `nodes` (array of node-ish values): tag now if a
    // blocking script is already known to be in `urls`; otherwise buffer the
    // insertion so it can be attributed once such a script is learned.
    const handleInsertion = (nodes, urls) => {
        if ( urls.length === 0 ) { return; }
        const url = firstBlocking(urls);
        if ( url !== '' ) {
            for ( const n of nodes ) { tagInserted(n, url); }
            return;
        }
        // Keep only still-connected element nodes worth revisiting.
        const kept = [];
        for ( const n of nodes ) {
            if ( n instanceof Element || n instanceof DocumentFragment ) { kept.push(n); }
        }
        if ( kept.length === 0 ) { return; }
        if ( pending.length >= PENDING_MAX ) { pending.shift(); }
        pending.push({ nodes: kept, urls, t: Date.now() });
    };

    // Re-check buffered insertions against the (now larger) blocked-script set.
    const resolvePending = () => {
        if ( pending.length === 0 ) { return; }
        const cutoff = Date.now() - PENDING_TTL;
        let w = 0;
        for ( let r = 0; r < pending.length; r++ ) {
            const entry = pending[r];
            if ( entry.t < cutoff ) { continue; }   // expired → drop
            const url = firstBlocking(entry.urls);
            if ( url !== '' ) {
                for ( const n of entry.nodes ) { tagInserted(n, url); }
                continue;                            // resolved → drop
            }
            pending[w++] = entry;                    // keep unresolved
        }
        pending.length = w;
    };

    // Wrap a method whose inserted node(s) are positional arguments.
    const wrapNodeArgs = (proto, name, argIndices) => {
        const original = proto[name];
        if ( typeof original !== 'function' ) { return; }
        proto[name] = function(...args) {
            const result = original.apply(this, args);
            const urls = scriptUrlsInStack();
            if ( urls.length !== 0 ) {
                const nodes = argIndices === 'all'
                    ? args.filter(a => a && typeof a === 'object')
                    : argIndices.map(i => args[i]);
                handleInsertion(nodes, urls);
            }
            return result;
        };
    };

    try {
        wrapNodeArgs(Node.prototype, 'appendChild', [ 0 ]);
        wrapNodeArgs(Node.prototype, 'insertBefore', [ 0 ]);
        wrapNodeArgs(Node.prototype, 'replaceChild', [ 0 ]);
        wrapNodeArgs(Element.prototype, 'append', 'all');
        wrapNodeArgs(Element.prototype, 'prepend', 'all');
        wrapNodeArgs(Element.prototype, 'before', 'all');
        wrapNodeArgs(Element.prototype, 'after', 'all');
        wrapNodeArgs(Element.prototype, 'replaceWith', 'all');
        wrapNodeArgs(Element.prototype, 'insertAdjacentElement', [ 1 ]);
    } catch {
    }

    // HTML-string insertion: after the native call, tag the container's element
    // descendants (they were all produced by the blocking script).
    const wrapHtmlSetter = (proto, prop) => {
        const desc = Object.getOwnPropertyDescriptor(proto, prop);
        if ( desc === undefined || typeof desc.set !== 'function' ) { return; }
        Object.defineProperty(proto, prop, {
            configurable: true,
            enumerable: desc.enumerable,
            get: desc.get,
            set(value) {
                const urls = scriptUrlsInStack();
                const before = urls.length !== 0 && this instanceof Element
                    ? new Set(this.children)
                    : null;
                desc.set.call(this, value);
                if ( before !== null ) {
                    const added = [];
                    for ( const el of this.children ) {
                        if ( before.has(el) === false ) { added.push(el); }
                    }
                    if ( added.length !== 0 ) { handleInsertion(added, urls); }
                }
            },
        });
    };

    const wrapInsertAdjacentHTML = () => {
        const original = Element.prototype.insertAdjacentHTML;
        if ( typeof original !== 'function' ) { return; }
        Element.prototype.insertAdjacentHTML = function(position, text) {
            const urls = scriptUrlsInStack();
            const scope = (position === 'beforebegin' || position === 'afterend')
                ? this.parentElement : this;
            const before = urls.length !== 0 && scope
                ? new Set(scope.children)
                : null;
            const result = original.call(this, position, text);
            if ( before !== null && scope ) {
                const added = [];
                for ( const el of scope.children ) {
                    if ( before.has(el) === false ) { added.push(el); }
                }
                if ( added.length !== 0 ) { handleInsertion(added, urls); }
            }
            return result;
        };
    };

    try {
        wrapHtmlSetter(Element.prototype, 'innerHTML');
        wrapHtmlSetter(Element.prototype, 'outerHTML');
        wrapInsertAdjacentHTML();
    } catch {
    }

    resolvers.add(resolvePending);
}

(( ) => {
    const shared = self.__ubolAuditShared;
    if ( shared === undefined ) { return; }
    installDomDerivation(shared.wouldBlockScripts, shared.resolvers);
})();
