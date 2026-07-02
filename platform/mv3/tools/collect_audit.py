#!/usr/bin/env python3
"""
Collect uBOL "annotation (audit) mode" results from a real Chrome via CDP,
without missing telemetry across redirects, reloads, or late/async requests.

WHAT IT GATHERS (in one run)
----------------------------
  * NETWORK  -- every would-be-blocked request for the tab, read from the
    BACKGROUND store (the source of truth). That store is keyed by tabId and is
    reset only on tab-close / mode-toggle -- NOT on reload or redirect -- so it
    accumulates across an entire A->B->C redirect chain and any number of
    reloads. window.__ubolAudit.network is only a per-document mirror of this;
    we read the background directly so a just-navigated document (whose mirror
    hasn't re-hydrated yet) can never cause us to miss records. We also union in
    every frame's mirror as belt-and-suspenders.
  * DOM      -- every tagged node (data-ubol-hide/-remove/-remove-attr/
    -remove-class/-derived) across ALL frames, including cross-origin iframes.
    DOM tags are per-document, so a reload/redirect discards the previous
    document's nodes; we therefore snapshot on every navigation/load and keep a
    deduped union of everything ever seen in the tab.

WHY PER-FRAME FOR DOM: getElements() already pierces open shadow roots and
same-origin iframes within its own document, but a cross-origin iframe is a
separate document with its own window.__ubolAudit that the parent's JS cannot
touch. CDP/Playwright can evaluate inside each frame's own context, so we call
getElementDetails() once per frame and merge.

LIMITATIONS (inherent, called out honestly):
  * Nodes in CLOSED shadow roots or CROSS-ORIGIN iframes that are torn down
    before we snapshot cannot be recovered (no API exposes a dead document).
    Network telemetry for them is still captured (it lives in the background).
  * If you close the tab, the background drops its data. Keep the tab open
    until collection finishes.

PREREQUISITES
-------------
1. pip install playwright
2. Launch your real Chrome with the uBOL Lite dev build + a debug port:
     google-chrome \
       --remote-debugging-port=9222 \
       --user-data-dir="$HOME/.chrome-ubol-audit" \
       --load-extension=/path/to/dist/build/uBOLite.chromium
   (Annotation mode is on by default in this dev build.)
3. Run:
     python collect_audit.py --url "https://www.msn.com/en-us/news/..." \
       --reload 1 --settle 8 --out audit.json
   Omit --url to attach to whatever tab is already open (matched by --match).
"""

import argparse
import json
import secrets
import sys

from playwright.sync_api import sync_playwright


# ---------------------------------------------------------------------------
# Runs INSIDE each frame's MAIN world (where window.__ubolAudit lives). Returns
# only JSON-serializable data -- DOM Elements can't cross the CDP boundary, so
# each tagged element is serialized to a descriptor.
# ---------------------------------------------------------------------------
FRAME_SCRIPT = r"""
() => {
  const a = window.__ubolAudit;
  const out = { present: false, url: location.href, elements: [], network: [] };
  if (!a) { return out; }
  out.present = true;

  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
      let seg = node.localName;
      if (node.id) { parts.unshift(seg + '#' + node.id); break; }
      const p = node.parentNode;
      if (p && p.children) {
        const sibs = Array.from(p.children).filter(c => c.localName === node.localName);
        if (sibs.length > 1) { seg += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')'; }
      }
      parts.unshift(seg);
      node = (p && p.host) ? p.host : p;  // step across a shadow boundary
    }
    return parts.join(' > ');
  };

  const serialize = (el) => {
    const ubol = {};
    for (const name of (el.getAttributeNames ? el.getAttributeNames() : [])) {
      if (name.startsWith('data-ubol-')) { ubol[name] = el.getAttribute(name); }
    }
    return {
      tag: el.localName || null,
      id: el.id || null,
      classes: (el.getAttribute && el.getAttribute('class')) || null,
      selector: cssPath(el),
      ubolAttrs: ubol,
      outerHTMLHead: (el.outerHTML || '').slice(0, 240),
    };
  };

  const details = a.getElementDetails
    ? a.getElementDetails()
    : a.getElements().map(el => ({ element: el, actions: {}, filters: [] }));

  out.elements = details.map(d => Object.assign(serialize(d.element), {
    actions: d.actions || {},
    filters: d.filters || [],
    derivedFrom: d.derivedFrom || null,
  }));
  out.network = Array.isArray(a.network) ? a.network : [];
  return out;
}
"""


