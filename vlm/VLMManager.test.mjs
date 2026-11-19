import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VLMManager, IDLE_RELEASE_MS, HIDDEN_RELEASE_MS, imageKey } from './VLMManager.js';
import {
    listModels, getModel, resolvePlan, assessFit, modelFileUrl, estimatedBytes, formatBytes,
    MODEL_CACHE_NAME, TRANSFORMERS_VERSION, SMALLEST_MODEL_ID, RUNTIME_FILE,
} from './modelCatalog.js';
import { createModelStore, PROGRESS_INTERVAL_MS } from './modelStore.js';
import {
    createFetchGuard, TokenBatcher, isRepeating, buildMessages, continuationTurns,
    createInferenceEngine, describeLoadError, TOKEN_FLUSH_MS,
} from './vlmRuntime.js';

const SMOL = 'HuggingFaceTB/SmolVLM-256M-Instruct';
const FAST = 'onnx-community/FastVLM-0.5B-ONNX';
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CONFIGS = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'processor_config.json', 'tokenizer.json', 'tokenizer_config.json'];
const VARIANTS = ['', '_fp16', '_q4', '_q4f16', '_quantized'];
const MODULES = ['embed_tokens', 'vision_encoder', 'decoder_model_merged'];

/** A repository listing shaped like the Hugging Face tree API, with small fake sizes. */
function fakeListing() {
    const files = CONFIGS.map((path, i) => ({ type: 'file', path, size: 200 + i }));
    files.push({ type: 'file', path: 'chat_template.json', size: 90 }, { type: 'file', path: 'README.md', size: 50 });
    files.push({ type: 'directory', path: 'onnx', size: 0 });
    for (const module of MODULES) VARIANTS.forEach((suffix, i) => {
        files.push({ type: 'file', path: `onnx/${module}${suffix}.onnx`, size: 4000 + i * 1000, lfs: { size: 4000 + i * 1000 } });
    });
    return files;
}

function fakeCaches() {
    const buckets = new Map();
    const urlOf = request => (typeof request === 'string' ? request : request.url);
    const bucket = () => {
        const entries = new Map();
        return {
            entries,
            async match(request) {
                const entry = entries.get(urlOf(request));
                return entry ? new Response(entry.body, { headers: entry.headers }) : undefined;
            },
            async put(request, response) {
                const body = new Uint8Array(await response.arrayBuffer());   // rejects if the stream errors
                entries.set(urlOf(request), { body, headers: Object.fromEntries(response.headers) });
            },
            async delete(request) { return entries.delete(urlOf(request)); },
            async keys() { return [...entries.keys()].map(url => ({ url })); },
        };
    };
    return {
        buckets,
        async has(name) { return buckets.has(name); },
        async open(name) { if (!buckets.has(name)) buckets.set(name, bucket()); return buckets.get(name); },
        async keys() { return [...buckets.keys()]; },
        async delete(name) { return buckets.delete(name); },
    };
}

/** Seed a cache the way an older version of the site (Transformers.js itself) would have left it. */
async function seedLegacy(caches, modelId, dtype = { embed_tokens: '_fp16', vision_encoder: '_q4', decoder_model_merged: '_q4' }, skip = []) {
    const cache = await caches.open(MODEL_CACHE_NAME);
    for (const path of [...CONFIGS, ...MODULES.map(module => `onnx/${module}${dtype[module]}.onnx`)]) {
        if (!skip.includes(path)) await cache.put(modelFileUrl(modelId, path), new Response(new Uint8Array(300), { headers: { 'Content-Length': '300' } }));
    }
}

const RUNTIME = { url: 'https://cdn.example/runtime.wasm', path: 'runtime.wasm', size: 3000, runtime: true };

/**
 * A fetch that serves the fake repository. `control` can slow a file down,
 * make it fail or truncate it, so cancel and failure paths can be driven.
 */
