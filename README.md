# MarkItDown

Turn documents into clean, LLM-ready Markdown — entirely in your browser.

**[Open the app →](https://markitdown.harishkrishna.in/)**

Drop in a document and get readable Markdown back in seconds. No account, no upload, no server: the conversion happens on your device.

## Features

- Converts all the common document formats listed below
- Handles multiple files at once with a live queue
- Raw Markdown view and rendered preview
- Copy to clipboard, download individual `.md` files, or export everything as a ZIP
- Installable app with offline support after the first visit
- Light and dark themes

## Supported formats

PDF · DOCX · PPTX · XLSX · XLS · HTML · CSV · JSON · XML · EPUB · TXT

## How to use

1. Open the app.
2. Drop files onto the page, or choose them from your device.
3. When the queue finishes, select a file to copy or download its Markdown.

The first visit downloads the conversion runtime (tens of megabytes). After that, the app is cached and works offline.

## Privacy

Your documents never leave your browser. The only network traffic is for the app itself and its cached conversion components — file contents are never uploaded.

## Development

The site is plain static HTML/CSS/JS; the converter assets are generated at build time. To run locally:

```bash
python -m pip install build hatchling tomlkit
python scripts/build_wasm_wheel.py --dist .
python -m http.server 8000
```

Then open <http://localhost:8000/>. `localhost` is a secure context, so the installable-app and offline features work normally.

To assemble a deployable `dist/`:

```bash
python scripts/build_wasm_wheel.py --source /path/to/markitdown --dist dist
cp index.html styles.css app.js worker.js sw.js manifest.json CNAME dist/
cp -R icons dist/
```

`version.json` and `wheels/` are generated and gitignored. Deployments are handled by `.github/workflows/sync-and-deploy.yml` on pushes to `main`, every six hours, and on demand.

## Credits

Built with the open-source [microsoft/markitdown](https://github.com/microsoft/markitdown) converter.
