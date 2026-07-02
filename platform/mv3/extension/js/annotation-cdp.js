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

// Annotation (audit) mode — precise initiator chains via CDP (Chromium only).
//
// The coarse path (annotation.js webRequest observer) attributes derived
// would-be-blocked requests at *frame* granularity only, because webRequest
// exposes the initiator origin, not the initiating script URL. This opt-in path
// attaches the Chrome DevTools Protocol (`chrome.debugger`) to observe
// `Network.requestWillBeSent`, whose `initiator.stack` gives the full JS call
// stack (script URLs). That lets us resolve exact script-to-script causality
// (a.js -> b.js in the same document) and flag a request as *derived* when any
// script in its initiator chain traces back to a would-be-blocked resource.
//
// Requires the optional `debugger` permission (added only to dev/sideloaded
// Chromium builds). Firefox has no equivalent, so this module is a no-op there.

import { chainTracesToWouldBlock, scriptUrlsFromStack } from './annotation-store.js';
import { getWouldBlockUrls, recordDerivedRequest } from './annotation.js';
import { ubolErr, ubolLog } from './debug.js';
import { webext } from './ext-compat.js';

/******************************************************************************/

const dbg = webext.debugger;
const PROTOCOL_VERSION = '1.3';

const attachedTabs = new Set();
let active = false;
let listenersInstalled = false;

/******************************************************************************/

export function isCDPAvailable() {
    return dbg !== undefined && typeof dbg.attach === 'function';
}

/******************************************************************************/

function onEvent(source, method, params) {
    if ( active === false ) { return; }
    if ( method !== 'Network.requestWillBeSent' ) { return; }
    const tabId = source.tabId;
    if ( typeof tabId !== 'number' ) { return; }
    const initiator = params?.initiator;
    if ( initiator instanceof Object === false ) { return; }
    const chain = [];
    if ( initiator.url ) { chain.push(initiator.url); }
    if ( initiator.stack ) { chain.push(...scriptUrlsFromStack(initiator.stack)); }
    if ( chain.length === 0 ) { return; }
    // A request is a derived would-be-blocked resource when any script in its
    // initiator chain is itself would-be-blocked.
    const wouldBlockUrls = getWouldBlockUrls(tabId);
    if ( chainTracesToWouldBlock(chain, wouldBlockUrls) === false ) { return; }
    const req = params.request || {};
    recordDerivedRequest({
        tabId,
        frameId: -1,
        documentId: params.frameId || '',
        url: req.url,
        type: params.type ? params.type.toLowerCase() : '',
        initiator: initiator.url || '',
        timeStamp: Date.now(),
    }, chain);
}

function onDetach(source, reason) {
    if ( source.tabId !== undefined ) {
        attachedTabs.delete(source.tabId);
    }
    ubolLog(`annotation/cdp: detached (${reason})`);
}

/******************************************************************************/

async function attachTab(tabId) {
    if ( attachedTabs.has(tabId) ) { return; }
    attachedTabs.add(tabId);
    try {
        await dbg.attach({ tabId }, PROTOCOL_VERSION);
        // Anti-detection invariant: enable ONLY the Network domain. Do NOT
        // enable Runtime or Debugger. Pages commonly detect a CDP client by
        // (a) timing a `debugger;` statement (fires only when the Debugger
        // domain is enabled) or (b) logging an object with a getter (fires only
        // when the Runtime domain serializes console args). Enabling just
        // Network avoids both, so this attach is not observable via those
        // techniques. Keep it this way.
        await dbg.sendCommand({ tabId }, 'Network.enable', {});
    } catch (reason) {
        attachedTabs.delete(tabId);
        // A failed attach is often an expected condition rather than a bug:
        // most commonly the user has DevTools open on the tab (or another
        // extension is debugging it), so the tab already has a debuggee client.
        // Log those quietly; only report genuinely unexpected failures.
        const msg = `${reason}`;
        if ( /already attached|cannot attach|cannot access|cannot be scripted|no tab with id|target is closing|no target with given id|detached/i.test(msg) ) {
            ubolLog(`annotation/cdp: skipping tab ${tabId} (${msg})`);
        } else {
            ubolErr(`annotation/cdp/attach/${msg}`);
        }
    }
}

// Some https pages cannot be debugged/scripted (e.g. the Chrome Web Store /
// extensions gallery). Skip them so we never attempt an attach that will fail.
function isDebuggableUrl(url) {
    if ( typeof url !== 'string' || url === '' ) { return true; }
    if ( /^https?:\/\//i.test(url) === false ) { return false; }
    let hostname;
    try { hostname = new URL(url).hostname; } catch { return false; }
    if ( hostname === 'chromewebstore.google.com' ) { return false; }
    if ( hostname === 'chrome.google.com' ) { return false; }
    return true;
}

async function detachTab(tabId) {
    if ( attachedTabs.has(tabId) === false ) { return; }
    attachedTabs.delete(tabId);
    try {
        await dbg.detach({ tabId });
    } catch {
    }
}

async function attachAllTabs() {
    if ( webext.tabs?.query === undefined ) { return; }
    let tabs = [];
    try {
        tabs = await webext.tabs.query({ url: [ 'http://*/*', 'https://*/*' ] });
    } catch {
    }
    for ( const tab of tabs ) {
        if ( typeof tab.id !== 'number' ) { continue; }
        if ( isDebuggableUrl(tab.url) === false ) { continue; }
        attachTab(tab.id);
    }
}

// Attach as soon as a tab begins navigating so we capture its requests from the
// start. Without this, tabs opened *after* precise-initiators is enabled would
// never be attached (and thus produce no initiator chains).
function onTabUpdated(tabId, changeInfo, tab) {
    if ( active === false ) { return; }
    if ( changeInfo.status !== 'loading' ) { return; }
    const url = changeInfo.url || (tab && tab.url) || '';
    if ( /^https?:/.test(url) === false && url !== '' ) { return; }
    if ( isDebuggableUrl(url) === false ) { return; }
    attachTab(tabId);
}

function installTabListeners() {
    if ( webext.tabs?.onUpdated?.addListener ) {
        if ( webext.tabs.onUpdated.hasListener(onTabUpdated) === false ) {
            webext.tabs.onUpdated.addListener(onTabUpdated);
        }
    }
}

function removeTabListeners() {
    if ( webext.tabs?.onUpdated?.removeListener ) {
        webext.tabs.onUpdated.removeListener(onTabUpdated);
    }
}

/******************************************************************************/

export async function startPreciseInitiators() {
    if ( isCDPAvailable() === false ) {
        ubolLog('annotation/cdp: debugger API unavailable');
        return false;
    }
    if ( active ) { return true; }
    active = true;
    if ( listenersInstalled === false ) {
        dbg.onEvent.addListener(onEvent);
        dbg.onDetach.addListener(onDetach);
        listenersInstalled = true;
    }
    installTabListeners();
    await attachAllTabs();
    return true;
}

export async function stopPreciseInitiators() {
    if ( active === false ) { return; }
    active = false;
    removeTabListeners();
    const tabIds = Array.from(attachedTabs);
    await Promise.all(tabIds.map(detachTab));
}
