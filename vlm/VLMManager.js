/**
 * VLMManager.js — Singleton VLM Engine
 *
 * Supports three backends, switchable at runtime:
 *
 *   LOCAL   — Web Worker running a small vision-language model via Transformers.js
 *   API     — OpenAI-compatible REST endpoint (GPT-4o, LM Studio, etc.)
 *   OLLAMA  — Ollama's native /api/chat endpoint
 *
 * Local models never download on their own. A model must first be downloaded
 * from Settings > AI Inspector (see modelStore.js, exposed as window.VLM_MODELS).
 * init() and restart() check browser storage: when the model is there they load
 * it; when it is not they report 'not-downloaded' and start nothing.
 *
 * Usage
 * ─────
 *   import { VLMManager } from './VLMManager.js';
 *
 *   const mgr = VLMManager.getInstance();
 *   mgr.on('ready', () => console.log('Model ready'));
 *
 *   // Local mode — loads from browser storage, or reports 'not-downloaded'
 *   mgr.init('HuggingFaceTB/SmolVLM-256M-Instruct');
 *
 *   // API mode — signals ready immediately
 *   mgr.setApiMode('https://api.openai.com/v1', 'sk-...', 'gpt-4o');
 *
 *   mgr.query(imageUrl, 'What's in this photo?', [], {
 *       onToken:  (tok) => console.log(tok),
 *       onDone:   (txt, tokenCount, avgTps, stats) => console.log('Full:', txt),
 *       onError:  (msg) => console.error(msg),
 *   });
 *
 * Model state for any UI
 * ──────────────────────
 *   window.VLM_MODELS.status(id) / download(id) / cancel(id) / remove(id) / progress(id)
 *   window 'vlm-model-state' events: { modelId, state, loaded?, total?, message? }
 *   mgr.stats — device, load time, tokens per second, memory, cache use
 */

import { createModelStore } from './modelStore.js';

// One manager and one store per page, however many URLs this module is imported
// under (a cache-busting ?v= makes each URL its own module instance).
const MANAGER_KEY = Symbol.for('thedoshoots.vlmManager');
const STORE_KEY = Symbol.for('thedoshoots.vlmModelStore');

const DEFAULT_MODEL_ID = 'onnx-community/FastVLM-0.5B-ONNX';
const WORKER_URL = './vlmWorker.js?v=12';

/** A loaded local model is released after this long without a question. */
export const IDLE_RELEASE_MS = 5 * 60 * 1000;
/** ...and sooner when the page is in a background tab. */
export const HIDDEN_RELEASE_MS = 60 * 1000;

function modelStore() {
    return (globalThis[STORE_KEY] ??= createModelStore());
}

/** Cheap, stable identity for an image source (URL or data URI), used to key per-image caches. */
export function imageKey(src, salt = '') {
    const text = String(src ?? '');
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    return `${text.length}:${(hash >>> 0).toString(36)}:${salt}`;
}

/**
 * Decode an image and scale it down to the model's input size before it goes to
 * the worker. Returns an ImageBitmap (transferable, so it crosses threads
 * without a copy) or null when the browser cannot produce one.
 */
export async function prepareImage(src, maxEdge) {
    const key = imageKey(src, maxEdge);
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return { bitmap: null, key };
    try {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        let bitmap = await createImageBitmap(await response.blob());
        const sourceWidth = bitmap.width, sourceHeight = bitmap.height;
        const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
        if (scale < 1) {
            const resized = await createImageBitmap(bitmap, {
                resizeWidth: Math.max(1, Math.round(sourceWidth * scale)),
                resizeHeight: Math.max(1, Math.round(sourceHeight * scale)),
                resizeQuality: 'medium',
            });
            bitmap.close();
            bitmap = resized;
        }
        return { bitmap, key, width: bitmap.width, height: bitmap.height, sourceWidth, sourceHeight };
    } catch (_) {
        return { bitmap: null, key };   // the worker fetches the source itself
    }
}

