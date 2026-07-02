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

// Unit tests for the pure annotation (audit) mode data layer.
// Run with:  node --test platform/mv3/tests/
//
// These cover the browser-free logic in
// platform/mv3/extension/js/annotation-store.js: request recording and
// deduplication, direct-vs-derived precedence, coarse frame-lineage
// attribution, would-block URL extraction, reset, snapshot/restore round-trip,
// and the CDP initiator-chain helpers. The browser-wired pieces
// (DNR/webRequest/CDP listeners, session persistence, messaging) are covered
// by manual QA — see platform/mv3/tests/ANNOTATION_MANUAL_QA.md.

import {
    AuditStore,
    chainTracesToWouldBlock,
    requestKey,
    scriptUrlsFromStack,
} from '../extension/js/annotation-store.js';
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

/******************************************************************************/

describe('requestKey', () => {
    it('combines requestId, url and type', () => {
        assert.equal(
            requestKey({ requestId: '7', url: 'https://a/x.js', type: 'script' }),
            '7|https://a/x.js|script'
        );
    });
    it('tolerates missing requestId and type', () => {
        assert.equal(requestKey({ url: 'https://a/x' }), '|https://a/x|');
    });
    it('distinguishes different types on the same url', () => {
        const a = requestKey({ url: 'https://a/x', type: 'image' });
        const b = requestKey({ url: 'https://a/x', type: 'script' });
        assert.notEqual(a, b);
    });
});

/******************************************************************************/

describe('AuditStore.record', () => {
    it('records a direct hit with defaults filled in', () => {
        const store = new AuditStore();
        const rec = store.record(
            { tabId: 1, url: 'https://ads/a.js', type: 'script', requestId: '1' },
            { source: 'dnr', verdict: 'direct', matchedRule: { rulesetId: 'r', ruleId: 5 } }
        );
        assert.equal(rec.tabId, 1);
        assert.equal(rec.url, 'https://ads/a.js');
        assert.equal(rec.verdict, 'direct');
        assert.equal(rec.source, 'dnr');
        assert.deepEqual(rec.matchedRule, { rulesetId: 'r', ruleId: 5 });
        assert.equal(rec.frameId, -1);
        assert.equal(rec.initiatorChain, null);
        assert.equal(typeof rec.timeStamp, 'number');
        assert.equal(store.getAuditData(1).requests.length, 1);
    });

    it('ignores requests with an invalid tabId', () => {
        const store = new AuditStore();
        assert.equal(store.record({ tabId: -1, url: 'x' }), undefined);
        assert.equal(store.record({ url: 'x' }), undefined);
        assert.equal(store.byTab.size, 0);
    });

    it('does NOT let a derived verdict overwrite an existing direct hit', () => {
        const store = new AuditStore();
        const details = { tabId: 1, url: 'https://ads/a.js', type: 'script', requestId: '1' };
        store.record(details, { verdict: 'direct' });
        const second = store.record(details, { verdict: 'derived' });
        assert.equal(second, undefined);
        const [ rec ] = store.getAuditData(1).requests;
        assert.equal(rec.verdict, 'direct');
    });

    it('lets a direct verdict upgrade a previously derived hit', () => {
        const store = new AuditStore();
        const details = { tabId: 1, url: 'https://ads/a.js', type: 'script', requestId: '1' };
        store.record(details, { verdict: 'derived' });
        store.record(details, { verdict: 'direct' });
        const requests = store.getAuditData(1).requests;
        assert.equal(requests.length, 1);
        assert.equal(requests[0].verdict, 'direct');
    });

    it('keeps requests on different tabs separate', () => {
        const store = new AuditStore();
        store.record({ tabId: 1, url: 'https://a/1', requestId: '1' });
        store.record({ tabId: 2, url: 'https://a/2', requestId: '2' });
        assert.equal(store.getAuditData(1).requests.length, 1);
        assert.equal(store.getAuditData(2).requests.length, 1);
    });
});

/******************************************************************************/

describe('AuditStore.markWouldBlock', () => {
    it('marks the frame and document of a would-block sub_frame', () => {
        const store = new AuditStore();
        store.markWouldBlock({
            tabId: 1, type: 'sub_frame', frameId: 3,
            documentId: 'doc-3', url: 'https://ads/frame.html',
        });
        const entry = store.tabEntry(1);
        assert.ok(entry.wouldBlockFrames.has(3));
        assert.deepEqual(entry.docs.get('doc-3'), {
            url: 'https://ads/frame.html',
            parentDocumentId: '',
            frameId: 3,
            wouldBlock: true,
        });
    });

    it('ignores non-frame request types', () => {
        const store = new AuditStore();
        store.markWouldBlock({ tabId: 1, type: 'script', frameId: 3 });
        assert.equal(store.byTab.size, 0);
    });
});

