/**
 * modelCatalog.js — the local models TheDoInspector can run, and the rules that
 * decide which files a device needs.
 *
 * Pure data and pure functions: no DOM, no network, no Cache Storage. Both the
 * download store (modelStore.js) and the settings UI read from here, so sizes,
 * names and per-device file choices live in exactly one place.
 *
 * File sizes were read from each repository's Hugging Face file listing
 * (2026-11). They are estimates for the UI only; the real byte total always
 * comes from the live listing when a download starts.
 */

export const HF_HOST = 'https://huggingface.co';

/** Cache Storage bucket Transformers.js v3 reads from (utils/hub.js: caches.open('transformers-cache')). */
export const MODEL_CACHE_NAME = 'transformers-cache';

/** Exact Transformers.js release the worker imports. Keep in sync with vlmWorker.js. */
export const TRANSFORMERS_VERSION = '3.8.1';
export const TRANSFORMERS_DIST = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}/dist/`;

/**
 * ONNX Runtime's WebAssembly binary. Transformers.js would fetch it from the
 * CDN the first time a session is created; downloading it with the model keeps
 * every large fetch behind the Download button and lets the model start offline.
 */
export const RUNTIME_FILE = Object.freeze({
    url: `${TRANSFORMERS_DIST}ort-wasm-simd-threaded.jsep.wasm`,
    path: 'ort-wasm-simd-threaded.jsep.wasm',
    size: 21_596_019,
    runtime: true,
});

/** Transformers.js dtype → file suffix (utils/dtypes.js: DEFAULT_DTYPE_SUFFIX_MAPPING). */
export const DTYPE_SUFFIX = Object.freeze({
    fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', uint8: '_uint8',
    q4: '_q4', q4f16: '_q4f16', bnb4: '_bnb4',
});

/** The three ONNX sessions of an image-text-to-text model (models.js: MODEL_TYPES.ImageTextToText). */
export const MODULES = Object.freeze(['embed_tokens', 'vision_encoder', 'decoder_model_merged']);

/** Files Transformers.js treats as fatal when loading the processor, tokenizer and config. */
export const REQUIRED_CONFIG_FILES = Object.freeze([
    'config.json', 'generation_config.json', 'preprocessor_config.json',
    'processor_config.json', 'tokenizer.json', 'tokenizer_config.json',
]);
/** Small files fetched when the repository has them. */
export const OPTIONAL_CONFIG_FILES = Object.freeze(['chat_template.json', 'chat_template.jinja']);

/**
 * Preferred dtype per module for each class of device, best first. The first
 * entry is what a new download fetches; later entries let files cached by
 * earlier versions of the site (or a repository without that variant) load.
 *
 *  webgpu-f16  WebGPU with the shader-f16 feature. fp16 embeddings + 4-bit
 *              vision encoder and decoder: the combination the SmolVLM and
 *              FastVLM model cards publish for WebGPU.
 *  webgpu      WebGPU without shader-f16. Transformers.js refuses fp16 here
 *              ("The device does not support fp16"), so embeddings stay fp32-sized.
 *  wasm        CPU. The fp16 embedding table is a single Gather, which ONNX
 *              Runtime's CPU kernels handle, so it shares the WebGPU files: a
 *              WebGPU failure can fall back to CPU without a second download.
 */
export const DTYPE_PREFERENCES = Object.freeze({
    'webgpu-f16': { embed_tokens: ['fp16', 'q4', 'fp32'], vision_encoder: ['q4', 'fp32'], decoder_model_merged: ['q4', 'fp32'] },
    'webgpu':     { embed_tokens: ['q4', 'fp32'],         vision_encoder: ['q4', 'fp32'], decoder_model_merged: ['q4', 'fp32'] },
    'wasm':       { embed_tokens: ['fp16', 'q4', 'q8', 'fp32'], vision_encoder: ['q4', 'q8', 'fp32'], decoder_model_merged: ['q4', 'q8', 'fp32'] },
});

const MB = 1e6;

/**
 * @typedef {Object} LocalModel
 * @property {string}  id            Hugging Face repository.
 * @property {string}  name          Display name.
 * @property {'smolvlm'|'fastvlm'|'lfm2vl'} family  Selects the prompt/processor path in the worker.
 * @property {number}  bytes         Approximate model download for a WebGPU (shader-f16) or CPU device,
 *                                  not counting the shared 21.6 MB runtime.
 * @property {number}  [bytesNoF16]  Approximate download for WebGPU without shader-f16.
 * @property {number}  inputSize     Longest image edge the vision encoder consumes, in pixels.
 * @property {string}  backend       Short device note for the list.
 * @property {string}  note          One-line description of the trade-off.
 * @property {string[]} tags
 * @property {string}  [unavailable] Reason the model cannot run in this build.
 */

/** @type {LocalModel[]} */
const BUILT_IN = [
    {
        id: 'onnx-community/FastVLM-0.5B-ONNX', name: 'Apple FastVLM 0.5B', family: 'fastvlm',
        bytes: 1106 * MB, bytesNoF16: 1378 * MB, inputSize: 1024, backend: 'WebGPU recommended',
        note: 'Most capable, but a large download. Desktop with WebGPU recommended.', tags: ['large'],
    },
    {
        id: 'HuggingFaceTB/SmolVLM-256M-Instruct', name: 'SmolVLM 256M', family: 'smolvlm',
        bytes: 211 * MB, bytesNoF16: 268 * MB, inputSize: 512, backend: 'WebGPU or CPU',
        note: 'Smallest and fastest. Best choice for phones.', tags: ['small'],
    },
    {
        id: 'HuggingFaceTB/SmolVLM-500M-Instruct', name: 'SmolVLM 500M', family: 'smolvlm',
        bytes: 394 * MB, bytesNoF16: 489 * MB, inputSize: 512, backend: 'WebGPU or CPU',
        note: 'More detailed answers; needs a laptop-class device.', tags: [],
    },
    {
        id: 'HuggingFaceTB/SmolVLM2-256M-Instruct', name: 'SmolVLM2 256M', family: 'smolvlm',
        bytes: 211 * MB, bytesNoF16: 268 * MB, inputSize: 512, backend: 'WebGPU or CPU',
        note: 'Newer small model; similar speed to SmolVLM 256M.', tags: ['small'],
    },
    {
        id: 'HuggingFaceTB/SmolVLM2-500M-Instruct', name: 'SmolVLM2 500M', family: 'smolvlm',
        bytes: 394 * MB, bytesNoF16: 489 * MB, inputSize: 512, backend: 'WebGPU or CPU',
        note: 'Newer mid-size model; needs a laptop-class device.', tags: [],
    },
    // Both LFM2.5-VL variants need vlm/lfm2vlModel.js + vlm/lfm2vlProcessor.js (a port of
    // Liquid AI's ONNX Runtime pipeline). Those files are not in the repository, so the
    // models cannot run; they stay listed so a saved selection still resolves to a name.
    {
        id: 'LiquidAI/LFM2.5-VL-450M-ONNX', name: 'Liquid LFM2.5-VL 450M', family: 'lfm2vl',
        bytes: 675 * MB, inputSize: 512, backend: 'WebGPU', note: 'Custom runtime.', tags: [],
        unavailable: 'Not available in this build',
    },
    {
        id: 'LiquidAI/LFM2.5-VL-1.6B-ONNX', name: 'Liquid LFM2.5-VL 1.6B', family: 'lfm2vl',
        bytes: 1800 * MB, inputSize: 512, backend: 'WebGPU', note: 'Custom runtime.', tags: ['large'],
        unavailable: 'Not available in this build',
    },
];

const registry = new Map(BUILT_IN.map(model => [model.id, Object.freeze(model)]));

/** The model recommended for phones and other memory-constrained devices. */
export const SMALLEST_MODEL_ID = 'HuggingFaceTB/SmolVLM-256M-Instruct';

export function listModels() { return [...registry.values()]; }
export function getModel(modelId) { return registry.get(modelId) ?? null; }

/**
 * Add a model at runtime (used by tests and for trying a repository that is not
 * in the built-in list). The repository must use the standard Transformers.js
 * layout: onnx/{embed_tokens,vision_encoder,decoder_model_merged}*.onnx.
 */
export function registerModel(model) {
    if (!model?.id || !/^[\w.-]+\/[\w.-]+$/.test(model.id)) throw new Error('registerModel: invalid model id');
    const entry = Object.freeze({
        name: model.id.split('/').pop(), family: 'smolvlm', bytes: 0, inputSize: 512,
        backend: 'WebGPU or CPU', note: '', tags: [], ...model,
    });
    registry.set(entry.id, entry);
    return entry;
}

export function modelFileUrl(modelId, path) { return `${HF_HOST}/${modelId}/resolve/main/${path}`; }
export function modelUrlPrefix(modelId) { return `${HF_HOST}/${modelId}/`; }
export function onnxPath(module, dtype) { return `onnx/${module}${DTYPE_SUFFIX[dtype]}.onnx`; }

/** Expected download size for a device class, for labels shown before the listing is fetched. */
export function estimatedBytes(model, deviceClass) {
    if (!model) return 0;
    return deviceClass === 'webgpu' && model.bytesNoF16 ? model.bytesNoF16 : model.bytes;
}

/**
 * Decide which files a device loads, given the set of files that exist
 * (a repository listing when downloading, the cache contents when loading).
 *
 * @param {LocalModel} model
 * @param {Iterable<string>} availablePaths  Repository-relative paths, e.g. 'onnx/embed_tokens_fp16.onnx'.
 * @param {'webgpu-f16'|'webgpu'|'wasm'} deviceClass
 * @returns {{ complete: boolean, dtype: Record<string,string>, files: string[], missing: string[] }}
 */
export function resolvePlan(model, availablePaths, deviceClass) {
    const available = availablePaths instanceof Set ? availablePaths : new Set(availablePaths);
    const preferences = DTYPE_PREFERENCES[deviceClass] ?? DTYPE_PREFERENCES.wasm;
    const dtype = {}, files = [], missing = [];

    for (const file of REQUIRED_CONFIG_FILES) (available.has(file) ? files : missing).push(file);
    for (const file of OPTIONAL_CONFIG_FILES) if (available.has(file)) files.push(file);

    for (const module of MODULES) {
        const choice = preferences[module].find(candidate => available.has(onnxPath(module, candidate)));
        if (!choice) { missing.push(onnxPath(module, preferences[module][0])); continue; }
        dtype[module] = choice;
        const base = onnxPath(module, choice);
        files.push(base);
        // External-data shards sit next to the graph as <name>.onnx_data[_N].
        for (const path of available) if (path.startsWith(`${base}_data`)) files.push(path);
    }
    return { complete: missing.length === 0 && !!model && !model.unavailable, dtype, files, missing };
}

export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 2).replace(/\.?0+$/, '')} GB`;
    if (bytes >= 1e7) return `${Math.round(bytes / 1e6)} MB`;
    return `${(bytes / 1e6).toFixed(1)} MB`;
}