class VLMManager {
    constructor() {
        // True singleton — subsequent `new VLMManager()` returns the same object.
        const existing = globalThis[MANAGER_KEY];
        if (existing) return existing;
        globalThis[MANAGER_KEY] = this;

        this._worker      = null;
        this._ready       = false;
        this._loading     = false;
        this._modelId     = null;        // local model currently selected
        this._mode        = 'local';     // 'local' | 'api'
        this._apiConfig   = null;        // { endpoint, apiKey, model }
        this._nextId      = 0;
        this._callbacks   = new Map();   // requestId → { onStart, onToken, onDone, onError }
        this._listeners   = {};          // event name → [handler, ...]
        this._systemPrompt = null;       // prepended as a system message in every API conversation

        this._store       = modelStore();
        this._starting    = null;        // token of the storage check in flight
        this._suspended   = false;       // model released after idling; reloads on the next question
        this._busy        = 0;           // local questions in flight
        this._releaseTimer = null;
        this._startPromise = null;       // resolves true once a worker has been started
        this._imageInfo   = new Map();   // requestId → how the image was prepared
        this._loadStarted = 0;
        this._stats       = this._emptyStats();

        if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('vlm-model-state', (event) => this._onModelState(event.detail ?? {}));
            if (typeof document !== 'undefined') {
                document.addEventListener('visibilitychange', () => this._scheduleRelease());
            }
        }
    }

    /** Always returns the page-level singleton. */
    static getInstance() {
        return globalThis[MANAGER_KEY] ?? new VLMManager();
    }

    get isReady()     { return this._ready; }
    get isLoading()   { return this._loading; }
    /** True while a ready local model is unloaded to save memory; the next query reloads it. */
    get isSuspended() { return this._suspended; }

    /**
     * Snapshot for a stats readout:
     * { backend, modelId, device, dtype, loaded, suspended, loadMs, warmupMs,
     *   heapMB, weightsMB, deviceMemoryGB, tokensPerSecond, releases, lastQuery }
     * lastQuery carries the worker's per-answer numbers (prompt tokens, tokens
     * reused from the key/value cache, time to first token, image preparation).
     */
    get stats() {
        return { ...this._stats, lastQuery: this._stats.lastQuery ? { ...this._stats.lastQuery } : null };
    }

    _emptyStats() {
        return {
            backend: 'local', modelId: null, device: null, dtype: null, loaded: false, suspended: false,
            // heapMB comes from performance.memory, which Chromium exposes on pages but not in
            // workers, so it is usually null; weightsMB (bytes of model files loaded) is the
            // dependable memory figure.
            loadMs: null, warmupMs: null, heapMB: null, weightsMB: null,
            deviceMemoryGB: (typeof navigator !== 'undefined' && navigator.deviceMemory) || null,
            tokensPerSecond: null, releases: 0, lastQuery: null,
        };
    }

    _setStats(patch) {
        Object.assign(this._stats, patch);
        this._emit('stats', this.stats);
    }

    // ─── Lifecycle ─────────────────────────────────────────────────────────

    /**
     * Select a local model and load it if it has been downloaded.
     * Never downloads: when the model is not in browser storage this emits
     * 'vlm-model-state' { state: 'not-downloaded' } (and an 'unavailable'
     * event) and leaves isReady and isLoading false.
     * Safe to call repeatedly — a call is ignored while a model is loaded or loading.
     * @param {string} [modelId]  HuggingFace model ID
     */
    init(modelId = DEFAULT_MODEL_ID) {
        if (this._worker || this._starting || (this._suspended && this._modelId === modelId)) return;
        if (this._mode === 'api') {
            this._apiConfig = null;
            this._ready = false;
        }
        this._mode      = 'local';
        this._modelId   = modelId;
        this._suspended = false;
        this._ready     = false;
        this._startLocal(modelId);
    }

    /** Check browser storage, then load. Resolves true when a worker was started. */
    _startLocal(modelId) {
        const attempt = this._checkAndLoad(modelId);
        this._startPromise = attempt;
        const clear = () => { if (this._startPromise === attempt) this._startPromise = null; };
        attempt.then(clear, clear);
        return attempt;
    }

    async _checkAndLoad(modelId) {
        const token = this._starting = { modelId };
        let plan = null, fallback = null, downloading = false;
        try {
            plan = await this._store.resolve(modelId);
            if (plan.complete && plan.device === 'webgpu') {
                // If WebGPU fails at load time, the CPU can take over only with files already stored.
                const cpu = await this._store.resolve(modelId, 'wasm');
                if (cpu.complete) fallback = { device: 'wasm', dtype: cpu.dtype };
            }
            if (!plan.complete) downloading = (await this._store.status(modelId)) === 'downloading';
        } catch (_) { plan = null; }
        if (this._starting !== token) return false;   // superseded by restart() or a backend change
        this._starting = null;

        if (!plan?.complete) {
            const model = this._store.get(modelId);
            const wasReady = this._ready;
            this._ready = false;
            this._loading = false;
            this._suspended = false;
            this._setStats({ backend: 'local', modelId, loaded: false, suspended: false });
            const message = model?.unavailable ? `${model.name}: ${model.unavailable}` : undefined;
            if (downloading) {
                this._store.announce({ modelId, state: 'downloading', ...(this._store.progress(modelId) ?? {}) }, { force: true, broadcast: false });
            } else {
                this._store.announce({ modelId, state: 'not-downloaded', ...(message ? { message } : {}) }, { broadcast: false });
            }
            this._emit('unavailable', { modelId, state: downloading ? 'downloading' : 'not-downloaded', message, wasReady });
            return false;
        }

        const model = this._store.get(modelId);
        this._loading = true;
        this._suspended = false;
        this._loadStarted = Date.now();
        let worker;
        try { worker = this._worker = this._createWorker(); }
        catch (error) { this._failLoad(error.message || 'Could not start the model worker'); return false; }
        worker.onmessage = (e) => { if (this._worker === worker) this._dispatch(e.data); };
        worker.onerror   = (e) => {
            if (this._worker !== worker) return;
            console.error('[VLMManager] Worker error:', e.message);
            this._failLoad(e.message || 'The model worker stopped unexpectedly');
        };
        worker.postMessage({
            type: 'load', modelId,
            family: model?.family ?? 'smolvlm',
            imageSplitting: false,
            plan: { device: plan.device, dtype: plan.dtype },
            fallback,
        });
        this._setStats({ backend: 'local', modelId, device: plan.device, dtype: plan.dtype, loaded: false, suspended: false });
        this._store.announce({ modelId, state: 'loading' }, { broadcast: false });
        this._store.inspect?.(modelId)
            .then((info) => { if (this._modelId === modelId) this._setStats({ weightsMB: Math.round(info.cachedBytes / 1e6) }); })
            .catch(() => {});
        return true;
    }

    /** Overridable so tests can supply a stand-in worker. */
    _createWorker() {
        return new Worker(new URL(WORKER_URL, import.meta.url), { type: 'module' });
    }

    /** Overridable so tests can skip image decoding. */
    _prepareImage(src, maxEdge) {
        return prepareImage(src, maxEdge);
    }

    _stopWorker() {
        clearTimeout(this._releaseTimer);
        this._releaseTimer = null;
        this._starting = null;
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
        this._busy = 0;
    }

    _failLoad(message) {
        const modelId = this._modelId;
        this._stopWorker();
        this._ready = false;
        this._loading = false;
        this._suspended = false;
        this._setStats({ loaded: false, suspended: false });
        for (const [id, cb] of this._callbacks) { cb.onError?.(message); this._callbacks.delete(id); }
        this._store.announce({ modelId, state: 'error', message }, { broadcast: false });
        this._emit('error', { message });
    }

    /**
     * Terminate the local worker and switch to a (possibly different) model.
     * Pending callbacks are discarded. Fires a 'restart' event so the UI can
     * reset its loading indicators. Like init(), never downloads.
     * @param {string} modelId
     */
    restart(modelId = DEFAULT_MODEL_ID) {
        this._stopWorker();
        this._mode     = 'local';
        this._ready    = false;
        this._loading  = false;
        this._suspended = false;
        this._modelId  = null;
        this._apiConfig = null;
        this._callbacks.clear();
        this._emit('restart', { modelId });
        this.init(modelId);
    }

    /**
     * Unload the local model to return its memory (several hundred MB of
     * WebAssembly heap or GPU buffers). The model stays "ready": the next
     * query reloads it from browser storage. Called automatically after
     * IDLE_RELEASE_MS without a question, or HIDDEN_RELEASE_MS in a
     * background tab. Does nothing while a question is being answered.
     * @returns {boolean} whether a model was released
     */
    release(reason = 'manual') {
        if (this._mode !== 'local' || !this._worker || !this._ready || this._busy > 0) return false;
        const modelId = this._modelId;
        this._stopWorker();
        this._suspended = true;
        this._loading = false;
        this._setStats({ loaded: false, suspended: true, heapMB: null, releases: this._stats.releases + 1 });
        this._store.announce({ modelId, state: 'ready', suspended: true }, { broadcast: false });
        this._emit('release', { modelId, reason });
        return true;
    }

    _scheduleRelease() {
        clearTimeout(this._releaseTimer);
        this._releaseTimer = null;
        if (this._mode !== 'local' || !this._worker || !this._ready || this._busy > 0) return;
        const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
        this._releaseTimer = setTimeout(() => this.release(hidden ? 'hidden' : 'idle'), hidden ? HIDDEN_RELEASE_MS : IDLE_RELEASE_MS);
        this._releaseTimer?.unref?.();
    }

    /** React to downloads finishing and models being deleted, on this page or another tab. */
    _onModelState({ modelId, state }) {
        if (this._mode !== 'local' || !modelId || modelId !== this._modelId) return;
        if (state === 'downloaded' && !this._worker && !this._starting && !this._suspended) {
            // The model this page asked for has arrived: load it, unless the tab is in the background.
            if (typeof document === 'undefined' || document.visibilityState !== 'hidden') this._startLocal(modelId);
        } else if (state === 'not-downloaded' && (this._worker || this._suspended)) {
            // The loaded model was deleted from storage: give its memory back too.
            this._stopWorker();
            this._ready = false;
            this._loading = false;
            this._suspended = false;
            for (const [id, cb] of this._callbacks) { cb.onError?.('The model was deleted.'); this._callbacks.delete(id); }
            this._setStats({ loaded: false, suspended: false });
            this._emit('unavailable', { modelId, state: 'not-downloaded', wasReady: true });
        }
    }

    /**
     * Switch to API mode.  Terminates any running local worker (returning the
     * model's memory), stores the config, and fires 'ready' immediately.
     *
     * Safe to call repeatedly: subsequent calls update the config and re-fire
     * 'ready' so the UI refreshes its status text.
     *
     * @param {string} endpoint  Base URL, e.g. 'https://api.openai.com/v1'
     * @param {string} apiKey    Bearer token (may be empty for local servers)
     * @param {string} model     Model name, e.g. 'gpt-4o'
     */
    setApiMode(endpoint, apiKey, model) {
        this._stopWorker();
        this._mode      = 'api';
        this._apiConfig = {
            endpoint: (endpoint || 'https://api.openai.com/v1').replace(/\/$/, ''),
            apiKey:   apiKey  || '',
            model:    model   || 'gpt-4o',
        };
        this._ready    = true;
        this._loading  = false;
        this._suspended = false;
        this._modelId  = null;
        this._callbacks.clear();
        this._stats = { ...this._emptyStats(), backend: 'api', modelId: this._apiConfig.model, device: 'api', loaded: true, releases: this._stats.releases };
        this._emit('ready', { device: 'api' });
    }

    /**
     * Switch to Ollama mode.  Uses Ollama's OpenAI-compatible /v1 endpoint.
     * Terminates any running local worker; fires 'ready' immediately.
     *
     * @param {string}       endpoint  Ollama server base URL, e.g. 'http://localhost:11434'
     * @param {string}       model     Model name, e.g. 'llava' or 'llava:13b'
     * @param {boolean|null} think     null = let model decide, true = force thinking on,
     *                                 false = force thinking off.  Only takes effect on
     *                                 models that support Ollama's think parameter (e.g.
     *                                 qwq, deepseek-r1, qwen3).
     */
    setOllamaMode(endpoint, model, think = null) {
        const base = (endpoint || 'http://localhost:11434').replace(/\/$/, '').replace(/\/v1$/, '');
        this.setApiMode(`${base}/v1`, '', model || 'gemma3');
        // Mark as native Ollama so _queryApi routes to the /api/chat endpoint,
        // which is the only path that correctly supports the `think` parameter.
        this._apiConfig.isOllama   = true;
        this._apiConfig.ollamaBase = base;
        this._apiConfig.think = (think === true || think === false) ? think : null;
        this._stats.backend = 'ollama';
    }

    /**
     * Fetch the list of all locally available models from an Ollama server.
     * Returns an array of objects: { name, families }.
     *
     * @param {string} endpoint  Ollama server base URL, e.g. 'http://localhost:11434'
     * @returns {Promise<Array<{name: string, families: string[]}>>}
     */
    static async listOllamaModels(endpoint = 'http://localhost:11434') {
        const base = (endpoint || 'http://localhost:11434').replace(/\/$/, '').replace(/\/v1$/, '');
        const res = await fetch(`${base}/api/tags`);
        if (!res.ok) throw new Error(`Ollama ${res.status}: ${res.statusText}`);
        const data = await res.json();
        return (data.models ?? []).map(m => ({
            name:     m.name,
            families: m.details?.families ?? [],
        }));
    }

    /**
     * Load a model into Ollama's GPU memory.
     * Sending an empty prompt with a keep_alive duration preloads the model.
     *
     * @param {string}         endpoint   Ollama server base URL
     * @param {string}         model      Model name, e.g. 'llava' or 'llava:13b'
     * @param {string|number}  keepAlive  Duration string ('5m', '1h') or seconds.
     *                                    Defaults to '5m'.
     * @returns {Promise<void>}
     */
    static async loadOllamaModel(endpoint = 'http://localhost:11434', model, keepAlive = '5m') {
        const base = (endpoint || 'http://localhost:11434').replace(/\/$/, '').replace(/\/v1$/, '');
        const res = await fetch(`${base}/api/generate`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ model, keep_alive: keepAlive }),
        });
        if (!res.ok) throw new Error(`Ollama ${res.status}: ${res.statusText}`);
        // Drain the streaming NDJSON response so the connection closes cleanly
        const reader = res.body.getReader();
        while (true) { const { done } = await reader.read(); if (done) break; }
    }

    /**
     * Immediately unload a model from Ollama's GPU memory.
     * Equivalent to loadOllamaModel with keep_alive = 0.
     *
     * @param {string} endpoint  Ollama server base URL
     * @param {string} model     Model name to unload
     * @returns {Promise<void>}
     */
    static async unloadOllamaModel(endpoint = 'http://localhost:11434', model) {
        return VLMManager.loadOllamaModel(endpoint, model, 0);
    }

    /**
     * Return the list of models currently loaded in Ollama's memory (/api/ps).
     *
     * @param {string} endpoint  Ollama server base URL
     * @returns {Promise<Array<{name: string, size_vram: number, expires_at: string}>>}
     */
    static async getOllamaRunningModels(endpoint = 'http://localhost:11434') {
        const base = (endpoint || 'http://localhost:11434').replace(/\/$/, '').replace(/\/v1$/, '');
        const res = await fetch(`${base}/api/ps`);
        if (!res.ok) throw new Error(`Ollama ${res.status}: ${res.statusText}`);
        const data = await res.json();
        return (data.models ?? []).map(m => ({
            name:       m.name,
            size_vram:  m.size_vram,
            expires_at: m.expires_at,
        }));
    }


    // ─── Query API ─────────────────────────────────────────────────────────

    /**
     * Submit an inference request.  Routes to the local worker or the
     * OpenAI-compatible API depending on the current mode.
     *
     * @param {string}   imageSrc      Absolute URL or data-URI of the image.
     * @param {string}   prompt        User's question.
     * @param {Array}    chatHistory   Prior {role, content} turns (may be empty).
     * @param {object}   callbacks     { onStart?, onToken?, onDone?, onError?, signal?, systemPrompt?, maxNewTokens? }
     * systemPrompt overrides the shared prompt for this request without changing other clients.
     * maxNewTokens caps a local answer (default 512).
     * onDone receives (text, tokenCount, avgTps, stats).
     * @returns {number}               Request ID.
     */
    query(imageSrc, prompt, chatHistory, callbacks = {}) {
        if (this._mode === 'api') {
            this._queryApi(imageSrc, prompt, chatHistory, callbacks);
            return 0;
        }
        if (!this._worker && !this._starting && !this._suspended) throw new Error('VLMManager: call init() before query()');

        const id = ++this._nextId;
        this._callbacks.set(id, callbacks);
        this._queryLocal(id, imageSrc, prompt, chatHistory, callbacks);
        return id;
    }

    async _queryLocal(id, imageSrc, prompt, chatHistory, callbacks) {
        this._busy++;
        clearTimeout(this._releaseTimer);
        try {
            if (!this._worker) {
                // Still checking storage after init(), or released after idling: wait for the worker.
                const pending = this._startPromise ?? (this._suspended ? this._startLocal(this._modelId) : null);
                if (!pending || !(await pending) || !this._worker) throw new Error('Download A Model In Settings');
            }
            if (!this._callbacks.has(id)) return;   // restarted or switched backend meanwhile
            const worker = this._worker;
            const started = Date.now();
            const model = this._store.get(this._modelId);
            const prepared = await this._prepareImage(imageSrc, model?.inputSize ?? 512);
            if (!this._callbacks.has(id) || this._worker !== worker) {
                prepared.bitmap?.close?.();
                return;
            }

            const requestPrompt = callbacks.systemPrompt ? `${callbacks.systemPrompt}\n\n${prompt}` : prompt;
            const message = {
                type: 'generate', id, prompt: requestPrompt, chatHistory,
                imageKey: prepared.key,
                maxNewTokens: callbacks.maxNewTokens,
            };
            if (prepared.bitmap) message.image = prepared.bitmap; else message.imageSrc = imageSrc;
            this._imageInfo.set(id, {
                prepareMs: Date.now() - started,
                transferred: !!prepared.bitmap,
                width: prepared.width ?? null, height: prepared.height ?? null,
                sourceWidth: prepared.sourceWidth ?? null, sourceHeight: prepared.sourceHeight ?? null,
            });
            this._worker.postMessage(message, prepared.bitmap ? [prepared.bitmap] : []);

            // Forward abort signal to the worker so local inference can stop mid-stream
            if (callbacks.signal) {
                const target = this._worker;
                const onAbort = () => { if (this._worker === target) target.postMessage({ type: 'abort', id }); };
                if (callbacks.signal.aborted) onAbort();
                else callbacks.signal.addEventListener('abort', onAbort, { once: true });
            }
        } catch (error) {
            this._imageInfo.delete(id);
            if (this._callbacks.delete(id)) callbacks.onError?.(error.message);
            this._settle();
        }
    }

    /** One local question finished (answered, failed or dropped). */
    _settle() {
        this._busy = Math.max(0, this._busy - 1);
        this._scheduleRelease();
    }

    // ─── Event Bus ─────────────────────────────────────────────────────────

    /**
     * Set a system-level instruction that is prepended to every API/Ollama
     * conversation.  Pass null to clear.  Returns `this` for chaining.
     * @param {string|null} prompt
     */
    setSystemPrompt(prompt) {
        this._systemPrompt = prompt ?? null;
        return this;
    }

    /**
     * Subscribe to a global event:
     *   'ready' | 'progress' | 'restart' | 'error'      (unchanged)
     *   'unavailable'  the selected local model is not downloaded, so nothing loaded
     *   'release'      the local model was unloaded after idling
     *   'stats'        the stats snapshot changed
     * Returns `this` for chaining.
     */
    on(event, handler) {
        (this._listeners[event] ??= []).push(handler);
        return this;
    }

    // ─── Internal — local worker dispatch ──────────────────────────────────

    _dispatch(data) {
        const { type, id } = data;
        const cb = id != null ? this._callbacks.get(id) : null;

        switch (type) {
            case 'ready':
                this._ready   = true;
                this._loading = false;
                this._suspended = false;
                this._setStats({
                    device: data.device, dtype: data.dtype ?? this._stats.dtype, loaded: true, suspended: false,
                    loadMs: data.loadMs ?? (Date.now() - this._loadStarted), heapMB: data.heapMB ?? null,
                });
                this._store.announce({ modelId: this._modelId, state: 'ready' }, { broadcast: false });
                this._emit('ready', data);
                this._scheduleRelease();
                break;

            case 'warm':
                this._setStats({ warmupMs: data.warmupMs, heapMB: data.heapMB ?? this._stats.heapMB });
                break;

            case 'progress':
                this._emit('progress', data);
                break;

            case 'generating':
                cb?.onStart?.();
                break;

            case 'token':
                cb?.onToken?.(data.token, data.tps, data.tokenCount);
                break;

            case 'done': {
                const stats = data.stats ? { ...data.stats, image: this._imageInfo.get(id) ?? null } : null;
                this._imageInfo.delete(id);
                if (stats) this._setStats({ lastQuery: stats, tokensPerSecond: data.avgTps ?? null, heapMB: stats.heapMB ?? this._stats.heapMB });
                if (id != null && this._callbacks.delete(id)) {
                    cb?.onDone?.(data.text, data.tokenCount, data.avgTps, stats);
                    this._settle();
                }
                break;
            }

            case 'error':
                if (id != null) {
                    this._imageInfo.delete(id);
                    if (this._callbacks.delete(id)) {
                        cb?.onError?.(data.message);
                        this._settle();
                    }
                } else {
                    this._failLoad(data.message);
                }
                break;
        }
    }

    // ─── Internal — OpenAI-compatible API streaming ────────────────────────

    async _queryApi(imageSrc, prompt, chatHistory, callbacks) {
        if (this._apiConfig.isOllama) {
            return this._queryOllamaChat(imageSrc, prompt, chatHistory, callbacks);
        }
        const { endpoint, apiKey, model } = this._apiConfig;

        callbacks.onStart?.();

        // Build the messages array.  The image is attached to the first user
        // turn (either from history or the current prompt).  Subsequent turns
        // are plain text so the context window stays small.
        const messages = [];

        // Prepend system prompt if configured
        const systemPrompt = callbacks.systemPrompt ?? this._systemPrompt;
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }

        let imageInserted = false;

        for (const turn of chatHistory ?? []) {
            if (turn.role === 'user' && !imageInserted) {
                messages.push({
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: imageSrc } },
                        { type: 'text',      text: turn.content },
                    ],
                });
                imageInserted = true;
            } else {
                messages.push({ role: turn.role, content: turn.content });
            }
        }

        if (!imageInserted) {
            // No history — current prompt is the first (and only) turn with the image
            messages.push({
                role: 'user',
                content: [
                    { type: 'image_url', image_url: { url: imageSrc } },
                    { type: 'text',      text: prompt },
                ],
            });
        } else {
            // History already has the image — current prompt is plain text
            messages.push({ role: 'user', content: prompt });
        }

        let fullText   = '';
        let tokenCount = 0;
        let startMs    = 0;

        try {
            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

            const body = { model, messages, stream: true, max_tokens: 2048 };

            const res = await fetch(`${endpoint}/chat/completions`, {
                method: 'POST',
                headers,
                signal: callbacks.signal ?? null,
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const errText = await res.text().catch(() => res.statusText);
                callbacks.onError?.(`API ${res.status}: ${errText}`);
                return;
            }

            // Parse SSE stream — compatible with OpenAI, Ollama, LM Studio, etc.
            const reader  = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer     = '';
            startMs        = performance.now();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';   // keep any incomplete last line

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const payload = line.slice(6).trim();
                    if (payload === '[DONE]') continue;
                    try {
                        const json    = JSON.parse(payload);
                        const delta   = json.choices?.[0]?.delta ?? {};
                        // Ollama uses delta.thinking; OpenRouter / other OpenAI-compat
                        // providers use delta.reasoning or delta.reasoning_content.
                        const thinkChunk = delta.thinking ?? delta.reasoning ?? delta.reasoning_content;
                        if (thinkChunk) {
                            callbacks.onThinking?.(thinkChunk);
                        }
                        if (delta.content) {
                            fullText += delta.content;
                            tokenCount++;
                            const elapsed = (performance.now() - startMs) / 1000;
                            const tps = elapsed > 0.5
                                ? parseFloat((tokenCount / elapsed).toFixed(1))
                                : null;
                            callbacks.onToken?.(delta.content, tps, tokenCount);
                        }
                    } catch (_) { /* malformed SSE chunk — skip */ }
                }
            }

            const elapsed = (performance.now() - startMs) / 1000;
            const avgTps  = elapsed > 0 ? parseFloat((tokenCount / elapsed).toFixed(1)) : null;
            callbacks.onDone?.(fullText, tokenCount, avgTps);

        } catch (err) {
            if (err.name === 'AbortError') {
                // User stopped the response — treat as a completed (partial) reply
                const elapsed = (performance.now() - startMs) / 1000;
                const avgTps  = elapsed > 0 && tokenCount > 0
                    ? parseFloat((tokenCount / elapsed).toFixed(1)) : null;
                callbacks.onDone?.(fullText, tokenCount, avgTps);
            } else {
                callbacks.onError?.(err.message);
            }
        }
    }

    // ─── Internal — Ollama native /api/chat streaming ─────────────────────

    async _queryOllamaChat(imageSrc, prompt, chatHistory, callbacks) {
        const { ollamaBase, model, think } = this._apiConfig;
        callbacks.onStart?.();

        // Convert imageSrc to base64 for Ollama's native messages format.
        // data URIs: strip the header.  URLs: fetch and encode.
        let imageB64 = null;
        if (imageSrc) {
            try {
                if (imageSrc.startsWith('data:')) {
                    imageB64 = imageSrc.split(',')[1] ?? null;
                } else {
                    const res = await fetch(imageSrc);
                    const buf = await res.arrayBuffer();
                    let binary = '';
                    const bytes = new Uint8Array(buf);
                    // Chunked to avoid call-stack limits on large images
                    for (let i = 0; i < bytes.length; i += 8192) {
                        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
                    }
                    imageB64 = btoa(binary);
                }
            } catch (_) { /* proceed without image */ }
        }

        // Build messages — image attached to the first user turn only
        const messages = [];
        const systemPrompt = callbacks.systemPrompt ?? this._systemPrompt;
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }

        let imageInserted = false;
        for (const turn of chatHistory ?? []) {
            if (turn.role === 'user' && !imageInserted && imageB64) {
                messages.push({ role: 'user', content: turn.content, images: [imageB64] });
                imageInserted = true;
            } else {
                messages.push({ role: turn.role, content: turn.content });
            }
        }

        if (!imageInserted) {
            const msg = { role: 'user', content: prompt };
            if (imageB64) msg.images = [imageB64];
            messages.push(msg);
        } else {
            messages.push({ role: 'user', content: prompt });
        }

        let fullText   = '';
        let tokenCount = 0;
        let startMs    = 0;

        try {
            const body = { model, messages, stream: true };
            if (think !== null && think !== undefined) body.think = think;

            const res = await fetch(`${ollamaBase}/api/chat`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                signal:  callbacks.signal ?? null,
                body:    JSON.stringify(body),
            });

            if (!res.ok) {
                const errText = await res.text().catch(() => res.statusText);
                callbacks.onError?.(`Ollama ${res.status}: ${errText}`);
                return;
            }

            // Ollama streams NDJSON — one JSON object per line
            const reader  = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer     = '';
            startMs        = performance.now();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    try {
                        const json = JSON.parse(trimmed);
                        const msg  = json.message ?? {};
                        if (msg.thinking) {
                            callbacks.onThinking?.(msg.thinking);
                        }
                        if (msg.content) {
                            fullText += msg.content;
                            tokenCount++;
                            const elapsed = (performance.now() - startMs) / 1000;
                            const tps = elapsed > 0.5
                                ? parseFloat((tokenCount / elapsed).toFixed(1))
                                : null;
                            callbacks.onToken?.(msg.content, tps, tokenCount);
                        }
                        if (json.done) {
                            const elapsed = (performance.now() - startMs) / 1000;
                            const avgTps  = elapsed > 0 ? parseFloat((tokenCount / elapsed).toFixed(1)) : null;
                            callbacks.onDone?.(fullText, tokenCount, avgTps);
                            return;
                        }
                    } catch (_) { /* malformed line — skip */ }
                }
            }

            // Stream closed without done marker
            const elapsed = (performance.now() - startMs) / 1000;
            const avgTps  = elapsed > 0 && tokenCount > 0
                ? parseFloat((tokenCount / elapsed).toFixed(1)) : null;
            callbacks.onDone?.(fullText, tokenCount, avgTps);

        } catch (err) {
            if (err.name === 'AbortError') {
                const elapsed = (performance.now() - startMs) / 1000;
                const avgTps  = elapsed > 0 && tokenCount > 0
                    ? parseFloat((tokenCount / elapsed).toFixed(1)) : null;
                callbacks.onDone?.(fullText, tokenCount, avgTps);
            } else {
                callbacks.onError?.(err.message);
            }
        }
    }

    _emit(event, data) {
        (this._listeners[event] ?? []).forEach(fn => fn(data));
    }
}

// window.VLM_MODELS — the model store, on every page that loads this module.
if (typeof window !== 'undefined' && !window.VLM_MODELS) {
    const store = modelStore();
    window.VLM_MODELS = store;
    // A download the visitor started on the previous page of the site continues here.
    setTimeout(() => { store.resumePending().catch(() => {}); }, 0);
}

export { VLMManager };