function fakeFetch(control = {}) {
    const requests = [];
    const listing = fakeListing();
    const sizeOf = new Map(listing.map(file => [file.path, file.size]));
    const fetcher = async (input, init = {}) => {
        const url = String(input);
        requests.push(url);
        if (init.signal?.aborted) throw init.signal.reason;
        if (url.includes('/api/models/')) return new Response(JSON.stringify(listing), { status: 200 });
        const path = url === RUNTIME.url ? RUNTIME.path : url.split('/resolve/main/')[1];
        const size = url === RUNTIME.url ? RUNTIME.size : sizeOf.get(path);
        if (size == null || control.status?.[path]) return new Response('missing', { status: control.status?.[path] ?? 404 });
        const total = control.truncate?.[path] ?? size;
        let sent = 0;
        const body = new ReadableStream({
            async pull(controller) {
                if (init.signal?.aborted) { controller.error(init.signal.reason); return; }
                if (control.gate?.[path]) await control.gate[path];
                if (control.delay) await tick(control.delay);
                if (init.signal?.aborted) { controller.error(init.signal.reason); return; }
                const chunk = Math.min(500, total - sent);
                if (chunk <= 0) { controller.close(); return; }
                sent += chunk;
                controller.enqueue(new Uint8Array(chunk));
            },
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
    };
    fetcher.requests = requests;
    fetcher.modelRequests = () => requests.filter(url => url.includes('/resolve/main/'));
    return fetcher;
}

function fakeStoreEnv(overrides = {}) {
    const events = [];
    const persist = { asked: 0 };
    const memory = new Map();
    const env = {
        root: {},
        caches: fakeCaches(),
        fetch: fakeFetch(),
        deviceClass: 'webgpu-f16',
        runtimeFile: RUNTIME,
        eventTarget: { dispatchEvent: () => true },
        localStorage: {
            getItem: key => (memory.has(key) ? memory.get(key) : null),
            setItem: (key, value) => memory.set(key, String(value)),
            removeItem: key => memory.delete(key),
        },
        navigator: {
            storage: {
                estimate: async () => ({ usage: 1e6, quota: 5e9 }),
                persisted: async () => false,
                persist: async () => { persist.asked++; return true; },
            },
        },
        ...overrides,
    };
    env.root.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init.detail; } };
    env.eventTarget = { dispatchEvent: (event) => { events.push({ ...event.detail, at: Date.now() }); return true; } };
    return { env, events, persist, memory };
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

test('catalog picks one file set per device class and accepts files cached by earlier versions', () => {
    const model = getModel(SMOL);
    const all = new Set(fakeListing().filter(file => file.type === 'file').map(file => file.path));

    const gpu = resolvePlan(model, all, 'webgpu-f16');
    assert.equal(gpu.complete, true);
    assert.deepEqual(gpu.dtype, { embed_tokens: 'fp16', vision_encoder: 'q4', decoder_model_merged: 'q4' });
    assert.ok(gpu.files.includes('onnx/embed_tokens_fp16.onnx') && gpu.files.includes('tokenizer.json') && gpu.files.includes('chat_template.json'));
    assert.equal(gpu.files.some(path => /README|_quantized|_q4f16/.test(path)), false, 'only the files this device loads');

    // The CPU plan uses the same files, so a WebGPU failure needs no second download.
    assert.deepEqual(resolvePlan(model, all, 'wasm').files, gpu.files);
    // Without shader-f16 Transformers.js rejects fp16, so the embedding table stays 32-bit.
    assert.equal(resolvePlan(model, all, 'webgpu').dtype.embed_tokens, 'q4');

    const legacyCpu = new Set([...CONFIGS, ...MODULES.map(module => `onnx/${module}_q4.onnx`)]);
    assert.equal(resolvePlan(model, legacyCpu, 'wasm').complete, true, 'old q4-only CPU cache still loads');
    assert.equal(resolvePlan(model, legacyCpu, 'webgpu-f16').dtype.embed_tokens, 'q4');

    const partial = new Set([...legacyCpu].filter(path => !path.includes('decoder')));
    assert.equal(resolvePlan(model, partial, 'wasm').complete, false, 'a missing weight file means not downloaded');
    assert.deepEqual(resolvePlan(model, partial, 'wasm').missing, ['onnx/decoder_model_merged_q4.onnx']);
    assert.equal(resolvePlan(model, new Set([...legacyCpu].filter(path => path !== 'tokenizer.json')), 'wasm').complete, false);
    assert.equal(resolvePlan(getModel('LiquidAI/LFM2.5-VL-450M-ONNX'), all, 'webgpu-f16').complete, false, 'models without a runtime never count');
});

test('catalog sizes are stated per device and large models are flagged before download', () => {
    for (const model of listModels()) assert.ok(model.bytes > 150e6 && model.name && model.note !== undefined, model.id);
    assert.ok(estimatedBytes(getModel(FAST), 'webgpu-f16') > 1e9, 'FastVLM is over a gigabyte');
    assert.ok(estimatedBytes(getModel(SMOL), 'webgpu') > estimatedBytes(getModel(SMOL), 'webgpu-f16'));
    assert.equal(formatBytes(211e6), '211 MB');
    assert.equal(formatBytes(1106e6), '1.11 GB');

    const phone = assessFit(getModel(FAST), { mobile: true, deviceMemory: 4, deviceClass: 'webgpu-f16', freeBytes: 20e9 });
    assert.equal(phone.level, 'warn');
    assert.equal(phone.recommend, SMALLEST_MODEL_ID, 'phones are pointed at the smallest model');
    assert.equal(assessFit(getModel(SMOL), { mobile: true, deviceMemory: 4, deviceClass: 'webgpu-f16', freeBytes: 20e9 }).level, 'ok');
    assert.equal(assessFit(getModel(FAST), { mobile: false, deviceMemory: 8, deviceClass: 'webgpu-f16', freeBytes: 20e9 }).level, 'ok');
    assert.match(assessFit(getModel(FAST), { deviceMemory: 2, deviceClass: 'webgpu-f16' }).reasons.join(' '), /2 GB of memory/);
    assert.match(assessFit(getModel(SMOL), { freeBytes: 50e6, deviceClass: 'wasm' }).reasons.join(' '), /browser storage/);
    assert.match(assessFit(getModel(FAST), { deviceClass: 'wasm', deviceMemory: 8 }).reasons.join(' '), /CPU/);
});

test('worker imports the exact Transformers.js release the catalog names', async () => {
    const source = await readFile(new URL('./vlmWorker.js', import.meta.url), 'utf8');
    assert.ok(source.includes(`'https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}'`));
    assert.ok(RUNTIME_FILE.url.includes(`@${TRANSFORMERS_VERSION}/dist/`));
    assert.match(source, /env\.allowRemoteModels = false/);
    assert.equal((source.match(/local_files_only: true/g) ?? []).length, 2, 'processor and model both load from storage only');
    assert.equal(/huggingface\.co/.test(source), false, 'the worker has no model host to fetch from');
});

// ─── Model store ─────────────────────────────────────────────────────────────

test('status is derived from the cache and never touches the network', async () => {
    const { env } = fakeStoreEnv();
    const store = createModelStore(env);
    assert.equal(await store.status(SMOL), 'not-downloaded');
    assert.equal(store.progress(SMOL), null);

    await seedLegacy(env.caches, SMOL);
    assert.equal(await store.status(SMOL), 'downloaded', 'a cache from before explicit downloads counts');
    assert.equal(await store.status(FAST), 'not-downloaded');

    await seedLegacy(env.caches, FAST, undefined, ['onnx/decoder_model_merged_q4.onnx']);
    assert.equal(await store.status(FAST), 'not-downloaded', 'a half-present model is not downloaded');
    const row = await store.inspect(FAST);
    assert.equal(row.partial, true);
    assert.equal(row.cachedBytes, 300 * 8);
    assert.equal(env.fetch.requests.length, 0);
});

test('download streams every needed file into the cache with throttled progress, then asks for persistence', async () => {
    const { env, events, persist } = fakeStoreEnv();
    env.fetch = fakeFetch({ delay: 12 });
    const store = createModelStore(env);

    await store.download(SMOL);
    assert.equal(await store.status(SMOL), 'downloaded');

    const cache = await env.caches.open(MODEL_CACHE_NAME);
    const stored = [...cache.entries.keys()];
    const plan = resolvePlan(getModel(SMOL), new Set(fakeListing().map(file => file.path)), 'webgpu-f16');
    assert.deepEqual(stored.filter(url => url !== RUNTIME.url).sort(), plan.files.map(path => modelFileUrl(SMOL, path)).sort());
    assert.ok(stored.includes(RUNTIME.url), 'the ONNX runtime binary is stored with the first model');
    const weight = cache.entries.get(modelFileUrl(SMOL, 'onnx/embed_tokens_fp16.onnx'));
    assert.equal(weight.body.byteLength, 5000);
    assert.equal(weight.headers['content-length'], '5000', 'exact length stored so the loader can size its buffer');

    const mine = events.filter(event => event.modelId === SMOL);
    assert.equal(mine.at(-1).state, 'downloaded');
    const ticks = mine.filter(event => event.state === 'downloading');
    const total = plan.files.reduce((sum, path) => sum + fakeListing().find(file => file.path === path).size, 0) + RUNTIME.size;
    assert.ok(ticks.length >= 2 && ticks.every(event => event.total === 0 || event.total === total));
    assert.ok(ticks.every((event, i) => i === 0 || event.loaded >= ticks[i - 1].loaded), 'progress never goes backwards');
    // First two ticks are forced (start, then totals known); after that at most four per second.
    const paced = ticks.slice(2);
    for (let i = 1; i < paced.length; i++) assert.ok(paced[i].at - paced[i - 1].at >= PROGRESS_INTERVAL_MS - 20, 'at most four progress events per second');
    assert.equal(mine.at(-1).loaded, total);
    assert.equal(persist.asked, 1);

    // A second model reuses the stored runtime and does not ask for persistence again.
    const before = env.fetch.requests.length;
    await store.download(FAST);
    assert.equal(env.fetch.requests.slice(before).includes(RUNTIME.url), false);
    assert.equal(persist.asked, 1);
});

test('cancel rejects, removes what this run wrote and leaves the model not downloaded', async () => {
    const { env, events, memory } = fakeStoreEnv();
    let open;
    const gate = new Promise(resolve => { open = resolve; });
    env.fetch = fakeFetch({ gate: { 'onnx/decoder_model_merged_q4.onnx': gate } });
    const store = createModelStore(env);

    const running = store.download(SMOL);
    assert.equal(store.download(SMOL), running, 'a second click joins the running download');
    await tick(60);
    assert.equal(await store.status(SMOL), 'downloading');
    assert.ok(store.progress(SMOL).loaded > 0 && store.progress(SMOL).total > store.progress(SMOL).loaded);
    assert.ok(memory.get('tdsVlmDownloadIntent').includes(SMOL));

    store.cancel(SMOL);
    open();
    await assert.rejects(running, { name: 'AbortError' });
    assert.equal(await store.status(SMOL), 'not-downloaded');
    assert.equal(store.progress(SMOL), null);
    const cache = await env.caches.open(MODEL_CACHE_NAME);
    assert.deepEqual([...cache.entries.keys()], [], 'cancel returns the storage it used');
    assert.equal(events.at(-1).state, 'not-downloaded');
    assert.equal(memory.has('tdsVlmDownloadIntent'), false, 'a cancelled download never resumes by itself');
});

test('a failed or truncated file is never stored, and the next attempt resumes with the missing files only', async () => {
    const { env, events } = fakeStoreEnv();
    env.fetch = fakeFetch({ truncate: { 'onnx/decoder_model_merged_q4.onnx': 2500 } });
    const store = createModelStore(env);

    await assert.rejects(store.download(SMOL), /expected 6000 bytes, received 2500/);
    assert.equal(await store.status(SMOL), 'not-downloaded');
    const cache = await env.caches.open(MODEL_CACHE_NAME);
    assert.equal(cache.entries.has(modelFileUrl(SMOL, 'onnx/decoder_model_merged_q4.onnx')), false, 'no half-written entry');
    assert.equal(cache.entries.has(modelFileUrl(SMOL, 'onnx/embed_tokens_fp16.onnx')), true, 'completed files are kept for the retry');
    assert.equal(events.at(-1).state, 'not-downloaded');
    assert.match(events.at(-1).message, /expected 6000 bytes/);
    assert.match((await store.inspect(SMOL)).message, /expected 6000 bytes/);
    assert.equal((await store.inspect(SMOL)).partial, true);

    env.fetch = fakeFetch({ status: { 'onnx/decoder_model_merged_q4.onnx': 503 } });
    const store2 = createModelStore(env);
    await assert.rejects(store2.download(SMOL), /HTTP 503/);
    assert.equal(await store2.status(SMOL), 'not-downloaded');

    env.fetch = fakeFetch();
    const store3 = createModelStore(env);
    await store3.download(SMOL);
    assert.deepEqual(env.fetch.modelRequests(), [modelFileUrl(SMOL, 'onnx/decoder_model_merged_q4.onnx')], 'only the missing file is fetched');
    assert.equal(await store3.status(SMOL), 'downloaded');
    assert.equal((await store3.inspect(SMOL)).message, null);
});

test('remove deletes one model and keeps the others and the shared runtime', async () => {
    const { env, events } = fakeStoreEnv();
    const store = createModelStore(env);
    await store.download(SMOL);
    await seedLegacy(env.caches, FAST);
    const legacyBucket = await env.caches.open('older-bucket');
    await legacyBucket.put(modelFileUrl(SMOL, 'config.json'), new Response('{}'));

    await store.remove(SMOL);
    assert.equal(await store.status(SMOL), 'not-downloaded');
    assert.equal(await store.status(FAST), 'downloaded');
    const cache = await env.caches.open(MODEL_CACHE_NAME);
    assert.equal([...cache.entries.keys()].some(url => url.includes(SMOL)), false);
    assert.equal(cache.entries.has(RUNTIME.url), true);
    assert.equal(legacyBucket.entries.size, 0, 'stray copies in other buckets go too');
    assert.deepEqual({ modelId: events.at(-1).modelId, state: events.at(-1).state }, { modelId: SMOL, state: 'not-downloaded' });

    await store.removeAll();
    assert.equal(await store.status(FAST), 'not-downloaded');
    assert.equal(env.caches.buckets.has(MODEL_CACHE_NAME), false);
});

test('an interrupted download resumes on the next page only while its intent is fresh', async () => {
    const { env, memory } = fakeStoreEnv();
    memory.set('tdsVlmDownloadIntent', JSON.stringify({ [SMOL]: Date.now() - 1000, [FAST]: Date.now() - 3600_000 }));
    const store = createModelStore(env);
    assert.deepEqual(await store.resumePending(), [SMOL], 'a stale intent is dropped, not resumed');
    for (let i = 0; i < 200 && (await store.status(SMOL)) !== 'downloaded'; i++) await tick(5);
    assert.equal(await store.status(SMOL), 'downloaded');
    assert.equal(env.fetch.requests.some(url => url.includes(FAST)), false);
    assert.equal(memory.has('tdsVlmDownloadIntent'), false);
});

// ─── Manager ─────────────────────────────────────────────────────────────────

class FakeWorker {
    constructor() { this.messages = []; this.terminated = false; FakeWorker.created.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    reply(data) { this.onmessage?.({ data }); }
}
FakeWorker.created = [];

/** Reset the page singleton onto a fake store and fake workers. */
function freshManager(downloaded = []) {
    const manager = VLMManager.getInstance();
    manager._stopWorker();
    manager._callbacks.clear();
    manager._mode = 'local'; manager._ready = false; manager._loading = false;
    manager._suspended = false; manager._modelId = null; manager._apiConfig = null;
    FakeWorker.created = [];
    const have = new Set(downloaded);
    const announced = [];
    manager._store = {
        calls: [],
        get: getModel,
        progress: () => null,
        async status(modelId) { return have.has(modelId) ? 'downloaded' : 'not-downloaded'; },
        async resolve(modelId, cls) {
            this.calls.push(['resolve', modelId, cls ?? 'device']);
            const complete = have.has(modelId);
            return { complete, device: cls === 'wasm' ? 'wasm' : 'webgpu', dtype: complete ? { embed_tokens: 'fp16', vision_encoder: 'q4', decoder_model_merged: 'q4' } : {} };
        },
        announce(detail) { announced.push(detail); },
        have,
    };
    manager._createWorker = () => new FakeWorker();
    manager._prepareImage = async src => ({ bitmap: null, key: imageKey(src) });
    return { manager, announced };
}

test('init and restart never start a worker for a model that is not downloaded', async () => {
    const { manager, announced } = freshManager([]);
    const unavailable = [];
    manager.on('unavailable', event => unavailable.push(event));

    manager.init(SMOL);
    manager.init(SMOL);   // repeated calls while the storage check runs are ignored
    await tick();
    assert.equal(FakeWorker.created.length, 0);
    assert.equal(manager.isReady, false);
    assert.equal(manager.isLoading, false);
    assert.deepEqual(announced, [{ modelId: SMOL, state: 'not-downloaded' }]);
    assert.equal(unavailable.at(-1).state, 'not-downloaded');

    manager.restart(FAST);
    await tick();
    assert.equal(FakeWorker.created.length, 0);
    assert.deepEqual(announced.at(-1), { modelId: FAST, state: 'not-downloaded' });
    assert.equal(manager.isReady || manager.isLoading, false);
    assert.throws(() => manager.query('data:,x', 'q', [], {}), /call init\(\) before query/, 'nothing to ask: no model is loaded');

    manager.init('LiquidAI/LFM2.5-VL-450M-ONNX');
    await tick();
    assert.match(announced.at(-1).message, /Not available in this build/);
    assert.equal(FakeWorker.created.length, 0);
});

test('explicit load resumes a released model and rejects an uncached model without starting a worker', async () => {
    const { manager } = freshManager([SMOL]);
    assert.equal(await manager.load(FAST), false);
    assert.equal(FakeWorker.created.length, 0);

    const starts = await Promise.all([manager.load(SMOL), manager.load(SMOL)]);
    assert.deepEqual(starts, [true, true]);
    assert.equal(FakeWorker.created.length, 1);
    const first = FakeWorker.created[0];
    first.reply({ type: 'ready', device: 'wasm' });
    assert.equal(manager.release(), true);
    assert.equal(first.terminated, true);

    assert.equal(await manager.load(SMOL), true);
    assert.equal(FakeWorker.created.length, 2);
    assert.equal(manager.isSuspended, false);
    assert.equal(manager.isLoading, true);
});

test('a downloaded model loads in one worker with a device plan, and a finished download loads the model that was asked for', async () => {
    const { manager, announced } = freshManager([SMOL]);
    manager.init(SMOL);
    await tick();
    assert.equal(FakeWorker.created.length, 1);
    const worker = FakeWorker.created[0];
    assert.deepEqual(worker.messages[0], {
        type: 'load', modelId: SMOL, family: 'smolvlm', imageSplitting: false,
        plan: { device: 'webgpu', dtype: { embed_tokens: 'fp16', vision_encoder: 'q4', decoder_model_merged: 'q4' } },
        fallback: { device: 'wasm', dtype: { embed_tokens: 'fp16', vision_encoder: 'q4', decoder_model_merged: 'q4' } },
    });
    assert.equal(manager.isLoading, true);
    assert.deepEqual(announced.at(-1), { modelId: SMOL, state: 'loading' });
    manager.init(SMOL);
    await tick();
    assert.equal(FakeWorker.created.length, 1, 'init is idempotent while a model is loaded');

    worker.reply({ type: 'ready', device: 'webgpu', loadMs: 1234, heapMB: 80 });
    worker.reply({ type: 'warm', warmupMs: 456 });
    assert.equal(manager.isReady, true);
    assert.equal(manager.isLoading, false);
    assert.deepEqual(announced.at(-1), { modelId: SMOL, state: 'ready' });
    const stats = manager.stats;
    assert.deepEqual([stats.backend, stats.device, stats.loadMs, stats.warmupMs, stats.loaded], ['local', 'webgpu', 1234, 456, true]);

    // Deleting the loaded model gives its memory back as well.
    manager._onModelState({ modelId: SMOL, state: 'not-downloaded' });
    assert.equal(worker.terminated, true);
    assert.equal(manager.isReady, false);

    // The panel asked for FAST before it was downloaded; when the download lands, it loads.
    manager.restart(FAST);
    await tick();
    assert.equal(FakeWorker.created.length, 1);
    manager._store.have.add(FAST);
    manager._onModelState({ modelId: SMOL, state: 'downloaded' });   // some other model: ignored
    await tick();
    assert.equal(FakeWorker.created.length, 1);
    manager._onModelState({ modelId: FAST, state: 'downloaded' });
    await tick();
    assert.equal(FakeWorker.created.length, 2);
    assert.equal(FakeWorker.created[1].messages[0].family, 'fastvlm');
});

test('a load error stops the worker and reports state error', async () => {
    const { manager, announced } = freshManager([SMOL]);
    const errors = [];
    manager.on('error', event => errors.push(event.message));
    manager.init(SMOL);
    await tick();
    const worker = FakeWorker.created[0];
    worker.reply({ type: 'error', message: 'Load failed: boom' });
    assert.equal(worker.terminated, true);
    assert.equal(manager.isReady || manager.isLoading, false);
    assert.deepEqual(announced.at(-1), { modelId: SMOL, state: 'error', message: 'Load failed: boom' });
    assert.equal(errors.at(-1), 'Load failed: boom');
});

test('an idle or hidden model is released and comes back on the next question; a busy one is kept', async (t) => {
    const { manager, announced } = freshManager([SMOL]);
    manager.init(SMOL);
    await tick();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const first = FakeWorker.created[0];
    first.reply({ type: 'ready', device: 'wasm' });

    // A question in flight holds the model, however long it takes.
    let answer = null;
    manager.query('data:image/jpeg;base64,one', 'What is this?', [], { onDone: (text, count, tps, stats) => { answer = { text, stats }; } });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    t.mock.timers.tick(IDLE_RELEASE_MS * 3);
    assert.equal(first.terminated, false);
    const generate = first.messages.at(-1);
    assert.equal(generate.type, 'generate');
    first.reply({ type: 'done', id: generate.id, text: 'A heron.', tokenCount: 4, avgTps: 20, stats: { cache: 'none', promptTokens: 90 } });
    assert.equal(answer.text, 'A heron.');
    assert.equal(answer.stats.cache, 'none');
    assert.equal(manager.stats.tokensPerSecond, 20);

    t.mock.timers.tick(IDLE_RELEASE_MS - 1);
    assert.equal(first.terminated, false);
    t.mock.timers.tick(1);
    assert.equal(first.terminated, true, 'released after the idle period');
    assert.equal(manager.isReady, true, 'still ready: the next question reloads it');
    assert.equal(manager.isSuspended, true);
    assert.equal(manager.stats.loaded, false);
    assert.deepEqual(announced.at(-1), { modelId: SMOL, state: 'ready', suspended: true });
    t.mock.timers.reset();

    let second = null;
    manager.query('data:image/jpeg;base64,one', 'And now?', [], { onDone: text => { second = text; } });
    await tick();
    assert.equal(FakeWorker.created.length, 2, 'exactly one new worker');
    const revived = FakeWorker.created[1];
    assert.deepEqual(revived.messages.map(message => message.type), ['load', 'generate']);
    revived.reply({ type: 'ready', device: 'wasm' });
    revived.reply({ type: 'done', id: revived.messages[1].id, text: 'Still a heron.', tokenCount: 3, avgTps: 9 });
    assert.equal(second, 'Still a heron.');
    assert.equal(manager.isSuspended, false);

    // Hidden tabs give the memory back sooner.
    const originalDocument = globalThis.document;
    globalThis.document = { visibilityState: 'hidden' };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
        manager._scheduleRelease();
        t.mock.timers.tick(HIDDEN_RELEASE_MS);
        assert.equal(revived.terminated, true);
    } finally {
        t.mock.timers.reset();
        if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    }

    // If the model was deleted while released, the question fails cleanly instead of downloading.
    manager._store.have.delete(SMOL);
    let failure = null;
    manager.query('data:image/jpeg;base64,one', 'Again?', [], { onError: message => { failure = message; } });
    await tick();
    assert.equal(failure, 'Download A Model In Settings');
    assert.equal(FakeWorker.created.length, 2);
    assert.equal(manager.isReady, false);
});

test('switching backend terminates the local worker, and every import of the module shares one manager', async () => {
    const { manager } = freshManager([SMOL]);
    manager.init(SMOL);
    await tick();
    const worker = FakeWorker.created[0];
    worker.reply({ type: 'ready', device: 'webgpu' });

    manager.setApiMode('http://fixture.invalid/v1', '', 'fixture');
    assert.equal(worker.terminated, true);
    assert.equal(manager._worker, null);
    assert.equal(manager.stats.backend, 'api');
    manager.setOllamaMode('http://fixture.invalid', 'fixture');
    assert.equal(manager.stats.backend, 'ollama');

    // The panel, the camera LCD and the settings page import this file under different URLs.
    const versioned = await import('./VLMManager.js?v=12');
    const other = await import('./VLMManager.js?v=999');
    assert.notEqual(versioned.VLMManager, other.VLMManager, 'separate module instances');
    assert.equal(versioned.VLMManager.getInstance(), manager);
    assert.equal(other.VLMManager.getInstance(), manager);
    assert.equal(new other.VLMManager(), manager);
});

test('camera request instructions stay isolated from the gallery across API, Ollama, and local backends', async t => {
    const { manager } = freshManager([SMOL]);
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        requests.push(JSON.parse(options.body));
        return new Response(url.endsWith('/api/chat') ? '{"message":{"content":"Stars."},"done":true}\n'
            : 'data: {"choices":[{"delta":{"content":"Stars."}}]}\n\ndata: [DONE]\n\n', { status: 200 });
    });
    manager.setSystemPrompt('Gallery instructions');
    const query = options => new Promise((resolve, reject) => manager.query('data:image/jpeg;base64,fixture', 'Describe this.', [], { ...options, onDone: resolve, onError: reject }));
    for (const backend of ['api', 'ollama']) {
        if (backend === 'api') manager.setApiMode('http://fixture.invalid/v1', '', 'fixture');
        else manager.setOllamaMode('http://fixture.invalid', 'fixture');
        assert.equal(await query({ systemPrompt: 'Describe only. No tips. Forty words maximum.' }), 'Stars.');
        assert.equal(requests.at(-1).messages[0].content, 'Describe only. No tips. Forty words maximum.');
        await query({});
        assert.equal(requests.at(-1).messages[0].content, 'Gallery instructions', `${backend} retains the gallery prompt`);
    }
    manager.restart(SMOL);
    await tick();
    const worker = FakeWorker.created.at(-1);
    worker.reply({ type: 'ready', device: 'wasm' });
    manager.query('data:image/jpeg;base64,fixture', 'Describe this.', [], { systemPrompt: 'Camera instructions', maxNewTokens: 96 });
    await tick();
    assert.equal(worker.messages.at(-1).prompt, 'Camera instructions\n\nDescribe this.');
    assert.equal(worker.messages.at(-1).maxNewTokens, 96);
    assert.equal(worker.messages.at(-1).imageSrc, 'data:image/jpeg;base64,fixture');
    manager.query('data:image/jpeg;base64,fixture', 'Gallery question', [], {});
    await tick();
    assert.equal(worker.messages.at(-1).prompt, 'Gallery question');
    assert.equal(worker.messages.at(-1).imageKey, worker.messages.at(-2).imageKey, 'the same picture keeps the same cache key');
    assert.equal(manager._systemPrompt, 'Gallery instructions');
    manager._stopWorker(); manager._callbacks.clear();
});

