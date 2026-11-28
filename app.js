/* MarkItDown — main thread UI. All conversion happens in worker.js. */

const ACCEPTED_EXTENSIONS = new Set([
  ".pdf", ".docx", ".pptx", ".xlsx", ".xls", ".html", ".htm",
  ".csv", ".json", ".xml", ".epub", ".txt",
]);

const CDN = {
  marked: "https://cdn.jsdelivr.net/npm/marked@15/+esm",
  purify: "https://cdn.jsdelivr.net/npm/dompurify@3/+esm",
  jszip: "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm",
};

const $ = (id) => document.getElementById(id);

const elements = {
  dropzone: $("dropzone"),
  pickBtn: $("pick-btn"),
  fileInput: $("file-input"),
  addMore: $("add-more"),
  workspace: $("workspace"),
  fileList: $("file-list"),
  fileCount: $("file-count"),
  queueSummary: $("queue-summary"),
  tabRaw: $("tab-raw"),
  tabPreview: $("tab-preview"),
  rawView: $("raw-view"),
  previewView: $("preview-view"),
  rawOutput: $("raw-output"),
  previewOutput: $("preview-output"),
  emptyState: $("empty-state"),
  stats: $("stats"),
  copyBtn: $("copy-btn"),
  downloadBtn: $("download-btn"),
  zipBtn: $("zip-btn"),
  statusPill: $("status-pill"),
  statusText: $("status-text"),
  offlineBadge: $("offline-badge"),
  themeToggle: $("theme-toggle"),
  themeIcon: $("theme-icon"),
  installBtn: $("install-btn"),
  toast: $("toast"),
};

const state = {
  files: [],
  activeId: null,
  view: "raw",
  worker: null,
  workerReady: false,
  fatal: false,
};

let librariesPromise = null;
let deferredInstallPrompt = null;
let toastTimer = 0;
let bootWatchdog = 0;
let workerRestarts = 0;
const CONVERSION_TIMEOUT_MS = 180000;

/* ------------------------------ helpers ------------------------------ */

function extensionOf(name) {
  const value = String(name || "");
  const dot = value.lastIndexOf(".");
  return dot >= 0 ? value.slice(dot).toLowerCase() : "";
}