/******************************************************************************/

describe('AuditStore.noteFrameLineage (coarse derivation)', () => {
    it('flags a request inside a would-block frame as derived', () => {
        const store = new AuditStore();
        store.markWouldBlock({ tabId: 1, type: 'sub_frame', frameId: 3, documentId: 'd3', url: 'u' });
        const derived = store.noteFrameLineage({
            tabId: 1, frameId: 3, parentFrameId: 0, type: 'image',
        });
        assert.equal(derived, true);
    });

    it('does not flag requests in a normal frame', () => {
        const store = new AuditStore();
        const derived = store.noteFrameLineage({
            tabId: 1, frameId: 0, parentFrameId: -1, type: 'image',
        });
        assert.equal(derived, false);
    });

    it('propagates would-block into nested sub-frames', () => {
        const store = new AuditStore();
        store.markWouldBlock({ tabId: 1, type: 'sub_frame', frameId: 3, documentId: 'd3', url: 'u' });
        // A sub_frame nested under would-block frame 3 becomes would-block too.
        const nestedIsDerived = store.noteFrameLineage({
            tabId: 1, frameId: 9, parentFrameId: 3, type: 'sub_frame',
        });
        assert.equal(nestedIsDerived, true);
        // Now a resource inside the nested frame 9 is also derived.
        const resourceDerived = store.noteFrameLineage({
            tabId: 1, frameId: 9, parentFrameId: 3, type: 'script',
        });
        assert.equal(resourceDerived, true);
    });

    it('returns false for an invalid tabId', () => {
        const store = new AuditStore();
        assert.equal(store.noteFrameLineage({ tabId: -1, frameId: 0 }), false);
    });
});

/******************************************************************************/

describe('AuditStore.getWouldBlockUrls', () => {
    it('returns only the URLs of direct hits', () => {
        const store = new AuditStore();
        store.record({ tabId: 1, url: 'https://ads/a.js', requestId: '1' }, { verdict: 'direct' });
        store.record({ tabId: 1, url: 'https://ads/b.js', requestId: '2' }, { verdict: 'derived' });
        const urls = store.getWouldBlockUrls(1);
        assert.ok(urls.has('https://ads/a.js'));
        assert.equal(urls.has('https://ads/b.js'), false);
    });
    it('returns an empty set for an unknown tab', () => {
        const store = new AuditStore();
        assert.equal(store.getWouldBlockUrls(99).size, 0);
    });
});

/******************************************************************************/

describe('AuditStore.reset', () => {
    it('clears a single tab', () => {
        const store = new AuditStore();
        store.record({ tabId: 1, url: 'x', requestId: '1' });
        store.record({ tabId: 2, url: 'y', requestId: '2' });
        store.reset(1);
        assert.equal(store.getAuditData(1).requests.length, 0);
        assert.equal(store.getAuditData(2).requests.length, 1);
    });
    it('clears everything when no tabId is given', () => {
        const store = new AuditStore();
        store.record({ tabId: 1, url: 'x', requestId: '1' });
        store.record({ tabId: 2, url: 'y', requestId: '2' });
        store.reset();
        assert.equal(store.byTab.size, 0);
    });
});

/******************************************************************************/

describe('AuditStore snapshot/restore round-trip', () => {
    it('preserves requests, docs and would-block frames', () => {
        const store = new AuditStore();
        store.record(
            { tabId: 5, url: 'https://ads/a.js', type: 'script', requestId: '1' },
            { verdict: 'direct', matchedRule: { rulesetId: 'r', ruleId: 1 } }
        );
        store.markWouldBlock({ tabId: 5, type: 'sub_frame', frameId: 2, documentId: 'd2', url: 'f' });
        store.noteFrameLineage({ tabId: 5, frameId: 2, parentFrameId: 0, type: 'image' });
        store.record(
            { tabId: 5, url: 'https://ads/derived.png', type: 'image', requestId: '2' },
            { verdict: 'derived' }
        );

        // Serialize -> JSON round-trip (as session storage would) -> restore.
        const snapshot = JSON.parse(JSON.stringify(store.snapshot()));
        const restored = new AuditStore();
        restored.restore(snapshot);

        assert.deepEqual(
            restored.getAuditData(5).requests.map(r => r.url).sort(),
            [ 'https://ads/a.js', 'https://ads/derived.png' ]
        );
        assert.ok(restored.getWouldBlockUrls(5).has('https://ads/a.js'));
        // Frame lineage survived: a new resource in frame 2 is still derived.
        assert.equal(
            restored.noteFrameLineage({ tabId: 5, frameId: 2, parentFrameId: 0, type: 'script' }),
            true
        );
    });

    it('tolerates a missing/invalid payload', () => {
        const store = new AuditStore();
        store.restore(undefined);
        store.restore(null);
        assert.equal(store.byTab.size, 0);
    });
});