// ─── Worker runtime ──────────────────────────────────────────────────────────

test('the worker fetch guard answers model hosts with 404 without calling the network', async () => {
    const reached = [], blocked = [];
    const guard = createFetchGuard(async url => { reached.push(String(url)); return new Response('ok'); }, {
        allow: ['https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/'],
        onBlocked: url => blocked.push(url),
    });
    for (const url of [
        'https://huggingface.co/HuggingFaceTB/SmolVLM-256M-Instruct/resolve/main/onnx/decoder_model_merged_q4.onnx',
        'https://us.aws.cdn.hf.co/xet-bridge-us/abc',
        '/models/HuggingFaceTB/SmolVLM-256M-Instruct/config.json',
        'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.0/dist/ort-wasm-simd-threaded.jsep.wasm',
    ]) {
        const response = await guard(url);
        assert.equal(response.status, 404, url);
    }
    assert.equal((await guard({ url: 'https://huggingface.co/x/y/resolve/main/config.json' })).status, 404, 'Request objects are checked too');
    assert.deepEqual(reached, []);
    assert.equal(blocked.length, 5);
    assert.equal((await guard('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/ort-wasm-simd-threaded.jsep.wasm')).status, 200);
    assert.equal((await guard('data:image/png;base64,AAAA')).status, 200);
    assert.equal(reached.length, 2);
    assert.match(describeLoadError('`local_files_only=true` or `env.allowRemoteModels=false` and file was not found locally at "/models/x".'), /press Download again/);
});

