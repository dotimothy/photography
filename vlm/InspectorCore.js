/**
 * InspectorCore.js — DOM-free logic for TheDoInspector.
 *
 * Everything here is plain data in, plain data out, so it runs under `node --test`
 * (see GalleryVLMOverlay.test.mjs) as well as in the browser:
 *
 *   titleCase / isTitleCase     button-label casing ("Where Was This Taken?")
 *   ModelGate                   local-model download state (window.VLM_MODELS contract)
 *   findStableBoundary          incremental markdown streaming (commit finished blocks once)
 *   formatCoordinates / place*  location text for the map card
 */

// ─── Button labels ───────────────────────────────────────────────────────────

/** Capitalise the first letter of every word. Existing capitals (EXIF, VLM, AI) are kept. */
export function titleCase(text) {
    return String(text ?? '').replace(
        /(^|[\s\-–—/(\[“"])(\p{Ll})/gu,
        (_, lead, letter) => lead + letter.toUpperCase(),
    );
}

/** True when no word in the label starts with a lowercase letter. */
export function isTitleCase(text) {
    return String(text ?? '')
        .split(/[\s\-–—/]+/)
        .every(word => !/^[(\[“"]*\p{Ll}/u.test(word));
}

// ─── Local model catalogue (names and sizes shown in the download notice) ────

export const DEFAULT_LOCAL_MODEL = 'onnx-community/FastVLM-0.5B-ONNX';

/** Fallback names and sizes (from vlm/modelCatalog.js) for pages that do not expose window.VLM_MODELS.catalog. */
export const LOCAL_MODEL_CATALOG = Object.freeze({
    'onnx-community/FastVLM-0.5B-ONNX':     { name: 'Apple FastVLM 0.5B',    size: '1.1 GB' },
    'HuggingFaceTB/SmolVLM-256M-Instruct':  { name: 'SmolVLM 256M',          size: '211 MB' },
    'HuggingFaceTB/SmolVLM-500M-Instruct':  { name: 'SmolVLM 500M',          size: '394 MB' },
    'HuggingFaceTB/SmolVLM2-256M-Instruct': { name: 'SmolVLM2 256M',         size: '211 MB' },
    'HuggingFaceTB/SmolVLM2-500M-Instruct': { name: 'SmolVLM2 500M',         size: '394 MB' },
    'LiquidAI/LFM2.5-VL-450M-ONNX':         { name: 'Liquid LFM2.5-VL 450M', size: '675 MB' },
    'LiquidAI/LFM2.5-VL-1.6B-ONNX':         { name: 'Liquid LFM2.5-VL 1.6B', size: '1.8 GB' },
});

/** 1536000 → "1.5 MB"; 1.8e9 → "1.8 GB". Returns '' for unusable input. */
export function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
    if (n >= 1e7) return `${Math.round(n / 1e6)} MB`;
    return `${(n / 1e6).toFixed(1)} MB`;
}

/**
 * Name and size for a model id. `lists` are optional page-provided model lists
 * (arrays of { id, name, size | sizeBytes | bytes }); the built-in catalogue is the fallback.
 */
export function describeModel(modelId, lists = []) {
    const id = String(modelId ?? '');
    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        const hit = list.find(model => model && model.id === id);
        if (!hit) continue;
        const bytes = hit.sizeBytes ?? hit.bytes;
        return {
            id,
            name: hit.name || LOCAL_MODEL_CATALOG[id]?.name || id.split('/').pop() || 'the selected model',
            size: (typeof hit.size === 'string' && hit.size) || formatBytes(bytes ?? hit.size) || LOCAL_MODEL_CATALOG[id]?.size || '',
        };
    }
    const known = LOCAL_MODEL_CATALOG[id];
    return { id, name: known?.name ?? (id.split('/').pop() || 'the selected model'), size: known?.size ?? '' };
}

/** { loaded, total } → { pct: 0–100 | null, text: "120 MB of 500 MB" }. */
export function describeProgress(progress) {
    const loaded = Number(progress?.loaded);
    const total = Number(progress?.total);
    const hasLoaded = Number.isFinite(loaded) && loaded >= 0;
    const hasTotal = Number.isFinite(total) && total > 0;
    const pct = hasLoaded && hasTotal ? Math.max(0, Math.min(100, Math.round((loaded / total) * 100))) : null;
    const parts = [];
    if (hasLoaded && loaded > 0) parts.push(formatBytes(loaded));
    if (hasTotal) parts.push(parts.length ? `of ${formatBytes(total)}` : formatBytes(total));
    return { pct, text: parts.join(' ') };
}

// ─── Model gate ──────────────────────────────────────────────────────────────

const GATE_STATES = new Set(['not-downloaded', 'downloading', 'downloaded', 'loading', 'ready', 'error']);

/**
 * Tracks whether the active local model can answer, following the shared contract:
 *
 *   window.VLM_MODELS.status(modelId) → Promise<'downloaded' | 'not-downloaded' | 'downloading'>
 *   window.VLM_MODELS.progress(modelId) → { loaded, total } | null
 *   window 'vlm-model-state' CustomEvent, detail { modelId, state, loaded?, total?, message? }
 *
 * The gate only applies to the local backend and only when VLM_MODELS exists.
 * Without it (older runtime) `applies` is false and the panel behaves as it always has.
 */
export class ModelGate {
    /**
     * @param {object} deps
     * @param {() => object|undefined} deps.getModels    returns window.VLM_MODELS
     * @param {() => object|undefined} deps.getSettings  returns window.VLM_SETTINGS
     * @param {() => object|undefined} deps.getManager   returns the VLMManager
     * @param {(gate: ModelGate) => void} [deps.onChange]
     */
    constructor({ getModels, getSettings, getManager, onChange } = {}) {
        this._getModels = getModels ?? (() => undefined);
        this._getSettings = getSettings ?? (() => undefined);
        this._getManager = getManager ?? (() => undefined);
        this._onChange = onChange ?? (() => {});
        this._state = 'unknown';
        this._trackedModel = null;
        this._progress = null;
        this._message = '';
        this._statusFailed = false;
        this._seq = 0;
    }

    get backend() {
        // The manager is the source of truth once it has been put in API mode;
        // before that, the saved settings say what the visitor chose.
        if (this._getManager()?._mode === 'api') return 'api';
        const type = this._getSettings()?.type;
        return type === 'api' || type === 'ollama' ? type : 'local';
    }

    /** The local model the visitor has selected. */
    get modelId() {
        return this._getSettings()?.model || this._getManager()?._modelId || DEFAULT_LOCAL_MODEL;
    }

    /** True when the download contract is in force for the current backend. */
    get applies() {
        const models = this._getModels();
        return this.backend === 'local' && !!models && typeof models.status === 'function' && !this._statusFailed;
    }

    /** 'unknown' until the first status() answer, then one of the contract states. */
    get state() { return this._state; }
    get progress() { return this._progress; }
    get message() { return this._message; }

    /** Send and suggestions are enabled only when this is true (plus a photo and non-empty input). */
    get canChat() {
        const ready = !!this._getManager()?.isReady;
        return this.applies ? ready && this._state === 'ready' : ready;
    }

    /**
     * Which notice the panel shows:
     *   'none'           chat as usual (ready, or the gate does not apply)
     *   'checking'       waiting for the first status() answer
     *   'not-downloaded' explain the one-time download, offer "Open AI Settings"
     *   'downloading'    progress from the event
     *   'loading'        downloaded; the runtime is starting the model
     *   'error'          message from the event
     */
    get view() {
        if (!this.applies) return 'none';
        switch (this._state) {
            case 'ready': return 'none';
            case 'unknown': return 'checking';
            case 'downloaded': return 'loading';
            default: return this._state;
        }
    }

    /** Feed a 'vlm-model-state' event detail. Returns true when it changed anything. */
    handleEvent(detail) {
        if (!detail || !GATE_STATES.has(detail.state)) return false;
        if (detail.modelId != null && detail.modelId !== this.modelId) return false;
        this._seq++;                       // a live event outranks any status() call still in flight
        this._trackedModel = this.modelId;
        this._state = detail.state;
        this._message = detail.state === 'error' ? String(detail.message ?? '') : '';
        if (detail.state === 'downloading') {
            const fromEvent = Number.isFinite(Number(detail.loaded)) || Number.isFinite(Number(detail.total));
            this._progress = fromEvent
                ? { loaded: Number(detail.loaded) || 0, total: Number(detail.total) || 0 }
                : this._readProgress();
        } else {
            this._progress = null;
        }
        this._onChange(this);
        return true;
    }

    /** The manager reported a ready local model (keeps the gate correct if events arrive out of order). */
    markReady() {
        if (this.backend !== 'local' || this._state === 'ready') return;
        this._seq++;
        this._trackedModel = this.modelId;
        this._state = 'ready';
        this._progress = null;
        this._message = '';
        this._onChange(this);
    }

    /**
     * Ask VLM_MODELS for the current status. Call when the panel opens and whenever the
     * backend or the selected model changes. Never downloads anything.
     */
    async refresh() {
        const seq = ++this._seq;
        const modelId = this.modelId;
        if (this._trackedModel !== modelId) {
            // A different model was selected: nothing known about it yet.
            this._trackedModel = modelId;
            this._state = 'unknown';
            this._progress = null;
            this._message = '';
            this._statusFailed = false;
            this._onChange(this);
        }
        if (!this.applies) return this.view;
        let status;
        try {
            status = await this._getModels().status(modelId);
        } catch (_) {
            if (seq !== this._seq) return this.view;
            this._statusFailed = true;     // unusable API: fall back to the pre-contract behaviour
            this._onChange(this);
            return this.view;
        }
        if (seq !== this._seq) return this.view;   // superseded by an event or a newer refresh
        if (status === 'not-downloaded') {
            this._state = 'not-downloaded';
            this._progress = null;
        } else if (status === 'downloading') {
            this._state = 'downloading';
            this._progress = this._readProgress();
        } else if (status === 'downloaded') {
            const manager = this._getManager();
            if (manager?.isReady) this._state = 'ready';
            else if (manager?.isLoading) this._state = 'loading';
            else if (this._state !== 'loading' && this._state !== 'error') this._state = 'downloaded';
        }
        this._onChange(this);
        return this.view;
    }

    _readProgress() {
        try {
            const progress = this._getModels()?.progress?.(this.modelId);
            return progress ? { loaded: Number(progress.loaded) || 0, total: Number(progress.total) || 0 } : null;
        } catch (_) {
            return null;
        }
    }
}

// ─── Incremental markdown streaming ──────────────────────────────────────────

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
// A line that may continue the block before it even after a blank line
// (list item, indented continuation, block quote, table row).
const CONTINUATION_RE = /^(?:[ \t]|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|>|\|)/;

/**
 * Find how much of a growing markdown string is finished and can be rendered once.
 *
 * Returns an index `b` with `from <= b <= text.length` such that `text.slice(from, b)`
 * is a run of complete top-level blocks: it ends at a blank line outside any code
 * fence or `$$` math block, and the text after it starts a new block that cannot
 * merge backwards (so loose lists and quotes stay together). Returns `from` when
 * nothing new is finished yet.
 *
 * `from` must itself be a boundary returned earlier (or 0).
 */
export function findStableBoundary(text, from = 0) {
    const source = String(text ?? '');
    let boundary = from;
    let lineStart = from;
    let fence = null;          // the opening fence marker while inside a code block
    let mathOpen = false;      // inside a $$ … $$ block
    let pending = -1;          // start of the first line after a blank-line run
    let sawContent = false;

    while (lineStart < source.length) {
        const newline = source.indexOf('\n', lineStart);
        const complete = newline !== -1;
        const line = source.slice(lineStart, complete ? newline : source.length);
        const blank = line.trim() === '';

        if (fence) {
            const close = line.match(FENCE_RE);
            if (close && close[1][0] === fence[0] && close[1].length >= fence.length && line.trim() === close[1]) fence = null;
        } else if (blank) {
            if (!mathOpen && sawContent && complete) pending = newline + 1;
        } else {
            if (pending !== -1 && !mathOpen) {
                // The block type of an unfinished first line is not knowable yet
                // ("-" may become a list item, "1" may become "1."), so wait for more text.
                const decidable = complete || line.length >= 4;
                if (decidable && !CONTINUATION_RE.test(line)) boundary = pending;
            }
            pending = -1;
            sawContent = true;
            const open = line.match(FENCE_RE);
            if (open) {
                fence = open[1];
            } else {
                const dollars = line.split('$$').length - 1;
                if (dollars % 2 === 1) mathOpen = !mathOpen;
            }
        }
        if (!complete) break;
        lineStart = newline + 1;
    }
    return boundary;
}

/** True when the text may contain LaTeX worth loading KaTeX for. */
export function mayContainMath(text) {
    return /\$[^$\n]+\$|\$\$/.test(String(text ?? ''));
}

// ─── Location text ───────────────────────────────────────────────────────────

/** 37.71557, -119.67689 → "37.71557° N, 119.67689° W". */
export function formatCoordinates(lat, lon, digits = 5) {
    const la = Number(lat), lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return '';
    return `${Math.abs(la).toFixed(digits)}° ${la < 0 ? 'S' : 'N'}, ${Math.abs(lo).toFixed(digits)}° ${lo < 0 ? 'W' : 'E'}`;
}

/** Cache key for a place lookup: about 100 m precision, so nearby frames share one lookup. */
export function placeKey(lat, lon) {
    return `${Number(lat).toFixed(3)},${Number(lon).toFixed(3)}`;
}

/**
 * Build a short place label from an OpenStreetMap (Nominatim) address object.
 * Stays at town level on purpose: no street, house number or postcode.
 */
export function placeLabelFromAddress(address) {
    if (!address || typeof address !== 'object') return '';
    const locality = address.city ?? address.town ?? address.village ?? address.hamlet ?? address.municipality ?? '';
    const parts = [locality, address.county, address.state ?? address.region, address.country_code === 'us' ? '' : address.country]
        .map(part => String(part ?? '').trim())
        .filter(Boolean);
    return [...new Set(parts)].slice(0, 3).join(', ');
}

/** External map links for a coordinate. Only the coordinate is put in the URL. */
export function locationLinks(lat, lon) {
    const la = Number(lat).toFixed(6), lo = Number(lon).toFixed(6);
    return {
        openStreetMap: `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=13/${la}/${lo}`,
        googleMaps: `https://maps.google.com/?q=${la},${lo}`,
        lightPollution: `https://timothydo.me/astronomy/lightpollution?lat=${la}&lon=${lo}`,
    };
}

/** Thumbnail URL for a portfolio photo (…/fulls/x.jpg → …/thumbs/480/x.jpg); null for anything else. */
export function thumbnailFor(src) {
    const value = String(src ?? '');
    if (!value || value.startsWith('data:')) return null;
    if (/\/thumbs\//.test(value)) return value;
    return /\/fulls\/[^/]+$/.test(value) ? value.replace(/\/fulls\/([^/]+)$/, '/thumbs/480/$1') : null;
}

/** Gallery name from a portfolio URL (…/portfolios/astronomy/…), or null. */
export function galleryFromUrl(url) {
    const match = String(url ?? '').match(/\/portfolios\/([^/]+)\//);
    if (!match) return null;
    try { return decodeURIComponent(match[1]); } catch (_) { return match[1]; }
}
