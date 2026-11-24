/*
 * MarkItDown Pyodide worker.
 *
 * Owns the Python runtime exclusively: the main thread stays responsive while
 * Pyodide boots and while individual documents are converted.
 */

const PYODIDE_VERSION = "0.27.7";
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/* Pyodide-provided (WASM) packages. The rest are pure Python wheels. */
const WASM_PACKAGES = [
  "micropip",
  "lxml",
  "beautifulsoup4",
  "requests",
  "certifi",
  "charset-normalizer",
  "cryptography",
  "pillow",
  "six",
  "typing-extensions",
  "xlrd",
];

/* Installed by micropip with dependency resolution disabled: every transitive
 * dependency is either in WASM_PACKAGES or listed here explicitly. */
const PURE_PYTHON_PACKAGES = [
  "markdownify",
  "pdfminer.six",
  "mammoth",
  "python-pptx",
  "openpyxl",
  "defusedxml",
  "XlsxWriter",
  "et-xmlfile",
];

const MAGIKA_STUB = String.raw`
"""Minimal, dependency-free magika stand-in for Pyodide.

markitdown only needs Magika to *guess* stream metadata. We deliberately report
"unknown" so markitdown relies on the extension / MIME type supplied by the
browser (via StreamInfo) instead of trying to load the native ONNX runtime.
"""
import sys
import types

class _StubContent:
    ct_label = "unknown"
    label = "unknown"
    output = None
    mime_type = "application/octet-stream"
    group = "unknown"
    is_text = False
    extensions = []
    score = 0.0

class _StubPrediction:
    label = "unknown"
    ct_label = "unknown"
    output = None
    mime_type = "application/octet-stream"
    group = "unknown"
    is_text = False
    extensions = []
    score = 0.0

class _StubResult:
    status = "ok"
    label = "unknown"
    ct_label = "unknown"
    mime_type = "application/octet-stream"
    group = "unknown"
    is_text = False
    extensions = []
    score = 0.0
    prediction = None
    output = None

_StubContent.output = _StubContent()
_StubPrediction.output = _StubContent()
_StubResult.prediction = _StubPrediction()
_StubResult.output = _StubResult.prediction

class MagikaStatus:
    OK = "ok"
    ERROR = "error"

class Magika:
    def __init__(self, *args, **kwargs):
        pass

    def identify_stream(self, *args, **kwargs):
        return _StubResult()

    def identify_bytes(self, *args, **kwargs):
        return _StubResult()

    def identify_path(self, *args, **kwargs):
        return _StubResult()

    def identify_file(self, *args, **kwargs):
        return _StubResult()

    def identify(self, *args, **kwargs):
        return _StubResult()

def identify_stream(*args, **kwargs):
    return _StubResult()

def identify_bytes(*args, **kwargs):
    return _StubResult()

def identify_path(*args, **kwargs):
    return _StubResult()

_magika_stub = types.ModuleType("magika")
_magika_stub.Magika = Magika
_magika_stub.MagikaStatus = MagikaStatus
_magika_stub.identify_stream = identify_stream
_magika_stub.identify_bytes = identify_bytes
_magika_stub.identify_path = identify_path
_magika_stub.__version__ = "0.0.0+pyodide-stub"
sys.modules["magika"] = _magika_stub
`;

let pyodide = null;
let bootPromise = null;
let queue = Promise.resolve();

function post(message) {
  self.postMessage(message);
}

function status(message, phase = "loading") {
  post({ type: "status", phase, message });
}

function relativeUrl(path) {
  return new URL(path, self.location.href).href;
}

function fileExtension(name) {
  const dot = String(name || "").lastIndexOf(".");
  return dot >= 0 ? String(name).slice(dot).toLowerCase() : "";
}

const MIME_TYPES = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".html": "text/html",
  ".htm": "text/html",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".epub": "application/epub+zip",
  ".txt": "text/plain",
};

function friendlyError(error) {
  const raw = error && error.message ? error.message : String(error);
  if (/MissingDependencyException|ModuleNotFoundError|No module named/i.test(raw)) {
    return "This format needs a document parser that is not available in the browser build.";
  }
  if (/UnsupportedFormatException|Unsupported format/i.test(raw)) {
    return "markitdown does not support this file format.";
  }
  if (/magika|onnx/i.test(raw)) {
    return "Format detection failed. Please try a file with a standard extension.";
  }
  if (/JSONDecodeError|SyntaxError/i.test(raw)) {
    return "The file could not be parsed. Check that it is not corrupted.";
  }
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const message = lines.length ? lines[lines.length - 1] : raw;
  return message.length > 360 ? `${message.slice(0, 357)}...` : message;
}

async function readVersion() {
  const response = await fetch(relativeUrl("./version.json"), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`version.json is missing (HTTP ${response.status}). Run scripts/build_wasm_wheel.py first.`);
  }
  const version = await response.json();
  if (!version || !version.wheel) {
    throw new Error("version.json does not declare a markitdown wheel.");
  }
  return version;
}

async function loadWasmPackages() {
  await pyodide.loadPackage(WASM_PACKAGES, {
    messageCallback: (message) => status(message),
    errorCallback: (message) => console.warn("[markitdown worker]", message),
  });
}

