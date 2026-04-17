/**
 * VLMManager.js — Singleton VLM Engine
 *
 * Supports two backends, switchable at runtime:
 *
 *   LOCAL  — Web Worker running SmolVLM via Transformers.js (default)
 *   API    — OpenAI-compatible REST endpoint (GPT-4o, Ollama, LM Studio, etc.)
 *
 * Usage
 * ─────
 *   import { VLMManager } from './VLMManager.js';
 *
 *   const mgr = VLMManager.getInstance();
 *   mgr.on('ready', () => console.log('Model ready'));
 *
 *   // Local mode
 *   mgr.init('onnx-community/FastVLM-0.5B-ONNX');
 *
 *   // API mode — signals ready immediately, no download
 *   mgr.setApiMode('https://api.openai.com/v1', 'sk-...', 'gpt-4o');
 *
 *   mgr.query(imageUrl, 'What's in this photo?', [], {
 *       onToken:  (tok) => console.log(tok),
 *       onDone:   (txt) => console.log('Full:', txt),
 *       onError:  (msg) => console.error(msg),
 *   });
 */

let _singleton = null;

class VLMManager {
    constructor() {
        // True singleton — subsequent `new VLMManager()` returns the same object.
        if (_singleton) return _singleton;
        _singleton = this;

        this._worker      = null;
        this._ready       = false;
        this._loading     = false;
        this._modelId     = null;        // model ID currently loaded in the worker
        this._mode        = 'local';     // 'local' | 'api'
        this._apiConfig   = null;        // { endpoint, apiKey, model }
        this._nextId      = 0;
        this._callbacks   = new Map();   // requestId → { onStart, onToken, onDone, onError }
        this._listeners   = {};          // event name → [handler, ...]
        this._systemPrompt = null;       // prepended as a system message in every API conversation
    }

    /** Always returns the page-level singleton. */
    static getInstance() {
        return _singleton ?? new VLMManager();
    }

    get isReady()   { return this._ready; }
    get isLoading() { return this._loading; }

    // ─── Lifecycle ─────────────────────────────────────────────────────────

    /**
     * Spawn the worker and begin loading the local model.
     * Safe to call multiple times — only the first call has any effect.
     * @param {string} [modelId]  HuggingFace model ID
     */
    init(modelId = 'onnx-community/FastVLM-0.5B-ONNX') {
        if (this._worker) return;
        this._mode    = 'local';
        this._loading = true;
        this._modelId = modelId;

        this._worker = new Worker(
            new URL('./vlmWorker.js?v=11', import.meta.url),
            { type: 'module' },
        );

        this._worker.onmessage = (e) => this._dispatch(e.data);
        this._worker.onerror   = (e) => {
            console.error('[VLMManager] Worker error:', e.message);
            this._emit('error', { message: e.message });
        };

        this._worker.postMessage({ type: 'load', modelId });
    }

    /**
     * Terminate the local worker and restart with a (possibly different) model.
     * Pending callbacks are discarded. Fires a 'restart' event so the UI can
     * reset its loading indicators.
     * @param {string} modelId
     */
    restart(modelId = 'onnx-community/FastVLM-0.5B-ONNX') {
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
        this._mode     = 'local';
        this._ready    = false;
        this._loading  = false;
        this._modelId  = null;
        this._apiConfig = null;
        this._callbacks.clear();
        this._emit('restart', { modelId });
        this.init(modelId);
    }

    /**
     * Switch to API mode.  Terminates any running local worker, stores the
     * config, and fires 'ready' immediately — there is nothing to download.
     *
     * Safe to call repeatedly: subsequent calls update the config and re-fire
     * 'ready' so the UI refreshes its status text.
     *
     * @param {string} endpoint  Base URL, e.g. 'https://api.openai.com/v1'
     * @param {string} apiKey    Bearer token (may be empty for local servers)
     * @param {string} model     Model name, e.g. 'gpt-4o'
     */
    setApiMode(endpoint, apiKey, model) {
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
        this._mode      = 'api';
        this._apiConfig = {
            endpoint: (endpoint || 'https://api.openai.com/v1').replace(/\/$/, ''),
            apiKey:   apiKey  || '',
            model:    model   || 'gpt-4o',
        };
        this._ready    = true;
        this._loading  = false;
        this._modelId  = null;
        this._callbacks.clear();
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
     * @param {object}   callbacks     { onStart?, onToken?, onDone?, onError? }
     * @returns {number}               Request ID.
     */
    query(imageSrc, prompt, chatHistory, callbacks = {}) {
        if (this._mode === 'api') {
            this._queryApi(imageSrc, prompt, chatHistory, callbacks);
            return 0;
        }
        if (!this._worker) throw new Error('VLMManager: call init() before query()');

        const id = ++this._nextId;
        this._callbacks.set(id, callbacks);
        this._worker.postMessage({ type: 'generate', id, imageSrc, prompt, chatHistory });
        return id;
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
     * Subscribe to a global event: 'ready' | 'progress' | 'restart' | 'error'
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
                this._emit('ready', data);
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

            case 'done':
                cb?.onDone?.(data.text, data.tokenCount, data.avgTps);
                this._callbacks.delete(id);
                break;

            case 'error':
                if (cb?.onError) {
                    cb.onError(data.message);
                } else {
                    this._emit('error', data);
                }
                if (id != null) this._callbacks.delete(id);
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
        if (this._systemPrompt) {
            messages.push({ role: 'system', content: this._systemPrompt });
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
        if (this._systemPrompt) {
            messages.push({ role: 'system', content: this._systemPrompt });
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

export { VLMManager };
