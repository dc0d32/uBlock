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
                }
            }
        },
        schedule() {
            if ( this.pending ) { return; }
            this.pending = true;
            self.requestAnimationFrame(( ) => { this.tagAll(); });
        },
        add(selectorText, reason) {
            if ( selectorText === '' ) { return; }
            this.selectors.add({ selector: selectorText, reason });
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
        // Hide (or, in annotation mode, tag) elements matching `selectorText`.
        // `reason` identifies the cosmetic source (e.g. 'specific', 'generic').
        async hide(selectorText, reason) {
            if ( selectorText === '' ) { return; }
            await annotator.ready;
            if ( annotator.enabled ) {
                annotator.add(selectorText, reason);
                return;
            }
            this.insert(`${selectorText}{display:none!important;}`);
        },
        get annotating() {
            return annotator.enabled;
        },
    };
})(self.cssAPI);
