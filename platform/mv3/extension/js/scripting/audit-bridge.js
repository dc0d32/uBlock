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

// Annotation (audit) mode — bridge (ISOLATED world).
//
// The page-global mirror (`audit-page.js`) runs in the MAIN world and cannot
// talk to the extension. This isolated content script bridges the two:
//   - relays `report` messages from audit-aware scriptlets to the background
//     (recorded as source:'scriptlet' would-be-blocked requests);
//   - periodically pulls the background audit dataset for this tab and pushes
//     it to the MAIN-world mirror, so `window.__ubolAudit.network` stays current
//     and survives navigations/redirects.

(( ) => {
    const forwardToMain = network => {
        try {
            window.postMessage({ __ubolAudit: 'data', network }, '*');
        } catch {
        }
    };

    // MAIN -> background: scriptlet-suppressed requests.
    window.addEventListener('message', ev => {
        if ( ev.source !== window ) { return; }
        const data = ev.data;
        if ( data instanceof Object === false ) { return; }
        if ( data.__ubolAudit === 'report' ) {
            if ( data.entry instanceof Object === false ) { return; }
            chrome.runtime.sendMessage({
                what: 'recordScriptletRequest',
                details: data.entry,
            }).catch(( ) => { });
            return;
        }
        // MAIN -> background: DOM-annotation ("element") events, at tag time.
        // The durable per-tab store + WAL means a tagged node in a cross-origin
        // iframe or a torn-down document is captured even if a later DOM walk
        // could no longer reach it.
        if ( data.__ubolAudit === 'elements' ) {
            if ( Array.isArray(data.records) === false ) { return; }
            chrome.runtime.sendMessage({
                what: 'recordAuditElements',
                records: data.records,
            }).catch(( ) => { });
            return;
        }
    });

    // background -> MAIN: mirror the would-be-blocked dataset for this tab.
    let stopped = false;
    const pump = async ( ) => {
        if ( stopped ) { return; }
        try {
            const data = await chrome.runtime.sendMessage({
                what: 'getAuditDataForSelf',
            });
            forwardToMain(Array.isArray(data?.requests) ? data.requests : []);
        } catch {
            // Extension context invalidated (e.g. reload): stop polling.
            stopped = true;
            return;
        }
    };

    // Poll quickly during initial page load (when would-be-blocked scripts are
    // being discovered and may be inserting DOM nodes), then settle to a slower
    // steady-state interval. The fast early cadence minimizes the window in
    // which the MAIN-world mirror doesn't yet know a script is would-be-blocked.
    let fastPolls = 40;   // ~40 * 250ms = first 10s
    const schedule = ( ) => {
        if ( stopped ) { return; }
        const delay = fastPolls > 0 ? 250 : 1000;
        if ( fastPolls > 0 ) { fastPolls -= 1; }
        self.setTimeout(async ( ) => {
            await pump();
            schedule();
        }, delay);
    };

    pump();
    schedule();
})();
