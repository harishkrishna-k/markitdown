/* MarkItDown service worker.
 *
 * - Network-first for the HTML shell and version.json (spot new upstream builds).
 * - Cache-first for immutable Pyodide / PyPI / wheel assets (instant offline loads).
 */

const CACHE_NAME = "markitdown-app-v6";
const CACHE_PREFIX = "markitdown-";

const SCOPE = new URL("./", self.location.href);
const scoped = (path) => new URL(path, SCOPE).href;
const pathOf = (path) => new URL(path, SCOPE).pathname;

const ROOT_URL = SCOPE.href;
const INDEX_URL = scoped("index.html");
const VERSION_URL = scoped("version.json");
const VERSION_KEY = scoped("__synced_version__");

const ROOT_PATH = pathOf("./");
const INDEX_PATH = pathOf("index.html");
const VERSION_PATH = pathOf("version.json");

const PYODIDE_BASE = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";

const PRECACHE_URLS = [
  ROOT_URL,
  INDEX_URL,
  VERSION_URL,
  scoped("styles.css"),
  scoped("app.js"),
  scoped("worker.js"),
  scoped("manifest.json"),
  scoped("icons/icon.svg"),
  scoped("icons/icon-192.png"),
  scoped("icons/icon-512.png"),
  `${PYODIDE_BASE}pyodide.js`,
  `${PYODIDE_BASE}pyodide-lock.json`,
  "https://cdn.jsdelivr.net/npm/marked@15/+esm",
  "https://cdn.jsdelivr.net/npm/dompurify@3/+esm",
  "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm",
];

function wheelUrl(filename) {
  return scoped(filename);
}

async function pruneWheels(currentFilename) {
  const cache = await caches.open(CACHE_NAME);
  let current = currentFilename;

  if (!current) {
    const marker = await cache.match(VERSION_KEY);
    if (marker) {
      try {
        current = (await marker.json()).wheel || null;
      } catch (_) {
        current = null;
      }
    }
  }

  const currentHref = current ? wheelUrl(current) : null;
  for (const request of await cache.keys()) {
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || !/(?:^|\/)wheels\/markitdown-[^/]+\.whl$/.test(url.pathname)) {
      continue;
    }
    const isCurrent = currentHref
      ? url.href === currentHref || url.pathname.endsWith(`/${String(current).split("/").pop()}`)
      : false;
    if (!isCurrent) await cache.delete(request);
  }
}

async function rememberVersion(response) {
  try {
    const data = await response.clone().json();
    if (!data || !data.wheel) return;
    const cache = await caches.open(CACHE_NAME);
    await cache.put(
      VERSION_KEY,
      new Response(JSON.stringify({ wheel: data.wheel, sha: data.sha || null }), {
        headers: { "content-type": "application/json" },
      }),
    );
    await pruneWheels(data.wheel);
  } catch (_) {
    /* A malformed version.json must never break navigation. */
  }
}

async function networkFirst(request, isNavigation) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await cache.put(request, response.clone());
      if (isNavigation) await cache.put(INDEX_URL, response.clone());
      if (new URL(request.url).pathname === VERSION_PATH) await rememberVersion(response.clone());
    }
    return response;
  } catch (error) {
    const cached =
      (await cache.match(request)) ||
      (isNavigation ? await cache.match(INDEX_URL) : null) ||
      (await cache.match(ROOT_URL));
    if (cached) return cached;
    if (isNavigation) {
      return new Response(
        "<!doctype html><meta charset=utf-8><title>Offline</title><h1>You are offline</h1><p>Reconnect once to cache the app.</p>",
        { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && (response.ok || response.type === "opaque")) {
    await cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(async (response) => {
      if (response && (response.ok || response.type === "opaque")) {
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) return cached;
  const response = await network;
  return response || (await cache.match(request)) || Response.error();
}

function isExternalCacheable(url) {
  return (
    url.hostname === "cdn.jsdelivr.net" ||
    url.hostname === "files.pythonhosted.org" ||
    url.hostname === "pypi.org"
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.allSettled(
        PRECACHE_URLS.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => undefined)),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
      await pruneWheels();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (request.mode === "navigate" || url.pathname === ROOT_PATH || url.pathname === INDEX_PATH) {
      event.respondWith(networkFirst(request, true));
    } else if (url.pathname === VERSION_PATH) {
      event.respondWith(networkFirst(request, false));
    } else if (url.pathname.includes("/wheels/")) {
      event.respondWith(cacheFirst(request));
    } else {
      event.respondWith(staleWhileRevalidate(request));
    }
    return;
  }

  if (isExternalCacheable(url)) {
    event.respondWith(cacheFirst(request));
  }
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING" || (event.data && event.data.type === "SKIP_WAITING")) {
    self.skipWaiting();
  }
});
