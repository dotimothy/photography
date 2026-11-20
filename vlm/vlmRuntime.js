/**
 * vlmRuntime.js — the inference logic of the local worker, without the CDN import.
 *
 * vlmWorker.js imports Transformers.js from a URL, which Node cannot load, so
 * everything worth unit-testing lives here and receives the library, processor
 * and model as arguments. Nothing in this file touches the network.
 */

export const DEFAULT_MAX_NEW_TOKENS = 512;
/** Streamed text is posted at most once per this many milliseconds (about two frames at 60 Hz). */
export const TOKEN_FLUSH_MS = 32;

/** Chat-end markers some tokenizers do not flag as special, so they survive skip_special_tokens. */
const CHAT_END_RE = /<\|im_end\|>|<\|endoftext\|>|<\|end\|>|<end_of_utterance>/;

// ─── Network guard ───────────────────────────────────────────────────────────

/**
 * Wrap fetch so code running in the worker can reach only an allowlist of URL
 * prefixes. Everything else gets a synthetic 404 without touching the network.
 *
 * Transformers.js looks a file up in Cache Storage first and calls fetch only
 * on a miss, so with this guard in place a miss can never become a download:
 * the library sees "not found" and reports the model as unavailable.
 */
export function createFetchGuard(originalFetch, { allow = [], onBlocked } = {}) {
    return function guardedFetch(input, init) {
        const url = typeof input === 'string' ? input : (input?.url ?? String(input));
        if (/^(data|blob):/i.test(url) || allow.some(prefix => url.startsWith(prefix))) return originalFetch(input, init);
        onBlocked?.(url);
        return Promise.resolve(new Response('', { status: 404, statusText: 'Blocked: models load from browser storage only' }));
    };
}

// ─── Streaming ───────────────────────────────────────────────────────────────

/**
 * Coalesces streamed text so a fast model does not post one message per token.
 * Slow models are unaffected: a chunk arriving after the interval goes out at once.
 */
export class TokenBatcher {
    constructor(emit, { intervalMs = TOKEN_FLUSH_MS, now = () => performance.now() } = {}) {
        this._emit = emit; this._interval = intervalMs; this._now = now;
        this._text = ''; this._last = -Infinity; this._meta = null;
        this.messages = 0;
    }
    push(text, meta = null) {
        this._text += text; this._meta = meta;
        if (this._now() - this._last >= this._interval) this.flush();
    }
    flush() {
        if (!this._text) return;
        const text = this._text;
        this._text = ''; this._last = this._now(); this.messages++;
        this._emit(text, this._meta);
    }
}

/**
 * True when the tail of a token sequence is the same run of tokens three times
 * in a row. Greedy decoding on small models can fall into such a loop and would
 * otherwise burn the whole token budget repeating itself.
 */
export function isRepeating(ids, { minLen = 6, maxLen = 48, repeats = 3 } = {}) {
    const total = ids.length;
    for (let size = minLen; size <= maxLen && size * repeats <= total; size++) {
        let same = true;
        for (let offset = 0; same && offset < size; offset++) {
            const token = ids[total - 1 - offset];
            for (let copy = 1; copy < repeats; copy++) {
                if (ids[total - 1 - offset - copy * size] !== token) { same = false; break; }
            }
        }
        if (same) return true;
    }
    return false;
}

// ─── Prompt construction ─────────────────────────────────────────────────────

/**
 * Build chat messages in the shape each model family's template expects.
 * The image belongs to the first user turn only.
 *  smolvlm  content blocks: [{ type: 'image' }, { type: 'text', text }]
 *  fastvlm  plain strings with an inline <image> token
 */
export function buildMessages(family, history, prompt) {
    const turns = [...(history ?? []), { role: 'user', content: prompt }];
    let imageInserted = false;
    return turns.map((turn) => {
        const withImage = turn.role === 'user' && !imageInserted;
        if (withImage) imageInserted = true;
        if (family === 'fastvlm') return { role: turn.role, content: withImage ? `<image>${turn.content}` : turn.content };
        const blocks = [{ type: 'text', text: turn.content }];
        if (withImage) blocks.unshift({ type: 'image' });
        return { role: turn.role, content: blocks };
    });
}

function pairs(history) {
    const turns = [];
    for (let i = 0; i + 1 < (history?.length ?? 0); i += 2) {
        turns.push({ sent: String(history[i].content ?? ''), answer: String(history[i + 1].content ?? '') });
    }
    return turns;
}

/**
 * If a request continues the conversation the worker just answered (same image,
 * same turns), return those turns exactly as the model saw them.
 *
 * Callers send a decorated prompt (instructions and metadata in front of the
 * question) but record only the bare question in their history, so a history
 * replayed verbatim never matches what is in the key/value cache. Matching by
 * suffix lets the cached conversation be recognised and continued.
 */
