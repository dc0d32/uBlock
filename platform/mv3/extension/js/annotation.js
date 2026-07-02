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
import {
    localRead,
    localWrite,
    sessionRead,
    sessionWrite,
} from './ext.js';
import { rulesetConfig, saveRulesetConfig } from './config.js';
import {
    startPreciseInitiators,
    stopPreciseInitiators,
} from './annotation-cdp.js';
import { AuditStore } from './annotation-store.js';
import { AuditWal } from './annotation-wal.js';
import { DNRMatcher } from './dnr-matcher.js';
import { getEnabledRulesets } from './ruleset-manager.js';

/******************************************************************************/

const AUDIT_SESSION_KEY = 'annotationAudit';

// Durable element-annotation write-ahead log lives in `chrome.storage.local`
// (survives service-worker restarts AND tab close), separate from the per-tab
// session snapshot above. A reader (see tools/collect_audit.py) can replay it
// by sequence number to recover any tag events the real-time CDP stream missed.
const AUDIT_WAL_KEY = 'annotationAuditWal';

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

// Element write-ahead log (durable, in chrome.storage.local).

const wal = new AuditWal({ cap: 20000 });
let walDirty = false;
let walTimer;

async function restoreWal() {
    let data;
    try {
        data = await localRead(AUDIT_WAL_KEY);
    } catch {
    }
    const restored = AuditWal.fromJSON(data, { cap: 20000 });
    wal.seq = restored.seq;
    wal.records = restored.records;
}

function scheduleWalPersist() {
    walDirty = true;
    if ( walTimer !== undefined ) { return; }
    walTimer = setTimeout(( ) => {
        walTimer = undefined;
        persistWalNow();
    }, 1000);
}

