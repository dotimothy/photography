// Service Worker — TheDoShoots
// Build-injected: __BUILD_TIME__ replaced at deploy time by modules/builder.py.
const BUILD = '__BUILD_TIME__';
const STATIC_CACHE = `tds-static-${BUILD}`;
const IMAGE_CACHE  = `tds-images-${BUILD}`;
const RUNTIME_CACHE = `tds-runtime-${BUILD}`;

const CORE_ASSETS = [
    './',
    './index.html',
    './about.html',
    './linktree.html',
    './manifest.json',
    './assets/icon-192.png',
    './assets/icon-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then(cache => cache.addAll(CORE_ASSETS).catch(() => {}))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.filter(k => k.startsWith('tds-') && ![STATIC_CACHE, IMAGE_CACHE, RUNTIME_CACHE].includes(k))
                .map(k => caches.delete(k))
        )).then(() => self.clients.claim())
    );
});

function isThumbRequest(url) {
    return /\/portfolios\/[^/]+\/thumbs\//.test(url.pathname);
}
function isMetadataRequest(url) {
    return /\/portfolios\/[^/]+\/metadata\//.test(url.pathname) || /\/assets\/search-index\.json$/.test(url.pathname);
}
function isCoreAsset(url) {
    if (url.origin !== location.origin) return false;
    const p = url.pathname;
    if (p === '/' || p.endsWith('/index.html') || p.endsWith('/about.html') || p.endsWith('/linktree.html') || p.endsWith('/license.html')) return true;
    if (p.endsWith('.css') || p.endsWith('.js')) return true;
    if (/\/portfolios\/[^/]+\/(index|immersive|license)\.html$/.test(p)) return true;
    if (/\/portfolios\/[^/]+\/(css|js)\//.test(p)) return true;
    return false;
}
function isHtmlPage(url) {
    if (url.origin !== location.origin) return false;
    return url.pathname === '/' || url.pathname.endsWith('.html');
}
function isModelAsset(url) {
    // Hands-off: large ML weights, hosted on huggingface, ollama endpoints, etc.
    if (url.host.includes('huggingface.co')) return true;
    if (url.host.includes('cdn-lfs')) return true;
    if (url.pathname.endsWith('.onnx') || url.pathname.endsWith('.bin')) return true;
    if (url.pathname.startsWith('/vlm/') || url.pathname.includes('/vlm/')) return true;
    if (url.host === 'localhost' && url.port === '11434') return true;  // ollama
    return false;
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    // Hands-off: never intercept ML weights, ollama, or hf hub
    if (isModelAsset(url)) return;

    // Network-first for pages so navigation does not retain stale HTML after an update.
    if (isHtmlPage(url)) {
        event.respondWith(
            caches.open(STATIC_CACHE).then(cache =>
                fetch(req).then(resp => {
                    if (resp && resp.ok) cache.put(req, resp.clone()).catch(() => {});
                    return resp;
                }).catch(() => cache.match(req))
            )
        );
        return;
    }

    // Stale-while-revalidate: thumbs + metadata json
    if (url.origin === location.origin && (isThumbRequest(url) || isMetadataRequest(url))) {
        event.respondWith(
            caches.open(IMAGE_CACHE).then(cache =>
                cache.match(req).then(cached => {
                    const network = fetch(req).then(resp => {
                        if (resp && resp.ok) cache.put(req, resp.clone()).catch(() => {});
                        return resp;
                    }).catch(() => cached);
                    return cached || network;
                })
            )
        );
        return;
    }

    // Cache-first: core HTML/CSS/JS
    if (isCoreAsset(url)) {
        event.respondWith(
            caches.open(STATIC_CACHE).then(cache =>
                cache.match(req).then(cached => {
                    if (cached) return cached;
                    return fetch(req).then(resp => {
                        if (resp && resp.ok) cache.put(req, resp.clone()).catch(() => {});
                        return resp;
                    }).catch(() => cached);
                })
            )
        );
        return;
    }

    // Default: pass through, opportunistically cache successful same-origin GETs
    if (url.origin === location.origin) {
        event.respondWith(
            fetch(req).then(resp => {
                if (resp && resp.ok && resp.type === 'basic') {
                    const clone = resp.clone();
                    caches.open(RUNTIME_CACHE).then(c => c.put(req, clone)).catch(() => {});
                }
                return resp;
            }).catch(() => caches.match(req))
        );
    }
});