test('token batching posts far fewer messages for a fast model and none fewer for a slow one', () => {
    const run = (tokens, spacingMs) => {
        let clock = 0, text = '';
        const batcher = new TokenBatcher(chunk => { text += chunk; }, { now: () => clock });
        for (let i = 0; i < tokens; i++) { clock += spacingMs; batcher.push('x'); }
        batcher.flush();
        assert.equal(text.length, tokens, 'no text is lost');
        return batcher.messages;
    };
    const fast = run(300, 8);      // 125 tokens per second
    const slow = run(40, 400);     // 2.5 tokens per second
    assert.ok(fast <= Math.ceil(300 * 8 / TOKEN_FLUSH_MS) + 1, `fast model: ${fast} messages for 300 tokens`);
    assert.ok(fast < 300 / 3);
    assert.equal(slow, 40, 'a slow model still shows every token as it arrives');
});

test('repetition guard recognises a loop but not ordinary text', () => {
    const phrase = [5, 9, 2, 7, 7, 3, 8];
    assert.equal(isRepeating([1, 2, 3, ...phrase, ...phrase, ...phrase]), true);
    assert.equal(isRepeating([1, 2, 3, ...phrase, ...phrase]), false, 'twice is not a loop yet');
    assert.equal(isRepeating(Array.from({ length: 200 }, (_, i) => (i * 37) % 101)), false);
    assert.equal(isRepeating(Array(18).fill(4)), true, 'a single token repeated');
    assert.equal(isRepeating([1, 2, 3]), false);
});