async function persistWalNow() {
    if ( walDirty === false ) { return; }
    walDirty = false;
    try {
        await localWrite(AUDIT_WAL_KEY, wal.toJSON());
    } catch (reason) {
        ubolErr(`annotation/wal/${reason}`);
    }
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

// Would-be-block oracle: a JS re-implementation of DNR matching (dnr-matcher.js)
// that evaluates the *same* ruleset data uBOL ships, so we can report what the
// DNR engine *would* have decided while enforcement is neutralized by the
// passthrough rule (so the page actually loads unblocked).
//
// The matcher is validated against Chrome's own declarativeNetRequest
// .testMatchOutcome over thousands of real-rule URLs (see .e2e/oracle*.mjs).

let matcher = null;
let matcherPromise = null;
// Requests observed before the (async-built) matcher is ready are buffered here
// and replayed once it's available, so the very first page load isn't missed.
let pendingRequests = [];

async function buildMatcher() {
    const m = new DNRMatcher();
    // Static rulesets currently enabled (their JSON ships in the extension).
    let rulesetIds = [];
    try {
        rulesetIds = await getEnabledRulesets();
    } catch (reason) {
        ubolErr(`annotation/matcher/rulesets/${reason}`);
    }
    await Promise.all(rulesetIds.map(async id => {
        try {
            const response = await fetch(`/rulesets/main/${id}.json`);
            const rules = await response.json();
            if ( Array.isArray(rules) ) { m.addRuleset(rules, id); }
        } catch {
            // Imported/custom lists may not have a main JSON; skip.
        }
    }));
    // Dynamic + session rules (regex/redirect/strict-block etc.), excluding our
    // own passthrough rules so we don't treat them as blocks.
    try {
        const dynamic = await dnr.getDynamicRules();
        if ( Array.isArray(dynamic) ) {
            m.addRuleset(dynamic.filter(r => isPassthroughRule(r) === false), '_dynamic');
        }
    } catch {
    }
    try {
        const session = await dnr.getSessionRules();
        if ( Array.isArray(session) ) {
            m.addRuleset(session.filter(r => isPassthroughRule(r) === false), '_session');
        }
    } catch {
    }
    m.finalize();
    ubolLog(`annotation: matcher built with ${m.ruleCount} rules`);
    return m;
}

function isPassthroughRule(rule) {
    return rule.id === PASSTHROUGH_RULE_ID || rule.id === PASSTHROUGH_RULE_ID + 1;
}

async function ensureMatcher() {
    if ( matcher !== null ) { return matcher; }
    if ( matcherPromise === null ) {
        matcherPromise = buildMatcher().then(m => {
            matcher = m;
            // Replay any requests observed while the matcher was building.
            const pending = pendingRequests;
            pendingRequests = [];
            for ( const details of pending ) {
                evaluateRequest(details);
            }
            return m;
        });
    }
    return matcherPromise;
}

function teardownMatcher() {
    matcher = null;
    matcherPromise = null;
    pendingRequests = [];
}

/******************************************************************************/

// Map a webRequest resourceType to a DNR resourceType. They largely coincide;
// this guards the few naming differences across browsers.
function dnrTypeFromWebRequest(type) {
    switch ( type ) {
    case 'main_frame': return 'main_frame';
    case 'sub_frame': return 'sub_frame';
    case 'stylesheet': return 'stylesheet';
    case 'script': return 'script';
    case 'image':
    case 'imageset': return 'image';
    case 'font': return 'font';
    case 'object':
    case 'object_subrequest': return 'object';
    case 'xmlhttprequest': return 'xmlhttprequest';
    case 'ping':
    case 'beacon': return 'ping';
    case 'csp_report': return 'csp_report';
    case 'media': return 'media';
    case 'websocket': return 'websocket';
    case 'webtransport': return 'webtransport';
    case 'webbundle': return 'webbundle';
    default: return 'other';
    }
}

// Firefox exposes the initiator via `originUrl`/`documentUrl`; Chromium via
// `initiator`.
function initiatorFromDetails(details) {
    return details.initiator || details.originUrl || details.documentUrl || '';
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
    // Buffer requests seen before the async matcher finishes building; they are
    // replayed in ensureMatcher() once it's ready.
    if ( matcher === null ) {
        if ( networkListening ) { pendingRequests.push(details); }
        return;
    }
    evaluateRequest(details);
}

function evaluateRequest(details) {
    if ( matcher === null ) { return; }
    const req = {
        url: details.url,
        type: dnrTypeFromWebRequest(details.type),
        method: details.method,
        initiator: initiatorFromDetails(details),
        tabId: details.tabId,
    };
    // Direct would-be-blocked: our matcher reproduces the DNR verdict that the
    // passthrough rule is currently masking.
    const verdict = matcher.match(req);
    const wouldBlock = verdict !== null &&
        (verdict.action === 'block' || verdict.action === 'redirect');
    if ( wouldBlock ) {
        recordRequest(details, {
            source: 'dnr',
            verdict: 'direct',
            matchedRule: { rulesetId: verdict.rulesetId, ruleId: verdict.ruleId },
        });
        // A would-be-blocked (sub-)frame navigation seeds coarse derivation for
        // every resource inside that frame.
        store.markWouldBlock(details);
    }
    // Coarse derived attribution: a request inside a would-block frame that
    // wasn't itself a direct hit is a derived would-be-blocked resource.
    if ( wouldBlock === false && store.noteFrameLineage(details) ) {
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
    // Register the observer first so no request is missed, then kick off the
    // async matcher build. Requests seen before it's ready are buffered and
    // replayed (see ensureMatcher / onBeforeRequestListener).
    startWebRequestObserver();
    networkListening = true;
    ensureMatcher();
}

function stopNetworkCapture() {
    if ( networkListening === false ) { return; }
    stopWebRequestObserver();
    teardownMatcher();
    networkListening = false;
}

/******************************************************************************/

// Public API used by the background message router and by the content-script
// bridge (page-global mirror + scriptlet audit channel).

export function recordScriptletRequest(details) {
    return recordRequest(details, { source: 'scriptlet', verdict: 'direct' });
}

// Record a batch of DOM-annotation ("element") events reported by the in-page
// sink for a given sender (tab/frame/document). Each record is stored in the
// per-tab dataset (so getAuditData exposes it) and appended to the durable WAL
// (so a reader can replay anything the live CDP stream missed).
export function recordAuditElements(ctx, records) {
    if ( Array.isArray(records) === false || records.length === 0 ) { return; }
    let stored = 0;
    for ( const record of records ) {
        if ( record instanceof Object === false ) { continue; }
        record.tabId = ctx.tabId;
        record.frameId = ctx.frameId;
        record.documentId = ctx.documentId;
        if ( store.recordElement(record) === undefined ) { continue; }
        wal.append(record);
        stored += 1;
    }
    if ( stored === 0 ) { return; }
    schedulePersist();
    scheduleWalPersist();
    return { seq: wal.seq };
}

// Read WAL records with seq strictly greater than `sinceSeq`. `oldestSeq` lets a
// reader detect whether the log rolled over past what it last consumed.
export function getAuditWal(sinceSeq = 0) {
    return { seq: wal.seq, oldestSeq: wal.oldestSeq, records: wal.read(sinceSeq) };
}

// Acknowledge consumption up to `uptoSeq`, dropping those records from the WAL.
export function ackAuditWal(uptoSeq) {
    wal.ack(uptoSeq);
    scheduleWalPersist();
    return { seq: wal.seq, oldestSeq: wal.oldestSeq };
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
        // Turning the mode off is a deliberate reset: drop the durable WAL too
        // so it doesn't carry stale records into a later capture session.
        wal.clear();
        scheduleWalPersist();
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
    await restoreWal();
    if ( rulesetConfig.annotationMode && isAnnotationModeAvailable() ) {
        await installPassthroughRule();
        startNetworkCapture();
        if ( rulesetConfig.preciseInitiators ) {
            startPreciseInitiators();
        }
    }
}

/******************************************************************************/
