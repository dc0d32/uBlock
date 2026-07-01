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

// Annotation (audit) mode — pure data layer.
//
// This module holds the per-tab audit dataset and all of its transformation
// logic with NO dependency on any browser/extension API, so it can be unit
// tested in plain Node (see platform/mv3/tests/annotation-store.test.js).
// The browser wiring (DNR/webRequest/CDP listeners, session persistence,
// content-script messaging) lives in annotation.js and annotation-cdp.js and
// delegates all bookkeeping to the AuditStore defined here.

/******************************************************************************/

// A stable-enough key for a request. `requestId` disambiguates otherwise
// identical URLs; url+type keep records distinct when requestId is absent
// (e.g. scriptlet-reported requests).
export function requestKey(details) {
    return `${details.requestId ?? ''}|${details.url}|${details.type ?? ''}`;
}

/******************************************************************************/

// NetworkRecord = {
//   tabId, frameId, documentId, parentDocumentId,
//   url, type, initiator,
//   source: 'dnr' | 'scriptlet',
//   verdict: 'direct' | 'derived',
//   matchedRule: { rulesetId, ruleId } | null,
//   initiatorChain: string[] | null,
//   timeStamp,
// }

export class AuditStore {
    constructor() {
        // Map<tabId, {
        //   requests: Map<requestKey, NetworkRecord>,
        //   docs: Map<documentId, { url, parentDocumentId, frameId, wouldBlock }>,
        //   wouldBlockFrames: Set<frameId>,
        // }>
        this.byTab = new Map();
    }

    newTabEntry() {
        return {
            requests: new Map(),
            docs: new Map(),
            wouldBlockFrames: new Set(),
        };
    }

    tabEntry(tabId, create = false) {
        let entry = this.byTab.get(tabId);
        if ( entry === undefined && create ) {
            entry = this.newTabEntry();
            this.byTab.set(tabId, entry);
        }
        return entry;
    }

    // Record a would-be-blocked request. Returns the stored record, or
    // undefined when nothing was recorded (invalid tabId, or a weaker 'derived'
    // verdict that must not overwrite an existing 'direct' hit).
    record(details, {
        source = 'dnr',
        verdict = 'direct',
        matchedRule = null,
        initiatorChain = null,
    } = {}) {
        const tabId = details.tabId;
        if ( typeof tabId !== 'number' || tabId < 0 ) { return; }
        const entry = this.tabEntry(tabId, true);
        const key = requestKey(details);
        const existing = entry.requests.get(key);
        // A direct verdict always wins over a previously-recorded derived one.
        if ( existing && existing.verdict === 'direct' && verdict !== 'direct' ) {
            return;
        }
        const record = {
            tabId,
            frameId: details.frameId ?? -1,
            documentId: details.documentId ?? '',
            parentDocumentId: details.parentDocumentId ?? '',
            url: details.url,
            type: details.type ?? '',
            initiator: details.initiator ?? '',
            source,
            verdict,
            matchedRule,
            initiatorChain,
            timeStamp: details.timeStamp ?? Date.now(),
        };
        entry.requests.set(key, record);
        return record;
    }

    // Mark the frame/document of a would-be-blocked navigation so that requests
    // inside it can later be attributed as derived (coarse frame lineage).
    markWouldBlock(request) {
        if ( request.type !== 'sub_frame' && request.type !== 'main_frame' ) {
            return;
        }
        const entry = this.tabEntry(request.tabId, true);
        if ( entry === undefined ) { return; }
        if ( typeof request.frameId === 'number' ) {
            entry.wouldBlockFrames.add(request.frameId);
        }
        if ( request.documentId ) {
            entry.docs.set(request.documentId, {
                url: request.url,
                parentDocumentId: request.parentDocumentId ?? '',
                frameId: request.frameId ?? -1,
                wouldBlock: true,
            });
        }
    }

    // Update frame lineage for an observed request and report whether it should
    // be recorded as a derived would-be-blocked resource (i.e. it lives in a
    // would-block frame). Also propagates would-block status into nested frames.
    noteFrameLineage(details) {
        const { tabId, frameId, parentFrameId, type } = details;
        if ( typeof tabId !== 'number' || tabId < 0 ) { return false; }
        const entry = this.tabEntry(tabId, true);
        if ( type === 'sub_frame' && entry.wouldBlockFrames.has(parentFrameId) ) {
            entry.wouldBlockFrames.add(frameId);
        }
        return entry.wouldBlockFrames.has(frameId);
    }

    getAuditData(tabId) {
        const entry = this.byTab.get(tabId);
        if ( entry === undefined ) {
            return { requests: [], docs: [] };
        }
        return {
            requests: Array.from(entry.requests.values()),
            docs: Array.from(entry.docs.entries()),
        };
    }

    // URLs directly would-be-blocked in a tab; used by the precise CDP path to
    // decide whether a request's initiator chain traces back to a blocked one.
    getWouldBlockUrls(tabId) {
        const urls = new Set();
        const entry = this.byTab.get(tabId);
        if ( entry === undefined ) { return urls; }
        for ( const rec of entry.requests.values() ) {
            if ( rec.verdict === 'direct' ) { urls.add(rec.url); }
        }
        return urls;
    }

    reset(tabId) {
        if ( tabId === undefined ) {
            this.byTab.clear();
        } else {
            this.byTab.delete(tabId);
        }
    }

    // Serialize to a structured-clone-friendly object for session storage.
    snapshot() {
        const out = {};
        for ( const [ tabId, entry ] of this.byTab ) {
            out[tabId] = {
                requests: Array.from(entry.requests.values()),
                docs: Array.from(entry.docs.entries()),
                wouldBlockFrames: Array.from(entry.wouldBlockFrames),
            };
        }
        return out;
    }

    // Rebuild from a snapshot() payload (e.g. after a service-worker restart).
    restore(data) {
        if ( data instanceof Object === false ) { return; }
        for ( const [ tabId, snapshot ] of Object.entries(data) ) {
            const entry = this.newTabEntry();
            for ( const rec of snapshot.requests || [] ) {
                entry.requests.set(requestKey(rec), rec);
            }
            for ( const [ id, doc ] of snapshot.docs || [] ) {
                entry.docs.set(id, doc);
            }
            for ( const frameId of snapshot.wouldBlockFrames || [] ) {
                entry.wouldBlockFrames.add(frameId);
            }
            this.byTab.set(parseInt(tabId, 10), entry);
        }
    }
}

/******************************************************************************/

// CDP helpers (pure): flatten a CDP `Runtime.StackTrace` into the list of
// script URLs in the initiator chain, and decide whether that chain traces
// back to a would-be-blocked URL.

export function scriptUrlsFromStack(stack) {
    const urls = [];
    let frame = stack;
    while ( frame instanceof Object ) {
        for ( const callFrame of frame.callFrames || [] ) {
            if ( callFrame.url ) { urls.push(callFrame.url); }
        }
        frame = frame.parent;
    }
    return urls;
}

export function chainTracesToWouldBlock(chain, wouldBlockUrls) {
    if ( Array.isArray(chain) === false ) { return false; }
    if ( wouldBlockUrls instanceof Set === false ) { return false; }
    if ( wouldBlockUrls.size === 0 ) { return false; }
    return chain.some(url => wouldBlockUrls.has(url));
}