export function continuationTurns(session, imageKey, chatHistory) {
    if (!session || imageKey == null || session.imageKey !== imageKey) return null;
    const history = chatHistory ?? [];
    if (!history.length || history.length !== session.turns.length * 2) return null;
    const turns = [];
    for (let i = 0; i < session.turns.length; i++) {
        const user = history[i * 2], assistant = history[i * 2 + 1], turn = session.turns[i];
        if (user?.role !== 'user' || assistant?.role !== 'assistant') return null;
        if (!turn.sent.endsWith(String(user.content ?? '').trim())) return null;
        if (turn.answer.trim() !== String(assistant.content ?? '').trim()) return null;
        turns.push({ role: 'user', content: turn.sent }, { role: 'assistant', content: turn.answer });
    }
    return turns;
}

export function isPrefix(prefix, ids) {
    if (!prefix || prefix.length > ids.length) return false;
    for (let i = 0; i < prefix.length; i++) if (prefix[i] !== ids[i]) return false;
    return true;
}

function toIds(tensorOrArray) {
    const data = tensorOrArray?.data ?? tensorOrArray ?? [];
    return Array.from(data, Number);
}

function disposeCache(pastKeyValues) {
    for (const tensor of Object.values(pastKeyValues ?? {})) {
        // Only GPU-resident tensors hold memory that garbage collection cannot reclaim.
        if (tensor?.location === 'gpu-buffer') { try { tensor.dispose(); } catch (_) { /* already released */ } }
    }
}

/** Turn a library error into something a visitor can act on. */
export function describeLoadError(message) {
    const text = String(message ?? 'Unknown error');
    if (/not found locally|Blocked: models load|Could not locate file/i.test(text)) {
        return 'Model files are missing from browser storage. Open AI settings and press Download again.';
    }
    return text;
}

// ─── Inference engine ────────────────────────────────────────────────────────

/**
 * Drives one loaded model. Holds the per-conversation state that makes
 * follow-up questions cheap:
 *
 *  key/value cache  After each answer the decoder's past_key_values are kept.
 *                   When the next request extends that same token sequence,
 *                   only the new tokens are run and the vision encoder is not
 *                   run at all.
 *  image features   The vision encoder's output is remembered per image, so a
 *                   fresh question about the same photo skips the encoder even
 *                   when the key/value cache cannot be reused.
 *
 * @param {object} deps
 * @param {object} deps.lib        Transformers.js exports: TextStreamer, StoppingCriteria.
 * @param {object} deps.processor  Loaded processor (callable, with apply_chat_template and tokenizer).
 * @param {object} deps.model      Loaded model (generate, encode_image).
 * @param {'smolvlm'|'fastvlm'} deps.family
 * @param {boolean} [deps.imageSplitting=false]  SmolVLM only: tile the image into extra 512px crops.
 * @param {() => number} [deps.now]
 */
