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

// Unit tests for the pure DNR would-be-block matcher.
// Run with:  npm run test:mv3   (node --test "platform/mv3/tests/**/*.test.js")
//
// These test the matcher's building blocks and end-to-end verdicts on
// hand-written rules. The matcher is *also* validated against Chrome's own
// declarativeNetRequest.testMatchOutcome over thousands of real-rule URLs in
// the e2e oracle suite (.e2e/oracle*.mjs); that cross-check is the primary
// correctness guarantee, these unit tests guard the logic without a browser.

import {
    DNRMatcher,
    domainAndParents,
    isThirdParty,
    reFromUrlFilter,
    registrableDomain,
    tokensFromString,
} from '../extension/js/dnr-matcher.js';
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

/******************************************************************************/

describe('reFromUrlFilter', () => {
    it('domain anchor || matches host and subdomains, any scheme', () => {
        const re = reFromUrlFilter('||example.com^');
        assert.ok(re.test('https://example.com/'));
        assert.ok(re.test('http://foo.example.com/a'));
        assert.ok(re.test('https://example.com'));
        assert.equal(re.test('https://notexample.com/'), false);
        // Must NOT match a look-alike parent (example.com is not a domain
        // boundary of example.com.evil.com); ^ does not match '.'.
        assert.equal(re.test('https://example.com.evil.com/'), false);
    });
    it('separator ^ matches non-alphanumeric or end', () => {
        const re = reFromUrlFilter('||ads.com^');
        assert.ok(re.test('https://ads.com/'));
        assert.ok(re.test('https://ads.com'));
        assert.equal(re.test('https://ads.company/'), false);
    });
    it('wildcard * spans arbitrary characters', () => {
        const re = reFromUrlFilter('||g.doubleclick.net/gpt/*pubads');
        assert.ok(re.test('https://g.doubleclick.net/gpt/abc/pubads'));
        assert.equal(re.test('https://g.doubleclick.net/other'), false);
    });
    it('left/right anchors | constrain URL start/end', () => {
        const re = reFromUrlFilter('|https://a.com/x|');
        assert.ok(re.test('https://a.com/x'));
        assert.equal(re.test('https://a.com/x?y'), false);
        assert.equal(re.test('pre-https://a.com/x'), false);
    });
    it('is case-insensitive by default, case-sensitive when asked', () => {
        assert.ok(reFromUrlFilter('||Example.com^').test('https://example.COM/'));
        assert.equal(
            reFromUrlFilter('/Ads/', true).test('https://x.com/ads/'),
            false
        );
    });
});

/******************************************************************************/

describe('tokensFromString', () => {
    it('extracts lowercased alphanumeric runs >= 3 chars', () => {
        assert.deepEqual(
            tokensFromString('https://G.Doubleclick.net/ad?x=1'),
            [ 'https', 'doubleclick', 'net']
        );
    });
});

describe('domainAndParents', () => {
    it('walks a hostname up to the TLD', () => {
        assert.deepEqual(domainAndParents('a.b.example.com'), [
            'a.b.example.com', 'b.example.com', 'example.com', 'com',
        ]);
    });
    it('handles empty input', () => {
        assert.deepEqual(domainAndParents(''), []);
    });
});

describe('registrableDomain / isThirdParty', () => {
    it('reduces to last two labels', () => {
        assert.equal(registrableDomain('a.b.example.com'), 'example.com');
        assert.equal(registrableDomain('example.com'), 'example.com');
    });
    it('detects third-party by registrable domain', () => {
        assert.equal(isThirdParty('cdn.ads.com', 'example.com'), true);
        assert.equal(isThirdParty('img.example.com', 'www.example.com'), false);
    });
});

/******************************************************************************/

function matcherFrom(rules) {
    const m = new DNRMatcher();
    m.addRuleset(rules, 'test');
    m.finalize();
    return m;
}

