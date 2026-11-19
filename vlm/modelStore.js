/**
 * modelStore.js — explicit, cancellable model downloads.
 *
 * Model files reach the browser only through download(), which the settings
 * page calls when the visitor presses Download. Files are streamed straight
 * into the Cache Storage bucket Transformers.js reads ('transformers-cache'),
 * under the same URLs it would use, so the worker can then load the model with
 * the network switched off.
 *
 * What "downloaded" means is derived from Cache Storage every time it is asked:
 * a model counts only when every file its device needs is present. An entry is
 * written only after its whole body arrived and its byte count matched the
 * repository listing, so a half-finished file never exists, and a model with
 * some files missing is simply "not downloaded" (the next download resumes at
 * the first missing file).
 */

import {
    HF_HOST, MODEL_CACHE_NAME, RUNTIME_FILE,
    listModels, getModel, registerModel, modelFileUrl, modelUrlPrefix,
    resolvePlan, estimatedBytes, assessFit, isMobileDevice, formatBytes,
} from './modelCatalog.js';

const CHANNEL_NAME = 'tds-vlm-models';
const LOCK_PREFIX = 'tds-vlm-download:';
const INTENT_KEY = 'tdsVlmDownloadIntent';
const PERSIST_KEY = 'tdsVlmPersistAsked';
/** Contract: at most four progress events per second while downloading. */
export const PROGRESS_INTERVAL_MS = 250;
/** A download interrupted by navigation resumes on the next page if it was active this recently. */
const INTENT_TTL_MS = 10 * 60 * 1000;
const MODEL_URL_RE = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/main\/(.+)$/;

class DownloadCancelled extends Error {
    constructor() { super('Download cancelled'); this.name = 'AbortError'; }
}

function safe(fn, fallback = null) { try { return fn(); } catch (_) { return fallback; } }

/**
 * @param {object} [env]  Injection points for tests; every field defaults to the browser global.
 */
