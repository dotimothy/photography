/**
 * vlmWorker.js — local model worker for TheDoInspector.
 *
 * Runs entirely off the main thread and loads models from browser storage
 * only. The page downloads model files when the visitor presses Download in
 * Settings > AI Inspector (vlm/modelStore.js); this worker never does.
 *
 * Three layers keep that true:
 *   1. Remote loading is disabled in the library's env and every
 *      from_pretrained call asks for local files only, so Transformers.js reads
 *      Cache Storage ('transformers-cache') and refuses to fall back to the hub
 *      (utils/hub.js: getModelFile).
 *   2. A fetch guard that answers 404 to everything except the pinned runtime
 *      directory on the CDN, so even a misconfiguration cannot download a model.
 *   3. VLMManager only starts this worker after the store reports the model as
 *      fully downloaded.
 *
 * Message protocol
 *   in   { type: 'load', modelId, plan, fallback?, family, imageSplitting? }
 *        { type: 'generate', id, image? (ImageBitmap) | imageSrc?, imageKey?, prompt, chatHistory, maxNewTokens?, temperature? }
 *        { type: 'abort', id }
 *   out  progress { stage, message, pct } · ready { device, dtype, loadMs, heapMB }
 *        warm { warmupMs } · generating { id } · token { id, token, tps, tokenCount }
 *        done { id, text, tokenCount, avgTps, stats } · error { id?, message }
 */

import {
    AutoProcessor,
    AutoModelForVision2Seq,
    AutoModelForImageTextToText,
    RawImage,
    TextStreamer,
    StoppingCriteria,
    env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
import { MODEL_CACHE_NAME, RUNTIME_FILE, TRANSFORMERS_DIST, TRANSFORMERS_VERSION } from './modelCatalog.js';
import { createFetchGuard, createInferenceEngine, describeLoadError } from './vlmRuntime.js';

// ─── Network policy ──────────────────────────────────────────────────────────

const nativeFetch = self.fetch.bind(self);
const blockedRequests = [];
// Transformers.js and ONNX Runtime resolve `fetch` at call time, so replacing it
// here covers every request they make. The runtime directory stays reachable for
// visitors whose model was cached before the runtime was stored alongside it.
self.fetch = createFetchGuard(nativeFetch, {
    allow: [TRANSFORMERS_DIST],
    onBlocked: (url) => { if (blockedRequests.length < 50) blockedRequests.push(url); },
});

// Remote loading is off; the library then insists that "local" loading is on.
// A cache miss makes it probe env.localModelPath on this origin, which the guard
// answers with 404 without touching the network.
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = typeof caches !== 'undefined';

if (env.version !== TRANSFORMERS_VERSION) {
    console.warn(`[vlmWorker] Transformers.js ${env.version} loaded, catalog expects ${TRANSFORMERS_VERSION}`);
}

// WASM threads are left at ONNX Runtime's default (min(4, cores / 2), and only
// when the page is cross-origin isolated). GitHub Pages cannot send the COOP/COEP
// headers isolation needs, so the CPU path is single-threaded there regardless.
// wasm.proxy stays off: this code already runs in a worker, and proxying would
// stop Transformers.js from keeping the key/value cache on the GPU.

// ─── State ───────────────────────────────────────────────────────────────────

let processor = null;
let model = null;
let engine = null;
let device = 'wasm';
let loadPromise = null;
let warmupPromise = null;
let isProcessing = false;
const aborted = new Set();
const queue = [];

function post(message, transfer) { self.postMessage(message, transfer ?? []); }

/** JS heap in MB. performance.memory is Chromium-only. */
function heapMB() {
    const memory = typeof performance !== 'undefined' && performance.memory;
    return memory ? Math.round(memory.usedJSHeapSize / 1_048_576) : null;
}

/**
 * Confirm a WebGPU adapter can actually be acquired from inside the worker.
 * navigator.gpu exists on some mobile browsers where the adapter request fails.
 */
async function webgpuUsable() {
    if (typeof navigator === 'undefined' || !navigator.gpu) return false;
    try {
        const adapter = await Promise.race([
            navigator.gpu.requestAdapter(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('GPU adapter request timed out')), 3000)),
        ]);
        return !!adapter;
    } catch (error) {
        console.warn('[vlmWorker] WebGPU adapter check failed:', error.message);
        return false;
    }
}

/** Hand ONNX Runtime its WebAssembly binary from browser storage instead of the CDN. */
async function useStoredRuntime() {
    if (typeof caches === 'undefined' || env.backends?.onnx?.wasm?.wasmBinary) return;
    try {
        const cache = await caches.open(MODEL_CACHE_NAME);
        const stored = await cache.match(RUNTIME_FILE.url);
        if (stored) env.backends.onnx.wasm.wasmBinary = await stored.arrayBuffer();
    } catch (_) { /* fall back to the CDN copy, which the fetch guard allows */ }
}

// ─── Loading ─────────────────────────────────────────────────────────────────