describe('DNRMatcher.match — basic block/allow', () => {
    it('blocks a matching urlFilter', () => {
        const m = matcherFrom([
            { id: 1, priority: 10, action: { type: 'block' },
              condition: { urlFilter: '||ads.com^' } },
        ]);
        assert.equal(m.wouldBlock({ url: 'https://ads.com/x.js', type: 'script' }), true);
        assert.equal(m.wouldBlock({ url: 'https://safe.com/x.js', type: 'script' }), false);
    });

    it('honors an allow exception at higher priority', () => {
        const m = matcherFrom([
            { id: 1, priority: 10, action: { type: 'block' },
              condition: { urlFilter: '||ads.com^' } },
            { id: 2, priority: 30, action: { type: 'allow' },
              condition: { urlFilter: '||ads.com/allowed.js' } },
        ]);
        assert.equal(m.wouldBlock({ url: 'https://ads.com/blocked.js', type: 'script' }), true);
        assert.equal(m.wouldBlock({ url: 'https://ads.com/allowed.js', type: 'script' }), false);
        assert.equal(m.match({ url: 'https://ads.com/allowed.js', type: 'script' }).action, 'allow');
    });

    it('treats redirect as would-be-filtered', () => {
        const m = matcherFrom([
            { id: 1, priority: 11, action: { type: 'redirect', redirect: { url: 'x' } },
              condition: { urlFilter: '||track.com/beacon' } },
        ]);
        assert.equal(m.wouldBlock({ url: 'https://track.com/beacon', type: 'ping' }), true);
    });

    it('returns null when nothing matches', () => {
        const m = matcherFrom([
            { id: 1, priority: 10, action: { type: 'block' },
              condition: { urlFilter: '||ads.com^' } },
        ]);
        assert.equal(m.match({ url: 'https://ok.com/', type: 'script' }), null);
    });
});

describe('DNRMatcher.match — condition filters', () => {
    it('respects resourceTypes', () => {
        const m = matcherFrom([
            { id: 1, priority: 10, action: { type: 'block' },
              condition: { urlFilter: '||ads.com^', resourceTypes: [ 'script' ] } },
        ]);
        assert.equal(m.wouldBlock({ url: 'https://ads.com/a', type: 'script' }), true);
        assert.equal(m.wouldBlock({ url: 'https://ads.com/a', type: 'image' }), false);
    });

    it('respects excludedResourceTypes', () => {
        const m = matcherFrom([
            { id: 1, priority: 10, action: { type: 'block' },
              condition: { urlFilter: '||ads.com^', excludedResourceTypes: [ 'image' ] } },
        ]);
        assert.equal(m.wouldBlock({ url: 'https://ads.com/a', type: 'script' }), true);
        assert.equal(m.wouldBlock({ url: 'https://ads.com/a', type: 'image' }), false);
    });

    it('respects requestDomains (domain or subdomain)', () => {
        const m = matcherFrom([
            { id: 1, priority: 10, action: { type: 'block' },
              condition: { requestDomains: [ 'tracker.com' ] } },
        ]);
        assert.equal(m.wouldBlock({ url: 'https://tracker.com/a', type: 'script' }), true);
        assert.equal(m.wouldBlock({ url: 'https://sub.tracker.com/a', type: 'script' }), true);
        assert.equal(m.wouldBlock({ url: 'https://other.com/a', type: 'script' }), false);
    });

    it('respects initiatorDomains', () => {
        const m = matcherFrom([
            { id: 1, priority: 10, action: { type: 'block' },
              condition: { urlFilter: '||ads.com^', initiatorDomains: [ 'publisher.com' ] } },
        ]);
        assert.equal(
            m.wouldBlock({ url: 'https://ads.com/a', type: 'script', initiator: 'https://publisher.com' }),
            true
        );
        assert.equal(
            m.wouldBlock({ url: 'https://ads.com/a', type: 'script', initiator: 'https://other.com' }),
            false
        );
    });

    it('respects domainType third-party', () => {
        const m = matcherFrom([
            { id: 1, priority: 10, action: { type: 'block' },
              condition: { urlFilter: '||ads.com^', domainType: 'thirdParty' } },
        ]);
        assert.equal(
            m.wouldBlock({ url: 'https://ads.com/a', type: 'script', initiator: 'https://publisher.com' }),
            true
        );
        // First-party to ads.com initiator -> not third party -> no match.
        assert.equal(
            m.wouldBlock({ url: 'https://ads.com/a', type: 'script', initiator: 'https://ads.com' }),
            false
        );
    });

    it('respects requestMethods', () => {
        const m = matcherFrom([
            { id: 1, priority: 10, action: { type: 'block' },
              condition: { urlFilter: '||api.com^', requestMethods: [ 'post' ] } },
        ]);
        assert.equal(m.wouldBlock({ url: 'https://api.com/x', type: 'xmlhttprequest', method: 'post' }), true);
        assert.equal(m.wouldBlock({ url: 'https://api.com/x', type: 'xmlhttprequest', method: 'get' }), false);
    });
});