export function createModelStore(env = {}) {
    const root = env.root ?? globalThis;
    const nav = env.navigator ?? root.navigator;
    const doFetch = env.fetch ?? ((...args) => root.fetch(...args));
    const cacheStorage = () => env.caches ?? safe(() => root.caches);
    const storage = env.localStorage ?? (root.document ? safe(() => root.localStorage) : null);
    const runtimeFile = env.runtimeFile ?? RUNTIME_FILE;
    const now = env.now ?? (() => Date.now());
    const setTimer = env.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    const clearTimer = env.clearTimeout ?? (id => globalThis.clearTimeout(id));

    /** modelId → { controller, loaded, total, promise, written: string[] } for downloads running in this page. */
    const jobs = new Map();
    /** modelId → { loaded, total } for downloads running in another tab. */
    const remote = new Map();
    /** modelId → last failure message, shown in settings until the next attempt. */
    const failures = new Map();
    /** modelId → { time, timer, pending } for throttling progress events. */
    const throttle = new Map();
    /** url → bytes, valid until the entry is deleted. */
    const sizes = new Map();
    let deviceClassPromise = null;
    let unloading = false;

    // Only real pages (or tests that inject one) open a channel; a bare Node import must not hold one open.
    const channel = safe(() => {
        const Channel = env.BroadcastChannel ?? (root.document ? root.BroadcastChannel : null);
        return Channel ? new Channel(CHANNEL_NAME) : null;
    });

    // ── Events ──────────────────────────────────────────────────────────────

    function dispatch(detail) {
        const target = env.eventTarget ?? root;
        if (typeof target?.dispatchEvent !== 'function' || typeof root.CustomEvent !== 'function') return;
        target.dispatchEvent(new root.CustomEvent('vlm-model-state', { detail }));
    }

    /** Dispatch on this page and, for download states, mirror to other tabs of the origin. */
    function publish(detail, { broadcast = true } = {}) {
        dispatch(detail);
        if (broadcast) safe(() => channel?.postMessage({ type: 'state', detail }));
    }

    /** Announce a state. Progress ticks are throttled; every other change goes out at once. */
    function announce(detail, options = {}) {
        const key = detail.modelId;
        const slot = throttle.get(key) ?? { time: -Infinity, timer: null, pending: null };
        throttle.set(key, slot);
        const isTick = detail.state === 'downloading' && !options.force;
        if (!isTick) {
            if (slot.timer !== null) clearTimer(slot.timer);
            slot.timer = null; slot.pending = null;
            if (detail.state === 'downloading') slot.time = now();
            publish(detail, options);
            return;
        }
        const wait = PROGRESS_INTERVAL_MS - (now() - slot.time);
        if (wait <= 0 && slot.timer === null) {
            slot.time = now();
            publish(detail, options);
            return;
        }
        slot.pending = detail;
        if (slot.timer === null) {
            slot.timer = setTimer(() => {
                slot.timer = null;
                const latest = slot.pending; slot.pending = null;
                if (!latest) return;
                slot.time = now();
                publish(latest, options);
            }, Math.max(0, wait));
        }
    }

    if (channel) {
        channel.onmessage = (event) => {
            const data = event.data ?? {};
            if (data.type === 'cancel') { jobs.get(data.modelId)?.controller.abort(new DownloadCancelled()); return; }
            if (data.type !== 'state' || !data.detail?.modelId) return;
            const { modelId, state, loaded, total, message } = data.detail;
            if (state === 'downloading') remote.set(modelId, { loaded: loaded ?? 0, total: total ?? 0 });
            else {
                remote.delete(modelId);
                invalidate(modelId);
                if (message && state === 'not-downloaded' && message !== 'Download cancelled') failures.set(modelId, message); else failures.delete(modelId);
            }
            dispatch(data.detail);
        };
    }
    safe(() => root.addEventListener?.('pagehide', () => { unloading = true; }));
    safe(() => root.addEventListener?.('pageshow', () => { unloading = false; }));

    // ── Cache inspection ────────────────────────────────────────────────────

    async function openCache(create = false) {
        const storageApi = cacheStorage();
        if (!storageApi) return null;
        try {
            if (!create && !(await storageApi.has(MODEL_CACHE_NAME))) return null;
            return await storageApi.open(MODEL_CACHE_NAME);
        } catch (_) { return null; }
    }

    /** modelId → Map(path → url) for everything cached from the model host. */
    async function index() {
        const byModel = new Map();
        const cache = await openCache();
        if (!cache) return byModel;
        let requests = [];
        try { requests = await cache.keys(); } catch (_) { return byModel; }
        for (const request of requests) {
            const url = typeof request === 'string' ? request : request.url;
            const match = MODEL_URL_RE.exec(url);
            if (!match) continue;
            const files = byModel.get(match[1]) ?? new Map();
            files.set(decodeURIComponent(match[2]), url);
            byModel.set(match[1], files);
        }
        return byModel;
    }

    function invalidate(modelId) {
        const prefix = modelUrlPrefix(modelId);
        for (const url of sizes.keys()) if (url.startsWith(prefix)) sizes.delete(url);
    }

    async function entrySize(cache, url) {
        if (sizes.has(url)) return sizes.get(url);
        let size = 0;
        try {
            const response = await cache.match(url);
            if (response) {
                const header = response.headers.get('Content-Length');
                // A Content-Length stored with a compressed transfer describes the wire size, not the body.
                if (header && !response.headers.get('Content-Encoding')) size = parseInt(header, 10) || 0;
                else size = (await response.blob()).size;
            }
        } catch (_) { /* unreadable entry counts as zero */ }
        sizes.set(url, size);
        return size;
    }

    function deviceClass() {
        deviceClassPromise ??= (async () => {
            if (env.deviceClass) return env.deviceClass;
            const gpu = nav?.gpu;
            if (!gpu) return 'wasm';
            try {
                const adapter = await Promise.race([
                    gpu.requestAdapter(),
                    new Promise((_, reject) => setTimer(() => reject(new Error('timeout')), 3000)),
                ]);
                if (!adapter) return 'wasm';
                return adapter.features?.has?.('shader-f16') ? 'webgpu-f16' : 'webgpu';
            } catch (_) { return 'wasm'; }
        })();
        return deviceClassPromise;
    }

    /**
     * Which cached files this device would load for a model.
     * `complete` is the single definition of "downloaded".
     */
    async function resolve(modelId, forClass = null, cachedIndex = null) {
        const model = getModel(modelId);
        const cls = forClass ?? await deviceClass();
        const files = (cachedIndex ?? await index()).get(modelId) ?? new Map();
        const plan = model ? resolvePlan(model, new Set(files.keys()), cls) : { complete: false, dtype: {}, files: [], missing: [] };
        return { ...plan, modelId, deviceClass: cls, device: cls === 'wasm' ? 'wasm' : 'webgpu', cachedFiles: files };
    }

    async function lockHeld(modelId) {
        try {
            const state = await nav?.locks?.query?.();
            return !!state?.held?.some(lock => lock.name === LOCK_PREFIX + modelId);
        } catch (_) { return false; }
    }

    async function status(modelId) {
        if (jobs.has(modelId)) return 'downloading';
        if (await lockHeld(modelId)) return 'downloading';
        remote.delete(modelId);
        return (await resolve(modelId)).complete ? 'downloaded' : 'not-downloaded';
    }

    function progress(modelId) {
        const job = jobs.get(modelId);
        if (job) return { loaded: job.loaded, total: job.total };
        const other = remote.get(modelId);
        return other ? { loaded: other.loaded, total: other.total } : null;
    }

    /** Everything the settings row needs for one model, from one cache snapshot. */
    async function inspect(modelId, cachedIndex = null, held = null) {
        const model = getModel(modelId);
        const cls = await deviceClass();
        const snapshot = cachedIndex ?? await index();
        const plan = await resolve(modelId, cls, snapshot);
        const cache = plan.cachedFiles.size ? await openCache() : null;
        let cachedBytes = 0;
        if (cache) for (const url of plan.cachedFiles.values()) cachedBytes += await entrySize(cache, url);
        const downloading = jobs.has(modelId) || (held ? held.has(modelId) : await lockHeld(modelId));
        return {
            modelId,
            state: downloading ? 'downloading' : plan.complete ? 'downloaded' : 'not-downloaded',
            progress: progress(modelId),
            cachedBytes,
            fileCount: plan.cachedFiles.size,
            partial: !plan.complete && plan.cachedFiles.size > 0,
            dtype: plan.dtype,
            deviceClass: cls,
            estimate: estimatedBytes(model, cls),
            unavailable: model?.unavailable ?? null,
            message: failures.get(modelId) ?? null,
        };
    }

    async function inspectAll() {
        const snapshot = await index();
        const held = new Set();
        try {
            const state = await nav?.locks?.query?.();
            for (const lock of state?.held ?? []) if (lock.name.startsWith(LOCK_PREFIX)) held.add(lock.name.slice(LOCK_PREFIX.length));
        } catch (_) { /* no Web Locks: only this page's downloads are visible */ }
        const known = new Set(listModels().map(model => model.id));
        const rows = [];
        for (const model of listModels()) rows.push(await inspect(model.id, snapshot, held));
        const others = [];
        const cache = snapshot.size ? await openCache() : null;
        for (const [modelId, files] of snapshot) {
            if (known.has(modelId)) continue;
            let bytes = 0;
            if (cache) for (const url of files.values()) bytes += await entrySize(cache, url);
            others.push({ modelId, cachedBytes: bytes, fileCount: files.size });
        }
        return { models: rows, others };
    }

    async function storageInfo() {
        let usage = null, quota = null, persisted = null;
        try { ({ usage = null, quota = null } = (await nav?.storage?.estimate?.()) ?? {}); } catch (_) { /* unavailable */ }
        try { persisted = (await nav?.storage?.persisted?.()) ?? null; } catch (_) { /* unavailable */ }
        return { usage, quota, persisted, free: usage != null && quota != null ? Math.max(0, quota - usage) : null };
    }

    async function fit(modelId) {
        const model = getModel(modelId);
        if (!model) return { level: 'ok', reasons: [], recommend: null };
        const [cls, store] = await Promise.all([deviceClass(), storageInfo()]);
        return assessFit(model, {
            bytes: estimatedBytes(model, cls), deviceClass: cls, mobile: isMobileDevice(nav),
            deviceMemory: nav?.deviceMemory, freeBytes: store.free ?? undefined,
        });
    }

    // ── Download intent (survives navigation between pages of the site) ────

    function readIntents() { return safe(() => JSON.parse(storage?.getItem(INTENT_KEY) || '{}'), {}) || {}; }
    function writeIntent(modelId, value) {
        safe(() => {
            const intents = readIntents();
            if (value == null) delete intents[modelId]; else intents[modelId] = value;
            if (Object.keys(intents).length) storage?.setItem(INTENT_KEY, JSON.stringify(intents));
            else storage?.removeItem(INTENT_KEY);
        });
    }

    /**
     * Continue downloads the visitor started moments ago on another page of the
     * site (pressing Download, then navigating, aborts the transfer mid-flight).
     * Only an unexpired, never-cancelled, never-failed intent qualifies.
     */
    async function resumePending() {
        const intents = readIntents();
        const resumed = [];
        for (const [modelId, time] of Object.entries(intents)) {
            if (!getModel(modelId) || now() - time > INTENT_TTL_MS) { writeIntent(modelId, null); continue; }
            const current = await status(modelId);
            if (current === 'downloaded') { writeIntent(modelId, null); continue; }
            if (current === 'downloading') continue;
            resumed.push(modelId);
            download(modelId).catch(() => {});
        }
        return resumed;
    }

    // ── Download ────────────────────────────────────────────────────────────

    async function listing(modelId, signal) {
        const response = await doFetch(`${HF_HOST}/api/models/${modelId}/tree/main?recursive=true`, { signal });
        if (!response.ok) throw new Error(`Could not read the file list for ${modelId} (HTTP ${response.status})`);
        const entries = await response.json();
        const files = new Map();
        for (const entry of Array.isArray(entries) ? entries : []) {
            if (entry?.type === 'file' && typeof entry.path === 'string') files.set(entry.path, entry.lfs?.size ?? entry.size ?? 0);
        }
        return files;
    }

    async function fetchInto(cache, file, job) {
        const response = await doFetch(file.url, { signal: job.controller.signal, cache: 'no-store' });
        if (!response.ok || !response.body) throw new Error(`${file.path}: HTTP ${response.status}`);
        let received = 0;
        const counted = response.body.pipeThrough(new TransformStream({
            transform(chunk, controller) {
                received += chunk.byteLength;
                job.loaded += chunk.byteLength;
                job.tick();
                controller.enqueue(chunk);
            },
            flush(controller) {
                // Reject a truncated or substituted body: the entry is never committed.
                if (file.size && received !== file.size) {
                    controller.error(new Error(`${file.path}: expected ${file.size} bytes, received ${received}`));
                }
            },
        }));
        const headers = { 'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream' };
        if (file.size) headers['Content-Length'] = String(file.size);
        try {
            await cache.put(file.url, new Response(counted, { status: 200, headers }));
        } catch (error) {
            job.loaded -= received;
            if (job.controller.signal.aborted) throw job.controller.signal.reason ?? new DownloadCancelled();
            if (error?.name === 'QuotaExceededError') throw new Error('Not enough browser storage for this model. Delete another model and try again.');
            throw error;
        }
        sizes.set(file.url, file.size || received);
        job.written.push(file.url);
    }

    async function run(modelId, job) {
        const model = getModel(modelId);
        const cls = await deviceClass();
        const files = await listing(modelId, job.controller.signal);
        const plan = resolvePlan(model, new Set(files.keys()), cls);
        if (!plan.complete) throw new Error(`${model.name} is missing files for this device: ${plan.missing.join(', ')}`);

        const cache = await openCache(true);
        if (!cache) throw new Error('Browser storage (Cache API) is not available, so models cannot be saved.');

        const wanted = plan.files
            .map(path => ({ path, url: modelFileUrl(modelId, path), size: files.get(path) ?? 0 }))
            .sort((a, b) => a.size - b.size);   // small files first: fail fast on a broken repository
        wanted.unshift(runtimeFile);

        const pending = [];
        job.total = 0; job.loaded = 0;
        for (const file of wanted) {
            const present = !!(await cache.match(file.url));
            if (file.runtime && present) continue;   // shared runtime already stored: not part of this download
            job.total += file.size;
            if (present) job.loaded += file.size; else pending.push(file);
        }
        job.tick(true);
        for (const file of pending) {
            if (job.controller.signal.aborted) throw job.controller.signal.reason ?? new DownloadCancelled();
            await fetchInto(cache, file, job);
        }
        if (!(await resolve(modelId, cls)).complete) throw new Error('Downloaded files could not be verified in browser storage.');
    }

    async function requestPersistence() {
        // Ask once: persisted storage is exempt from automatic eviction under storage pressure.
        if (safe(() => storage?.getItem(PERSIST_KEY))) return;
        safe(() => storage?.setItem(PERSIST_KEY, '1'));
        try { if (!(await nav?.storage?.persisted?.())) await nav?.storage?.persist?.(); } catch (_) { /* best effort */ }
    }

    async function discard(urls) {
        const cache = await openCache();
        if (!cache) return;
        await Promise.all(urls.map(url => { sizes.delete(url); return cache.delete(url).catch(() => false); }));
    }

    function startJob(modelId) {
        const job = {
            controller: new AbortController(), loaded: 0, total: 0, written: [], lastIntent: 0,
            tick(force = false) {
                announce({ modelId, state: 'downloading', loaded: job.loaded, total: job.total }, { force });
                if (now() - job.lastIntent > 5000) { job.lastIntent = now(); writeIntent(modelId, now()); }
            },
        };
        jobs.set(modelId, job);
        failures.delete(modelId);
        writeIntent(modelId, now());
        job.tick(true);

        job.promise = (async () => {
            try {
                await run(modelId, job);
                jobs.delete(modelId);
                writeIntent(modelId, null);
                announce({ modelId, state: 'downloaded', loaded: job.total, total: job.total });
                requestPersistence();
            } catch (error) {
                jobs.delete(modelId);
                const cancelled = error instanceof DownloadCancelled || (job.controller.signal.aborted && job.controller.signal.reason instanceof DownloadCancelled);
                if (unloading && !cancelled) throw error;   // page is navigating away: keep the intent so the next page resumes
                writeIntent(modelId, null);
                if (cancelled) {
                    // Cancel returns the storage this run used; files that were already there stay.
                    await discard(job.written);
                    announce({ modelId, state: (await resolve(modelId)).complete ? 'downloaded' : 'not-downloaded', message: 'Download cancelled' });
                    throw new DownloadCancelled();
                }
                const message = error?.message || 'Download failed';
                failures.set(modelId, message);
                announce({ modelId, state: 'not-downloaded', message });
                throw error instanceof Error ? error : new Error(message);
            }
        })();
        return job.promise;
    }

    /**
     * Download every file this device needs for a model. Resolves once the
     * model is fully cached; rejects on failure or cancel. Safe to call twice:
     * the second call joins the download already running (in this tab or another).
     */
    function download(modelId) {
        const model = getModel(modelId);
        if (!model) return Promise.reject(new Error(`Unknown model: ${modelId}`));
        if (model.unavailable) return Promise.reject(new Error(`${model.name}: ${model.unavailable}`));
        const running = jobs.get(modelId);
        if (running) return running.promise;

        const locks = nav?.locks;
        if (!locks?.request) return startJob(modelId);

        // One download per model across all tabs; a second tab follows the first one's progress.
        let outcome;
        const result = new Promise((resolveOutcome, rejectOutcome) => { outcome = { resolve: resolveOutcome, reject: rejectOutcome }; });
        locks.request(LOCK_PREFIX + modelId, { ifAvailable: true }, async (lock) => {
            if (!lock) { followRemote(modelId, outcome); return; }
            try { await (jobs.get(modelId)?.promise ?? startJob(modelId)); outcome.resolve(); }
            catch (error) { outcome.reject(error); }
        }).catch(error => outcome.reject(error));
        return result;
    }

    /**
     * Another tab is downloading this model. Queue behind its lock: the request
     * is granted when that download ends (or its tab closes), and the cache then
     * says how it went.
     */
    function followRemote(modelId, outcome) {
        nav.locks.request(LOCK_PREFIX + modelId, async () => {}).then(async () => {
            if ((await resolve(modelId)).complete) outcome.resolve();
            else outcome.reject(new Error('The download did not finish in the other tab.'));
        }, outcome.reject);
    }

    /** Stop a download. If another tab owns it, ask that tab to stop. */
    function cancel(modelId) {
        const job = jobs.get(modelId);
        if (job) job.controller.abort(new DownloadCancelled());
        else {
            writeIntent(modelId, null);
            safe(() => channel?.postMessage({ type: 'cancel', modelId }));
        }
    }

    /** Delete a model's files (the shared runtime stays for the other models). */
    async function remove(modelId) {
        const job = jobs.get(modelId);
        if (job) {
            job.controller.abort(new DownloadCancelled());
            await job.promise.catch(() => {});
        }
        writeIntent(modelId, null);
        failures.delete(modelId);
        const prefix = modelUrlPrefix(modelId);
        const storageApi = cacheStorage();
        if (storageApi) {
            // Older versions of the site may have left model files in other buckets; sweep them all.
            for (const name of await storageApi.keys().catch(() => [])) {
                try {
                    const cache = await storageApi.open(name);
                    const requests = await cache.keys();
                    await Promise.all(requests.filter(request => request.url.startsWith(prefix)).map(request => cache.delete(request)));
                } catch (_) { /* unreadable bucket */ }
            }
        }
        invalidate(modelId);
        announce({ modelId, state: 'not-downloaded' });
    }

    /** Delete every cached model and the runtime. */
    async function removeAll() {
        for (const [modelId, job] of jobs) {
            job.controller.abort(new DownloadCancelled());
            await job.promise.catch(() => {});
            writeIntent(modelId, null);
        }
        const snapshot = await index();
        const storageApi = cacheStorage();
        if (storageApi) {
            for (const name of await storageApi.keys().catch(() => [])) {
                try {
                    if (name === MODEL_CACHE_NAME) { await storageApi.delete(name); continue; }
                    const cache = await storageApi.open(name);
                    const requests = await cache.keys();
                    await Promise.all(requests.filter(request => request.url.startsWith(`${HF_HOST}/`)).map(request => cache.delete(request)));
                } catch (_) { /* unreadable bucket */ }
            }
        }
        sizes.clear(); failures.clear();
        const affected = new Set([...snapshot.keys(), ...listModels().map(model => model.id)]);
        for (const modelId of affected) announce({ modelId, state: 'not-downloaded' });
    }

    return {
        get catalog() { return listModels(); },
        /** True on phones and tablets; steers the recommendation toward the smallest model. */
        mobile: isMobileDevice(nav),
        get: getModel,
        register: registerModel,
        formatBytes,
        // Contract with the inspector panel:
        status, download, cancel, remove, progress,
        // Settings page and manager:
        inspect, inspectAll, resolve, deviceClass, fit, storage: storageInfo, removeAll, resumePending, announce,
        runtimeUrl: runtimeFile.url,
        cacheName: MODEL_CACHE_NAME,
    };
}