def eprint(*a):
    print(*a, file=sys.stderr, flush=True)


def net_key(r):
    return "|".join(str(r.get(k, "")) for k in
                    ("url", "type", "initiator", "verdict", "source"))


def el_key(frame_url, e):
    return "|".join([
        frame_url,
        e.get("selector") or "",
        json.dumps(e.get("ubolAttrs") or {}, sort_keys=True),
        e.get("outerHTMLHead") or "",
    ])


def find_extension_id(context):
    # MV3 background is a service worker: chrome-extension://<id>/js/background.js
    for sw in context.service_workers:
        if sw.url.startswith("chrome-extension://"):
            return sw.url.split("/")[2]
    for pg in context.pages:  # fallback: any extension page already open
        if pg.url.startswith("chrome-extension://"):
            return pg.url.split("/")[2]
    return None


def snapshot_frames(page, elements_store, network_store):
    """One pass over every frame (top + nested + cross-origin)."""
    for frame in list(page.frames):
        try:
            res = frame.evaluate(FRAME_SCRIPT)
        except Exception:
            continue  # frame detached/navigated mid-eval
        if not res or not res.get("present"):
            continue
        furl = res.get("url") or frame.url
        for e in res.get("elements", []):
            elements_store[el_key(furl, e)] = dict(e, frame=furl)
        for r in res.get("network", []):
            network_store.setdefault(net_key(r), r)


def pull_background_network(control_page, tab_id, network_store):
    """Authoritative, cumulative network log straight from the background."""
    if tab_id is None:
        return 0
    try:
        data = control_page.evaluate(
            "async (tabId) => await chrome.runtime.sendMessage("
            "{ what: 'getAuditData', tabId })", tab_id)
    except Exception as e:
        eprint(f"  getAuditData failed: {e}")
        return 0
    reqs = (data or {}).get("requests") or []
    for r in reqs:
        network_store[net_key(r)] = r  # background wins over frame mirror
    return len(reqs)