describe('DNRMatcher.match — priority resolution', () => {
    it('higher numeric priority wins regardless of order', () => {
        const m = matcherFrom([
            { id: 1, priority: 10, action: { type: 'block' }, condition: { urlFilter: '||x.com^' } },
            { id: 2, priority: 40, action: { type: 'block' }, condition: { urlFilter: '||x.com/important' } },
            { id: 3, priority: 30, action: { type: 'allow' }, condition: { urlFilter: '||x.com/important' } },
        ]);
        // priority 40 block beats priority 30 allow.
        const r = m.match({ url: 'https://x.com/important', type: 'script' });
        assert.equal(r.action, 'block');
        assert.equal(r.priority, 40);
    });

    it('at equal priority, allow beats block', () => {
        const m = matcherFrom([
            { id: 1, priority: 20, action: { type: 'block' }, condition: { urlFilter: '||y.com^' } },
            { id: 2, priority: 20, action: { type: 'allow' }, condition: { urlFilter: '||y.com^' } },
        ]);
        assert.equal(m.match({ url: 'https://y.com/a', type: 'script' }).action, 'allow');
    });
});

describe('DNRMatcher indexing', () => {
    it('auto-finalizes on first match and indexes by rarest token', () => {
        const m = new DNRMatcher();
        m.addRuleset([
            { id: 1, priority: 10, action: { type: 'block' },
              condition: { urlFilter: '||ads.example.com^' } },
        ], 'test');
        // No explicit finalize(): match() should trigger it.
        assert.equal(m.wouldBlock({ url: 'https://ads.example.com/x', type: 'script' }), true);
        assert.equal(m.finalized, true);
    });
});

describe('DNRMatcher — regexFilter rules', () => {
    it('matches a regexFilter block rule', () => {
        const m = matcherFrom([
            { id: 1, priority: 10, action: { type: 'block' },
              condition: { regexFilter: '^https?://ads\\.[a-z]+/track' } },
        ]);
        assert.equal(m.wouldBlock({ url: 'https://ads.com/track', type: 'script' }), true);
        assert.equal(m.wouldBlock({ url: 'https://safe.com/track', type: 'script' }), false);
    });

    it('honors isUrlFilterCaseSensitive for regexFilter', () => {
        const ci = matcherFrom([
            { id: 1, priority: 10, action: { type: 'block' },
              condition: { regexFilter: 'ADS' } },
        ]);
        assert.equal(ci.wouldBlock({ url: 'https://x.com/ads', type: 'script' }), true);
        const cs = matcherFrom([
            { id: 1, priority: 10, action: { type: 'block' },
              condition: { regexFilter: 'ADS', isUrlFilterCaseSensitive: true } },
        ]);
        assert.equal(cs.wouldBlock({ url: 'https://x.com/ads', type: 'script' }), false);
        assert.equal(cs.wouldBlock({ url: 'https://x.com/ADS', type: 'script' }), true);
    });

    it('does NOT false-negative when a literal fuses with a quantifier ' +
       '(serch\\d{2}.biz -> serch77.biz); regex rules are domain-indexed', () => {
        // Reproduces the real bug: token-indexing "serch" would miss "serch77".
        const m = matcherFrom([
            { id: 1, priority: 29, action: { type: 'redirect', redirect: { url: 'x' } },
              condition: {
                  regexFilter: '^https://serch\\d{2}\\.biz/\\?p=.*',
                  resourceTypes: [ 'main_frame' ],
                  requestDomains: [ 'biz' ],
              } },
        ]);
        assert.equal(m.wouldBlock({ url: 'https://serch77.biz/?p=a', type: 'main_frame' }), true);
        assert.equal(m.wouldBlock({ url: 'https://serch7.biz/?p=a', type: 'main_frame' }), false);
    });

    it('skips a regexFilter that is not a valid JS RegExp (no throw)', () => {
        const m = matcherFrom([
            { id: 1, priority: 10, action: { type: 'block' },
              condition: { regexFilter: '(' } },   // invalid
        ]);
        assert.equal(m.ruleCount, 0);
        assert.equal(m.match({ url: 'https://x.com/', type: 'script' }), null);
    });
});
