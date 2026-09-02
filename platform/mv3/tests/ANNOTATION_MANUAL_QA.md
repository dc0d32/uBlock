# Annotation (audit) mode — testing & QA

## How the network side works (Design B)

Annotation mode must let the page load **unblocked** (so ads/scripts run and
derived resources appear) while still reporting what DNR *would* have blocked.
MV3 makes these mutually exclusive through the DNR engine (an enabled ruleset is
an enforcing ruleset, and a top-priority `allowAllRequests` passthrough — needed
to unblock — masks every real verdict, so `onRuleMatchedDebug`/`testMatchOutcome`
only ever report the passthrough).

So annotation mode:
1. installs a top-priority `allowAllRequests` + `allow` **passthrough** session
   rule → the page loads fully unblocked;
2. observes every request with non-blocking `webRequest.onBeforeRequest`;
3. re-computes the would-be verdict in JS with **`dnr-matcher.js`**, evaluating
   the same ruleset data uBOL ships (static rulesets + dynamic/session rules,
   minus the passthrough).

`dnr-matcher.js` is validated two ways:
- **Unit tests** (`platform/mv3/tests/dnr-matcher.test.js`) — pure logic.
- **Oracle cross-check** against Chrome's own
  `declarativeNetRequest.testMatchOutcome` over thousands of real-rule URLs
  (`.e2e/oracle*.mjs`) — 100% agreement on all sub-resource types.

## Automated tests

Unit tests (no browser, run anywhere):

```sh
npm run test:mv3          # node --test "platform/mv3/tests/**/*.test.js"
```

End-to-end (headless Chromium via Puppeteer) — validates the full pipeline
(extension loads, annotation mode toggles, real pages get flagged). Requires a
Chromium binary and `puppeteer-core`. On NixOS:

```sh
nix-shell -p chromium --run 'command -v chromium'   # get a chromium path
npm install --no-save puppeteer-core
# .e2e/chrome-path.txt holds the chromium binary path used by the harness
node .e2e/annotation-e2e.mjs      # loads ext, enables mode, hits canyoublockit.com
node .e2e/oracle.mjs              # matcher vs Chrome testMatchOutcome (curated)
node .e2e/oracle-fuzz.mjs         # matcher vs oracle, randomized real-rule URLs
```

Offline smoke test (no npm dependencies, no network required for the cosmetic
assertions) — loads the *built* extension, serves a local fixture, and asserts
the two core invariants: generic cosmetic filters **tag** (`data-ubol-hide` +
`data-ubol-filter`) instead of hiding, and would-be-blocked requests **load**
while being recorded in `window.__ubolAudit.network`:

```sh
./tools/make-mv3.sh chromium
node .e2e/smoke.mjs               # add --headful to watch it
EXT_DIR=/path/to/unzipped/build node .e2e/smoke.mjs   # validate a shipped zip
```

> **Chrome 137+ automation caveat.** Chrome removed `--load-extension`, and
> `Extensions.loadUnpacked` is only exposed over a CDP **pipe**. Harnesses must
> launch with `--remote-debugging-pipe --enable-unsafe-extension-debugging`
> (*not* `--remote-debugging-port`) and then call `Extensions.loadUnpacked`;
> otherwise the extension silently never loads. `.e2e/smoke.mjs` does this.

> **Filtering mode matters.** uBOL defaults to *optimal* (specific cosmetic
> filters only). **Generic** filters such as those in
> `rulesets/scripting/generic/` only apply at *complete* (`MODE_COMPLETE`, 3),
> so a harness must raise the mode before expecting generic tags. Modes are keyed
> by hostname via the public suffix list, so fixtures should be served from a
> PSL-valid hostname (e.g. `--host-resolver-rules`) rather than a bare IP.

The e2e harness lives under `.e2e/` (gitignored; environment-specific chromium
path). It asserts, on canyoublockit.com simple + extreme: every tracker the page
actually loads is flagged, first-party assets are not, verdicts/records are
shaped correctly, `data-ubol-*` element tags exist, and `window.__ubolAudit` is
present.

## Manual QA

The remaining runtime pieces (content-script injection, the MAIN-world
`postMessage` bridge, the `chrome.debugger`/CDP precise-initiator path, and
service-worker session persistence) are best spot-checked manually with an
**unpacked developer build** (annotation mode is dev/sideloaded only; the dev
build adds `webRequest` + `debugger` via `tools/make-mv3.sh`).

## Build & load

```sh
# from the uBlock submodule root
git submodule update --init --recursive   # codemirror-ubol, s14e-serializer
./tools/make-mv3.sh chromium              # or: firefox
```

