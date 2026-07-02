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

(api => {
    if ( typeof api === 'object' ) { return; }

    // Annotation (audit) mode: instead of hiding matched elements, tag them in
    // the DOM with `data-ubol-hide="<reason>"` so an external DOM walk can find
    // what *would* have been hidden. A MutationObserver keeps tagging elements
    // that match as the DOM changes, mirroring what a global stylesheet would
    // affect.
    const annotator = {
        enabled: false,
        selectors: new Set(),
        observer: undefined,
        pending: false,
        HIDE_ATTR: 'data-ubol-hide',
        FILTER_ATTR: 'data-ubol-filter',
        addReason(node, reason) {
            const existing = node.getAttribute(this.HIDE_ATTR);
            if ( existing === null ) {
                node.setAttribute(this.HIDE_ATTR, reason);
                return;
            }
            if ( existing === reason ) { return; }
            const set = new Set(existing.split(/\s+/));
            if ( set.has(reason) ) { return; }
            set.add(reason);
            node.setAttribute(this.HIDE_ATTR, Array.from(set).join(' '));
        },
        // Record which specific filter/selector (and which engine) would have
        // acted on this node, as a JSON array in a DOM attribute so page code
        // (window.__ubolAudit) can read the attribution across worlds.
        recordFilter(node, source, filter) {
            if ( !filter ) { return; }
            let list;
            try {
                list = JSON.parse(node.getAttribute(this.FILTER_ATTR) || '[]');
            } catch {
                list = [];
            }
            if ( Array.isArray(list) === false ) { list = []; }
            for ( const e of list ) {
                if ( e.source === source && e.filter === filter ) { return; }
            }
            list.push({ source, filter });
            try {
                node.setAttribute(this.FILTER_ATTR, JSON.stringify(list));
            } catch {
            }
        },
        tagAll() {
            this.pending = false;
            for ( const entry of this.selectors ) {
                let nodes;
                try {
                    nodes = document.querySelectorAll(entry.selector);
                } catch {
                    continue;
                }
                for ( const node of nodes ) {
                    this.addReason(node, entry.reason);
                    this.recordFilter(node, entry.reason, entry.selector);
                }
            }
        },
        schedule() {
            if ( this.pending ) { return; }
            this.pending = true;
            self.requestAnimationFrame(( ) => { this.tagAll(); });
        },
        add(selectors, reason) {
            // Accept a single selector string or an array of individual
            // selectors. Individual selectors let us attribute a tagged element
            // to the exact filter that matched it.
            const list = Array.isArray(selectors) ? selectors : [ selectors ];
            let added = false;
            for ( const selector of list ) {
                if ( typeof selector !== 'string' || selector === '' ) { continue; }
                this.selectors.add({ selector, reason });
                added = true;
            }
            if ( added === false ) { return; }
            if ( this.observer === undefined ) {
                this.observer = new MutationObserver(( ) => { this.schedule(); });
                this.observer.observe(document, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: [ 'id', 'class' ],
                });
            }
            this.schedule();
        },
    };

    // Determine once whether annotation mode is active, from the config the
    // background mirrors into session storage.
    annotator.ready = (async ( ) => {
        try {
            const bin = await chrome.storage.session.get('rulesetConfig');
            annotator.enabled = bin?.rulesetConfig?.annotationMode === true;
        } catch {
        }
    })();

    self.cssAPI = {
        ready: annotator.ready,
        insert(css) {
            chrome.runtime.sendMessage({
                what: 'insertCSS',
                css,
            }).catch(( ) => {
            });
        },
        // Hide (or, in annotation mode, tag) elements matching `selectors`.
        // `selectors` may be a single combined selector string or an array of
        // individual selectors; an array lets annotation mode attribute each
        // tagged element to the exact filter that matched it.
        // `reason` identifies the cosmetic source (e.g. 'specific', 'generic').
        async hide(selectors, reason) {
            await annotator.ready;
            if ( annotator.enabled ) {
                annotator.add(selectors, reason);
                return;
            }
            const css = Array.isArray(selectors) ? selectors.join(',\n') : selectors;
            if ( css === '' ) { return; }
            this.insert(`${css}{display:none!important;}`);
        },
        // Record filter attribution for a node tagged outside the annotator
        // (e.g. the procedural filterer). Exposed so those paths can attribute
        // elements to their exact filter via the shared data-ubol-filter attr.
        recordFilter(node, source, filter) {
            annotator.recordFilter(node, source, filter);
        },
        get annotating() {
            return annotator.enabled;
        },
    };
})(self.cssAPI);