test('messages follow each family template and put the image on the first user turn only', () => {
    const history = [{ role: 'user', content: 'What is this?' }, { role: 'assistant', content: 'A bird.' }];
    assert.deepEqual(buildMessages('smolvlm', history, 'What colour?'), [
        { role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'What is this?' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'A bird.' }] },
        { role: 'user', content: [{ type: 'text', text: 'What colour?' }] },
    ]);
    assert.deepEqual(buildMessages('fastvlm', [], 'Describe.'), [{ role: 'user', content: '<image>Describe.' }]);
    assert.deepEqual(buildMessages('fastvlm', history, 'More?').map(message => message.content), ['<image>What is this?', 'A bird.', 'More?']);
});

/** Stand-ins for Transformers.js with the same call shapes the engine relies on. */
function fakeModelKit({ answers = [' A grey heron.'], family = 'smolvlm' } = {}) {
    const EOS = 1;
    const encode = text => BigInt64Array.from([...text].map(char => BigInt(char.charCodeAt(0))));
    const decode = ids => ids.filter(id => Number(id) !== EOS).map(id => String.fromCharCode(Number(id))).join('');
    const log = { generate: [], vision: 0, disposed: 0, processorOptions: [] };

    const render = messages => messages.map((message) => {
        const body = typeof message.content === 'string' ? message.content
            : message.content.map(block => (block.type === 'image' ? '<image>' : block.text)).join('');
        return `${message.role === 'user' ? 'User:' : 'Assistant: '}${body}${String.fromCharCode(EOS)}\n`;
    }).join('') + 'Assistant:';
    const processor = Object.assign(async (first, second, options) => {
        const text = family === 'fastvlm' ? second : first;
        log.processorOptions.push(options);
        const ids = encode(text);
        return { input_ids: { data: ids }, attention_mask: { data: ids.map(() => 1n) }, pixel_values: { image: family === 'fastvlm' ? first : second[0] } };
    }, { apply_chat_template: render, tokenizer: { decode } });

    class TextStreamer {
        constructor(tokenizer, options) { Object.assign(this, options, { tokenizer, first: true }); }
        put(value) {
            if (this.first) { this.first = false; if (this.skip_prompt) return; }
            this.token_callback_function?.(value[0]);
            this.callback_function?.(this.tokenizer.decode(value[0]));
        }
        end() { this.first = true; }
    }
    class StoppingCriteria { }

    let turn = 0;
    const model = {
        async encode_image({ pixel_values }) { log.vision++; return { features: pixel_values.image }; },
        async generate(args) {
            log.generate.push(args);
            const prompt = Array.from(args.input_ids.data);
            // Like the library: the vision encoder runs only on a full pass that carries pixels.
            if (args.pixel_values && !args.past_key_values) await this.encode_image({ pixel_values: args.pixel_values });
            if (args.past_key_values?.fail) throw new Error('cache rejected');
            const all = [...prompt];
            args.streamer?.put([prompt]);
            const answer = [...encode(answers[Math.min(turn, answers.length - 1)]), BigInt(EOS)];
            turn++;
            let produced = 0;
            for (const token of answer) {
                if (produced >= (args.max_new_tokens ?? Infinity)) break;
                all.push(token); produced++;
                args.streamer?.put([[token]]);
                if (args.stopping_criteria?._call([all]).every(Boolean)) break;
            }
            args.streamer?.end();
            if (!args.return_dict_in_generate) return { data: BigInt64Array.from(all) };
            return {
                sequences: { data: BigInt64Array.from(all) },
                past_key_values: { 'past_key_values.0.key': { location: 'gpu-buffer', dispose() { log.disposed++; } } },
            };
        },
    };
    return { lib: { TextStreamer, StoppingCriteria }, processor, model, log };
}

