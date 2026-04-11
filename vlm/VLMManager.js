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
 *   mgr.init('HuggingFaceTB/SmolVLM-256M-Instruct');
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
    init(modelId = 'HuggingFaceTB/SmolVLM-256M-Instruct') {
        if (this._worker) return;
        this._mode    = 'local';
        this._loading = true;
        this._modelId = modelId;

        this._worker = new Worker(
            new URL('./vlmWorker.js', import.meta.url),
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
    restart(modelId = 'HuggingFaceTB/SmolVLM-256M-Instruct') {
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
        const { endpoint, apiKey, model } = this._apiConfig;

        callbacks.onStart?.();

        // Build the messages array.  The image is attached to the first user
        // turn (either from history or the current prompt).  Subsequent turns
        // are plain text so the context window stays small.
        const messages = [];
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

        try {
            const headers = { 'Content-Type': 'application/json' };
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

            const res = await fetch(`${endpoint}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model,
                    messages,
                    stream:     true,
                    max_tokens: 500,
                }),
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
            let fullText   = '';
            let tokenCount = 0;
            const startMs  = performance.now();

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
                        const json  = JSON.parse(payload);
                        const delta = json.choices?.[0]?.delta?.content;
                        if (delta) {
                            fullText += delta;
                            tokenCount++;
                            const elapsed = (performance.now() - startMs) / 1000;
                            const tps = elapsed > 0.5
                                ? parseFloat((tokenCount / elapsed).toFixed(1))
                                : null;
                            callbacks.onToken?.(delta, tps, tokenCount);
                        }
                    } catch (_) { /* malformed SSE chunk — skip */ }
                }
            }

            const elapsed = (performance.now() - startMs) / 1000;
            const avgTps  = elapsed > 0 ? parseFloat((tokenCount / elapsed).toFixed(1)) : null;
            callbacks.onDone?.(fullText, tokenCount, avgTps);

        } catch (err) {
            callbacks.onError?.(err.message);
        }
    }

    _emit(event, data) {
        (this._listeners[event] ?? []).forEach(fn => fn(data));
    }
}

export { VLMManager };