def resolve_tab_id(control_page, marker, url_hint):
    """Map our target tab to its chrome tabId (stable across reloads/redirects).

    Uses a unique title marker first (unambiguous), then falls back to URL."""
    try:
        tabs = control_page.evaluate(
            "async () => (await chrome.tabs.query({})).map("
            "t => ({ id: t.id, url: t.url, title: t.title }))")
    except Exception as e:
        eprint(f"  chrome.tabs.query failed: {e}")
        return None
    if marker:
        for t in tabs:
            if marker in (t.get("title") or ""):
                return t["id"]
    if url_hint:
        for t in tabs:
            if url_hint in (t.get("url") or ""):
                return t["id"]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cdp", default="http://localhost:9222")
    ap.add_argument("--url", default=None,
                    help="Navigate the target tab here. If omitted, attach to "
                         "an existing tab matched by --match.")
    ap.add_argument("--match", default=None,
                    help="Substring to pick an existing tab when --url omitted.")
    ap.add_argument("--reload", type=int, default=0,
                    help="Reload the target tab N times (to exercise reloads).")
    ap.add_argument("--settle", type=float, default=8.0,
                    help="Seconds to wait after each load for async telemetry.")
    ap.add_argument("--stable-polls", type=int, default=4,
                    help="Stop early once the network count is unchanged for "
                         "this many 1s polls.")
    ap.add_argument("--max-wait", type=float, default=60.0,
                    help="Hard cap (s) on the final stabilization loop.")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    elements_store = {}
    network_store = {}

    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp(args.cdp)
        context = browser.contexts[0] if browser.contexts else browser.new_context()

        ext_id = find_extension_id(context)
        if not ext_id:
            eprint("ERROR: could not find the uBOL extension (service worker). "
                   "Is the dev build loaded?")
            sys.exit(2)

        # --- pick / open the target page -----------------------------------
        page = None
        if args.url:
            page = context.new_page()
        else:
            for p in context.pages:
                if p.url.startswith("http") and (not args.match or args.match in p.url):
                    page = p
                    break
            if page is None:
                eprint("ERROR: no matching existing tab; pass --url or --match.")
                sys.exit(2)

        # Log the redirect chain, and snapshot DOM on every load so a redirect
        # chain's intermediate docs AND the final one all contribute nodes.
        page.on("framenavigated", lambda f:
                eprint(f"  -> navigated: {f.url}") if f == page.main_frame else None)
        page.on("load", lambda:
                snapshot_frames(page, elements_store, network_store))

        if args.url:
            eprint(f"opening: {args.url}")
            page.goto(args.url, wait_until="domcontentloaded", timeout=90000)
        else:
            eprint(f"attached: {page.url}")

        page.wait_for_timeout(int(args.settle * 1000))
        snapshot_frames(page, elements_store, network_store)

        # --- resolve the stable tabId via a unique title marker ------------
        marker = "\u2063UBOLAUDIT-" + secrets.token_hex(4)
        try:
            page.evaluate("m => { try { document.title += m; } catch {} }", marker)
        except Exception:
            pass
        control = context.new_page()
        control.goto(f"chrome-extension://{ext_id}/dashboard.html",
                     wait_until="domcontentloaded", timeout=30000)
        control.wait_for_timeout(300)
        tab_id = resolve_tab_id(control, marker, args.url or args.match or page.url)
        if tab_id is None:
            eprint("WARN: could not resolve tabId; relying on frame mirrors only.")
        else:
            eprint(f"target tabId = {tab_id}")
        try:  # clean the marker back off the title
            page.evaluate(
                "m => { try { document.title = document.title.replace(m,''); } catch {} }",
                marker)
        except Exception:
            pass

        # --- optional reloads (tabId stays the same; store accumulates) ----
        for i in range(args.reload):
            eprint(f"reload {i+1}/{args.reload}")
            page.reload(wait_until="domcontentloaded", timeout=90000)
            page.wait_for_timeout(int(args.settle * 1000))
            snapshot_frames(page, elements_store, network_store)

        # --- stabilization loop: keep pulling the authoritative background
        #     store until the would-be-blocked count stops growing (captures
        #     late XHR / ad / beacon telemetry) --------------------------------
        last, stable, waited = -1, 0, 0.0
        while waited < args.max_wait:
            snapshot_frames(page, elements_store, network_store)
            pull_background_network(control, tab_id, network_store)
            total = len(network_store)
            if total == last:
                stable += 1
                if stable >= args.stable_polls:
                    break
            else:
                stable = 0
            last = total
            page.wait_for_timeout(1000)
            waited += 1.0

        # Final authoritative pull + DOM sweep.
        pull_background_network(control, tab_id, network_store)
        snapshot_frames(page, elements_store, network_store)

        result = {
            "page": page.url,
            "tabId": tab_id,
            "frameCount": len(page.frames),
            "elements": list(elements_store.values()),
            "network": list(network_store.values()),
        }
        control.close()
        browser.close()  # detaches CDP; does NOT close your Chrome

    derived_dom = [e for e in result["elements"] if e.get("derivedFrom")]
    direct_net = [r for r in result["network"] if r.get("verdict") == "direct"]
    derived_net = [r for r in result["network"] if r.get("verdict") == "derived"]
    eprint("---")
    eprint(f"page: {result['page']}")
    eprint(f"tagged DOM nodes: {len(result['elements'])} "
           f"({len(derived_dom)} derived) across {result['frameCount']} frames")
    eprint(f"would-be-blocked network: {len(result['network'])} "
           f"({len(direct_net)} direct, {len(derived_net)} derived)")

    payload = json.dumps(result, indent=2, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(payload)
        eprint(f"wrote {args.out}")
    else:
        print(payload)


if __name__ == "__main__":
    main()
