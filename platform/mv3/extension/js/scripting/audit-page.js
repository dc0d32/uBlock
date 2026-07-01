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
    ].join(',');

    window.__ubolAudit = {
        network: [],
        getElements() {
            return Array.from(document.querySelectorAll(ELEMENT_SELECTOR));
        },
        report(entry) {
            try {
                window.postMessage({ __ubolAudit: 'report', entry }, '*');
            } catch {
            }
        },
    };

    window.addEventListener('message', ev => {
        if ( ev.source !== window ) { return; }
        const data = ev.data;
        if ( data instanceof Object === false ) { return; }
        if ( data.__ubolAudit !== 'data' ) { return; }
        window.__ubolAudit.network = Array.isArray(data.network)
            ? data.network
            : [];
    });
})();
