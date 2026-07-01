/*******************************************************************************

    uBlock Origin Lite - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2022-present Raymond Hill

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

// Annotation (audit) mode.
//
// Instead of *enforcing* filters, annotation mode records what *would* have
// been filtered:
//   - network requests DNR would have blocked (without actually blocking them),
//     including transitively-derived requests (see net-derived tracking below);
//   - scriptlet-suppressed network requests (recorded here too, source:scriptlet).
//
// Element (cosmetic) annotations live in the page DOM as `data-ubol-*`
// attributes and are handled by the injected content scripts, not here.
//
// This module owns the authoritative, per-tab audit dataset. It lives in the
// background/service-worker and is mirrored to `chrome.storage.session` so it
// survives service-worker restarts *and same-tab navigations/redirects* (the
// page-global mirror is re-hydrated from here on every new document).
//
// Annotation mode is inherently a developer/sideloaded capability: it depends
// on the `declarativeNetRequestFeedback` permission (unpacked builds only) and,
// for precise initiator chains, the optional `debugger` permission (Chromium).

import { dnr, webext } from './ext-compat.js';
import { isSideloaded, ubolErr, ubolLog } from './debug.js';
import { rulesetConfig, saveRulesetConfig } from './config.js';
import {
    sessionRead,
    sessionWrite,
} from './ext.js';
import {
    startPreciseInitiators,
    stopPreciseInitiators,
} from './annotation-cdp.js';
import { AuditStore } from './annotation-store.js';

/******************************************************************************/

const AUDIT_SESSION_KEY = 'annotationAudit';

// Session rule id used to neutralize real blocking while annotation mode is on.
// A single top-priority `allowAllRequests` rule makes the *net* DNR outcome
// "allow" for every request, so nothing is actually blocked and derived
// resources load — while `onRuleMatchedDebug` still reports the block rules
// that matched. See ANNOTATION_NET_MECHANISM in docs for the validation notes.
const PASSTHROUGH_RULE_ID = 1000000;

/******************************************************************************/

// The authoritative per-tab audit dataset. All bookkeeping lives in the pure,
// unit-tested AuditStore; this module only wires it to browser APIs and to
// session-storage persistence.
const store = new AuditStore();

let networkListening = false;

/******************************************************************************/

// Persist a compact snapshot to session storage so the dataset survives
// service-worker restarts and same-tab navigations.

let persistTimer;

function schedulePersist() {
    if ( persistTimer !== undefined ) { return; }
    persistTimer = setTimeout(( ) => {
        persistTimer = undefined;
        persistNow();
    }, 500);
}

async function persistNow() {
    try {
        await sessionWrite(AUDIT_SESSION_KEY, store.snapshot());
    } catch (reason) {
        ubolErr(`annotation/persist/${reason}`);
    }
}

async function restore() {
    let data;
    try {
        data = await sessionRead(AUDIT_SESSION_KEY);
    } catch {
    }
    store.restore(data);
}

/******************************************************************************/

// Record a request that would have been blocked. `verdict` is 'direct' when the
// request itself matched a block rule (or a network-suppressing scriptlet), and
// 'derived' when it only exists because a would-be-blocked ancestor was allowed
// to run.

function recordRequest(details, options) {
    const record = store.record(details, options);
    if ( record !== undefined ) { schedulePersist(); }
    return record;
}

/******************************************************************************/

// Direct would-be-blocked capture via `onRuleMatchedDebug`.
//
// Requires the `declarativeNetRequestFeedback` permission (unpacked/sideloaded
// builds only). While annotation mode is on we install a top-priority
// `allowAllRequests` passthrough rule so the request is not actually blocked;
// `onRuleMatchedDebug` still reports the matched block rule.

function onRuleMatchedDebugListener(info) {
    const { request, rule } = info;
    if ( request === undefined || rule === undefined ) { return; }
    recordRequest(request, {
        source: 'dnr',
        verdict: 'direct',
        matchedRule: { rulesetId: rule.rulesetId, ruleId: rule.ruleId },
    });
    // Mark the initiating document/frame as a would-block origin so derived
    // requests can be attributed (coarse lineage).
    store.markWouldBlock(request);
}

/******************************************************************************/

// Coarse derived-resource attribution (net-derived-coarse).
//
// Non-blocking `webRequest.onBeforeRequest` observation lets us see *every*
// request (including those that only exist because a would-be-blocked ancestor
// was allowed to run). We attribute derivation at *frame* granularity: if a
// (sub-)frame's navigation would have been blocked, every request inside that
// frame — and inside frames nested under it — is a derived would-be-blocked
// resource, even if it matches no rule itself.
//
// Limitation: webRequest exposes the initiator *origin*, not the initiating
// *script* URL, so same-document script-to-script causality (a.js -> b.js in
// the top frame) cannot be resolved here. That precision requires the opt-in
// CDP path (net-derived-cdp).

const webRequest = webext.webRequest;

function onBeforeRequestListener(details) {
    if ( store.noteFrameLineage(details) ) {
        recordDerivedRequest(details);
    }
}

function startWebRequestObserver() {
    if ( webRequest?.onBeforeRequest?.addListener === undefined ) { return; }
    if ( webRequest.onBeforeRequest.hasListener(onBeforeRequestListener) ) { return; }
    webRequest.onBeforeRequest.addListener(
        onBeforeRequestListener,
        { urls: [ '<all_urls>' ] }
    );
}

