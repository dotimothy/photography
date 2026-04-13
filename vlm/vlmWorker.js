/**
 * vlmWorker.js — Multi-Model VLM Web Worker
 *
 * Runs entirely off the main thread. Handles model loading (WebGPU → WASM
 * fallback) and sequential inference with streaming token output.
 * Requests are queued so concurrent gallery interactions never race on the GPU.
 *
 * Supported model families:
 *   - SmolVLM / SmolVLM2 (HuggingFaceTB)  → AutoModelForVision2Seq
 *   - Apple FastVLM      (onnx-community)  → AutoModelForImageTextToText
 *
 * Progress events carry granular metrics so the UI can show:
 *   - Per-file and cumulative MB downloaded
 *   - JS heap usage (Chrome/Chromium; null elsewhere)
 *   - Live tokens-per-second and token count during generation
 *
 * Mobile robustness:
 *   - detectDevice() validates a real GPU adapter is acquirable (not just
 *     navigator.gpu != null) before committing to WebGPU
 *   - If WebGPU model loading throws for any reason, initModel() resets and
 *     retries automatically with WASM
 *   - WASM thread count is only raised when SharedArrayBuffer is available;
 *     without it ONNX Runtime is forced to single-threaded mode anyway
 */

import {
    AutoProcessor,
    AutoModelForVision2Seq,
    AutoModelForImageTextToText,
    RawImage,
    TextStreamer,
    env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';

env.allowLocalModels = false;
// Cache API requires a secure context and is unavailable in Workers on some
// mobile browsers (iOS Safari without HTTPS, certain Android WebViews, etc.).
// Fall back gracefully so the model still loads — it just won't be cached.
env.useBrowserCache = typeof caches !== 'undefined';

// Only request extra WASM threads when SharedArrayBuffer is available.
// Mobile browsers without COOP/COEP headers block SharedArrayBuffer, which
// makes ONNX Runtime silently fall back to 1 thread.  Setting numThreads > 1
// without SAB triggers a warning but not a crash — still fine to guard here.
if (typeof SharedArrayBuffer !== 'undefined' &&
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
    env.backends.onnx.wasm.numThreads = Math.max(1, navigator.hardwareConcurrency - 1);
}

const DEFAULT_MODEL_ID = 'onnx-community/FastVLM-0.5B-ONNX';

let processor      = null;
let model          = null;
let _device        = 'wasm';   // remembered for stats
let _modelId       = DEFAULT_MODEL_ID;  // remembered for inference routing
let isProcessing   = false;
let _warmupPromise = null;     // resolves when background warmup finishes

/** True when the loaded model is Apple FastVLM (different processor/message API). */
function isFastVLM() { return /FastVLM/i.test(_modelId); }
const queue        = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function post(msg) { self.postMessage(msg); }

function basename(path) { return path ? path.split('/').pop() : ''; }

/**
 * Current JS heap usage in MB.
 * performance.memory is Chrome/Chromium only — returns null elsewhere.
 */
function heapMB() {
    const mem = typeof performance !== 'undefined' && performance.memory;
    return mem ? Math.round(mem.usedJSHeapSize / 1_048_576) : null;
}

// ─── Device Detection ─────────────────────────────────────────────────────────

/**
 * Validate that WebGPU is actually usable, not just present.
 *
 * navigator.gpu exists on iOS Safari 16.4+ and some Android Chrome builds even
 * when the GPU adapter cannot be acquired (driver issues, sandboxing, etc.).
 * We confirm by requesting an adapter with a 3-second timeout.
 *
 * @returns {Promise<'webgpu'|'wasm'>}
 */
async function detectDevice() {
    if (typeof navigator === 'undefined' || !navigator.gpu) return 'wasm';
    try {
        const adapter = await Promise.race([
            navigator.gpu.requestAdapter(),
            new Promise((_, rej) =>
                setTimeout(() => rej(new Error('GPU adapter request timed out')), 3000)),
        ]);
        return adapter ? 'webgpu' : 'wasm';
    } catch (e) {
        console.warn('[vlmWorker] WebGPU adapter check failed:', e.message, '— using WASM');
        return 'wasm';
    }
}

// ─── Model Init ──────────────────────────────────────────────────────────────

/**
 * Inner loader: loads processor + model for a given device.
 * Separated so initModel() can call it twice (WebGPU then WASM) on failure.
 */
async function _loadForDevice(modelId, device) {
    const dtype = device === 'webgpu'
        ? { embed_tokens: 'fp16', vision_encoder: 'q4', decoder_model_merged: 'q4' }
        : 'q4';

    // ── Stage 1: Processor & tokenizer ───────────────────────────────────
    post({ type: 'progress', stage: 'proc',
           message: `Loading processor & tokenizer… [${device.toUpperCase()}]`, pct: 0 });

    processor = await AutoProcessor.from_pretrained(modelId, {
        progress_callback: (p) => {
            if (p.status === 'progress') {
                post({ type: 'progress', stage: 'proc',
                       message: `Processor: ${basename(p.file)}…`,
                       pct: Math.round((p.progress ?? 0) * 8) });
            }
        },
    });

    post({ type: 'progress', stage: 'proc_done',
           message: `Processor ready — fetching model weights… [${device.toUpperCase()}]`, pct: 8 });

    // ── Stage 2: Model weights ────────────────────────────────────────────
    // Track per-file loaded bytes for a running cumulative total.
    const fileProgress    = new Map();
    let   doneBytes       = 0;
    let   compileSignaled = false;

    // FastVLM uses a different auto-class than the SmolVLM family
    const ModelClass = /FastVLM/i.test(modelId)
        ? AutoModelForImageTextToText
        : AutoModelForVision2Seq;

    model = await ModelClass.from_pretrained(modelId, {
        dtype,
        device,
        progress_callback: (p) => {
            const file = basename(p.file ?? '');

            if (p.status === 'initiate') {
                post({
                    type:         'progress',
                    stage:        'download',
                    message:      `Fetching ${file}…`,
                    file,
                    downloadedMB: (doneBytes / 1e6).toFixed(1),
                    pct:          10,
                });

            } else if (p.status === 'progress' || p.status === 'download') {
                fileProgress.set(file, p.loaded ?? 0);

                const inFlight  = [...fileProgress.values()].reduce((s, b) => s + b, 0);
                const totalMB   = ((doneBytes + inFlight) / 1e6).toFixed(1);
                const fileMB    = p.loaded ? (p.loaded / 1e6).toFixed(1) : null;
                const filePct   = p.progress ?? 0;

                post({
                    type:         'progress',
                    stage:        'download',
                    message:      fileMB ? `${file} — ${fileMB} MB` : `Downloading ${file}…`,
                    file,
                    fileMB,
                    downloadedMB: totalMB,
                    pct:          10 + Math.round(filePct * 0.72),
                });

            } else if (p.status === 'done') {
                doneBytes += fileProgress.get(file) ?? 0;
                fileProgress.delete(file);

                if (!compileSignaled &&
                    (file.endsWith('.onnx') || file.endsWith('.onnx_data') || file.endsWith('.bin'))) {
                    compileSignaled = true;
                    post({
                        type:         'progress',
                        stage:        'compile',
                        message:      'Initialising ONNX runtime…',
                        downloadedMB: (doneBytes / 1e6).toFixed(1),
                        loadedMB:     (doneBytes / 1e6).toFixed(1),
                        heapMB:       heapMB(),
                        pct:          85,
                    });
                }
            }
        },
    });
}

async function initModel(modelId = DEFAULT_MODEL_ID) {
    _modelId = modelId;

    // Validate WebGPU by requesting an adapter — falls back to 'wasm' if the
    // adapter is unavailable or the request times out (common on iOS Safari).
    _device = await detectDevice();

    try {
        await _loadForDevice(modelId, _device);

    } catch (firstErr) {
        // ── WebGPU → WASM automatic fallback ─────────────────────────────
        if (_device === 'webgpu') {
            console.warn(
                `[vlmWorker] WebGPU load failed (${firstErr.message}) — retrying with WASM…`
            );
            _device   = 'wasm';
            processor = null;
            model     = null;

            post({
                type:    'progress',
                stage:   'proc',
                message: `WebGPU failed — retrying with WASM… (${firstErr.message})`,
                pct:     0,
            });

            try {
                await _loadForDevice(modelId, 'wasm');
            } catch (wasmErr) {
                post({ type: 'error',
                       message: `Load failed [WASM after WebGPU fallback]: ${wasmErr.message}` });
                return;
            }

        } else {
            // WASM attempt itself failed — surface the real error
            post({ type: 'error',
                   message: `Load failed [${_device.toUpperCase()}]: ${firstErr.message}` });
            return;
        }
    }

    // Signal ready immediately — the UI unlocks and the loading panel collapses.
    // Warmup (JIT compilation / shader builds) runs silently in the background.
    // The first real inference awaits _warmupPromise so JIT still front-loads;
    // it just no longer blocks the loading screen.
    post({ type: 'ready', device: _device, heapMB: heapMB() });

    _warmupPromise = (async () => {
        try {
            const dummyImg = new RawImage(new Uint8ClampedArray(32 * 32 * 3).fill(200), 32, 32, 3);
            let warmInputs;
            if (isFastVLM()) {
                const warmText = processor.apply_chat_template(
                    [{ role: 'user', content: '<image>.' }],
                    { add_generation_prompt: true },
                );
                warmInputs = await processor(dummyImg, warmText, { add_special_tokens: false });
            } else {
                const warmText = processor.apply_chat_template(
                    [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: '.' }] }],
                    { tokenize: false, add_generation_prompt: true },
                );
                warmInputs = await processor(warmText, [dummyImg], { return_tensors: 'pt' });
            }
            await model.generate({ ...warmInputs, max_new_tokens: 1, do_sample: false });
        } catch (_) { /* warmup failure is non-fatal */ }
    })().finally(() => { _warmupPromise = null; });
}

