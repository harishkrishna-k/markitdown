# MarkItDown (client-side)

A 100% browser-based document → Markdown converter built on Microsoft's
[`markitdown`](https://github.com/microsoft/markitdown). Python runs in a
Pyodide Web Worker, so the UI never blocks and **no file is ever uploaded**.

Supported inputs: PDF, DOCX, PPTX, XLSX, XLS, HTML, CSV, JSON, XML, EPUB, TXT.

## How it works

- `index.html` / `styles.css` / `app.js` — instant-paint vanilla UI, drag & drop,
  raw/rendered tabs, copy, per-file `.md` download, batch `.zip`, install prompt.
- `worker.js` — boots Pyodide from jsDelivr, injects a pure-Python `magika` stub
  (so the native ONNX runtime is never needed), installs the document parsers,
  then calls `MarkItDown().convert_stream(...)` with a browser-provided
  `StreamInfo`.
- `scripts/build_wasm_wheel.py` — clones upstream `microsoft/markitdown`, strips
  native-only dependencies from `pyproject.toml`, builds a pure-Python wheel,
  removes its runtime dependency declarations, and stamps it with the upstream
  commit SHA in `version.json`.
- `sw.js` / `manifest.json` — installable PWA; network-first shell + version
  checks, cache-first Pyodide/PyPI/wheel assets, automatic old-wheel pruning.
- `.github/workflows/sync-and-deploy.yml` — rebuilds and deploys every 6 hours,
  on pushes to `main`, and on demand; scheduled runs are skipped when the live
  site already has the latest upstream commit.

## GitHub Pages setup (one time)

1. Go to **Settings → Pages → Build and deployment**.
2. Set **Source** to **GitHub Actions**. (Do *not* select "Deploy from a branch".)
3. Go to **Settings → Pages → Custom domain**, enter
   `markitdown.harishkrishna.in`, and save. Tick **Enforce HTTPS** once DNS
   validates.
4. In your DNS provider for `harishkrishna.in`, add:

   | Type  | Name        | Value                     |
   | ----- | ----------- | ------------------------- |
   | CNAME | `markitdown` | `harishkrishna-k.github.io` |

5. Push to `main` (or run **Actions → Sync upstream markitdown and deploy →
   Run workflow**). The `CNAME` file in this repo is copied into the deployment
   automatically.
6. If you remove the custom domain later, delete `CNAME` from this repo or the
   workflow will re-add it to the deployment.

The site will then be live at <https://markitdown.harishkrishna.in/>.
Without a custom domain it also works at
<https://harishkrishna-k.github.io/markitdown/>.

## Run locally

A plain static server is enough, but the wheel and `version.json` must exist
first:

```bash
python -m pip install build hatchling tomlkit
python scripts/build_wasm_wheel.py --dist .
python -m http.server 8000
```

Open <http://localhost:8000/>. `localhost` is a secure context, so the service
worker and Pyodide work normally. On the first load Pyodide and the Python
wheels are downloaded (~tens of MB); subsequent loads are served from the
service worker cache and work offline.

To produce the deployable site manually:

```bash
python scripts/build_wasm_wheel.py --source /path/to/markitdown --dist dist
cp index.html styles.css app.js worker.js sw.js manifest.json README.md dist/
cp -R icons dist/ && cp CNAME dist/
```

## Customising

- `PYODIDE_VERSION` in `worker.js` and the CDN URL in `sw.js` must match.
- CDN versions for `marked`, `DOMPurify`, and `JSZip` live in `app.js` (`CDN`)
  and in `sw.js` (`PRECACHE_URLS`).
- Add or remove accepted formats in `ACCEPTED_EXTENSIONS` in `app.js` and in
  the `accept` attribute of the file input in `index.html`.

## Privacy

Everything runs in your browser. The only network requests are for static app
assets, the Pyodide runtime, Python wheels from PyPI/jsDelivr, and the small
`version.json` metadata file. Uploaded document bytes never leave the page.
