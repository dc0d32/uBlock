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

// Pure, browser-free DNR "would-be-blocked" matcher.
//
// Annotation (audit) mode disables uBOL's DNR *enforcement* so pages load
// unblocked; this module re-computes, in JS, what the DNR engine *would* have
// decided for a given request by evaluating the same static ruleset JSON that
// ships in the extension. It is deliberately dependency-free so it can be unit
// tested in Node and validated against Chrome's own `testMatchOutcome` (used as
// an oracle in the e2e suite).
//
// Scope (verified against all 57 shipped rulesets, 69.5k rules):
//   - conditions: urlFilter (no regexFilter anywhere), resourceTypes /
//     excludedResourceTypes, requestDomains / excludedRequestDomains,
//     initiatorDomains / excludedInitiatorDomains, domainType, requestMethods.
//   - actions: block, allow, redirect, modifyHeaders (allowAllRequests unused).
//   - priority resolution: highest numeric priority wins; on a tie, allow beats
//     block beats redirect (mirrors Chrome's documented algorithm). Default
//     priority is 1 when unspecified.

/******************************************************************************/

// Translate a DNR `urlFilter` mini-pattern into a RegExp.
//
//   *   wildcard            -> .*
//   ^   separator           -> [^a-z0-9._%-] or end-of-url
//   |   at start/end        -> URL start/end anchor
//   ||  at start            -> (sub)domain anchor
//
// The URL is matched with the fragment removed; matching is case-insensitive
// unless `isCaseSensitive`.
export function reFromUrlFilter(urlFilter, isCaseSensitive = false) {
    let src = urlFilter;
    let anchorStart = false;
    let domainAnchor = false;
    let anchorEnd = false;

    if ( src.startsWith('||') ) {
        domainAnchor = true;
        src = src.slice(2);
    } else if ( src.startsWith('|') ) {
        anchorStart = true;
        src = src.slice(1);
    }
    if ( src.endsWith('|') ) {
        anchorEnd = true;
        src = src.slice(0, -1);
    }

    const sepClass = '[^a-z0-9._%-]';
    let out = '';
    for ( const ch of src ) {
        if ( ch === '*' ) {
            out += '.*';
        } else if ( ch === '^' ) {
            // Separator: a non-alphanumeric-ish char, or end of URL.
            out += `(?:${sepClass}|$)`;
        } else {
            out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
    }

    let prefix = '';
    if ( domainAnchor ) {
        // Start of a (sub-)domain: optional scheme, "//", then optional
        // subdomain labels ending with a dot, right before the literal.
        prefix = '^(?:[a-z][a-z0-9+.-]*:)?//(?:[^/?#]*\\.)?';
    } else if ( anchorStart ) {
        prefix = '^';
    }
    let suffix = '';
    if ( anchorEnd ) { suffix = '$'; }

    const flags = isCaseSensitive ? '' : 'i';
    return new RegExp(prefix + out + suffix, flags);
}

/******************************************************************************/

// Extract the eTLD+1-ish hostname labels for domain-list matching. DNR
// `requestDomains`/`initiatorDomains` match a domain or any of its subdomains.
function hostnameMatchesDomainList(hostname, domains) {
    if ( Array.isArray(domains) === false || domains.length === 0 ) { return false; }
    for ( const d of domains ) {
        if ( hostname === d ) { return true; }
        if ( hostname.endsWith(`.${d}`) ) { return true; }
    }
    return false;
}

function hostnameFromUrl(url) {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return '';
    }
}

/******************************************************************************/

// Tokenize a string into lowercased alphanumeric runs of length >= 3, used for
// the inverted index. Mirrors the well-known adblocker tokenization approach.
const reToken = /[a-z0-9%]{3,}/g;

export function tokensFromString(s) {
    const tokens = [];
    const lower = s.toLowerCase();
    let m;
    reToken.lastIndex = 0;
    while ( (m = reToken.exec(lower)) !== null ) {
        tokens.push(m[0]);
    }
    return tokens;
}

// Choose a single indexing token for a rule from its urlFilter: the longest
// alphanumeric run (most selective). Returns '' when none (rule goes to the
// untokenizable bucket, scanned for every request).
export function indexTokenFromUrlFilter(urlFilter) {
    if ( typeof urlFilter !== 'string' || urlFilter === '' ) { return ''; }
    let best = '';
    let m;
    reToken.lastIndex = 0;
    while ( (m = reToken.exec(urlFilter.toLowerCase())) !== null ) {
        if ( m[0].length > best.length ) { best = m[0]; }
    }
    return best;
}

/******************************************************************************/

// Default priority when a rule omits it (Chrome DNR default is 1).
const DEFAULT_PRIORITY = 1;

// Action precedence for tie-breaking at equal priority (higher wins).
const ACTION_RANK = {
    allowAllRequests: 4,
    allow: 3,
    block: 2,
    upgradeScheme: 1,
    redirect: 0,
    modifyHeaders: -1,
};