// ─── Inference ────────────────────────────────────────────────────────────────

/**
 * SmolVLM-style messages: image is a content-block object `{ type: 'image' }`.
 */
function buildMessages(history, prompt) {
    const messages = [];
    let imageInserted = false;

    for (const turn of history) {
        if (turn.role === 'user' && !imageInserted) {
            messages.push({
                role:    'user',
                content: [{ type: 'image' }, { type: 'text', text: turn.content }],
            });
            imageInserted = true;
        } else {
            messages.push({
                role:    turn.role,
                content: [{ type: 'text', text: turn.content }],
            });
        }
    }

    if (!imageInserted) {
        messages.push({ role: 'user', content: [{ type: 'image' }, { type: 'text', text: prompt }] });
    } else {
        messages.push({ role: 'user', content: [{ type: 'text', text: prompt }] });
    }

    return messages;
}

/**
 * FastVLM-style messages: image is the inline string token `<image>` prepended
 * to the first user turn's content string.
 */
function buildFastVLMMessages(history, prompt) {
    const messages = [];
    let imageInserted = false;

    for (const turn of history) {
        if (turn.role === 'user' && !imageInserted) {
            messages.push({ role: 'user', content: `<image>${turn.content}` });
            imageInserted = true;
        } else {
            messages.push({ role: turn.role, content: turn.content });
        }
    }

    if (!imageInserted) {
        messages.push({ role: 'user', content: `<image>${prompt}` });
    } else {
        messages.push({ role: 'user', content: prompt });
    }

    return messages;
}

