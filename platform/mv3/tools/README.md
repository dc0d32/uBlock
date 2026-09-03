# uBO Lite Audit Collector

## Setup

Create an isolated environment outside the repository:

```powershell
uv venv Q:\TMP\ublock-audit-venv --python 3.13
uv pip install --python Q:\TMP\ublock-audit-venv\Scripts\python.exe `
  -r tools\requirements.txt
Q:\TMP\ublock-audit-venv\Scripts\python.exe -m playwright install chromium
```

On macOS or Linux, replace the environment and executable paths with suitable
local paths.

## Collect a site

From this bundle's root:

```powershell
Q:\TMP\ublock-audit-venv\Scripts\python.exe tools\collect_audit.py `
  --extension extension `
  --url https://example.com/ `
  --reload 1 `
  --settle 8 `
  --out audit.json
```

The collector launches Playwright Chromium, loads the unpacked extension using
the Chrome 137+ `Extensions.loadUnpacked` API, enables complete filtering, and
uses a temporary profile. Add `--headful` to watch the run.

The JSON result contains:

- `elements`: cosmetic, procedural, scriptlet, derived, and removal records;
- `network`: direct and derived would-be-blocked requests;
- `sourceStats`: coverage from the live stream, write-ahead log, and background
  store;
- `frameCount` and `tabId`: collection context.

Use `--ack` to drain consumed WAL records. To attach to a manually loaded
browser instead of launching one, use `--cdp http://localhost:9222` and either
`--url` or `--match`.