- Chromium: `chrome://extensions` → enable Developer mode → *Load unpacked* →
  select the built `dist/build/uBOLite.chromium` folder.
- Firefox: `about:debugging` → This Firefox → *Load Temporary Add-on* → pick the
  built manifest.

Then open the dashboard (options page) and enable **Annotation (audit) mode**
(and optionally **Precise network initiators (CDP)** on Chromium). These toggles
appear only when the build is sideloaded/dev.

## Checklist

### Elements (both browsers)
- [ ] On an ad-heavy page, ads that would normally be hidden are **still visible**
      but tagged. In the page console:
      `document.querySelectorAll('[data-ubol-hide]').length` > 0.
- [ ] Specific/generic/declarative filters produce
      `data-ubol-hide="specific|generic|declarative"`.
- [ ] A procedural `:has()`/`:style()` filter tags with
      `data-ubol-hide="procedural"`; a procedural `remove` filter tags
      `data-ubol-remove` (element NOT removed).
- [ ] Dynamically inserted matching nodes get tagged too (MutationObserver).

### Network — direct (both; needs feedback permission)
- [ ] Requests that would be blocked are **not** blocked (the resources load).
- [ ] They appear in the audit view (popup 🔍 → “Show annotation audit”) with
      verdict **direct**, source **dnr**, and a matched rule.
- [ ] `window.__ubolAudit.network` on the page lists the same requests.

### Network — derived
- [ ] Coarse: a would-be-blocked **sub-frame** loads; every request inside it is
      recorded with verdict **derived** (both browsers).
- [ ] Precise (Chromium, CDP toggle on): if would-be-blocked `a.js` requests
      `b.js`, `b.js` is recorded as **derived** with an `initiatorChain` even
      though `b.js` matches no rule. A debugging banner is shown while active.

### Scriptlets
- [ ] A page using `no-fetch-if`/`no-xhr-if` (`prevent-fetch`/`prevent-xhr`):
      the request is **allowed** and recorded with source **scriptlet**.
- [ ] `set-attr`/`remove-attr`/`remove-node-text`/`remove-class`/`href-sanitizer`
      tag the target (`data-ubol-set-attr`/`-remove-attr`/`-remove-node-text`/
      `-remove-class`/`-sanitize-href`) instead of mutating it.

### Persistence / lifecycle
- [ ] Navigate/redirect within the same tab: `window.__ubolAudit.network`
      re-populates (background dataset survives; the page-global is rebuilt).
- [ ] The audit view keeps prior entries across a same-tab navigation.
- [ ] Reload the extension / let the service worker idle and wake: the dataset is
      restored from session storage.
- [ ] Closing the tab drops its dataset; **Reset** in the audit view clears it.
- [ ] Turning annotation mode OFF restores normal blocking/hiding (passthrough
      DNR rule removed, listeners detached, CDP detached).

## Bulk collection tool (Playwright/CDP)

`platform/mv3/tools/collect_audit.py` attaches to a real Chrome (dev build
loaded) over CDP and gathers, in one run and without missing telemetry across
redirects/reloads/late requests:

- every would-be-blocked network record, read from the **background** store
  (the cumulative source of truth, keyed by tabId — survives reloads/redirects),
  unioned with each frame's `window.__ubolAudit.network` mirror;
- every tagged DOM node across **all** frames (top + nested + cross-origin).

DOM tags are collected from four complementary sinks so nothing is lost to a
late DOM walk (a node in a cross-origin iframe / closed shadow root / torn-down
document is still captured):

- **stream (B):** the in-page sink calls `window.__ubolSink()` at tag-time,
  exposed as a Playwright context binding — delivered synchronously;
- **store (A):** a durable per-tab background dataset (`getAuditData().elements`);
- **WAL (C):** a `chrome.storage.local` write-ahead log (`getAuditWal`) that
  survives tab close and lets the collector replay anything the live stream
  missed, deduped by record `uid`; drain it with `--ack`;
- **removal (D):** removed tagged nodes are serialized (`event:"remove"`) before
  they detach.

Each element in the output carries its `source` (`stream`/`wal`/`store`/`dom`),
`event`, `actions`, `filters`, and `derivedFrom`.

```
pip install playwright
google-chrome --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.chrome-ubol-audit" \
  --load-extension=/path/to/dist/build/uBOLite.chromium
python platform/mv3/tools/collect_audit.py \
  --url "https://example.com/…" --reload 1 --settle 8 --out audit.json
```

Inherent limits: a node in a **closed** shadow root is captured via the in-page
sink (stream/wal/store) but not by the live DOM snapshot (it has no `source:"dom"`
entry). Turning annotation mode off, or `--ack`, clears the WAL.