async function runInference(request) {
    const { id, imageSrc, prompt, chatHistory } = request;
    isProcessing = true;

    try {
        post({ type: 'generating', id });

        // If background warmup is still running, wait for it before using the
        // model — avoids concurrent model.generate calls on the same instance.
        if (_warmupPromise) await _warmupPromise;

        const image = await RawImage.fromURL(imageSrc);
        let inputs;

        if (isFastVLM()) {
            // FastVLM: inline <image> token in string content; processor takes (image, text)
            const messages = buildFastVLMMessages(chatHistory ?? [], prompt);
            const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
            inputs = await processor(image, text, { add_special_tokens: false });
        } else {
            // SmolVLM / SmolVLM2: content-block objects; processor takes (text, [images])
            const messages = buildMessages(chatHistory ?? [], prompt);
            const text = processor.apply_chat_template(messages, {
                tokenize: false, add_generation_prompt: true,
            });
            inputs = await processor(text, [image], { return_tensors: 'pt' });
        }

        let fullText   = '';
        let tokenCount = 0;
        let startMs    = null;   // set on first token so we exclude prompt-processing lag

        const streamer = new TextStreamer(processor.tokenizer, {
            skip_prompt:         true,
            skip_special_tokens: true,
            callback_function: (chunk) => {
                if (startMs === null) startMs = performance.now();
                tokenCount++;

                const elapsed = (performance.now() - startMs) / 1000;
                const tps     = elapsed > 0.2
                    ? parseFloat((tokenCount / elapsed).toFixed(1))
                    : null;

                fullText += chunk;
                post({ type: 'token', id, token: chunk, tps, tokenCount });
            },
        });

        await model.generate({ ...inputs, max_new_tokens: 768, do_sample: false, streamer });

        const elapsed = startMs ? (performance.now() - startMs) / 1000 : 0;
        const avgTps  = elapsed > 0 ? parseFloat((tokenCount / elapsed).toFixed(1)) : null;

        post({ type: 'done', id, text: fullText.trim(), tokenCount, avgTps });

    } catch (err) {
        post({ type: 'error', id, message: err.message });
    } finally {
        isProcessing = false;
        drainQueue();
    }
}

function drainQueue() {
    if (!isProcessing && queue.length > 0) runInference(queue.shift());
}

// ─── Message Router ──────────────────────────────────────────────────────────

self.onmessage = (e) => {
    switch (e.data.type) {
        case 'load':     initModel(e.data.modelId); break;
        case 'generate': queue.push(e.data); drainQueue(); break;
    }
};