async function loadWith(modelId, plan, request) {
    post({ type: 'progress', stage: 'proc', message: `Loading processor… [${plan.device.toUpperCase()}]`, pct: 5 });

    // No progress_callback: without one the library reads each cached file with a
    // single arrayBuffer() call instead of a chunked copy loop.
    processor = await AutoProcessor.from_pretrained(modelId, { local_files_only: true });

    post({ type: 'progress', stage: 'compile', message: 'Initialising ONNX runtime…', heapMB: heapMB(), pct: 60 });

    const ModelClass = request.family === 'fastvlm' ? AutoModelForImageTextToText : AutoModelForVision2Seq;
    model = await ModelClass.from_pretrained(modelId, {
        local_files_only: true,
        dtype: plan.dtype,
        device: plan.device,
    });

    engine = createInferenceEngine({
        lib: { TextStreamer, StoppingCriteria },
        processor, model,
        family: request.family,
        imageSplitting: !!request.imageSplitting,
    });
}

async function load(request) {
    const { modelId } = request;
    const started = performance.now();

    if (typeof caches === 'undefined') {
        post({ type: 'error', message: 'Browser storage is not available to background workers here, so local models cannot load.' });
        return;
    }
    await useStoredRuntime();

    const plans = [request.plan, request.fallback].filter(Boolean);
    const gpuOk = plans.some(plan => plan.device === 'webgpu') ? await webgpuUsable() : false;
    const attempts = plans.filter(plan => plan.device !== 'webgpu' || gpuOk);
    let failure = plans.length && !attempts.length ? new Error('WebGPU is not available and no CPU files are downloaded') : new Error('No load plan supplied');

    let active = null;
    for (const plan of attempts) {
        try {
            await loadWith(modelId, plan, request);
            active = plan;
            break;
        } catch (error) {
            failure = error;
            console.warn(`[vlmWorker] ${plan.device} load failed:`, error.message);
            try { await model?.dispose?.(); } catch (_) { /* partially constructed */ }
            processor = null; model = null; engine = null;
        }
    }
    if (!active) {
        post({ type: 'error', message: `Load failed: ${describeLoadError(failure.message)}`, blocked: blockedRequests.slice() });
        return;
    }

    device = active.device;
    // Ready first so the panel unlocks; shader compilation and graph warm-up run
    // behind it, and the first question waits for that to finish.
    post({
        type: 'ready', device, dtype: active.dtype, heapMB: heapMB(),
        loadMs: Math.round(performance.now() - started), blocked: blockedRequests.length,
    });

    warmupPromise = (async () => {
        try {
            const dummy = new RawImage(new Uint8ClampedArray(32 * 32 * 3).fill(200), 32, 32, 3);
            const warmupMs = await engine.warmup(dummy);
            post({ type: 'warm', warmupMs, heapMB: heapMB() });
        } catch (_) { /* warm-up failure is not fatal */ }
    })().finally(() => { warmupPromise = null; });
}

// ─── Inference ───────────────────────────────────────────────────────────────

async function toRawImage(request) {
    if (request.image) {
        // Decoded and sized on the main thread, transferred without a copy.
        const bitmap = request.image;
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        bitmap.close?.();
        return RawImage.fromCanvas(canvas);
    }
    // Fallback for browsers that could not prepare a bitmap: fetch the picture
    // itself (never a model file) with the unguarded fetch.
    const response = await nativeFetch(request.imageSrc);
    if (!response.ok) throw new Error(`Unable to read image (${response.status})`);
    return RawImage.fromBlob(await response.blob());
}

async function runInference(request) {
    const { id } = request;
    isProcessing = true;
    try {
        if (loadPromise) await loadPromise;
        if (!engine) throw new Error('Model is not loaded');
        if (aborted.has(id)) { post({ type: 'done', id, text: '', tokenCount: 0, avgTps: null }); return; }

        post({ type: 'generating', id });
        if (warmupPromise) await warmupPromise;

        const image = await toRawImage(request);
        const result = await engine.generate({
            image,
            imageKey: request.imageKey ?? null,
            prompt: request.prompt,
            chatHistory: request.chatHistory ?? [],
            maxNewTokens: request.maxNewTokens,
            temperature: request.temperature,
        }, {
            onText: (token, meta) => post({ type: 'token', id, token, tps: meta?.tps ?? null, tokenCount: meta?.tokenCount ?? 0 }),
            shouldStop: () => aborted.has(id),
        });
        result.stats.device = device;
        result.stats.heapMB = heapMB();
        post({ type: 'done', id, ...result });
    } catch (error) {
        request.image?.close?.();
        post({ type: 'error', id, message: error.message });
    } finally {
        aborted.delete(id);
        isProcessing = false;
        drainQueue();
    }
}

function drainQueue() {
    if (!isProcessing && queue.length > 0) runInference(queue.shift());
}

// ─── Message router ──────────────────────────────────────────────────────────

self.onmessage = (event) => {
    const data = event.data;
    switch (data.type) {
        case 'load':
            loadPromise = load(data).catch((error) => post({ type: 'error', message: `Load failed: ${error.message}` }));
            break;
        case 'generate':
            queue.push(data);
            drainQueue();
            break;
        case 'abort':
            if (data.id != null) aborted.add(data.id);
            break;
    }
};