test('follow-up questions reuse the key/value cache and skip the vision encoder; a new chat reuses the image encoding', async () => {
    const kit = fakeModelKit({ answers: [' A grey heron.', ' It is wading.', ' Dawn.', ' A harbour.'] });
    const engine = createInferenceEngine({ ...kit, family: 'smolvlm' });
    const image = { id: 'heron' };
    const preamble = 'Keep it short.\n\n[Photo metadata]\nFile: heron.jpg\n\n';

    // Turn 1: full pass.
    const first = await engine.generate({ image, imageKey: 'heron', prompt: `${preamble}What is this?`, chatHistory: [] });
    assert.equal(first.text, 'A grey heron.');
    assert.equal(first.stats.cache, 'none');
    assert.equal(kit.log.vision, 1);
    assert.ok(kit.log.generate[0].pixel_values, 'first pass carries the pixels');
    assert.deepEqual(kit.log.processorOptions[0], { do_image_splitting: false }, 'one 512px tile instead of up to 17');
    assert.equal(first.stats.processedTokens, first.stats.promptTokens);

    // Turn 2: the panel replays its history with the bare question, as it really does.
    const history = [{ role: 'user', content: 'What is this?' }, { role: 'assistant', content: 'A grey heron.' }];
    const second = await engine.generate({ image, imageKey: 'heron', prompt: `${preamble}What is it doing?`, chatHistory: history });
    assert.equal(second.text, 'It is wading.');
    assert.equal(second.stats.cache, 'kv');
    const call = kit.log.generate[1];
    assert.ok(call.past_key_values, 'the cache from turn 1 is passed back');
    assert.equal('pixel_values' in call, false, 'no pixels, so the vision encoder cannot run');
    assert.equal(kit.log.vision, 1);
    assert.equal(second.stats.reusedTokens, first.stats.promptTokens + first.tokenCount - 1);
    assert.ok(second.stats.processedTokens < second.stats.promptTokens / 2, `${second.stats.processedTokens} of ${second.stats.promptTokens} prompt tokens processed`);
    assert.equal(kit.log.disposed, 0, 'tensors handed to generate() are not disposed by us');

    // New chat about the same photo: no key/value reuse, but the image encoding is remembered.
    const fresh = await engine.generate({ image, imageKey: 'heron', prompt: 'What time of day?', chatHistory: [] });
    assert.equal(fresh.stats.cache, 'image');
    assert.equal(kit.log.vision, 1, 'vision encoder still ran only once');
    assert.equal(kit.log.disposed, 1, 'the stale cache was released');
    assert.ok(kit.log.generate[2].pixel_values && !kit.log.generate[2].past_key_values);

    // A different photo starts from nothing.
    const other = await engine.generate({ image: { id: 'harbour' }, imageKey: 'harbour', prompt: 'And this?', chatHistory: [] });
    assert.equal(other.stats.cache, 'none');
    assert.equal(kit.log.vision, 2);
    assert.equal(engine.visionRuns, 2);

    // History that does not match what the model saw is never continued.
    const mismatch = await engine.generate({ image: { id: 'harbour' }, imageKey: 'harbour', prompt: 'Why?', chatHistory: [{ role: 'user', content: 'And this?' }, { role: 'assistant', content: 'Something else entirely.' }] });
    assert.equal(mismatch.stats.cache, 'image');
    assert.equal(continuationTurns({ imageKey: 'a', turns: [{ sent: 'x', answer: 'y' }] }, 'b', [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }]), null);
    engine.dispose();
    assert.equal(engine.hasSession, false);
});