/******************************************************************************/

describe('scriptUrlsFromStack', () => {
    it('flattens callFrames across the parent chain, in order', () => {
        const stack = {
            callFrames: [ { url: 'https://a/b.js' }, { url: 'https://a/a.js' } ],
            parent: {
                callFrames: [ { url: 'https://a/root.js' } ],
            },
        };
        assert.deepEqual(scriptUrlsFromStack(stack), [
            'https://a/b.js', 'https://a/a.js', 'https://a/root.js',
        ]);
    });
    it('skips frames without a url and handles no stack', () => {
        assert.deepEqual(scriptUrlsFromStack(undefined), []);
        assert.deepEqual(
            scriptUrlsFromStack({ callFrames: [ { url: '' }, { url: 'https://a/x.js' } ] }),
            [ 'https://a/x.js' ]
        );
    });
});

/******************************************************************************/

describe('chainTracesToWouldBlock', () => {
    it('is true when any chain url is would-block', () => {
        const wb = new Set([ 'https://ads/a.js' ]);
        assert.equal(chainTracesToWouldBlock([ 'https://x/y.js', 'https://ads/a.js' ], wb), true);
    });
    it('is false when the chain does not intersect', () => {
        const wb = new Set([ 'https://ads/a.js' ]);
        assert.equal(chainTracesToWouldBlock([ 'https://x/y.js' ], wb), false);
    });
    it('is false for an empty would-block set or a non-array chain', () => {
        assert.equal(chainTracesToWouldBlock([ 'a' ], new Set()), false);
        assert.equal(chainTracesToWouldBlock('a', new Set([ 'a' ])), false);
        assert.equal(chainTracesToWouldBlock([ 'a' ], null), false);
    });
});

/******************************************************************************/

describe('AuditStore.recordElement', () => {
    it('stores element records and returns them from getAuditData', () => {
        const store = new AuditStore();
        store.recordElement({ tabId: 1, uid: 'f:1', event: 'tag', tag: 'div' });
        store.recordElement({ tabId: 1, uid: 'f:2', event: 'tag', tag: 'span' });
        const data = store.getAuditData(1);
        assert.equal(data.elements.length, 2);
        assert.deepEqual(data.elements.map(e => e.uid), [ 'f:1', 'f:2' ]);
    });
    it('dedups by uid; a repeat tag does not overwrite', () => {
        const store = new AuditStore();
        store.recordElement({ tabId: 1, uid: 'f:1', event: 'tag', tag: 'div' });
        store.recordElement({ tabId: 1, uid: 'f:1', event: 'tag', tag: 'CHANGED' });
        assert.equal(store.getAuditData(1).elements[0].tag, 'div');
    });
    it('a remove event upgrades an existing uid', () => {
        const store = new AuditStore();
        store.recordElement({ tabId: 1, uid: 'f:1', event: 'tag', tag: 'div' });
        store.recordElement({ tabId: 1, uid: 'f:1', event: 'remove', tag: 'div', outerHTMLHead: '<div>' });
        const rec = store.getAuditData(1).elements[0];
        assert.equal(rec.event, 'remove');
        assert.equal(rec.outerHTMLHead, '<div>');
    });
    it('ignores records with an invalid tabId or uid', () => {
        const store = new AuditStore();
        store.recordElement({ tabId: -1, uid: 'f:1' });
        store.recordElement({ tabId: 1 });
        store.recordElement({ uid: 'f:1' });
        assert.equal(store.getAuditData(1).elements.length, 0);
    });
    it('is included in snapshot/restore round-trip', () => {
        const store = new AuditStore();
        store.recordElement({ tabId: 5, uid: 'f:1', event: 'tag', tag: 'div' });
        const restored = new AuditStore();
        restored.restore(JSON.parse(JSON.stringify(store.snapshot())));
        assert.deepEqual(restored.getAuditData(5).elements.map(e => e.uid), [ 'f:1' ]);
    });
    it('reset clears element records for a tab', () => {
        const store = new AuditStore();
        store.recordElement({ tabId: 1, uid: 'f:1' });
        store.reset(1);
        assert.equal(store.getAuditData(1).elements.length, 0);
    });
});