function ruleBeats(a, b) {
    const pa = a.priority ?? DEFAULT_PRIORITY;
    const pb = b.priority ?? DEFAULT_PRIORITY;
    if ( pa !== pb ) { return pa > pb; }
    return (ACTION_RANK[a.action.type] ?? -1) > (ACTION_RANK[b.action.type] ?? -1);
}

/******************************************************************************/

export class DNRMatcher {
    constructor() {
        this.tokenIndex = new Map();        // url token -> compiled rule[]
        this.reqDomainIndex = new Map();    // request domain -> compiled rule[]
        this.initDomainIndex = new Map();   // initiator domain -> compiled rule[]
        this.generic = [];                  // rules with no usable index key
        this.ruleCount = 0;
        this.compiledRules = [];            // all compiled rules, pre-index
        this.tokenFreq = new Map();         // token -> occurrence count
        this.finalized = false;
    }

    // Compile a single DNR rule into the fast-match form, or null to skip
    // (rules we don't model, e.g. those with regexFilter — none ship today).
    static compileRule(rule, rulesetId) {
        const c = rule.condition || {};
        if ( c.regexFilter ) { return null; }
        const compiled = {
            rulesetId,
            ruleId: rule.id,
            priority: rule.priority ?? DEFAULT_PRIORITY,
            action: rule.action,
            re: c.urlFilter ? reFromUrlFilter(c.urlFilter, c.isUrlFilterCaseSensitive === true) : null,
            urlFilter: c.urlFilter || '',
            urlTokens: c.urlFilter ? tokensFromString(c.urlFilter) : [],
            resourceTypes: c.resourceTypes || null,
            excludedResourceTypes: c.excludedResourceTypes || null,
            requestDomains: c.requestDomains || null,
            excludedRequestDomains: c.excludedRequestDomains || null,
            initiatorDomains: c.initiatorDomains || null,
            excludedInitiatorDomains: c.excludedInitiatorDomains || null,
            domainType: c.domainType || null,
            requestMethods: c.requestMethods || null,
            excludedRequestMethods: c.excludedRequestMethods || null,
        };
        return compiled;
    }

    // Stage 1: collect compiled rules and build the token-frequency histogram.
    addRule(rule, rulesetId) {
        const compiled = DNRMatcher.compileRule(rule, rulesetId);
        if ( compiled === null ) { return; }
        this.ruleCount += 1;
        this.compiledRules.push(compiled);
        for ( const t of compiled.urlTokens ) {
            this.tokenFreq.set(t, (this.tokenFreq.get(t) || 0) + 1);
        }
    }

    addRuleset(rules, rulesetId) {
        for ( const rule of rules ) {
            this.addRule(rule, rulesetId);
        }
    }

    // Stage 2: index each rule by its most selective dimension so match time
    // examines few candidates:
    //   1. rarest urlFilter token, else
    //   2. requestDomains (bucket per domain), else
    //   3. initiatorDomains (bucket per domain), else
    //   4. a small generic bucket scanned for every request.
    // Idempotent; auto-invoked on first match.
    finalize() {
        if ( this.finalized ) { return; }
        const addTo = (map, key, rule) => {
            let bucket = map.get(key);
            if ( bucket === undefined ) { bucket = []; map.set(key, bucket); }
            bucket.push(rule);
        };
        for ( const compiled of this.compiledRules ) {
            const token = this.rarestToken(compiled.urlTokens);
            if ( token !== '' ) {
                addTo(this.tokenIndex, token, compiled);
            } else if ( compiled.requestDomains ) {
                for ( const d of compiled.requestDomains ) {
                    addTo(this.reqDomainIndex, d, compiled);
                }
            } else if ( compiled.initiatorDomains ) {
                for ( const d of compiled.initiatorDomains ) {
                    addTo(this.initDomainIndex, d, compiled);
                }
            } else {
                this.generic.push(compiled);
            }
        }
        this.finalized = true;
    }

    // Pick the least frequent (most selective) token from a rule's token list.
    rarestToken(tokens) {
        let best = '';
        let bestFreq = Infinity;
        for ( const t of tokens ) {
            const f = this.tokenFreq.get(t) || 0;
            if ( f < bestFreq ) { bestFreq = f; best = t; }
        }
        return best;
    }