test('a rejected cache falls back to a full pass, and abort, token budget and loops stop generation', async () => {
    const kit = fakeModelKit({ answers: [' One.', ' Two.'], family: 'fastvlm' });
    const engine = createInferenceEngine({ ...kit, family: 'fastvlm' });
    const image = { id: 'p' };
    await engine.generate({ image, imageKey: 'p', prompt: 'First?', chatHistory: [] });
    assert.deepEqual(kit.log.processorOptions[0], { add_special_tokens: false });
    assert.equal(kit.log.generate[0].pixel_values.image, image, 'FastVLM processor receives (image, text)');

    // Poison the stored cache: the continuation throws before any token, so the engine retries in full.
    kit.log.generate[0] = null;
    const session = await engine.generate({ image, imageKey: 'p', prompt: 'x', chatHistory: [] });   // refresh session
    assert.ok(session);
    const realGenerate = kit.model.generate.bind(kit.model);
    kit.model.generate = async (args) => (args.past_key_values ? Promise.reject(new Error('cache rejected')) : realGenerate(args));
    const retried = await engine.generate({ image, imageKey: 'p', prompt: 'Second?', chatHistory: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'Two.' }] });
    assert.equal(retried.stats.cache, 'image');
    assert.equal(retried.text, 'Two.');
    kit.model.generate = realGenerate;

    const budget = await engine.generate({ image, imageKey: 'q', prompt: 'Short', chatHistory: [], maxNewTokens: 3 });
    assert.equal(budget.tokenCount, 3);
    assert.equal(kit.log.generate.at(-1).max_new_tokens, 3);
    assert.equal(kit.log.generate.at(-1).do_sample, false);

    let seen = 0;
    const stopped = await engine.generate({ image, imageKey: 'r', prompt: 'Stop me', chatHistory: [] }, { onText: () => { seen++; }, shouldStop: () => seen >= 1 });
    assert.ok(stopped.tokenCount < 5, 'stops within a token or two of the abort');
    assert.equal(engine.hasSession, false, 'an aborted answer is not kept as a conversation');

    const looping = fakeModelKit({ answers: [' again and again'.repeat(40)] });
    const loopEngine = createInferenceEngine({ ...looping, family: 'smolvlm' });
    const looped = await loopEngine.generate({ image, imageKey: 'loop', prompt: 'Loop', chatHistory: [], maxNewTokens: 600 });
    assert.ok(looped.tokenCount <= 16 * 3, `stopped after ${looped.tokenCount} tokens instead of 600`);

    const warm = fakeModelKit();
    const warmEngine = createInferenceEngine({ ...warm, family: 'smolvlm' });
    assert.equal(typeof await warmEngine.warmup({ id: 'dummy' }), 'number');
    assert.equal(warm.log.generate[0].max_new_tokens, 1);
    const afterWarm = await warmEngine.generate({ image, imageKey: 'w', prompt: 'Real', chatHistory: [] });
    assert.equal(afterWarm.stats.cache, 'none', 'the warm-up image is never mistaken for a real one');
});