function injectMagikaStub() {
  pyodide.runPython(MAGIKA_STUB);
}

async function installPurePythonPackages() {
  pyodide.globals.set("pip_requirements", PURE_PYTHON_PACKAGES);
  try {
    await pyodide.runPythonAsync(`
import micropip
await micropip.install(pip_requirements, deps=False, keep_going=True)
`);
  } finally {
    pyodide.globals.delete("pip_requirements");
  }
}

async function installMarkitdownWheel(version) {
  const wheelUrl = relativeUrl(version.wheel);
  pyodide.globals.set("markitdown_wheel_url", wheelUrl);
  let installed = false;

  /* SHA-stamped filenames are intentionally not PEP 440 versions, so micropip
   * may reject them. Try micropip first, then fall back to a plain wheel
   * extraction into site-packages. */
  try {
    await pyodide.runPythonAsync(`
import micropip
await micropip.install(markitdown_wheel_url, deps=False)
`);
    installed = true;
  } catch (error) {
    status("Unpacking the markitdown wheel...");
  } finally {
    pyodide.globals.delete("markitdown_wheel_url");
  }

  if (installed) return;

  const response = await fetch(wheelUrl);
  if (!response.ok) {
    throw new Error(`Could not download the markitdown wheel (HTTP ${response.status}).`);
  }
  pyodide.FS.writeFile("/tmp/markitdown-wheel.whl", new Uint8Array(await response.arrayBuffer()));
  try {
    await pyodide.runPythonAsync(`
import sys
import sysconfig
import zipfile
site_packages = sysconfig.get_paths()["purelib"]
with zipfile.ZipFile("/tmp/markitdown-wheel.whl") as archive:
    archive.extractall(site_packages)
if site_packages not in sys.path:
    sys.path.insert(0, site_packages)
`);
  } finally {
    try { pyodide.FS.unlink("/tmp/markitdown-wheel.whl"); } catch (_) { /* already gone */ }
  }
}

async function boot() {
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    try {
      status("Loading Python runtime...");
      importScripts(`${PYODIDE_BASE}pyodide.js`);
      pyodide = await self.loadPyodide({ indexURL: PYODIDE_BASE });

      status("Installing document parsers...");
      const version = await readVersion();
      await loadWasmPackages();
      injectMagikaStub();
      await installPurePythonPackages();
      await pyodide.runPythonAsync(`
import importlib
for module_name in ("markdownify", "pdfminer", "mammoth", "pptx", "openpyxl", "defusedxml", "xlsxwriter"):
    importlib.import_module(module_name)
`);
      await installMarkitdownWheel(version);

      status("Starting markitdown...");
      pyodide.runPython(`
from markitdown import MarkItDown, StreamInfo
_markitdown = MarkItDown()
`);

      status("Ready", "ready");
      post({ type: "ready", version });
      return version;
    } catch (error) {
      status("Converter failed to start", "error");
      post({ type: "fatal", message: friendlyError(error) });
      throw error;
    }
  })();

  return bootPromise;
}

async function convert({ id, name, type, buffer }) {
  const extension = fileExtension(name);
  const mime = type || MIME_TYPES[extension] || "application/octet-stream";
  const inputPath = `/tmp/markitdown-input-${String(id).replace(/[^a-zA-Z0-9_-]/g, "")}.bin`;

  pyodide.FS.writeFile(inputPath, new Uint8Array(buffer));
  pyodide.globals.set("md_input_path", inputPath);
  pyodide.globals.set("md_file_name", name);
  pyodide.globals.set("md_extension", extension);
  pyodide.globals.set("md_mimetype", mime);

  const started = performance.now();
  try {
    const markdown = pyodide.runPython(`
import io
from markitdown import StreamInfo
with open(md_input_path, "rb") as handle:
    stream = io.BytesIO(handle.read())
stream_info = StreamInfo(extension=md_extension, filename=md_file_name, mimetype=md_mimetype)
_markitdown.convert_stream(stream, stream_info=stream_info).text_content
`);
    const text = typeof markdown === "string" ? markdown : String(markdown);
    return {
      id,
      name,
      markdown: text,
      stats: {
        chars: text.length,
        words: (text.match(/\S+/g) || []).length,
        timeMs: Math.round(performance.now() - started),
      },
    };
  } finally {
    for (const key of ["md_input_path", "md_file_name", "md_extension", "md_mimetype"]) {
      pyodide.globals.delete(key);
    }
    try { pyodide.FS.unlink(inputPath); } catch (_) { /* already gone */ }
  }
}

self.onmessage = (event) => {
  const message = event.data;
  if (!message || message.type !== "convert") return;

  queue = queue.then(async () => {
    try {
      await boot();
      post({ type: "converting", id: message.id });
      const result = await convert(message);
      post({ type: "result", ...result });
    } catch (error) {
      post({
        type: "error",
        id: message.id,
        name: message.name,
        message: friendlyError(error),
      });
    }
  });
};

/* Start booting immediately so the status pill reflects real progress. */
boot().catch(() => {});