    // Does a compiled rule match this request's non-url conditions?
    static conditionsMatch(rule, req) {
        if ( rule.resourceTypes && rule.resourceTypes.includes(req.type) === false ) {
            return false;
        }
        if ( rule.excludedResourceTypes && rule.excludedResourceTypes.includes(req.type) ) {
            return false;
        }
        if ( rule.requestMethods ) {
            const method = (req.method || 'get').toLowerCase();
            if ( rule.requestMethods.includes(method) === false ) { return false; }
        }
        if ( rule.excludedRequestMethods ) {
            const method = (req.method || 'get').toLowerCase();
            if ( rule.excludedRequestMethods.includes(method) ) { return false; }
        }
        if ( rule.requestDomains &&
            hostnameMatchesDomainList(req.hostname, rule.requestDomains) === false ) {
            return false;
        }
        if ( rule.excludedRequestDomains &&
            hostnameMatchesDomainList(req.hostname, rule.excludedRequestDomains) ) {
            return false;
        }
        if ( rule.initiatorDomains &&
            hostnameMatchesDomainList(req.initiatorHostname, rule.initiatorDomains) === false ) {
            return false;
        }
        if ( rule.excludedInitiatorDomains &&
            hostnameMatchesDomainList(req.initiatorHostname, rule.excludedInitiatorDomains) ) {
            return false;
        }
        if ( rule.domainType ) {
            const dt = req.thirdParty ? 'thirdParty' : 'firstParty';
            if ( rule.domainType !== dt ) { return false; }
        }
        if ( rule.re && rule.re.test(req.url) === false ) {
            return false;
        }
        return true;
    }

    // Candidate rules for a request: from token buckets keyed by URL tokens,
    // plus the untokenized bucket.
    candidates(req) {
        if ( this.finalized === false ) { this.finalize(); }
        const seen = new Set();
        const out = [];
        const push = rules => {
            if ( rules === undefined ) { return; }
            for ( const r of rules ) {
                if ( seen.has(r) ) { continue; }
                seen.add(r);
                out.push(r);
            }
        };
        // URL-token buckets.
        for ( const token of tokensFromString(req.url) ) {
            push(this.tokenIndex.get(token));
        }
        // Request-domain buckets: request hostname and each parent domain.
        for ( const d of domainAndParents(req.hostname) ) {
            push(this.reqDomainIndex.get(d));
        }
        // Initiator-domain buckets: initiator hostname and each parent domain.
        for ( const d of domainAndParents(req.initiatorHostname) ) {
            push(this.initDomainIndex.get(d));
        }
        push(this.generic);
        return out;
    }

    // Evaluate a request. `req` = { url, type, method?, initiator?, tabId? }.
    // Returns the winning rule's summary, or null when nothing matches.
    //   { action, priority, rulesetId, ruleId }
    match(req) {
        const norm = {
            url: req.url,
            type: req.type || 'other',
            method: req.method,
            hostname: hostnameFromUrl(req.url),
            initiatorHostname: req.initiator ? hostnameFromUrl(req.initiator) : '',
            thirdParty: undefined,
        };
        // domainType: first vs third party relative to the initiator.
        if ( norm.initiatorHostname ) {
            norm.thirdParty = isThirdParty(norm.hostname, norm.initiatorHostname);
        } else {
            norm.thirdParty = false;
        }

        let winner = null;
        for ( const rule of this.candidates(norm) ) {
            if ( DNRMatcher.conditionsMatch(rule, norm) === false ) { continue; }
            if ( winner === null || ruleBeats(rule, winner) ) {
                winner = rule;
            }
        }
        if ( winner === null ) { return null; }
        return {
            action: winner.action.type,
            priority: winner.priority,
            rulesetId: winner.rulesetId,
            ruleId: winner.ruleId,
        };
    }

    // Convenience: would this request be blocked/redirected (i.e. filtered)?
    wouldBlock(req) {
        const r = this.match(req);
        if ( r === null ) { return false; }
        return r.action === 'block' || r.action === 'redirect';
    }
}

/******************************************************************************/

// Third-party test: request host is third party to the initiator when their
// registrable domains differ. We approximate the registrable domain with the
// last two labels, which is adequate for audit purposes (uBOL's own DNR data is
// compiled with the same eTLD+1 assumption for the common case).
export function registrableDomain(hostname) {
    if ( !hostname ) { return ''; }
    const parts = hostname.split('.');
    if ( parts.length <= 2 ) { return hostname; }
    return parts.slice(-2).join('.');
}

export function isThirdParty(hostname, initiatorHostname) {
    if ( !hostname || !initiatorHostname ) { return false; }
    return registrableDomain(hostname) !== registrableDomain(initiatorHostname);
}

// Yield a hostname and each of its parent domains, e.g.
// a.b.example.com -> a.b.example.com, b.example.com, example.com, com.
// Used to look up domain-indexed rules (which match a domain or subdomain).
export function domainAndParents(hostname) {
    const out = [];
    if ( !hostname ) { return out; }
    let h = hostname;
    out.push(h);
    for ( ;; ) {
        const pos = h.indexOf('.');
        if ( pos === -1 ) { break; }
        h = h.slice(pos + 1);
        if ( h === '' ) { break; }
        out.push(h);
    }
    return out;
}
