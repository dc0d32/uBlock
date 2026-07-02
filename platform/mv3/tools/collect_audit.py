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
  * DOM      -- every tagged node (data-ubol-*) across ALL frames, including
    cross-origin iframes. Beyond snapshotting the live DOM, the extension now
    streams every tag event AT TAG-TIME, so nodes in cross-origin iframes /
    closed shadow roots / torn-down documents are captured even though a DOM
    walk could never reach them:
      - B (stream): the in-page sink calls window.__ubolSink(), exposed here as
        a Playwright context binding; delivered synchronously so tear-down can't
        drop it;
      - A (store) + C (WAL): the background keeps a durable per-tab store and a
        chrome.storage.local write-ahead log; we read both at the end so any tag
        the live stream missed (e.g. attached late) is replayed by seq and
        deduped by uid. The WAL survives tab close; pass --ack to drain it.
    The live DOM snapshot is kept as a supplement (source:"dom").

WHY PER-FRAME FOR DOM: getElements() already pierces open shadow roots and
same-origin iframes within its own document, but a cross-origin iframe is a
separate document with its own window.__ubolAudit that the parent's JS cannot
touch. CDP/Playwright can evaluate inside each frame's own context, so we call
getElementDetails() once per frame and merge.

LIMITATIONS (inherent, called out honestly):
  * A node in a CLOSED shadow root is streamed/stored via the in-page sink
    (the extension observes it from the inside), but the live DOM snapshot can't
    reach it -- so it appears with source stream/wal/store, not "dom".
  * If you close the tab, the in-memory store is dropped, but the WAL in
    chrome.storage.local survives -- a later run can still replay it (until you
    --ack it or turn annotation mode off).

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


def elem_content_sig(rec):
    """Cross-source signature so a DOM-snapshot element and its durable record
    (which have no shared uid) are not double-counted."""
    return "|".join([
        rec.get("frameUrl") or rec.get("frame") or "",
        rec.get("selector") or "",
        json.dumps(rec.get("ubolAttrs") or {}, sort_keys=True),
    ])


def pull_durable_elements(control_page, tab_id, durable, sink_records, do_ack):
    """Merge the durable element sources (A store + C WAL) and the live stream
    (B) into `durable`, keyed by uid. Returns a dict of per-source raw uid counts
    (how many uids each source independently carried) plus the highest WAL seq."""
    stats = {"store": 0, "wal": 0, "stream": len(sink_records), "max_seq": 0}
    # A: authoritative in-memory store for this tab.
    if tab_id is not None:
        try:
            data = control_page.evaluate(
                "async (tabId) => await chrome.runtime.sendMessage("
                "{ what: 'getAuditData', tabId })", tab_id)
            for rec in (data or {}).get("elements", []):
                uid = rec.get("uid")
                if uid:
                    stats["store"] += 1
                    durable.setdefault(uid, dict(rec, _src="store"))
        except Exception as e:
            eprint(f"  getAuditData(elements) failed: {e}")
    # C: WAL replay recovers anything the live stream missed (attached late,
    # torn-down frame, etc.). Read the whole retained log.
    try:
        wal = control_page.evaluate(
            "async () => await chrome.runtime.sendMessage("
            "{ what: 'getAuditWal', sinceSeq: 0 })")
        for rec in (wal or {}).get("records", []):
            stats["wal"] += 1
            stats["max_seq"] = max(stats["max_seq"], rec.get("seq", 0))
            uid = rec.get("uid")
            if uid:
                durable.setdefault(uid, dict(rec, _src="wal"))
        oldest = (wal or {}).get("oldestSeq", 0)
        if oldest and oldest > 1:
            eprint(f"  note: WAL rolled over (oldestSeq={oldest}); very early "
                   f"records may only exist in the live stream.")
    except Exception as e:
        eprint(f"  getAuditWal failed: {e}")
    # B: the live stream (already collected via the binding).
    for uid, rec in sink_records.items():
        durable.setdefault(uid, dict(rec, _src="stream"))
    # Optionally drain the WAL so the next run starts clean.
    if do_ack and stats["max_seq"] > 0:
        try:
            control_page.evaluate(
                "async (uptoSeq) => await chrome.runtime.sendMessage("
                "{ what: 'ackAuditWal', uptoSeq })", stats["max_seq"])
        except Exception as e:
            eprint(f"  ackAuditWal failed: {e}")
    return stats


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
    ap.add_argument("--ack", action="store_true",
                    help="Acknowledge (drain) the WAL after reading it, so the "
                         "next run only sees new records.")
    args = ap.parse_args()

    elements_store = {}    # DOM-snapshot elements, keyed by content (el_key)
    network_store = {}
    sink_records = {}      # B: live CDP stream, keyed by record uid
    durable_records = {}   # A/C: background store + WAL, keyed by record uid

    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp(args.cdp)
        context = browser.contexts[0] if browser.contexts else browser.new_context()

        ext_id = find_extension_id(context)
        if not ext_id:
            eprint("ERROR: could not find the uBOL extension (service worker). "
                   "Is the dev build loaded?")
            sys.exit(2)

        # B: real-time element stream. The in-page sink calls window.__ubolSink()
        # at tag-time; exposing it at the CONTEXT level means it's present in
        # every frame (incl. cross-origin) and every page created afterwards.
        # Delivered synchronously, so a frame torn down right after tagging is
        # still captured here even if the DOM walk below can never reach it.
        def on_sink(source, arg):
            try:
                for rec in (arg or {}).get("records", []):
                    uid = rec.get("uid")
                    if uid:
                        sink_records[uid] = rec
            except Exception:
                pass
        try:
            context.expose_binding("__ubolSink", on_sink)
        except Exception as e:
            eprint(f"  note: __ubolSink already exposed or unavailable ({e})")

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

        # Merge the durable element sources (A store + C WAL + B stream). These
        # are the loss-proof record of every tag event; the DOM snapshot is a
        # supplement (live nodes still reachable, useful for live handles).
        estats = pull_durable_elements(control, tab_id, durable_records,
                                       sink_records, args.ack)

        # Unified element list: durable records first, then any DOM-snapshot-only
        # element whose content signature isn't already represented.
        seen_sigs = set(elem_content_sig(r) for r in durable_records.values())
        elements = [dict(r, source=r.pop("_src", "durable"))
                    for r in durable_records.values()]
        dom_only = 0
        for e in elements_store.values():
            if elem_content_sig(e) in seen_sigs:
                continue
            elements.append(dict(e, source="dom"))
            dom_only += 1

        result = {
            "page": page.url,
            "tabId": tab_id,
            "frameCount": len(page.frames),
            "sourceStats": estats,
            "elements": elements,
            "network": list(network_store.values()),
        }
        control.close()
        browser.close()  # detaches CDP; does NOT close your Chrome

    derived_dom = [e for e in result["elements"] if e.get("derivedFrom")]
    removed = [e for e in result["elements"] if e.get("event") == "remove"]
    direct_net = [r for r in result["network"] if r.get("verdict") == "direct"]
    derived_net = [r for r in result["network"] if r.get("verdict") == "derived"]
    es = result["sourceStats"] or {}
    eprint("---")
    eprint(f"page: {result['page']}")
    eprint(f"tagged elements: {len(result['elements'])} "
           f"({len(derived_dom)} derived, {len(removed)} removed) "
           f"across {result['frameCount']} frames")
    eprint(f"  source coverage (raw uids seen per channel): "
           f"stream(B)={es.get('stream',0)} wal(C)={es.get('wal',0)} "
           f"store(A)={es.get('store',0)}")
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