export function createInferenceEngine({ lib, processor, model, family, imageSplitting = false, now = () => performance.now() }) {
    const state = { session: null, image: { key: null, features: null }, activeKey: null, imageHit: false, visionRuns: 0 };

    // Memoise the vision encoder by image. generate() calls model.encode_image
    // on the first forward pass whenever pixel values are supplied.
    if (typeof model.encode_image === 'function') {
        const encode = model.encode_image.bind(model);
        model.encode_image = async (args) => {
            const key = state.activeKey;
            if (key != null && state.image.key === key && state.image.features) {
                state.imageHit = true;
                return state.image.features;
            }
            const features = await encode(args);
            state.visionRuns++;
            if (key != null) state.image = { key, features };
            return features;
        };
    }

    async function prepareInputs(messages, image) {
        if (family === 'fastvlm') {
            const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
            return processor(image, text, { add_special_tokens: false });
        }
        const text = processor.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true });
        // Without splitting the image is one 512px tile (64 visual tokens) instead of up to 17 tiles.
        return processor(text, [image], imageSplitting ? {} : { do_image_splitting: false });
    }

    function dropSession() {
        if (state.session) disposeCache(state.session.pkv);
        state.session = null;
    }

    /**
     * @param {object} request  { image, imageKey, prompt, chatHistory, maxNewTokens, temperature }
     * @param {object} hooks    { onText(text, { tps, tokenCount }), shouldStop() }
     * @returns {Promise<{ text: string, tokenCount: number, avgTps: number|null, stats: object }>}
     */
    async function generate(request, hooks = {}) {
        const { image, imageKey = null, prompt, chatHistory = [], maxNewTokens = DEFAULT_MAX_NEW_TOKENS, temperature = 0 } = request;
        const started = now();

        const continued = continuationTurns(state.session, imageKey, chatHistory);
        const priorTurns = continued ? state.session.turns : pairs(chatHistory);
        const messages = buildMessages(family, continued ?? chatHistory, prompt);
        const inputs = await prepareInputs(messages, image);
        const ids = toIds(inputs.input_ids);
        const prepared = now();

        // The cache covers every stored token except the last one generated, so the
        // new sequence must repeat the stored one exactly and then add to it.
        let past = null, cache = 'none', reusedTokens = 0;
        if (continued && state.session.pkv && ids.length > state.session.ids.length && isPrefix(state.session.ids, ids)) {
            past = state.session.pkv;
            reusedTokens = state.session.ids.length - 1;
            cache = 'kv';
            state.session = null;            // ownership of the tensors passes to generate()
        } else {
            dropSession();
        }

        const generated = [];
        let text = '', stop = false, ended = false, firstTokenAt = null;
        const batcher = new TokenBatcher((chunk, meta) => hooks.onText?.(chunk, meta), { now });
        const liveTps = () => {
            const seconds = (now() - firstTokenAt) / 1000;
            return seconds > 0.2 ? parseFloat((generated.length / seconds).toFixed(1)) : null;
        };
        const streamer = new lib.TextStreamer(processor.tokenizer, {
            skip_prompt: true,
            skip_special_tokens: true,
            token_callback_function: (tokens) => {
                if (firstTokenAt === null) firstTokenAt = now();
                for (const token of tokens) generated.push(Number(token));
                if (isRepeating(generated)) stop = true;
            },
            callback_function: (chunk) => {
                if (ended) return;
                let visible = chunk;
                const marker = chunk.match(CHAT_END_RE);
                if (marker) { visible = chunk.slice(0, marker.index); stop = true; ended = true; }
                if (!visible) return;
                text += visible;
                batcher.push(visible, { tps: liveTps(), tokenCount: generated.length });
            },
        });
        // Stopping through a criterion (instead of throwing out of the streamer) lets
        // generate() finish normally and hand back the key/value cache.
        class Stop extends lib.StoppingCriteria {
            _call(inputIds) { const halt = stop || !!hooks.shouldStop?.(); return inputIds.map(() => halt); }
        }
        const options = {
            max_new_tokens: maxNewTokens, do_sample: temperature > 0, streamer,
            stopping_criteria: new Stop(), return_dict_in_generate: true,
        };

        if (temperature > 0) options.temperature = temperature;

        state.activeKey = imageKey;
        state.imageHit = false;
        const generationStarted = now();
        let output;
        try {
            output = past
                ? await model.generate({ input_ids: inputs.input_ids, attention_mask: inputs.attention_mask, past_key_values: past, ...options })
                : await model.generate({ ...inputs, ...options });
        } catch (error) {
            // A cached continuation that fails before producing anything is retried as a full pass.
            if (!past || generated.length) throw error;
            disposeCache(past);
            past = null; cache = 'none'; reusedTokens = 0;
            output = await model.generate({ ...inputs, ...options });
        } finally {
            state.activeKey = null;
        }
        batcher.flush();
        const finished = now();

        if (cache === 'none' && state.imageHit) cache = 'image';
        const answer = text.trim();
        const sequence = output?.sequences ? toIds(output.sequences) : null;
        const aborted = !!hooks.shouldStop?.();
        if (sequence && output.past_key_values && imageKey != null && !aborted) {
            state.session = { imageKey, turns: [...priorTurns, { sent: prompt, answer }], ids: sequence, pkv: output.past_key_values };
        } else {
            disposeCache(output?.past_key_values);
        }

        const seconds = firstTokenAt === null ? 0 : (finished - firstTokenAt) / 1000;
        const avgTps = seconds > 0 ? parseFloat((generated.length / seconds).toFixed(1)) : null;
        return {
            text: answer,
            tokenCount: generated.length,
            avgTps,
            stats: {
                cache,                                   // 'kv' | 'image' | 'none'
                promptTokens: ids.length,
                reusedTokens,
                processedTokens: ids.length - reusedTokens,
                prepareMs: Math.round(prepared - started),
                ttftMs: firstTokenAt === null ? null : Math.round(firstTokenAt - generationStarted),
                totalMs: Math.round(finished - started),
                tokenCount: generated.length,
                tokensPerSecond: avgTps,
                messages: batcher.messages,
            },
        };
    }

    /** One-token generation so shader compilation and graph setup happen before the first real question. */
    async function warmup(image) {
        const started = now();
        const inputs = await prepareInputs(buildMessages(family, [], '.'), image);
        state.activeKey = null;
        await model.generate({ ...inputs, max_new_tokens: 1, do_sample: false });
        return Math.round(now() - started);
    }

    function dispose() {
        dropSession();
        state.image = { key: null, features: null };
    }

    return { generate, warmup, dispose, get visionRuns() { return state.visionRuns; }, get hasSession() { return !!state.session; } };
}
