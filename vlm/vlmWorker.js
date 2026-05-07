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

// ──────────────────────────────────────────────────────────────────────
// Modern-processor-config bridge.
//
// Several recent VLMs (LFM2.5-VL-1.6B, Gemma 3n/4 multimodal, etc.) ship
// only the new combined `processor_config.json` with `image_processor`
// nested inside, instead of the legacy split `preprocessor_config.json`.
// Transformers.js v3's AutoProcessor still requests `preprocessor_config.json`
// at the model root and fails with either:
//   - "Could not locate file: …/preprocessor_config.json" (404), or
//   - "No image_processor_type or feature_extractor_type found in the config"
//     (200 with a stripped-down body).
//
// We monkey-patch fetch BEFORE importing Transformers.js so its network
// layer transparently sees a synthesized preprocessor_config.json built
// from the model's processor_config.json's image_processor field.
// ──────────────────────────────────────────────────────────────────────
const _origFetch = self.fetch.bind(self);
self.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!/\/preprocessor_config\.json(\?|$)/.test(url)) {
        return _origFetch(input, init);
    }
    // Try the real preprocessor_config.json first
    let orig;
    try { orig = await _origFetch(input, init); }
    catch (e) { return Promise.reject(e); }

    // If it succeeded AND already has the field Transformers.js expects, pass through
    if (orig.ok) {
        try {
            const text = await orig.clone().text();
            const data = JSON.parse(text);
            if (data.image_processor_type || data.feature_extractor_type) {
                return new Response(text, {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            // Body was 200 but lacks the legacy type field — fall through and merge
        } catch (_) { return orig; }
    } else if (orig.status !== 404) {
        return orig;   // some other error — don't synthesize
    }

    // Fetch processor_config.json and derive a legacy-shaped body
    const altUrl   = url.replace(/\/preprocessor_config\.json/, '/processor_config.json');
    const altInput = typeof input === 'string' ? altUrl : new Request(altUrl, input);
    let altResp;
    try { altResp = await _origFetch(altInput, init); }
    catch (_) { return orig; }
    if (!altResp.ok) return orig;

    try {
        const altData = await altResp.json();
        const imgProc = altData.image_processor ?? altData;
        if (!imgProc.image_processor_type && !imgProc.feature_extractor_type) {
            // Best-effort fallback: derive the type from processor_class (e.g.
            // "Lfm2VlProcessor" → "Lfm2VlImageProcessor").
            const cls = altData.processor_class || imgProc.processor_class;
            if (cls) imgProc.image_processor_type = cls.replace(/Processor$/, 'ImageProcessor');
        }
        return new Response(JSON.stringify(imgProc), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (_) { return orig; }
};

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
/** True when the loaded model is Liquid LFM2-VL — needs ImageTextToText class but standard content-block messages. */
function isLFM2VL()  { return /LFM2.*VL/i.test(_modelId); }
/** True when the loaded model is Google Gemma 3n / Gemma 4 multimodal. */
function isGemmaVL() { return /gemma[-_]?[34]n?[-_]?E[24]B/i.test(_modelId); }
/**
 * True when this LFM2-VL variant must be driven via the custom ORT pipeline
 * (port of Liquid AI's reference WebGPU Space). Both 1.6B and 450M ship with
 * Lfm2VlImageProcessorFast which Transformers.js v3 doesn't support, so both
 * need the custom code path. The 1.6B uses one set of submodel names; the
 * 450M uses the standard ones — Lfm2VlModel handles both internally.
 */
function isLFM2_1_6B(id = _modelId) {
    return id === 'LiquidAI/LFM2.5-VL-1.6B-ONNX'
        || id === 'LiquidAI/LFM2.5-VL-450M-ONNX';
}
/** Models requiring AutoModelForImageTextToText (FastVLM, LFM2-VL, Gemma 3n/4). */
function usesImageTextToText() { return isFastVLM() || isLFM2VL() || isGemmaVL(); }

// Custom model instance for LFM2.5-VL-1.6B (bypasses Transformers.js — uses
// onnxruntime-web directly via the Liquid AI reference implementation).
let customModel = null;

// Abort flag for the in-flight inference. Set when the main thread posts an
// 'abort' message; checked in token streamers / generation loops so the user
// can stop a runaway response.
let _abortedId = null;
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
 * Custom loader for LFM2.5-VL (450M and 1.6B) — drives ONNX Runtime Web
 * directly via the Liquid AI reference port (vlm/lfm2vlModel.js +
 * vlm/lfm2vlProcessor.js). Bridges progress into the existing
 * 'proc' / 'download' / 'compile' protocol.
 */
async function _loadLFM2VL_1_6B() {
    // Dynamic import — costs nothing for users on other models
    const { Lfm2VlModel } = await import('./lfm2vlModel.js');

    if (customModel) {
        try { await customModel.dispose(); } catch (_) {}
        customModel = null;
    }
    customModel = new Lfm2VlModel(_modelId);

    // Track per-file bytes to feed cumulative progress, mirroring the main path
    const fileTotal      = new Map();   // file → total bytes
    const fileProgress   = new Map();   // file → bytes loaded
    let   doneBytes      = 0;
    let   largeDoneBytes = 0;
    let   compileSignaled = false;
    const LARGE_FILE_BYTES = 10e6;

    const computeOverallPct = () => {
        const largeTotal = [...fileTotal.values()].filter(t => t > LARGE_FILE_BYTES).reduce((s, t) => s + t, 0);
        const largeInFlight = [...fileProgress.entries()]
            .filter(([f]) => (fileTotal.get(f) ?? 0) > LARGE_FILE_BYTES)
            .reduce((s, [, b]) => s + b, 0);
        const largeDownloaded = largeDoneBytes + largeInFlight;
        return largeTotal > LARGE_FILE_BYTES
            ? Math.min(88, 10 + Math.round((largeDownloaded / largeTotal) * 78))
            : 12;
    };

    const progressBus = {
        proc: ({ message, pct }) => {
            post({ type: 'progress', stage: 'proc', message, pct: pct ?? 0 });
        },
        proc_done: ({ pct }) => {
            post({ type: 'progress', stage: 'proc_done', pct: pct ?? 8 });
        },
        download: ({ file, fileMB, received, total }) => {
            if (total) fileTotal.set(file, total);
            if (received != null) fileProgress.set(file, received);
            // When this fetch completes, fold its bytes into doneBytes
            if (received != null && total != null && received >= total) {
                doneBytes += total;
                if (total > LARGE_FILE_BYTES) largeDoneBytes += total;
                fileProgress.delete(file);
            }
            const pct = computeOverallPct();
            post({
                type: 'progress',
                stage: 'download',
                message: `${file} — ${fileMB} MB`,
                file, fileMB,
                downloadedMB: ((doneBytes + [...fileProgress.values()].reduce((s, b) => s + b, 0)) / 1e6).toFixed(1),
                pct,
            });
        },
        compile: ({ message, pct }) => {
            if (compileSignaled) return;
            compileSignaled = true;
            post({
                type: 'progress',
                stage: 'compile',
                message: message ?? 'Initialising ONNX runtime…',
                downloadedMB: (doneBytes / 1e6).toFixed(1),
                loadedMB: (doneBytes / 1e6).toFixed(1),
                heapMB: heapMB(),
                pct: pct ?? 92,
            });
        },
    };

    await customModel.load(progressBus);

    // Free reference to any prior Transformers.js model/processor — we don't use them
    if (model) { try { model = null; } catch (_) {} }
    if (processor) { try { processor = null; } catch (_) {} }
}

/**
 * Inner loader: loads processor + model for a given device.
 * Separated so initModel() can call it twice (WebGPU then WASM) on failure.
 */
async function _loadForDevice(modelId, device) {
    // LFM2.5-VL-1.6B uses architecture/processor classes Transformers.js v3 doesn't
    // support yet. Drive it via the custom ORT pipeline (port of Liquid AI's
    // reference WebGPU Space) instead of AutoProcessor / AutoModel.
    if (isLFM2_1_6B(modelId)) {
        return _loadLFM2VL_1_6B();
    }

    // Gemma 3n/4 is huge; its q4f16 build is ~3 GB and includes an audio encoder.
    // Everything else uses the standard SmolVLM/FastVLM submodel names.
    const isGemmaModel = /gemma[-_]?[34]n?[-_]?E[24]B/i.test(modelId);
    let dtype;
    if (isGemmaModel) {
        dtype = device === 'webgpu'
            ? { embed_tokens: 'q4f16', vision_encoder: 'q4f16', decoder_model_merged: 'q4f16', audio_encoder: 'q4f16' }
            : 'q4';
    } else {
        dtype = device === 'webgpu'
            ? { embed_tokens: 'fp16', vision_encoder: 'q4', decoder_model_merged: 'q4' }
            : 'q4';
    }

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
    const fileProgress     = new Map();  // file → bytes loaded (in-flight)
    const fileTotal        = new Map();  // file → total bytes (from p.total)
    let   doneBytes        = 0;
    let   largeDoneBytes   = 0;  // bytes from completed large files only
    let   compileSignaled  = false;
    // Model weight files are hundreds of MB; config/tokenizer are <5 MB.
    // Only large files drive the denominator so small files don't rush the bar to 88%.
    const LARGE_FILE_BYTES = 10e6;

    // FastVLM, LFM2-VL, and Gemma 3n/4 use AutoModelForImageTextToText; SmolVLM family uses AutoModelForVision2Seq.
    const useImageTextToText =
        /FastVLM/i.test(modelId) ||
        /LFM2.*VL/i.test(modelId) ||
        /gemma[-_]?[34]n?[-_]?E[24]B/i.test(modelId);
    const ModelClass = useImageTextToText ? AutoModelForImageTextToText : AutoModelForVision2Seq;

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
                if (p.total > 0) fileTotal.set(file, p.total);

                const thisTotal    = fileTotal.get(file) ?? 0;
                const isLargeFile  = thisTotal > LARGE_FILE_BYTES;

                // Denominator: only large files (model weights), so small config/tokenizer
                // files don't prematurely drive the bar to 88%.
                const largeTotal    = [...fileTotal.values()].filter(t => t > LARGE_FILE_BYTES).reduce((s, t) => s + t, 0);
                const largeInFlight = [...fileProgress.entries()]
                    .filter(([f]) => (fileTotal.get(f) ?? 0) > LARGE_FILE_BYTES)
                    .reduce((s, [, b]) => s + b, 0);
                const largeDownloaded = largeDoneBytes + largeInFlight;

                const totalMB  = ((doneBytes + largeInFlight) / 1e6).toFixed(1);
                const fileMB   = p.loaded ? (p.loaded / 1e6).toFixed(1) : null;

                // If a large file is known: true cumulative 10–88%.
                // Until then: small-file phase stays ≤15% so there's room to climb.
                const pct = largeTotal > LARGE_FILE_BYTES
                    ? Math.min(88, 10 + Math.round((largeDownloaded / largeTotal) * 78))
                    : Math.min(15, 10 + Math.round((p.progress ?? 0) * 0.05));

                post({
                    type:         'progress',
                    stage:        'download',
                    message:      fileMB ? `${file} — ${fileMB} MB` : `Downloading ${file}…`,
                    file,
                    fileMB,
                    downloadedMB: totalMB,
                    pct,
                });

            } else if (p.status === 'done') {
                const bytes = fileProgress.get(file) ?? 0;
                doneBytes += bytes;
                if ((fileTotal.get(file) ?? 0) > LARGE_FILE_BYTES) largeDoneBytes += bytes;
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
                        pct:          92,
                    });
                }
            }
        },
    });
}