function baseName(name) {
  const value = String(name || "document");
  const dot = value.lastIndexOf(".");
  return (dot > 0 ? value.slice(0, dot) : value).replace(/[\\/:*?"<>|]/g, "_");
}

function makeId() {
  if (globalThis.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `f-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

function toast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", isError);
  elements.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 5000);
}

function setStatus(message, phase = "loading") {
  elements.statusText.textContent = message;
  elements.statusPill.classList.toggle("is-ready", phase === "ready");
  elements.statusPill.classList.toggle("is-error", phase === "error");
}

function loadLibraries() {
  if (!librariesPromise) {
    librariesPromise = Promise.all([
      import(CDN.marked),
      import(CDN.purify),
      import(CDN.jszip),
    ]).then(([markedModule, purifyModule, zipModule]) => ({
      marked: markedModule.marked || markedModule.default || markedModule,
      purify: purifyModule.default || purifyModule,
      JSZip: zipModule.default || zipModule,
    })).catch((error) => {
      librariesPromise = null;
      throw error;
    });
  }
  return librariesPromise;
}

/* ------------------------------ setup ------------------------------ */

function setupTheme() {
  const saved = localStorage.getItem("markitdown-theme");
  const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
  applyTheme(saved || (prefersLight ? "light" : "dark"));
  elements.themeToggle.addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const isDark = theme === "dark";
  elements.themeIcon.textContent = isDark ? "☾" : "☀";
  elements.themeToggle.setAttribute("aria-label", isDark ? "Switch to light theme" : "Switch to dark theme");
  localStorage.setItem("markitdown-theme", theme);
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const script = new URL("./sw.js", import.meta.url).href;
    const scope = new URL("./", import.meta.url).href;
    const registration = await navigator.serviceWorker.register(script, { scope });
    const markOfflineReady = () => {
      if (registration.active) elements.offlineBadge.hidden = false;
    };
    let requestedUpdate = false;
    let reloading = false;
    const activateWaitingWorker = () => {
      if (!registration.waiting) return;
      requestedUpdate = true;
      registration.waiting.postMessage({ type: "SKIP_WAITING" });
    };

    markOfflineReady();
    activateWaitingWorker();
    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed") {
          markOfflineReady();
          activateWaitingWorker();
        }
      });
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      markOfflineReady();
      if (requestedUpdate && !reloading) {
        reloading = true;
        window.location.reload();
      }
    });
    await registration.update();
  } catch (error) {
    console.warn("Service worker registration failed:", error);
  }
}

function setupInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    elements.installBtn.hidden = false;
  });
  elements.installBtn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    promptEvent.prompt();
    await promptEvent.userChoice;
    elements.installBtn.hidden = true;
  });
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    elements.installBtn.hidden = true;
  });
}

function startWorker() {
  const workerUrl = new URL("./worker.js", import.meta.url).href;
  const worker = new Worker(workerUrl);
  state.worker = worker;

  worker.addEventListener("message", (event) => onWorkerMessage(event.data));
  worker.addEventListener("error", (event) => {
    state.fatal = true;
    clearTimeout(bootWatchdog);
    setStatus("Converter crashed", "error");
    console.error("Converter worker error:", event.message);
    toast("The converter stopped unexpectedly.", true);
  });

  clearTimeout(bootWatchdog);
  bootWatchdog = setTimeout(() => {
    if (state.workerReady || state.fatal) return;
    if (workerRestarts >= 1) {
      setStatus("Converter is taking too long to start", "error");
      toast("The converter could not start. Reload the page to try again.", true);
      return;
    }
    workerRestarts += 1;
    toast("Restarting the converter…", true);
    worker.terminate();
    state.workerReady = false;
    for (const record of state.files) {
      if (record.status === "queued" || record.status === "converting") {
        record.status = "queued";
      }
    }
    startWorker();
  }, 90000);
}

/* ------------------------------ worker messages ------------------------------ */

function onWorkerMessage(message) {
  if (!message) return;
  console.debug("[markitdown] worker message:", message.type, message.id || "");

  switch (message.type) {
    case "status":
      setStatus(message.message, message.phase);
      break;

    case "ready":
      clearTimeout(bootWatchdog);
      state.workerReady = true;
      setStatus("Ready", "ready");
      flushQueue();
      break;

    case "converting":
      updateFile(message.id, { status: "converting" });
      break;

    case "result": {
      updateFile(message.id, {
        status: "done",
        markdown: message.markdown,
        stats: message.stats,
        file: null,
      });
      if (state.activeId === message.id) renderOutput();
      break;
    }

    case "error":
      updateFile(message.id, { status: "error", error: message.message });
      if (state.activeId === message.id) renderOutput();
      toast(message.message || "Conversion failed.", true);
      break;

    case "fatal":
      clearTimeout(bootWatchdog);
      state.fatal = true;
      setStatus("Converter unavailable", "error");
      for (const record of state.files) {
        if (record.status === "queued" || record.status === "converting") {
          record.status = "error";
          record.error = message.message || "The converter could not start.";
          record.file = null;
        }
      }
      render();
      toast(message.message || "The converter could not start.", true);
      break;

    default:
      break;
  }
}

function clearConversionTimer(record) {
  if (!record || !record.conversionTimer) return;
  clearTimeout(record.conversionTimer);
  record.conversionTimer = 0;
}

function armConversionTimer(record) {
  clearConversionTimer(record);
  record.conversionTimer = setTimeout(() => {
    if (record.status !== "converting") return;
    updateFile(record.id, {
      status: "error",
      error: "Conversion timed out. The worker did not respond; retry or reload the page.",
    });
    toast(`${record.name} timed out.`, true);
  }, CONVERSION_TIMEOUT_MS);
}

function flushQueue() {
  if (!state.workerReady || state.fatal) return;
  for (const record of state.files) {
    if (record.status === "queued") {
      updateFile(record.id, { status: "converting", submittedAt: Date.now() });
      submitToWorker(record);
    }
  }
}

async function submitToWorker(record) {
  if (!record.file) {
    updateFile(record.id, {
      status: "error",
      error: "The original file is no longer available. Add it again.",
    });
    return;
  }

  armConversionTimer(record);
  try {
    const buffer = await record.file.arrayBuffer();
    console.debug("[markitdown] posting conversion", record.id, record.name);
    state.worker.postMessage(
      {
        type: "convert",
        id: record.id,
        name: record.name,
        mimeType: record.file.type || "",
        buffer,
      },
      [buffer],
    );
  } catch (error) {
    clearConversionTimer(record);
    updateFile(record.id, { status: "error", error: error.message || String(error), file: null });
    toast(`Could not read ${record.name}.`, true);
  }
}

function retryFile(id) {
  const record = state.files.find((item) => item.id === id);
  if (!record || !record.file || state.fatal || !state.workerReady) return;
  updateFile(id, { status: "queued", error: null });
  flushQueue();
}

/* ------------------------------ files ------------------------------ */

function handleFiles(fileList) {
  const incoming = Array.from(fileList || []);
  if (!incoming.length) return;

  let rejected = 0;
  for (const file of incoming) {
    if (!ACCEPTED_EXTENSIONS.has(extensionOf(file.name))) {
      rejected += 1;
      continue;
    }
    state.files.push({
      id: makeId(),
      name: file.name,
      size: file.size,
      status: state.fatal ? "error" : "queued",
      markdown: null,
      stats: null,
      error: state.fatal ? "The converter is unavailable. Reload the page to retry." : null,
      file: state.fatal ? null : file,
    });
  }

  if (rejected) {
    toast(`${rejected} file${rejected > 1 ? "s were" : " was"} skipped: unsupported format.`, true);
  }
  if (!state.files.length) return;

  if (!state.activeId) state.activeId = state.files[0].id;
  render();
  flushQueue();
}

function updateFile(id, patch) {
  const record = state.files.find((item) => item.id === id);
  if (!record) return;
  if (patch.status === "done" || patch.status === "error") clearConversionTimer(record);
  Object.assign(record, patch);
  render();
}

function activeFile() {
  return state.files.find((item) => item.id === state.activeId) || null;
}

function setActive(id) {
  state.activeId = id;
  render();
}

/* ------------------------------ rendering ------------------------------ */

function render() {
  const hasFiles = state.files.length > 0;
  elements.dropzone.hidden = hasFiles;
  elements.workspace.hidden = !hasFiles;
  elements.fileCount.textContent = String(state.files.length);

  const done = state.files.filter((item) => item.status === "done").length;
  const failed = state.files.filter((item) => item.status === "error").length;
  elements.queueSummary.textContent = state.fatal
    ? "Converter unavailable"
    : `${done} converted${failed ? ` · ${failed} failed` : ""} · ${state.files.length - done - failed} pending`;
  elements.zipBtn.hidden = done < 2;

  renderFileList();
  renderOutput();
}

function renderFileList() {
  elements.fileList.replaceChildren();
  for (const record of state.files) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-item";
    button.classList.toggle("is-active", record.id === state.activeId);
    button.dataset.status = record.status;

    const dot = document.createElement("span");
    dot.className = "file-status";
    dot.setAttribute("aria-hidden", "true");

    const meta = document.createElement("span");
    meta.className = "file-meta";

    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = record.name;
    name.title = record.name;

    const sub = document.createElement("span");
    sub.className = "file-sub";
    if (record.status === "error") {
      sub.textContent = record.error || "Conversion failed";
      sub.title = sub.textContent;
    } else if (record.status === "done" && record.stats) {
      sub.textContent = `${record.stats.chars.toLocaleString()} chars · ${record.stats.timeMs} ms`;
    } else {
      sub.textContent = `${formatBytes(record.size)} · ${record.status}`;
    }

    meta.append(name, sub);
    button.append(dot, meta);
    button.addEventListener("click", () => setActive(record.id));
    item.appendChild(button);

    if (record.status === "error" && record.file) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "retry-btn";
      retry.textContent = "Retry";
      retry.addEventListener("click", (event) => {
        event.stopPropagation();
        retryFile(record.id);
      });
      item.appendChild(retry);
    }

    elements.fileList.appendChild(item);
  }
}

function renderOutput() {
  const record = activeFile();
  const hasMarkdown = Boolean(record && record.status === "done" && record.markdown != null);
  const isPreview = state.view === "preview";

  elements.emptyState.hidden = hasMarkdown;
  elements.rawView.hidden = !hasMarkdown || isPreview;
  elements.previewView.hidden = !hasMarkdown || !isPreview;
  elements.copyBtn.disabled = !hasMarkdown;
  elements.downloadBtn.disabled = !hasMarkdown;

  if (!hasMarkdown) {
    elements.rawOutput.textContent = "";
    elements.previewOutput.replaceChildren();
    elements.stats.hidden = true;
    return;
  }

  elements.stats.hidden = false;
  const { chars, words, timeMs } = record.stats || { chars: 0, words: 0, timeMs: 0 };
  elements.stats.textContent = `${chars.toLocaleString()} chars · ${words.toLocaleString()} words · ${timeMs} ms`;

  if (isPreview) {
    renderPreview(record.id, record.markdown);
  } else {
    elements.rawOutput.textContent = record.markdown;
  }
}

async function renderPreview(fileId, markdown) {
  try {
    const { marked, purify } = await loadLibraries();
    if (state.activeId !== fileId || state.view !== "preview") return;
    const html = marked.parse(markdown, { async: false, gfm: true, breaks: false });
    elements.previewOutput.innerHTML = purify.sanitize(html, { USE_PROFILES: { html: true } });
  } catch {
    if (state.activeId === fileId) {
      toast("Preview unavailable. Please try again.", true);
    }
  }
}

function setView(view) {
  state.view = view;
  elements.tabRaw.classList.toggle("is-active", view === "raw");
  elements.tabPreview.classList.toggle("is-active", view === "preview");
  elements.tabRaw.setAttribute("aria-selected", String(view === "raw"));
  elements.tabPreview.setAttribute("aria-selected", String(view === "preview"));
  renderOutput();
}

/* ------------------------------ export actions ------------------------------ */

async function copyMarkdown() {
  const record = activeFile();
  if (!record || record.markdown == null) return;
  try {
    await navigator.clipboard.writeText(record.markdown);
    toast("Markdown copied to clipboard.");
  } catch (_) {
    const helper = document.createElement("textarea");
    helper.value = record.markdown;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    const copied = document.execCommand("copy");
    helper.remove();
    toast(copied ? "Markdown copied to clipboard." : "Copy failed — select the text manually.", !copied);
  }
}

function downloadActive() {
  const record = activeFile();
  if (!record || record.markdown == null) return;
  const blob = new Blob([record.markdown], { type: "text/markdown;charset=utf-8" });
  downloadBlob(blob, `${baseName(record.name)}.md`);
}

async function downloadAll() {
  const converted = state.files.filter((item) => item.status === "done" && item.markdown != null);
  if (converted.length < 2) return;
  try {
    const { JSZip } = await loadLibraries();
    const zip = new JSZip();
    const used = new Set();
    for (const record of converted) {
      let filename = `${baseName(record.name)}.md`;
      let counter = 2;
      while (used.has(filename)) {
        filename = `${baseName(record.name)}-${counter}.md`;
        counter += 1;
      }
      used.add(filename);
      zip.file(filename, record.markdown);
    }
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `converted-documents-${stamp}.zip`);
  } catch {
    toast("Could not build the ZIP. Please try again.", true);
  }
}

/* ------------------------------ events ------------------------------ */

function setupUploads() {
  elements.pickBtn.addEventListener("click", () => elements.fileInput.click());
  elements.addMore.addEventListener("click", () => elements.fileInput.click());
  elements.fileInput.addEventListener("change", () => {
    handleFiles(elements.fileInput.files);
    elements.fileInput.value = "";
  });

  elements.dropzone.addEventListener("click", (event) => {
    if (event.target === elements.pickBtn) return;
    elements.fileInput.click();
  });
  elements.dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      elements.fileInput.click();
    }
  });

  for (const name of ["dragenter", "dragover"]) {
    elements.dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      elements.dropzone.classList.add("is-dragging");
    });
  }
  for (const name of ["dragleave", "dragend"]) {
    elements.dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      if (event.target === elements.dropzone) elements.dropzone.classList.remove("is-dragging");
    });
  }
  elements.dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.dropzone.classList.remove("is-dragging");
    handleFiles(event.dataTransfer && event.dataTransfer.files);
  });

  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());
}

function setupControls() {
  elements.tabRaw.addEventListener("click", () => setView("raw"));
  elements.tabPreview.addEventListener("click", () => setView("preview"));
  elements.copyBtn.addEventListener("click", copyMarkdown);
  elements.downloadBtn.addEventListener("click", downloadActive);
  elements.zipBtn.addEventListener("click", downloadAll);
}

setupTheme();
setupUploads();
setupControls();
setupInstallPrompt();
registerServiceWorker();
startWorker();
