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
        if ( data.__ubolAudit !== 'report' ) { return; }
        if ( data.entry instanceof Object === false ) { return; }
        chrome.runtime.sendMessage({
            what: 'recordScriptletRequest',
            details: data.entry,
        }).catch(( ) => { });
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

    self.setInterval(pump, 1000);
    pump();
})();