async function initModel(modelId = DEFAULT_MODEL_ID) {
    _modelId = modelId;

    // Tear down any previous custom model when switching to a non-LFM2-1.6B model
    if (customModel && !isLFM2_1_6B(modelId)) {
        try { await customModel.dispose(); } catch (_) {}
        customModel = null;
    }

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
        // Custom LFM2-VL model handles its own JIT warmup on first inference;
        // no Transformers.js processor to feed dummy inputs through.
        if (customModel) return;
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
    _abortedId = null;     // reset for each new request

    try {
        post({ type: 'generating', id });

        // If background warmup is still running, wait for it before using the
        // model — avoids concurrent model.generate calls on the same instance.
        if (_warmupPromise) await _warmupPromise;

        // ── Custom LFM2-VL-1.6B path ──
        if (customModel) {
            const messages = (chatHistory ?? []).map(t => ({ role: t.role, content: t.content }));
            messages.push({ role: 'user', content: prompt });

            let fullText = '';
            let tokenCount = 0;
            let startMs = null;

            await customModel.generate(messages, {
                imageSrc,
                maxNewTokens: 768,
                onToken: (chunk) => {
                    if (startMs === null) startMs = performance.now();
                    tokenCount++;
                    const elapsed = (performance.now() - startMs) / 1000;
                    const tps = elapsed > 0.2 ? parseFloat((tokenCount / elapsed).toFixed(1)) : null;
                    fullText += chunk;
                    post({ type: 'token', id, token: chunk, tps, tokenCount });
                    // Returning truthy stops the generation loop in lfm2vlModel.generate()
                    return _abortedId === id;
                },
            });

            const elapsed = startMs ? (performance.now() - startMs) / 1000 : 0;
            const avgTps = elapsed > 0 ? parseFloat((tokenCount / elapsed).toFixed(1)) : null;
            post({ type: 'done', id, text: fullText.trim(), tokenCount, avgTps });
            return;
        }

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

        // Chat-end markers that some tokenizers don't classify as "special",
        // so skip_special_tokens leaves them in the decoded output. Strip them
        // here as a final safety net (LFM2.5-VL-450M is the main offender).
        const CHAT_END_RE = /<\|im_end\|>|<\|endoftext\|>|<\|end\|>/;

        const streamer = new TextStreamer(processor.tokenizer, {
            skip_prompt:         true,
            skip_special_tokens: true,
            callback_function: (chunk) => {
                if (startMs === null) startMs = performance.now();

                // If a chat-end marker shows up, keep any prefix text and stop
                let stop = false;
                let visible = chunk;
                const m = chunk.match(CHAT_END_RE);
                if (m) {
                    visible = chunk.slice(0, m.index);
                    stop = true;
                }

                if (visible) {
                    tokenCount++;
                    const elapsed = (performance.now() - startMs) / 1000;
                    const tps     = elapsed > 0.2
                        ? parseFloat((tokenCount / elapsed).toFixed(1))
                        : null;
                    fullText += visible;
                    post({ type: 'token', id, token: visible, tps, tokenCount });
                }

                // User-requested stop OR chat-end marker: break out of model.generate()
                if (stop || _abortedId === id) throw new Error('__VLM_ABORTED__');
            },
        });

        try {
            await model.generate({ ...inputs, max_new_tokens: 768, do_sample: false, streamer });
        } catch (err) {
            if (err.message !== '__VLM_ABORTED__') throw err;
            // Fall through — graceful stop, treat as completed (partial)
        }

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
        case 'abort':    _abortedId = e.data.id ?? null; break;
    }
};