/** True for phones and tablets. `nav` is injectable for tests. */
export function isMobileDevice(nav = globalThis.navigator) {
    if (!nav) return false;
    if (typeof nav.userAgentData?.mobile === 'boolean' && nav.userAgentData.mobile) return true;
    const ua = nav.userAgent || '';
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
    return /Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1;   // iPadOS reports as a Mac
}

/**
 * Judge whether a model is likely to fit this device before the visitor
 * commits to the download.
 *
 * Running a model holds roughly its download size in memory (weights are copied
 * into the WebAssembly heap or GPU buffers) plus working memory, so the test is
 * against a fraction of the reported RAM, not the whole of it.
 *
 * @param {LocalModel} model
 * @param {{ bytes?: number, deviceMemory?: number, mobile?: boolean, deviceClass?: string, freeBytes?: number }} env
 * @returns {{ level: 'ok'|'warn', reasons: string[], recommend: string|null }}
 */
export function assessFit(model, env = {}) {
    const bytes = env.bytes || estimatedBytes(model, env.deviceClass);
    const reasons = [];
    const isSmallest = model.id === SMALLEST_MODEL_ID;

    if (Number.isFinite(env.freeBytes) && env.freeBytes < bytes * 1.05) {
        reasons.push(`Only ${formatBytes(env.freeBytes)} of browser storage is free; this model needs ${formatBytes(bytes)}.`);
    }
    if (env.mobile && bytes > 320 * MB) {
        reasons.push(`${formatBytes(bytes)} is likely too large for a phone or tablet: the page may reload when memory runs out.`);
    }
    // navigator.deviceMemory is rounded down and capped at 8, so 8 means "8 GB or more".
    if (Number.isFinite(env.deviceMemory) && env.deviceMemory < 8 && bytes * 2.5 > env.deviceMemory * 1e9 * 0.5) {
        reasons.push(`This device reports about ${env.deviceMemory} GB of memory; the model needs roughly ${formatBytes(bytes * 2.5)} while running.`);
    }
    if (env.deviceClass === 'wasm' && bytes > 320 * MB) {
        reasons.push('WebGPU is not available here, so this model would run on the CPU and answer slowly.');
    }
    const recommend = reasons.length && !isSmallest ? SMALLEST_MODEL_ID : null;
    return { level: reasons.length ? 'warn' : 'ok', reasons, recommend };
}