function stopWebRequestObserver() {
    if ( webRequest?.onBeforeRequest?.removeListener === undefined ) { return; }
    if ( webRequest.onBeforeRequest.hasListener(onBeforeRequestListener) === false ) { return; }
    webRequest.onBeforeRequest.removeListener(onBeforeRequestListener);
}

async function installPassthroughRule() {
    if ( typeof dnr.updateSessionRules !== 'function' ) { return; }
    try {
        await dnr.updateSessionRules({
            addRules: [ {
                id: PASSTHROUGH_RULE_ID,
                priority: 1000000,
                action: { type: 'allowAllRequests' },
                condition: {
                    resourceTypes: [ 'main_frame', 'sub_frame' ],
                    urlFilter: '*',
                },
            }, {
                // allow (non-frame types) so sub-resources are not blocked
                id: PASSTHROUGH_RULE_ID + 1,
                priority: 1000000,
                action: { type: 'allow' },
                condition: { urlFilter: '*' },
            } ],
            removeRuleIds: [ PASSTHROUGH_RULE_ID, PASSTHROUGH_RULE_ID + 1 ],
        });
    } catch (reason) {
        ubolErr(`annotation/passthrough/add/${reason}`);
    }
}

async function removePassthroughRule() {
    if ( typeof dnr.updateSessionRules !== 'function' ) { return; }
    try {
        await dnr.updateSessionRules({
            removeRuleIds: [ PASSTHROUGH_RULE_ID, PASSTHROUGH_RULE_ID + 1 ],
        });
    } catch (reason) {
        ubolErr(`annotation/passthrough/remove/${reason}`);
    }
}

function startNetworkCapture() {
    if ( networkListening ) { return; }
    if ( dnr.onRuleMatchedDebug instanceof Object === false ) {
        ubolLog('annotation: onRuleMatchedDebug unavailable (need feedback perm)');
        return;
    }
    dnr.onRuleMatchedDebug.addListener(onRuleMatchedDebugListener);
    startWebRequestObserver();
    networkListening = true;
}

function stopNetworkCapture() {
    if ( networkListening === false ) { return; }
    if ( dnr.onRuleMatchedDebug instanceof Object ) {
        dnr.onRuleMatchedDebug.removeListener(onRuleMatchedDebugListener);
    }
    stopWebRequestObserver();
    networkListening = false;
}

/******************************************************************************/

// Public API used by the background message router and by the content-script
// bridge (page-global mirror + scriptlet audit channel).

export function recordScriptletRequest(details) {
    return recordRequest(details, { source: 'scriptlet', verdict: 'direct' });
}

export function recordDerivedRequest(details, initiatorChain = null) {
    return recordRequest(details, {
        source: 'dnr',
        verdict: 'derived',
        initiatorChain,
    });
}

export function getAuditData(tabId) {
    return store.getAuditData(tabId);
}

// Set of URLs known to be *directly* would-be-blocked in a tab. Used by the
// precise CDP path to decide whether a request's initiator script chain traces
// back to a would-be-blocked resource (making the request a derived hit).
export function getWouldBlockUrls(tabId) {
    return store.getWouldBlockUrls(tabId);
}

export function resetAudit(tabId) {
    store.reset(tabId);
    schedulePersist();
}

export function isAnnotationModeAvailable() {
    return isSideloaded === true;
}

/******************************************************************************/

export async function setAnnotationMode(state) {
    const next = state === true && isAnnotationModeAvailable();
    if ( next === rulesetConfig.annotationMode ) {
        return rulesetConfig.annotationMode;
    }
    rulesetConfig.annotationMode = next;
    if ( next ) {
        await installPassthroughRule();
        startNetworkCapture();
        if ( rulesetConfig.preciseInitiators ) {
            startPreciseInitiators();
        }
    } else {
        stopNetworkCapture();
        await stopPreciseInitiators();
        await removePassthroughRule();
        resetAudit();
    }
    await saveRulesetConfig();
    return rulesetConfig.annotationMode;
}

export async function setPreciseInitiators(state) {
    rulesetConfig.preciseInitiators = state === true;
    await saveRulesetConfig();
    // The CDP attach/detach lifecycle follows this flag while annotation mode
    // is active.
    if ( rulesetConfig.annotationMode ) {
        if ( rulesetConfig.preciseInitiators ) {
            await startPreciseInitiators();
        } else {
            await stopPreciseInitiators();
        }
    }
    return rulesetConfig.preciseInitiators;
}

/******************************************************************************/

// Tab lifecycle: drop data for closed tabs.
if ( webext.tabs && webext.tabs.onRemoved ) {
    webext.tabs.onRemoved.addListener(tabId => { resetAudit(tabId); });
}

// Restore persisted dataset and, if annotation mode was already on, resume
// capture after a service-worker wake-up.
export async function initAnnotation() {
    await restore();
    if ( rulesetConfig.annotationMode && isAnnotationModeAvailable() ) {
        await installPassthroughRule();
        startNetworkCapture();
        if ( rulesetConfig.preciseInitiators ) {
            startPreciseInitiators();
        }
    }
}

/******************************************************************************/
