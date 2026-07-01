# Annotation (audit) mode — manual QA checklist

The pure data layer (`platform/mv3/extension/js/annotation-store.js`) is covered
by automated unit tests:

```sh
npm run test:mv3          # or: node --test "platform/mv3/tests/**/*.test.js"
```

Everything else in annotation mode is browser-runtime code (content-script
injection, DNR `onRuleMatchedDebug`, non-blocking `webRequest`, the
`chrome.debugger`/CDP path, the MAIN-world `postMessage` bridge, and
service-worker session persistence) and has no Node harness. Verify it manually
with an **unpacked developer build**, which is the only build where annotation
mode is available (it needs `declarativeNetRequestFeedback`, added by
`tools/make-mv3.sh` only for local/dev builds).

## Build & load

```sh
# from the uBlock submodule root
./tools/make-mv3.sh chromium      # or: firefox
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
