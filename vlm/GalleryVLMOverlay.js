/**
 * GalleryVLMOverlay.js — Instance-Aware VLM Chat UI ("TheDoInspector")
 *
 * Attaches a floating AI chat panel to every gallery wrapper found on the page.
 * All DOM queries are SCOPED to the specific wrapper element so multiple gallery
 * instances never bleed into each other.
 *
 * Extraction strategy (attempted in order):
 *   1. MutationObserver on #imageViewer → #full-image-container img  (primary)
 *   2. Event delegation on wrapper → last-clicked 2D thumbnail        (secondary)
 *   3. canvas.toDataURL() scoped to the wrapper canvas                (tertiary; often
 *      returns black if preserveDrawingBuffer=false — see note below)
 *
 * Note on canvas capture:  Three.js's WebGLRenderer clears the draw buffer each
 * frame unless { preserveDrawingBuffer: true } is set.  Since we cannot modify
 * the gallery source, canvas capture is a best-effort fallback and may return a
 * black image.  The img-element strategies are always preferred.
 *
 * Auto-init:  importing this module automatically calls initGalleryVLM() after
 * the DOM is ready, so you only need one script tag:
 *   <script type="module" src="vlm/GalleryVLMOverlay.js"></script>
 *
 * What loads when (the panel is cheap until it is used):
 *   page load            this file, VLMManager, InspectorCore, inspectorStyles; launcher CSS only
 *   first open           panel CSS, Roboto 500/700 if the page lacks them
 *   first answer         marked (pinned); KaTeX only if the answer contains math
 *   first Search tab     ImageSearch.js and the metadata index
 *   first Crop           ImageCrop.js
 *   first location       InspectorMap.js, Leaflet and map tiles
 */

import { VLMManager } from './VLMManager.js?v=12';
import {
    ModelGate,
    describeModel,
    describeProgress,
    findStableBoundary,
    galleryFromUrl,
    locationLinks,
    mayContainMath,
    thumbnailFor,
    titleCase,
} from './InspectorCore.js?v=1';
import { ICONS, PANEL_CSS, TOGGLE_CSS } from './inspectorStyles.js?v=1';

// Pinned CDN builds (exact versions with Subresource Integrity).
const CDN = Object.freeze({
    marked: {
        src: 'https://cdn.jsdelivr.net/npm/marked@13.0.3/marked.min.js',
        integrity: 'sha384-YTBHtsL8yVTHcLakYNyrOfK3K+QQcXiECuaALJ+3j7Mo681Rtzadt8NR6WrZH+eQ',
    },
    katexJs: {
        src: 'https://cdn.jsdelivr.net/npm/katex@0.16.47/dist/katex.min.js',
        integrity: 'sha384-CwjPRVHTvLiMBFjEoij+QZViMV5rhTOIp7CJzl24JEqpRDA1sJFHVXXLURktbYYp',
    },
    katexCss: {
        href: 'https://cdn.jsdelivr.net/npm/katex@0.16.47/dist/katex.min.css',
        integrity: 'sha384-nH0MfJ44wi1dd7w6jinlyBgljjS8EJAh2JBoRad8a3VDw2K69vfaaqm4WnR+gXtA',
    },
});

/** Keep at most this many message nodes in the DOM; older ones are dropped from view. */
const MAX_DOM_MESSAGES = 40;
/** Width of the docked panel until the visitor resizes it. */
const DEFAULT_DOCK_WIDTH = 380;
/** At or below this viewport width the panel is a bottom sheet. */
const SHEET_BREAKPOINT = 600;

const SUGGESTED_PROMPTS = Object.freeze([
    'Describe the image',
    'Where was this taken?',
    'What camera settings were used?',
]);

// ─── Markdown + LaTeX rendering (loaded lazily from CDN) ─────────────────────

let _markedReady       = false;
let _katexReady        = false;
let _markedLoadPromise = null;
let _katexLoadPromise  = null;

// ─── EXIF extraction from portfolio metadata.json ────────────────────────────

/** Cache: portfolio base URL → Promise<Object|null> */
const _metadataCache = new Map();

/** Fetch (and cache) the metadata.json for a portfolio base URL. */
function _fetchPortfolioMeta(base) {
    if (_metadataCache.has(base)) return _metadataCache.get(base);
    const p = fetch(`${base}/metadata/metadata.json`)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null);
    _metadataCache.set(base, p);
    return p;
}

/**
 * Parse a rational-string (e.g. "27/5", "9/5", "30") to a number.
 * Returns null if unparseable.
 */
function _parseFraction(str) {
    if (str == null) return null;
    const s = String(str).trim();
    const slash = s.indexOf('/');
    if (slash === -1) { const n = parseFloat(s); return isNaN(n) ? null : n; }
    const num = parseFloat(s.slice(0, slash));
    const den = parseFloat(s.slice(slash + 1));
    return (isNaN(num) || isNaN(den) || den === 0) ? null : num / den;
}

/**
 * Parse a GPS DMS array string like "[36, 48, 346/25]" to decimal degrees.
 * Returns null if unparseable.
 */
function _parseDMS(str) {
    if (!str) return null;
    const parts = str.replace(/[\[\]]/g, '').split(',').map(s => _parseFraction(s.trim()));
    if (parts.length < 3 || parts.some(p => p == null)) return null;
    return parts[0] + parts[1] / 60 + parts[2] / 3600;
}

/**
 * Look up pre-computed metadata for an image URL.
 * Returns { text: string, gps: {lat,lon}|null } or null if no data found.
 * GPS coordinates are signed decimals (S/W negative) ready for map URLs.
 * Reads from portfolios/<name>/metadata/metadata.json — no image fetch needed.
 * @param {string} src  Absolute URL of the image (fulls/ or thumbs/ path)
 * @returns {Promise<{text:string, gps:{lat:number,lon:number}|null}|null>}
 */
async function _extractExif(src) {
    if (!src || src.startsWith('data:')) return null;
    try {
        const url       = new URL(src);
        const parts     = url.pathname.split('/');
        const segIdx    = parts.findIndex(p => p === 'fulls' || p === 'thumbs');
        if (segIdx === -1) return null;

        const base      = url.origin + parts.slice(0, segIdx).join('/');
        const stem      = (parts[segIdx + 1] ?? '').replace(/\.[^.]+$/, '');
        if (!stem) return null;

        const meta = await _fetchPortfolioMeta(base);
        const d    = meta?.[stem];
        if (!d) return null;

        const lines = [];

        const cam = [d['Image Make'], d['Image Model']].filter(Boolean).join(' ');
        if (cam) lines.push(`Camera: ${cam}`);

        const lens = d['EXIF LensModel'];
        if (lens) lines.push(`Lens: ${lens}`);

        const fl   = _parseFraction(d['EXIF FocalLength']);
        const fl35 = d['EXIF FocalLengthIn35mmFilm'];
        if (fl != null) {
            lines.push(`Focal length: ${parseFloat(fl.toFixed(1))}mm${fl35 ? ` (${fl35}mm equiv.)` : ''}`);
        }

        const fn = _parseFraction(d['EXIF FNumber']);
        if (fn != null) lines.push(`Aperture: f/${parseFloat(fn.toFixed(1))}`);

        const et = _parseFraction(d['EXIF ExposureTime']);
        if (et != null) lines.push(`Shutter speed: ${et < 1 ? `1/${Math.round(1 / et)}` : et}s`);

        const iso = d['EXIF ISOSpeedRatings'];
        if (iso != null) lines.push(`ISO: ${iso}`);

        const expMode = d['EXIF ExposureMode'];
        if (expMode) lines.push(`Exposure mode: ${expMode}`);

        const expProg = d['EXIF ExposureProgram'];
        if (expProg) lines.push(`Exposure program: ${expProg}`);

        const metering = d['EXIF MeteringMode'];
        if (metering) lines.push(`Metering: ${metering}`);

        const wb = d['EXIF WhiteBalance'];
        if (wb) lines.push(`White balance: ${wb}`);

        const flash = d['EXIF Flash'];
        if (flash) lines.push(`Flash: ${flash}`);

        const date = d['EXIF DateTimeOriginal'];
        if (date) lines.push(`Date: ${date}`);

        // Resolution — pixel dimensions of the processed image
        const imgW = d['Image Width']  ?? d['EXIF ExifImageWidth'];
        const imgH = d['Image Height'] ?? d['EXIF ExifImageLength'];
        if (imgW != null && imgH != null) lines.push(`Resolution: ${imgW} × ${imgH} px`);

        // GPS — stored separately so the caller can render iframes or links
        let gps = null;
        const lat    = _parseDMS(d['GPS GPSLatitude']);
        const latRef = d['GPS GPSLatitudeRef'];
        const lon    = _parseDMS(d['GPS GPSLongitude']);
        const lonRef = d['GPS GPSLongitudeRef'];
        if (lat != null && lon != null) {
            const alt    = _parseFraction(d['GPS GPSAltitude']);
            const altRef = d['GPS GPSAltitudeRef'];
            const latDec = latRef === 'S' ? -lat : lat;
            const lonDec = lonRef === 'W' ? -lon : lon;
            let locLine  = `Location: ${lat.toFixed(6)}° ${latRef ?? ''}, ${lon.toFixed(6)}° ${lonRef ?? ''}`.trim();
            if (alt != null) locLine += ` · ${alt.toFixed(0)}m${altRef === '1' ? ' below sea level' : ' alt.'}`;
            lines.push(locLine);
            gps = { lat: latDec, lon: lonDec, alt: alt != null && altRef !== '1' ? alt : null };
        }

        return lines.length ? { text: lines.join('\n'), gps } : null;
    } catch (_) {
        return null;
    }
}

function _loadScript({ src, integrity }) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.integrity = integrity;
        s.crossOrigin = 'anonymous';
        s.async = true;
        s.onload = resolve;
        s.onerror = () => { s.remove(); reject(new Error(`Could not load ${src}`)); };
        document.head.appendChild(s);
    });
}

function _loadMarked() {
    if (_markedLoadPromise) return _markedLoadPromise;
    if (typeof marked !== 'undefined') { _markedReady = true; return (_markedLoadPromise = Promise.resolve()); }
    _markedLoadPromise = _loadScript(CDN.marked)
        .then(() => { _markedReady = typeof marked !== 'undefined'; })
        .catch(() => { _markedLoadPromise = null; });   // plain text until a later answer retries
    return _markedLoadPromise;
}

function _loadKaTeX() {
    if (_katexLoadPromise) return _katexLoadPromise;
    if (typeof katex !== 'undefined') { _katexReady = true; return (_katexLoadPromise = Promise.resolve()); }
    if (!document.querySelector(`link[href="${CDN.katexCss.href}"]`)) {
        const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: CDN.katexCss.href });
        link.integrity = CDN.katexCss.integrity;
        link.crossOrigin = 'anonymous';
        document.head.appendChild(link);
    }
    _katexLoadPromise = _loadScript(CDN.katexJs)
        .then(() => { _katexReady = typeof katex !== 'undefined'; })
        .catch(() => { _katexLoadPromise = null; });
    return _katexLoadPromise;
}

/**
 * Render assistant response text as markdown + LaTeX.
 * Returns an HTML string. Requires marked (and optionally katex) to be loaded.
 */
function _renderMarkdown(text) {
    if (!text || !_markedReady) {
        // Fallback: plain-text safe escape
        return text
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // --- Protect LaTeX blocks before passing to marked ---
    const latexStore = [];

    // $$...$$ display math (must come before inline to avoid double-match)
    let safe = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, inner) => {
        latexStore.push({ display: true, src: inner });
        return `%%LATEX${latexStore.length - 1}%%`;
    });

    // $...$ inline math (not preceded/followed by another $)
    safe = safe.replace(/\$([^\$\n]+?)\$/g, (_, inner) => {
        latexStore.push({ display: false, src: inner });
        return `%%LATEX${latexStore.length - 1}%%`;
    });

    // Render markdown
    let html = marked.parse(safe, { breaks: true, gfm: true });

    // Restore LaTeX placeholders
    if (latexStore.length) {
        html = html.replace(/%%LATEX(\d+)%%/g, (_, idx) => {
            const { display, src } = latexStore[Number(idx)];
            if (_katexReady) {
                try {
                    return katex.renderToString(src, { displayMode: display, throwOnError: false });
                } catch (_) { /* fall through to raw */ }
            }
            return display ? `$$${src}$$` : `$${src}$`;
        });
    }

    return html;
}

// ─── Three.js render freeze during inference ──────────────────────────────────
// THREE is loaded as a global <script> tag (non-module) so it is accessible here.
// We patch WebGLRenderer.prototype.render once per page: while _vlmIsRunning is
// true the render call is skipped entirely, freeing the GPU for ONNX Runtime.
// The animation loop (requestAnimationFrame) keeps ticking so the gallery's
// state machine and input handling remain intact — only pixel output is frozen.

let _threePatched  = false;
let _vlmIsRunning  = false;

function _setVlmRunning(v) {
    _vlmIsRunning = v;
    try { window.dispatchEvent(new CustomEvent(v ? 'vlm:inference-start' : 'vlm:inference-end')); } catch (_) {}
}

function patchThreeRenderer() {
    if (_threePatched) return;
    if (typeof THREE === 'undefined') return;
    _threePatched = true;

    const _orig = THREE.WebGLRenderer.prototype.render;
    THREE.WebGLRenderer.prototype.render = function (scene, camera) {
        if (_vlmIsRunning) return;
        _orig.call(this, scene, camera);
    };
}

// ─── CSS (see inspectorStyles.js) ────────────────────────────────────────────

function _injectStyle(id, css) {
    if (typeof document === 'undefined' || document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
}

/** Launcher styles only: small enough to add as soon as the overlay initialises. */
function injectCSS() {
    // An un-styled panel must never flash on the page before its sheet arrives.
    _injectStyle('vlm-toggle-css', `${TOGGLE_CSS}\n.vlm-panel:not(.vlm-styled) { display: none !important; }`);
}

/** The full panel sheet, added the first time the panel is shown. */
function injectPanelCSS() {
    _injectStyle('vlm-panel-css', PANEL_CSS);
    // Every page already loads Roboto; add the medium and bold cuts only where they are missing.
    const links = [...document.querySelectorAll('link[href*="fonts.googleapis.com"][href*="Roboto"]')];
    if (links.some(link => /500/.test(link.href) && /700/.test(link.href))) return;
    const font = document.createElement('link');
    font.rel = 'stylesheet';
    font.href = 'https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap';
    document.head.appendChild(font);
}

// ─── Streaming markdown ──────────────────────────────────────────────────────

/**
 * Renders a growing answer without re-parsing what is already finished.
 * Completed blocks are parsed once and appended; only the unfinished tail is
 * re-rendered each frame. `finish()` does one exact pass over the final text.
 */
class StreamingMarkdown {
    constructor(textEl) {
        this.el = textEl;
        this.committed = 0;
        this.lastTail = null;
        this.tail = document.createElement('div');
        this.tail.className = 'vlm-md-tail';
        this._template = document.createElement('template');
        textEl.textContent = '';
        textEl.appendChild(this.tail);
    }

    update(text) {
        if (!_markedReady) {
            // marked failed to load: plain text is still readable.
            if (text !== this.lastTail) { this.tail.textContent = text; this.lastTail = text; }
            return;
        }
        this.el.classList.add('vlm-md');
        this.source = text;
        const boundary = findStableBoundary(text, this.committed);
        if (boundary > this.committed) {
            this._template.innerHTML = _renderMarkdown(text.slice(this.committed, boundary));
            this.el.insertBefore(this._template.content, this.tail);
            this.committed = boundary;
        }
        const tail = text.slice(this.committed);
        if (tail !== this.lastTail) {
            this.tail.innerHTML = tail ? _renderMarkdown(tail) : '';
            this.lastTail = tail;
        }
    }

    /**
     * Final render. Blocks committed while streaming are already exact, so only the
     * unfinished tail is rendered again; `full` re-renders everything (used once KaTeX
     * arrives, so math in earlier blocks is typeset too).
     */
    finish(text, { full = false } = {}) {
        if (!_markedReady) { this.el.textContent = text; return; }
        this.el.classList.add('vlm-md');
        const prefixIntact = this.committed > 0 && this.tail.isConnected &&
            this.source?.slice(0, this.committed) === text.slice(0, this.committed);
        if (full || !prefixIntact) {
            this.el.innerHTML = _renderMarkdown(text);
        } else {
            this._template.innerHTML = _renderMarkdown(text.slice(this.committed));
            this.tail.replaceWith(this._template.content);
        }
        this.committed = text.length;
        this.lastTail = null;
    }
}

// ─── System Prompts ───────────────────────────────────────────────────────────

const _RESPONSE_LENGTH_INSTRUCTION =
    'Keep each response under 100 words unless the user explicitly requests a different length or a more detailed response. ';

const _GALLERY_SYSTEM_PROMPT =
    _RESPONSE_LENGTH_INSTRUCTION +
    'You are an AI assistant embedded in a photography portfolio. ' +
    'A photograph is provided with every message. ' +
    'Answer questions directly and precisely — lead with the specific answer, then add supporting detail only if it adds value. ' +
    'Answer any question relating to the image: subjects, scene, composition, lighting, color, mood, technique, and storytelling. ' +
    'IMPORTANT — camera settings rule: do NOT mention, guess, or estimate any technical camera parameter (camera make/model, lens, focal length, aperture, shutter speed, ISO, exposure) ' +
    'unless the user explicitly asks about camera settings or gear. ' +
    'You cannot read EXIF from pixels — any guess will be wrong. If the user asks about settings, a separate system will answer from verified EXIF data. ' +
    'Only refuse if the request has absolutely no connection to the image (e.g. unrelated coding, math). ' +
    'In that case respond only with: "I can only answer questions about this photograph." ' +
    'Use markdown formatting (bold, lists, headings) to structure responses clearly.';

const _GALLERY_LIVE_PROMPT =
    _RESPONSE_LENGTH_INSTRUCTION +
    'You are an AI assistant in a live voice conversation about a photograph. ' +
    'Keep every reply to 2–3 sentences maximum — you are being read aloud. ' +
    'Be direct and conversational. No lists, no headings, no markdown. ' +
    'Do not mention, guess, or estimate camera settings unless explicitly asked.';

const _ABOUT_SYSTEM_PROMPT =
    _RESPONSE_LENGTH_INSTRUCTION +
    'You are TheDoInspector, an AI assistant for the photography portfolio of Timothy Do (TheDoShoots). ' +
    'You help visitors learn about the photographer and his work. ' +
    'Timothy Do is an astrophotographer and landscape photographer based in California. ' +
    'He graduated with a Master\'s degree in Electrical and Computer Engineering from UCLA, now works in Computer Vision and Image Processing, and is an Eagle Scout with a photography merit badge. ' +
    'Primary camera: Sony Alpha A7 IV with lenses: Sony FE 28-70mm F/3.5-5.6, Sony FE 50mm F/1.8, Tamron 70-300mm F/4.5-6.3, Samyang 12mm F/2.0; secondary: Canon EOS Rebel T5 with lenses: Canon EF 70-300mm F/4-5.6, Canon EF 18-55mm F/3.5-5.6; mobile: Samsung S24 Ultra and Pixel 9 Pro. ' +
    'He is known for astrophotography (Milky Way, Orion Nebula) and National Parks landscape photography. ' +
    'When shown an image, describe what you see and connect it to the photographer\'s story where relevant. ' +
    'Answer any question about Timothy\'s background, gear, specialties, philosophy, or the images shown. ' +
    'Use markdown formatting (bold, lists) to structure your responses clearly.';

// ─── GalleryVLMOverlay Class ─────────────────────────────────────────────────

let _overlayCounter = 0;

function _storageGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
}
function _storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* private mode: the choice lasts for this visit */ }
}

class GalleryVLMOverlay {
    /**
     * @param {Element}    wrapper  The gallery wrapper element (scopes all DOM queries).
     * @param {VLMManager} manager  The page-level singleton VLM manager.
     */
    constructor(wrapper, manager) {
        this.wrapper           = wrapper;
        this.manager           = manager;
        this._id               = `vlm-${++_overlayCounter}`;
        this._imageSrc         = null;
        this._imageName        = null;
        this._croppedImageSrc  = null;
        this._cropRect         = null;
        this._imageExif        = null;   // EXIF text string for the current image, or null
        this._imageGps         = null;   // { lat, lon, alt } signed decimals, or null
        this._imageExifPromise = null;   // resolves when EXIF extraction finishes
        this._history          = [];    // [{role, content}, ...]
        this._streaming        = false;
        this._generation       = 0;     // incremented on every chat/image reset; stale callbacks bail
        this._observers        = [];    // page-level (permanent) observers
        this._iframeEl         = null;
        this._iframeDoc        = null;
        this._iframeObservers  = [];    // per-gallery observers (reset on each switch)
        this._pendingThumbSrc  = null;
        this._pendingThumbName = null;
        this._pageContext       = null;  // about-page bio injected into first local-model message
        this._exifBypass       = _storageGet('vlm-exif-bypass') !== 'off'; // default on
        this._directLinks      = _storageGet('vlm-direct-links') === 'on'; // default off (interactive map)
        this._iframeMode       = window.VLM_PANEL_MODE === true;  // running inside vlm/panel.html
        this._galleryOpen      = false;  // tracks gallery state in iframe mode
        this._searchRecords    = [];
        this._searchInventory  = [];
        this._metadataMatches  = [];
        this._recommendController = null;
        // User-editable system prompt override (empty = use built-in default)
        this._customSystemPrompt = window.VLM_SETTINGS?.systemPrompt ?? '';
        // Default system prompt for API / Ollama modes (gallery context)
        manager.setSystemPrompt(this._baseSystemPrompt());

        // Voice I/O state
        this._ttsEnabled = _storageGet('vlm-tts') === 'on';
        this._sttActive  = false;
        this._stt        = null;
        this._liveMode         = false;
        this._ttsBuf           = '';
        this._ttsPending       = 0;   // number of utterances queued or playing
        this._activeTTSTextEl  = null;
        this._ttsHLMark        = null;

        // Layout and lifecycle
        this._dockWidth     = DEFAULT_DOCK_WIDTH;        // tracked, so docking never has to measure the panel
        this._lifecycle     = new AbortController();     // listeners that live as long as the overlay
        this._openScope     = null;                      // listeners that only matter while the panel is open
        this._pinnedToEnd   = true;                      // chat follows new text unless the visitor scrolled up
        this._mapCards      = [];                        // live LocationCard instances in this conversation
        this._suggestionBtns = [];
        this._extractTimer  = 0;
        this._clearanceTimer = 0;
        this._destroyed     = false;
        this._statusKind    = 'idle';

        // Local-model download state (window.VLM_MODELS contract; inert when that API is absent).
        this._gate = new ModelGate({
            getModels:   () => window.VLM_MODELS,
            getSettings: () => window.VLM_SETTINGS,
            getManager:  () => this.manager,
            onChange:    () => this._renderGate(),
        });

        this._buildUI();
        this._bindManagerEvents();
        this._bindSettingsEvents();
        this._bindModelEvents();
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    /**
     * Returns the system prompt to use for API/Ollama mode.
     * Falls back to the built-in default when no custom prompt is configured.
     */
    _baseSystemPrompt() {
        if (this._liveMode) return _GALLERY_LIVE_PROMPT;
        return this._customSystemPrompt?.trim() || _GALLERY_SYSTEM_PROMPT;
    }

    /**
     * Returns the full system prompt including current photo metadata (EXIF).
     * Always use this instead of _baseSystemPrompt() when calling setSystemPrompt.
     */
    _buildSystemPrompt() {
        const base = this._baseSystemPrompt();
        if (!this._imageName) return base;
        if (this._imageExif) {
            return base + `\n\n[Current photo metadata]\nFile: ${this._imageName}\n${this._imageExif}`;
        }
        return base + `\n\n[Current photo]\nFile: ${this._imageName}`;
    }

    /** True when the panel is laid out as a bottom sheet (phones). */
    _isSheet() {
        return !this._iframeMode && window.innerWidth <= SHEET_BREAKPOINT;
    }
    // ── Voice I/O ──────────────────────────────────────────────────────────

    _toggleSTT() {
        if (this._sttActive) { this._stt?.stop(); return; }
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) return;
        const micBtn = this._q('-mic');
        const input  = this._q('-input');
        this._stt = new SR();
        const _sttVoice = this._selectedVoice();
        this._stt.lang = _sttVoice?._langOnly ?? _sttVoice?.lang ?? navigator.language ?? 'en-US';
        this._stt.interimResults = true;
        this._stt.maxAlternatives = 1;
        this._sttActive = true;
        micBtn.classList.add('vlm-mic-active');
        micBtn.setAttribute('aria-pressed', 'true');
        this._stt.onresult = (e) => {
            let interim = '', final = '';
            for (const r of e.results) {
                if (r.isFinal) final += r[0].transcript;
                else interim += r[0].transcript;
            }
            input.value = final || interim;
            this._autosizeInput();
            this._refreshSendBtn();
        };
        this._stt.onend = () => {
            this._sttActive = false;
            micBtn.classList.remove('vlm-mic-active');
            micBtn.setAttribute('aria-pressed', 'false');
            this._stt = null;
            if (input.value.trim() && !this._streaming) this._sendMessage();
            // Live mode: restart mic only when TTS is not playing
            if (this._liveMode) setTimeout(() => {
                if (this._liveMode && !this._sttActive && this._ttsPending === 0)
                    this._toggleSTT();
            }, 150);
        };
        this._stt.onerror = (e) => {
            this._sttActive = false;
            micBtn.classList.remove('vlm-mic-active');
            micBtn.setAttribute('aria-pressed', 'false');
            this._stt = null;
            // Restart unless the user denied permission
            if (this._liveMode && e.error !== 'not-allowed' && e.error !== 'service-not-allowed') {
                setTimeout(() => {
                    if (this._liveMode && !this._sttActive && this._ttsPending === 0)
                        this._toggleSTT();
                }, 500);
            }
        };
        this._stt.start();
    }

    _toggleTTS() {
        // When actively speaking/queued: act as stop button
        if (window.speechSynthesis?.speaking || window.speechSynthesis?.pending) {
            this._stopTTS();
            return;
        }
        this._ttsEnabled = !this._ttsEnabled;
        _storageSet('vlm-tts', this._ttsEnabled ? 'on' : 'off');
        this._syncTTSButton();
    }

    /** Icon, pressed state and Title Case label of the Read Aloud button. */
    _syncTTSButton() {
        const btn = this._q('-tts');
        if (!btn) return;
        const on = this._ttsEnabled;
        btn.classList.toggle('vlm-tts-on', on);
        btn.innerHTML = on ? ICONS.speakerOn : ICONS.speakerOff;
        btn.setAttribute('aria-pressed', String(on));
        const label = on ? 'Read Aloud: On' : 'Read Aloud: Off';
        btn.title = label;
        btn.setAttribute('aria-label', label);
    }

    /** Pressed state and label of the Live conversation button. */
    _syncLiveButton() {
        const btn = this._q('-live');
        if (!btn) return;
        btn.classList.toggle('vlm-live-on', this._liveMode);
        btn.setAttribute('aria-pressed', String(this._liveMode));
        btn.title = this._liveMode ? 'Live Conversation: On' : 'Live Conversation: Off';
    }

    _selectedVoice() {
        const uri = _storageGet('vlm-voice-uri');
        if (!uri || !window.speechSynthesis) return null;
        if (uri.startsWith('lang:')) return { _langOnly: uri.slice(5) };
        // Prefer the shared list built by the settings UI — same objects, same URIs.
        // Fall back to a fresh getVoices() call if the list isn't available yet.
        const voices = window._vlmAllVoices ?? window.speechSynthesis.getVoices();
        return voices.find(v => v.voiceURI === uri) ?? null;
    }

    _stopTTS() {
        window.speechSynthesis?.cancel();
        this._ttsBuf    = '';
        this._ttsPending = 0;
        this._clearTTSHighlight();
        this._q('-tts')?.classList.remove('vlm-tts-speaking');
        const bar = this._q('-tts-bar');
        if (bar) bar.classList.remove('vlm-tts-bar-on');
    }

    /** Called per token during streaming — speaks complete sentences as they form. */
    _feedTTS(chunk) {
        if (!this._ttsEnabled || !window.speechSynthesis) return;
        this._ttsBuf = (this._ttsBuf ?? '') + chunk;
        // Split on sentence-ending punctuation followed by whitespace
        const parts = this._ttsBuf.split(/([.!?…])\s+/);
        for (let i = 0; i + 1 < parts.length; i += 2) {
            this._speakChunk(parts[i] + parts[i + 1]);
        }
        this._ttsBuf = parts[parts.length - 1] ?? '';
    }

    /** Speak any remaining buffered text (call in onDone). */
    _flushTTS() {
        if (!this._ttsEnabled || !window.speechSynthesis) return;
        const remaining = (this._ttsBuf ?? '').trim();
        if (remaining) this._speakChunk(remaining);
        this._ttsBuf = '';
    }

    _toggleLiveMode() {
        this._liveMode = !this._liveMode;
        this._syncLiveButton();
        // Swap system prompt between live (concise) and normal
        this.manager.setSystemPrompt(this._buildSystemPrompt());
        if (!this._liveMode) {
            this._abortController?.abort();
            this._stopTTS();
            this._stt?.stop();
        } else {
            // Ensure TTS is enabled for live mode
            if (!this._ttsEnabled) {
                this._ttsEnabled = true;
                _storageSet('vlm-tts', 'on');
                this._syncTTSButton();
            }
            // If not currently generating or speaking, start listening immediately
            if (!this._streaming && this._ttsPending === 0) {
                this._toggleSTT();
            }
        }
    }

    _speakChunk(text) {
        const plain = text
            .replace(/#{1,6}\s+/g, '')
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/\*(.+?)\*/g, '$1')
            .replace(/`{1,3}[^`\n]*`{1,3}/g, '')
            .replace(/\[(.+?)\]\([^)]*\)/g, '$1')
            .replace(/\n+/g, ' ')
            .trim();
        if (!plain) return;
        this._ttsPending++;
        const utt    = new SpeechSynthesisUtterance(plain);
        const voice  = this._selectedVoice();
        if (voice?._langOnly) utt.lang = voice._langOnly;
        else if (voice) utt.voice = voice;
        utt.rate = parseFloat(_storageGet('vlm-voice-speed') ?? '1') || 1;
        const ttsBtn = this._q('-tts');
        const bar    = this._q('-tts-bar');

        utt.onstart = () => {
            ttsBtn?.classList.add('vlm-tts-speaking');
            if (bar) {
                bar.textContent = plain;
                bar.classList.add('vlm-tts-bar-on');
            }
            this._highlightTTSSentence(plain);
        };

        utt.onboundary = (e) => {
            if (!bar || e.name !== 'word') return;
            const len    = e.charLength ?? 0;
            const before = plain.slice(0, e.charIndex).replace(/&/g,'&amp;').replace(/</g,'&lt;');
            const word   = plain.slice(e.charIndex, e.charIndex + len).replace(/&/g,'&amp;').replace(/</g,'&lt;');
            const after  = plain.slice(e.charIndex + len).replace(/&/g,'&amp;').replace(/</g,'&lt;');
            bar.innerHTML = `${before}<mark class="vlm-tts-hl">${word}</mark>${after}`;
        };

        utt.onend = utt.onerror = () => {
            this._ttsPending = Math.max(0, this._ttsPending - 1);
            this._clearTTSHighlight();
            if (this._ttsPending === 0) {
                ttsBtn?.classList.remove('vlm-tts-speaking');
                if (bar) bar.classList.remove('vlm-tts-bar-on');
                // Live mode: all utterances done — start listening
                if (this._liveMode && !this._sttActive && !this._streaming) {
                    setTimeout(() => {
                        if (this._liveMode && !this._sttActive && this._ttsPending === 0)
                            this._toggleSTT();
                    }, 300);
                }
            }
        };

        window.speechSynthesis.speak(utt);
    }

    /** Wrap the plain-text sentence in a <mark> inside the active response textEl.
     *  Uses a normalized char-map so whitespace differences (newlines vs spaces)
     *  between the TTS plain text and the rendered DOM don't break the search. */
    _highlightTTSSentence(plain) {
        this._clearTTSHighlight();
        const textEl = this._activeTTSTextEl;
        if (!textEl || !plain) return;

        const normTarget = plain.replace(/\s+/g, ' ').trim();
        if (!normTarget) return;

        try {
            // Build a flat list of {node, offset} for every character in text nodes,
            // plus a whitespace-collapsed string with a mapping back to that list.
            const tw = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
            const chars = [];   // [{node, offset}]
            let node;
            while ((node = tw.nextNode())) {
                for (let i = 0; i < node.textContent.length; i++)
                    chars.push({ node, offset: i });
            }

            let normStr = '';
            const normToChar = [];   // normStr index → chars index
            let inWS = false;
            for (let i = 0; i < chars.length; i++) {
                const ch = chars[i].node.textContent[chars[i].offset];
                if (/\s/.test(ch)) {
                    if (!inWS) { normStr += ' '; normToChar.push(i); inWS = true; }
                } else {
                    normStr += ch; normToChar.push(i); inWS = false;
                }
            }
            normStr = normStr.trimStart();
            const trimOffset = normToChar.length - normStr.length; // chars trimmed from front

            const pos = normStr.indexOf(normTarget);
            if (pos === -1) return;

            const startIdx = normToChar[pos + trimOffset];
            const endIdx   = normToChar[pos + trimOffset + normTarget.length - 1];
            if (startIdx == null || endIdx == null) return;

            const range = document.createRange();
            range.setStart(chars[startIdx].node, chars[startIdx].offset);
            range.setEnd(chars[endIdx].node,   chars[endIdx].offset + 1);

            const mark = document.createElement('mark');
            mark.className = 'vlm-tts-hl';
            range.surroundContents(mark);
            this._ttsHLMark = mark;
            mark.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } catch (_) { /* range spans element boundary — skip */ }
    }

    /** Remove the inline sentence highlight. */
    _clearTTSHighlight() {
        const mark = this._ttsHLMark;
        this._ttsHLMark = null;
        if (!mark?.parentNode) return;
        const parent = mark.parentNode;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
    }

    // ── UI Construction ────────────────────────────────────────────────────

    _buildUI() {
        const id = this._id;

        // ── Launcher ───────────────────────────────────────────────────────
        // One small round button, bottom-right above the safe area. It is hidden
        // whenever the panel is open (the panel has its own Close Panel button).
        this._btn = document.createElement('button');
        this._btn.type = 'button';
        this._btn.className = 'vlm-toggle-btn';
        this._btn.title = 'Open TheDoInspector';
        this._btn.setAttribute('aria-label', 'Open TheDoInspector');
        this._btn.setAttribute('aria-haspopup', 'dialog');
        this._btn.setAttribute('aria-expanded', 'false');
        this._btn.setAttribute('aria-controls', `${id}-panel`);
        this._btn.innerHTML = ICONS.inspect;
        this._btn.style.display = 'none';   // hidden until a gallery iframe loads
        this._btn.addEventListener('click', () => this._togglePanel());
        document.body.appendChild(this._btn);

        // Cut TTS and STT on page unload so audio never bleeds through a refresh
        window.addEventListener('beforeunload', () => {
            window.speechSynthesis?.cancel();
            this._stt?.stop();
        }, { once: true, signal: this._lifecycle.signal });

        // ── Panel ──────────────────────────────────────────────────────────
        // Only the always-visible skeleton is built here. The options tray, the
        // search view, the loading stages, the EXIF table, the crop dialog and
        // the map are created the first time they are needed.
        this._panel = document.createElement('div');
        this._panel.className = 'vlm-panel';
        this._panel.id = `${id}-panel`;
        this._panel.dataset.vlmMode = 'chat';
        this._panel.tabIndex = -1;
        this._panel.setAttribute('role', 'dialog');
        this._panel.setAttribute('aria-label', 'TheDoInspector');
        const suggestions = SUGGESTED_PROMPTS.map(prompt =>
            `<button type="button" class="vlm-btn vlm-suggestion" data-prompt="${this._escapeHtml(prompt)}" disabled>${this._escapeHtml(titleCase(prompt))}</button>`,
        ).join('');
        this._panel.innerHTML = `
<div class="vlm-resize-handle" aria-hidden="true"></div>
<div class="vlm-header">
    <div class="vlm-header-id">
        <span class="vlm-header-title">TheDoInspector</span>
        <span class="vlm-status">
            <span class="vlm-status-dot" id="${id}-dot"></span>
            <span class="vlm-status-label" id="${id}-status" role="status">Not started</span>
        </span>
    </div>
    <button class="vlm-btn vlm-btn-icon vlm-gear-btn" id="${id}-gear" type="button" title="Open AI Settings" aria-label="Open AI Settings">${ICONS.gear}</button>
    <button class="vlm-btn vlm-btn-icon vlm-fs-btn" id="${id}-fs" type="button" title="Enter Fullscreen" aria-label="Enter Fullscreen" aria-pressed="false">${ICONS.expand}</button>
    <button class="vlm-btn vlm-btn-icon vlm-close-btn" id="${id}-close" type="button" title="Close Panel" aria-label="Close Panel">${ICONS.close}</button>
</div>
<div class="vlm-toolbar">
    <div class="vlm-mode-tabs" role="tablist" aria-label="Assistant Mode">
        <button class="vlm-btn vlm-mode-tab vlm-active" id="${id}-mode-chat" type="button" role="tab" aria-selected="true">Chat</button>
        <button class="vlm-btn vlm-mode-tab" id="${id}-mode-search" type="button" role="tab" aria-selected="false" tabindex="-1">Search</button>
    </div>
    <span class="vlm-toolbar-spacer"></span>
    <button class="vlm-btn vlm-new-btn vlm-chat-only" id="${id}-new" type="button" title="Clear Chat And Stop The Current Response">Clear Chat</button>
    <button class="vlm-btn vlm-btn-icon vlm-options-btn" id="${id}-options-btn" type="button" title="Options" aria-label="Options" aria-expanded="false" aria-controls="${id}-options">${ICONS.sliders}</button>
</div>
<div class="vlm-options" id="${id}-options" hidden></div>
<div class="vlm-current-photo" id="${id}-imgname">
    <img class="vlm-photo-thumb" id="${id}-photothumb" alt="" decoding="async">
    <span class="vlm-photo-name" id="${id}-photoname"></span>
    <span class="vlm-crop-badge" id="${id}-crop-badge" hidden>
        <img class="vlm-crop-thumb" id="${id}-crop-thumb" alt="">
        <span class="vlm-crop-label">Cropped</span>
        <button class="vlm-btn vlm-btn-icon vlm-crop-clear" id="${id}-crop-clear" type="button" title="Remove Crop" aria-label="Remove Crop">${ICONS.close}</button>
    </span>
    <button class="vlm-btn vlm-exif-toggle" id="${id}-exif-toggle" type="button" hidden title="Show EXIF Details" aria-expanded="false" aria-controls="${id}-exif-drawer">EXIF</button>
    <button class="vlm-btn vlm-crop-btn" id="${id}-crop-btn" type="button" hidden title="Crop A Region To Ask About">${ICONS.crop}<span>Crop</span></button>
</div>
<div class="vlm-exif-drawer" id="${id}-exif-drawer"></div>
<img class="vlm-fullscreen-photo" id="${id}-fullscreen-photo" alt="" decoding="async">
<div class="vlm-gate vlm-chat-only" id="${id}-gate" hidden></div>
<div class="vlm-messages vlm-chat-only" id="${id}-msgs" role="log" aria-label="Conversation"></div>
<div class="vlm-tts-bar vlm-chat-only" id="${id}-tts-bar"></div>
<div class="vlm-search-view" id="${id}-search-view"></div>
<div class="vlm-composer vlm-chat-only">
    <div class="vlm-suggestions" role="group" aria-label="Sample Prompts">${suggestions}</div>
    <div class="vlm-input-area">
        <textarea class="vlm-input" id="${id}-input" rows="1" placeholder="Ask about this photo" aria-label="Ask About The Photo"></textarea>
        <div class="vlm-input-tools">
            <button class="vlm-btn vlm-btn-icon vlm-voice-btn vlm-mic-btn" id="${id}-mic" type="button" hidden title="Voice Input" aria-label="Voice Input" aria-pressed="false">${ICONS.mic}</button>
            <button class="vlm-btn vlm-btn-icon vlm-voice-btn vlm-tts-btn" id="${id}-tts" type="button" title="Read Aloud: Off" aria-label="Read Aloud: Off" aria-pressed="false">${ICONS.speakerOff}</button>
            <button class="vlm-btn vlm-live-btn" id="${id}-live" type="button" hidden title="Live Conversation: Off" aria-pressed="false"><span class="vlm-live-dot" aria-hidden="true"></span>Live</button>
            <span class="vlm-toolbar-spacer"></span>
            <button class="vlm-btn vlm-btn-danger vlm-stop-btn" id="${id}-stop" type="button" hidden>${ICONS.stop}<span>Stop</span></button>
            <button class="vlm-btn vlm-btn-primary vlm-send-btn" id="${id}-send" type="button" disabled>Send</button>
        </div>
    </div>
</div>`;
        document.body.appendChild(this._panel);
        this._renderEmptyState();

        for (const eventName of ['contextmenu', 'dragstart']) {
            this._panel.addEventListener(eventName, (event) => {
                if (this._panel.classList.contains('vlm-fullscreen') &&
                    event.target.closest('.vlm-fullscreen-photo')) event.preventDefault();
            });
        }

        // ── Panel event wiring ─────────────────────────────────────────────
        this._q('-close').addEventListener('click',    () => this._closePanel());
        this._q('-new').addEventListener('click',      () => this._newChat());
        this._q('-fs').addEventListener('click',       () => this._toggleFullscreen());
        this._q('-gear').addEventListener('click',     () => this._openSettings());
        this._q('-mode-chat').addEventListener('click', () => this._setPanelMode('chat'));
        this._q('-mode-search').addEventListener('click', () => this._setPanelMode('search'));
        this._q('-options-btn').addEventListener('click', () => this._toggleOptions());
        this._panel.querySelector('.vlm-mode-tabs').addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            const next = this._panel.dataset.vlmMode === 'chat' ? 'search' : 'chat';
            this._setPanelMode(next, { focusInput: false });
            this._q(`-mode-${next}`).focus();
            event.preventDefault();
        });

        // Phone: pull the header down to close the sheet, up to fill the screen.
        this._initHeaderDrag();
        this._q('-crop-btn').addEventListener('click', () => this._openCrop());
        this._q('-crop-clear').addEventListener('click', (e) => {
            e.stopPropagation();
            this._croppedImageSrc = null;
            this._cropRect = null;
            this._updateCropUI();
            this._refreshSendBtn();
        });
        this._q('-exif-toggle').addEventListener('click', () => this._toggleExifDrawer());

        // Restore saved font size
        const saved = _storageGet('vlm-font-sz');
        if (saved) this._panel.style.setProperty('--vlm-font-sz', saved);

        this._initResize();

        // One resize listener for the lifetime of the overlay; work is deferred to a frame.
        let resizeFrame = 0;
        window.addEventListener('resize', () => {
            if (resizeFrame) return;
            resizeFrame = requestAnimationFrame(() => {
                resizeFrame = 0;
                if (this._panel.classList.contains('vlm-open')) {
                    this._setPush(true);
                    this._syncViewport();
                } else {
                    this._scheduleToggleClearance();
                }
            });
        }, { passive: true, signal: this._lifecycle.signal });

        // Controls that appear later (a photo viewer opening, a menu) may land under the
        // launcher: re-check after clicks and whenever something shows or hides it.
        document.addEventListener('click', () => this._scheduleToggleClearance(380), { capture: true, passive: true, signal: this._lifecycle.signal });
        this._toggleObserver = new MutationObserver(() => this._scheduleToggleClearance());
        this._toggleObserver.observe(this._btn, { attributes: true, attributeFilter: ['style', 'class'] });
        this._observers.push(this._toggleObserver);

        const sendBtn = this._q('-send');
        const input   = this._q('-input');
        const msgs    = this._q('-msgs');

        // Follow new text only while the visitor is at the end of the chat.
        msgs.addEventListener('scroll', () => {
            this._pinnedToEnd = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 56;
        }, { passive: true });

        this._suggestionBtns = [...this._panel.querySelectorAll('.vlm-suggestion')];
        for (const button of this._suggestionBtns) {
            button.addEventListener('click', () => {
                if (!this._imageSrc || !this._gate.canChat || this._streaming) return;
                // The label is Title Case; the prompt that is sent keeps its original wording.
                input.value = button.dataset.prompt;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                // Suggested prompts send immediately; keep the software keyboard closed.
                if (document.activeElement === input) input.blur();
                this._sendMessage();
            });
        }
        this._panel.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            if (this._panel.classList.contains('vlm-fullscreen')) {
                event.preventDefault();
                event.stopPropagation();
                this._toggleFullscreen();
                this._q('-fs').focus();
            } else if (!this._q('-options').hidden) {
                event.preventDefault();
                event.stopPropagation();
                this._toggleOptions(false);
                this._q('-options-btn').focus();
            }
        }, true);
        // Keys used inside the panel (arrows, space, letters) never drive the gallery behind it.
        // Escape still reaches the page from buttons so it can close its own viewer, but
        // not from a text field, where it only means "stop typing".
        for (const type of ['keydown', 'keyup', 'keypress']) {
            this._panel.addEventListener(type, (event) => {
                if (event.key !== 'Escape' || event.target.matches?.('input, textarea')) event.stopPropagation();
            });
        }

        sendBtn.addEventListener('click',   () => {
            if (navigator.vibrate) try { navigator.vibrate(8); } catch (_) {}
            this._sendMessage();
        });
        this._q('-stop').addEventListener('click', () => { this._abortController?.abort(); this._stopTTS(); });
        this._q('-mic').addEventListener('click',  () => this._toggleSTT());
        this._q('-tts').addEventListener('click',  () => this._toggleTTS());
        this._q('-live').addEventListener('click', () => this._toggleLiveMode());
        // In iframe-panel mode the host page passes allow="microphone"; show buttons unconditionally.
        // For non-iframe mode, require runtime API availability.
        if (this._iframeMode || window.SpeechRecognition || window.webkitSpeechRecognition) {
            this._q('-mic').hidden = false;
            if (this._iframeMode || window.speechSynthesis) this._q('-live').hidden = false;
        }
        this._syncTTSButton();

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this._sendMessage(); }
        });
        // Browsers with field-sizing grow the box in CSS; the rest get one measured write per frame.
        this._nativeAutosize = typeof CSS !== 'undefined' && CSS.supports?.('field-sizing', 'content');
        if (this._nativeAutosize) input.style.fieldSizing = 'content';
        input.addEventListener('input', () => {
            this._autosizeInput();
            this._refreshSendBtn();
        });
    }

    /** Shorthand: query by id suffix within this panel. */
    _q(suffix) {
        return document.getElementById(`${this._id}${suffix}`);
    }

    /** Grow the composer with its text (no-op where CSS field-sizing does it). */
    _autosizeInput() {
        if (this._nativeAutosize || this._autosizeFrame) return;
        this._autosizeFrame = requestAnimationFrame(() => {
            this._autosizeFrame = 0;
            const input = this._q('-input');
            if (!input) return;
            input.style.height = 'auto';
            input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
        });
    }

    /** Status line under the title, the dot beside it, and the launcher's busy ring. */
    _setStatus(kind, label) {
        this._statusKind = kind;
        const dot = this._q('-dot');
        if (dot) {
            dot.className = `vlm-status-dot${kind === 'loading' ? ' vlm-dot-loading' : kind === 'ready' ? ' vlm-dot-ready' : kind === 'error' ? ' vlm-dot-error' : ''}`;
        }
        const text = this._q('-status');
        if (text && label != null && text.textContent !== label) text.textContent = label;
        const busy = kind === 'loading';
        if (this._btn.classList.contains('vlm-model-loading') !== busy) {
            this._btn.classList.toggle('vlm-model-loading', busy);
            if (this._iframeMode) window.parent.postMessage({ type: 'vlm-btn-state', loading: busy }, '*');
        }
    }

    /** The placeholder shown while the conversation is empty. */
    _renderEmptyState() {
        const msgs = this._q('-msgs');
        if (!msgs || msgs.querySelector('.vlm-msg, .vlm-load-error')) return;
        const empty = document.createElement('div');
        empty.className = 'vlm-empty';
        const title = document.createElement('strong');
        if (this._imageSrc) {
            title.textContent = this._imageName || 'This photo';
            empty.append(title, 'Ask anything about this photo, or start with a suggestion below.');
        } else {
            title.textContent = 'No photo selected';
            empty.append(title, 'Open a photo, then ask anything about it.');
        }
        msgs.replaceChildren(empty);
    }

    // ── Options tray (built on first use) ──────────────────────────────────

    _ensureOptions() {
        const tray = this._q('-options');
        if (tray.childElementCount) return tray;
        const id = this._id;
        tray.innerHTML = `
<div class="vlm-font-btns" role="group" aria-label="Text Size">
    <button class="vlm-btn vlm-font-btn" id="${id}-font-dn" type="button" title="Smaller Text" aria-label="Smaller Text">A−</button>
    <button class="vlm-btn vlm-font-btn" id="${id}-font-up" type="button" title="Larger Text" aria-label="Larger Text">A+</button>
</div>
<button class="vlm-btn vlm-exif-bypass-btn" id="${id}-bypass" type="button">EXIF Auto</button>
<button class="vlm-btn vlm-direct-links-btn" id="${id}-dlbtn" type="button">Direct Links</button>
<button class="vlm-btn" id="${id}-copy-chat" type="button" title="Copy The Whole Conversation">Copy Chat</button>
<button class="vlm-btn" id="${id}-export-log" type="button" title="Save The Conversation As A Text File">Export Log</button>
<p class="vlm-options-note">EXIF Auto answers camera and location questions straight from the photo's metadata. Direct Links shows map links in place of the interactive map.</p>`;
        this._q('-font-dn').addEventListener('click',  () => this._changeFontSize(-1));
        this._q('-font-up').addEventListener('click',  () => this._changeFontSize(+1));
        this._q('-bypass').addEventListener('click', () => {
            this._exifBypass = !this._exifBypass;
            _storageSet('vlm-exif-bypass', this._exifBypass ? 'on' : 'off');
            this._syncOptionButtons();
        });
        this._q('-dlbtn').addEventListener('click', () => {
            this._directLinks = !this._directLinks;
            _storageSet('vlm-direct-links', this._directLinks ? 'on' : 'off');
            this._syncOptionButtons();
        });
        this._q('-copy-chat').addEventListener('click', () => this._copyChat());
        this._q('-export-log').addEventListener('click', () => this._exportLog());
        this._syncOptionButtons();
        return tray;
    }

    _syncOptionButtons() {
        const bypass = this._q('-bypass');
        if (!bypass) return;
        bypass.setAttribute('aria-pressed', String(this._exifBypass));
        bypass.title = `EXIF Auto: ${this._exifBypass ? 'On' : 'Off'}`;
        const links = this._q('-dlbtn');
        links.setAttribute('aria-pressed', String(this._directLinks));
        links.title = `Direct Links: ${this._directLinks ? 'On' : 'Off'}`;
        const empty = !this._history.length;
        this._q('-copy-chat').disabled = empty;
        this._q('-export-log').disabled = empty;
    }

    _toggleOptions(force) {
        const tray = this._q('-options');
        const open = force ?? tray.hidden;
        if (open) this._ensureOptions();
        tray.hidden = !open;
        const button = this._q('-options-btn');
        button.setAttribute('aria-expanded', String(open));
        button.classList.toggle('vlm-on', open);
    }

    // ── Photo strip: EXIF drawer and crop ──────────────────────────────────

    _toggleExifDrawer(force) {
        const btn    = this._q('-exif-toggle');
        const drawer = this._q('-exif-drawer');
        const open   = force ?? !drawer.classList.contains('vlm-exif-open');
        if (open && !drawer.childElementCount && this._imageExif) {
            // Built on demand: a two-column table from the newline-delimited EXIF string.
            const table = document.createElement('table');
            table.className = 'vlm-exif-table';
            for (const line of this._imageExif.split('\n')) {
                const row = table.insertRow();
                const sep = line.indexOf(': ');
                if (sep === -1) {
                    row.insertCell().textContent = line;
                    row.cells[0].colSpan = 2;
                } else {
                    row.insertCell().textContent = line.slice(0, sep);
                    row.insertCell().textContent = line.slice(sep + 2);
                }
            }
            drawer.appendChild(table);
        }
        drawer.classList.toggle('vlm-exif-open', open);
        btn.setAttribute('aria-expanded', String(open));
        btn.classList.toggle('vlm-on', open);
        btn.title = open ? 'Hide EXIF Details' : 'Show EXIF Details';
    }

    async _openCrop() {
        if (!this._imageSrc) return;
        const button = this._q('-crop-btn');
        button.disabled = true;
        try {
            // The crop dialog is only fetched when someone actually crops.
            const { ImageCropModal } = await import('./ImageCrop.js?v=3');
            new ImageCropModal({
                imageSrc: this._imageSrc,
                initialCrop: this._cropRect,
                returnFocus: button,
                onApply: (croppedDataUrl, cropRect) => {
                    this._croppedImageSrc = croppedDataUrl;
                    this._cropRect = cropRect;
                    this._updateCropUI();
                    this._refreshSendBtn();
                },
                onReset: () => {
                    this._croppedImageSrc = null;
                    this._cropRect = null;
                    this._updateCropUI();
                    this._refreshSendBtn();
                },
            }).open();
        } finally {
            button.disabled = false;
        }
    }

    // ── Panel State ────────────────────────────────────────────────────────

    /** Add the panel sheet on first use. One style flush lets the first open animate. */
    _ensurePanelReady() {
        if (this._panelReady) return;
        this._panelReady = true;
        injectPanelCSS();
        this._panel.classList.add('vlm-styled');
        void this._panel.offsetWidth;
    }

    _openPanel({ focus = false } = {}) {
        this._ensurePanelReady();
        if (!this._panel.classList.contains('vlm-open')) {
            this._panel.classList.add('vlm-open');
            this._bindOpenListeners();
            this._gate.refresh();
        }
        this._setPush(true);
        this._syncViewport();
        if (focus) this._panel.focus({ preventScroll: true });
    }

    _togglePanel() {
        if (this._panel.classList.contains('vlm-open')) {
            this._closePanel();
            return;
        }
        this._openPanel({ focus: true });
    }

    _closePanel() {
        this._cancelRecommendations();
        const wasOpen = this._panel.classList.contains('vlm-open');
        const hadFocus = this._panel.contains(document.activeElement);
        if (this._panel.classList.contains('vlm-fullscreen')) this._toggleFullscreen();
        this._panel.classList.remove('vlm-open', 'vlm-kb-open');
        // Everything that only matters while the panel is visible stops here.
        this._openScope?.abort();
        this._openScope = null;
        this._panel.style.removeProperty('--vlm-kb');
        this._panel.style.removeProperty('--vlm-vvh');
        for (const card of this._mapCards) { card.disengage(); card.closeExpanded(); }
        this._setPush(false);
        if (wasOpen && hadFocus && this._btn.isConnected && this._btn.style.display !== 'none') {
            this._btn.focus({ preventScroll: true });
        }
    }

    /** Listeners that are only needed while the panel is open; removed again by _closePanel. */
    _bindOpenListeners() {
        this._openScope?.abort();
        this._openScope = new AbortController();
        const vv = window.visualViewport;
        if (!vv) return;
        const { signal } = this._openScope;
        let frame = 0;
        const onViewport = () => {
            if (frame) return;
            frame = requestAnimationFrame(() => { frame = 0; this._syncViewport(); });
        };
        vv.addEventListener('resize', onViewport, { passive: true, signal });
        vv.addEventListener('scroll', onViewport, { passive: true, signal });
    }

    /**
     * Phone sheet: sit on top of the on-screen keyboard and never grow taller than
     * what is actually visible, so the composer stays in view while typing.
     */
    _syncViewport() {
        const vv = window.visualViewport;
        const panel = this._panel;
        if (!vv || !this._isSheet() || !panel.classList.contains('vlm-open')) {
            if (this._viewportApplied) {
                this._viewportApplied = false;
                this._sheetHeight = 0;
                document.documentElement.style.removeProperty('--vlm-sheet-h');
                panel.style.removeProperty('--vlm-kb');
                panel.style.removeProperty('--vlm-vvh');
                panel.classList.remove('vlm-kb-open');
            }
            return;
        }
        const keyboard = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
        const keyboardOpen = keyboard > 50;
        this._viewportApplied = true;
        panel.style.setProperty('--vlm-kb', keyboardOpen ? `${keyboard}px` : '0px');
        panel.style.setProperty('--vlm-vvh', `${Math.round(vv.height)}px`);
        panel.classList.toggle('vlm-kb-open', keyboardOpen);
        // The photo viewer centres its image in the space above the sheet (see inspectorStyles.js).
        const sheetHeight = panel.classList.contains('vlm-fullscreen') ? 0 : Math.round(panel.offsetHeight);
        if (sheetHeight !== this._sheetHeight) {
            this._sheetHeight = sheetHeight;
            document.documentElement.style.setProperty('--vlm-sheet-h', `${sheetHeight}px`);
        }
    }

    async _setPanelMode(mode, { focusInput = true } = {}) {
        if (mode !== 'search') this._cancelRecommendations();
        this._panel.dataset.vlmMode = mode;
        const chatTab = this._q('-mode-chat');
        const searchTab = this._q('-mode-search');
        chatTab.classList.toggle('vlm-active', mode === 'chat');
        chatTab.setAttribute('aria-selected', String(mode === 'chat'));
        chatTab.tabIndex = mode === 'chat' ? 0 : -1;
        searchTab.classList.toggle('vlm-active', mode === 'search');
        searchTab.setAttribute('aria-selected', String(mode === 'search'));
        searchTab.tabIndex = mode === 'search' ? 0 : -1;
        if (mode === 'search') {
            this._ensureSearchUI();
            await this._refreshSearchData();
            if (focusInput && this._panel.dataset.vlmMode === 'search') this._q('-search-input')?.focus({ preventScroll: true });
        }
    }

    // ── Portfolio search (view and module are created on first use) ────────

    _ensureSearchUI() {
        const view = this._q('-search-view');
        if (view.childElementCount) return;
        const id = this._id;
        view.innerHTML = `
<div class="vlm-search-controls">
    <input class="vlm-search-input" id="${id}-search-input" type="search" placeholder="Sony, ISO 3200, astronomy…" aria-label="Search Portfolio Metadata" autocomplete="off">
    <div class="vlm-search-scopes">
        <button class="vlm-btn vlm-search-scope vlm-active" id="${id}-scope-current" type="button" aria-pressed="true">Current Gallery</button>
        <button class="vlm-btn vlm-search-scope" id="${id}-scope-all" type="button" aria-pressed="false">All Galleries</button>
        <span class="vlm-toolbar-spacer"></span>
        <button class="vlm-btn vlm-recommend-btn" id="${id}-recommend" type="button" disabled title="Rank These Results Visually With The AI Model">Recommend With VLM</button>
        <span class="vlm-search-coverage" id="${id}-search-coverage"></span>
    </div>
</div>
<div class="vlm-search-results" id="${id}-search-results" aria-live="polite"><div class="vlm-search-note">Loading the photo index…</div></div>`;
        this._q('-scope-current').addEventListener('click', () => this._setSearchScope('current'));
        this._q('-scope-all').addEventListener('click', () => this._setSearchScope('all'));
        // Typing re-ranks at most every 120 ms rather than on every keystroke.
        let debounce = 0;
        this._q('-search-input').addEventListener('input', () => {
            this._cancelRecommendations();
            clearTimeout(debounce);
            debounce = setTimeout(() => this._renderSearchResults(), 120);
        });
        this._q('-recommend').addEventListener('click', () => this._recommendSearchResults());
        // One delegated listener serves every result card.
        this._q('-search-results').addEventListener('click', (event) => {
            const card = event.target.closest('.vlm-result');
            const record = card && this._resultRecords?.[Number(card.dataset.index)];
            if (record) this._openSearchResult(record);
        });
    }

    _setSearchScope(scope) {
        this._cancelRecommendations();
        this._searchScope = scope;
        const current = this._q('-scope-current'), all = this._q('-scope-all');
        current.classList.toggle('vlm-active', scope === 'current');
        current.setAttribute('aria-pressed', String(scope === 'current'));
        all.classList.toggle('vlm-active', scope === 'all');
        all.setAttribute('aria-pressed', String(scope === 'all'));
        this._renderSearchResults();
    }

    _currentGalleryName() {
        const fromImage = galleryFromUrl(this._imageSrc);
        if (fromImage) return fromImage;
        try {
            return galleryFromUrl(this._iframeEl?.src) ?? galleryFromUrl(location.href);
        } catch (_) { return null; }
    }

    async _refreshSearchData() {
        const coverage = this._q('-search-coverage');
        try {
            this._search ??= await import('./ImageSearch.js?v=4');
            const { records, inventory } = await this._search.loadSearchRecords();
            this._searchRecords = records;
            this._searchInventory = inventory;
            if (coverage) coverage.textContent = `${inventory.length} metadata records`;
        } catch (error) {
            this._searchRecords = [];
            this._searchInventory = [];
            this._metadataMatches = [];
            if (coverage) coverage.textContent = 'Index unavailable';
            this._setSearchNote(error.message);
            return;
        }
        this._renderSearchResults();
    }

    _escapeHtml(value) {
        return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /** Replace the results with one line of guidance, or put it above them with `prepend`. */
    _setSearchNote(text, { prepend = false } = {}) {
        const container = this._q('-search-results');
        if (!container) return;
        const note = document.createElement('div');
        note.className = 'vlm-search-note';
        note.textContent = text;
        if (prepend) container.prepend(note);
        else { this._resultRecords = []; container.replaceChildren(note); }
    }

    _renderSearchResults() {
        const container = this._q('-search-results');
        const coverage = this._q('-search-coverage');
        const recommendButton = this._q('-recommend');
        const query = this._q('-search-input')?.value?.trim() ?? '';
        if (!container) return;
        this._metadataMatches = [];
        if (recommendButton) recommendButton.disabled = true;
        const totalCount = this._searchInventory?.length ?? 0;
        if (coverage) coverage.textContent = `${totalCount} metadata records`;
        if (!this._searchRecords?.length) {
            this._setSearchNote('No build-time metadata index is available.');
            return;
        }
        if (!query) {
            this._setSearchNote('Start with a gallery, filename, camera, lens, date, ISO, GPS coordinates or any other EXIF value. Once there is a shortlist, the AI model can rank it visually.');
            return;
        }
        const currentGallery = this._currentGalleryName();
        const gallery = (this._searchScope ?? 'current') === 'current' ? currentGallery : null;
        if (!gallery && (this._searchScope ?? 'current') === 'current') {
            this._setSearchNote('Open a portfolio gallery or choose All Galleries.');
            return;
        }
        const matches = this._search.rankImageRecords(this._searchRecords, query, { gallery });
        this._metadataMatches = matches;
        if (recommendButton) recommendButton.disabled = matches.length === 0;
        if (coverage) coverage.textContent = `${matches.length} metadata result${matches.length === 1 ? '' : 's'}`;
        if (!matches.length) {
            this._setSearchNote('No metadata matched. Try a gallery, camera model, date, ISO, lens, filename or GPS value.');
            return;
        }
        this._renderSearchCards(matches);
    }

    _renderSearchCards(items, { recommended = false } = {}) {
        const container = this._q('-search-results');
        if (!container) return;
        // Build off-document and attach once: one layout however many cards there are.
        const fragment = document.createDocumentFragment();
        this._resultRecords = [];
        items.forEach((item, index) => {
            const record = item.record ?? item;
            this._resultRecords.push(record);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'vlm-result';
            button.dataset.index = String(index);
            button.title = titleCase(`Open ${record.name} in ${record.gallery}`);
            const img = document.createElement('img');
            img.src = record.thumbUrl;
            img.alt = record.caption || record.name;
            img.loading = 'lazy';
            img.decoding = 'async';
            const body = document.createElement('span');
            body.className = 'vlm-result-body';
            const title = document.createElement('span');
            title.className = 'vlm-result-title';
            title.textContent = record.name;
            const meta = document.createElement('span');
            meta.className = 'vlm-result-meta';
            const camera = record.metadata?.['Image Model'] ?? record.metadata?.['Image Make'] ?? '';
            meta.textContent = recommended
                ? `${item.score}% VLM match, ${record.gallery}`
                : [record.gallery, camera].filter(Boolean).join(', ');
            const caption = document.createElement('span');
            caption.className = 'vlm-result-caption';
            caption.textContent = recommended
                ? item.reason
                : (record.metadata?.['EXIF DateTimeOriginal'] ?? record.metadata?.['Image DateTime'] ?? 'Matched build metadata');
            body.append(title, meta, caption);
            button.append(img, body);
            fragment.appendChild(button);
        });
        container.replaceChildren(fragment);
    }

    _cancelRecommendations() {
        if (this._recommendController) this._recommendController.abort();
        this._recommendController = null;
        const button = this._q('-recommend');
        if (button) {
            button.textContent = 'Recommend With VLM';
            button.disabled = !(this._metadataMatches?.length);
        }
    }

    async _recommendSearchResults() {
        if (this._recommendController) {
            this._cancelRecommendations();
            this._renderSearchResults();
            return;
        }
        const query = this._q('-search-input')?.value?.trim() ?? '';
        const candidates = this._metadataMatches ?? [];
        const container = this._q('-search-results');
        const coverage = this._q('-search-coverage');
        const button = this._q('-recommend');
        if (!query || !candidates.length || !container || !button) return;
        if (!this._gate.canChat) {
            this._setSearchNote('The AI model is not ready yet. Metadata results stay available; try recommendations once it is.', { prepend: true });
            return;
        }

        const controller = new AbortController();
        this._recommendController = controller;
        button.textContent = 'Cancel';
        button.disabled = false;
        const candidateCount = Math.min(6, candidates.length);
        this._setSearchNote(`Preparing ${candidateCount} metadata candidate${candidateCount === 1 ? '' : 's'} for visual recommendation…`);

        try {
            const recommendations = await this._search.recommendImageRecords(this.manager, query, candidates, {
                limit: candidateCount,
                signal: controller.signal,
                onProgress: ({ stage, record, completed, total }) => {
                    if (controller.signal.aborted) return;
                    const action = stage === 'analyzing' ? 'Inspecting' : stage === 'loading' ? 'Loading' : stage === 'error' ? 'Skipped' : 'Recommended';
                    this._setSearchNote(`${action} ${record.name} (${completed} of ${total})`);
                },
            });
            if (controller.signal.aborted || this._q('-search-input')?.value?.trim() !== query) return;
            if (!recommendations.length) {
                this._renderSearchResults();
                this._setSearchNote('The AI model could not inspect this shortlist, so the metadata ranking is shown.', { prepend: true });
                return;
            }
            if (coverage) coverage.textContent = `${recommendations.length} VLM recommendation${recommendations.length === 1 ? '' : 's'} from the metadata shortlist`;
            this._renderSearchCards(recommendations, { recommended: true });
        } catch (error) {
            if (error?.name !== 'AbortError') {
                this._renderSearchResults();
                this._setSearchNote(`Recommendation failed; the metadata ranking is back. ${error.message}`, { prepend: true });
            }
        } finally {
            if (this._recommendController === controller) {
                this._recommendController = null;
                button.textContent = 'Recommend With VLM';
                button.disabled = false;
            }
        }
    }

    _openSearchResult(record) {
        const detail = { gallery: record.gallery, image: record.name };
        if (this._iframeMode) {
            window.parent.postMessage({ type: 'vlm-open-image', ...detail }, '*');
            return;
        }
        if (document.getElementById('exhibit-iframe')) {
            window.dispatchEvent(new CustomEvent('vlm-open-image', { detail }));
            return;
        }
        const url = new URL(`../${record.gallery}/index.html`, location.href);
        url.searchParams.set('img', record.name);
        location.href = url.href;
    }

    // ── Launcher placement ─────────────────────────────────────────────────

    /**
     * Keep the launcher out of the way.
     *   open  → hidden (the panel's own Close Panel button takes over)
     *   closed → bottom-right above the safe area, lifted just enough to clear
     *            any other page control that already occupies that corner.
     * Called by the page scripts as well (assets/js/photo-tools.js).
     */
    _syncTogglePlacement(open) {
        if (this._iframeMode) return;
        // Older versions docked the launcher inside the panel header; undo that if it happened.
        if (this._panel.contains(this._btn)) document.body.appendChild(this._btn);
        this._btn.classList.toggle('vlm-toggle-hidden', !!open);
        this._btn.setAttribute('aria-expanded', String(!!open));
        this._toggleObserver?.takeRecords();
        if (!open) this._scheduleToggleClearance();
    }

    _scheduleToggleClearance(delay = 0) {
        if (this._destroyed || this._iframeMode) return;
        clearTimeout(this._clearanceTimer);
        this._clearanceTimer = setTimeout(() => {
            cancelAnimationFrame(this._clearanceFrame);
            this._clearanceFrame = requestAnimationFrame(() => this._liftToggleClear());
        }, delay);
    }

    /** Raise the launcher until no other interactive control sits underneath it. */
    _liftToggleClear() {
        const btn = this._btn;
        if (!btn.isConnected || btn.style.display === 'none' || btn.classList.contains('vlm-toggle-hidden')) return;
        let lift = 0;
        btn.style.setProperty('--vlm-toggle-lift', '0px');
        for (let attempt = 0; attempt < 6; attempt++) {
            const rect = btn.getBoundingClientRect();
            if (!rect.width || rect.top < 80) break;
            const blocker = this._controlUnder(rect);
            if (!blocker) break;
            lift += Math.max(8, Math.ceil(rect.bottom - blocker.top) + 8);
            btn.style.setProperty('--vlm-toggle-lift', `${lift}px`);
        }
        this._toggleObserver?.takeRecords();   // our own style write is not a reason to re-check
    }

    /** The bounding box of another page control overlapping `rect`, or null. */
    _controlUnder(rect) {
        const selector = 'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [onclick]';
        const points = [
            [rect.left + rect.width / 2, rect.top + rect.height / 2],
            [rect.left + 3, rect.top + 3], [rect.right - 3, rect.top + 3],
            [rect.left + 3, rect.bottom - 3], [rect.right - 3, rect.bottom - 3],
        ];
        const probe = (doc, x, y, offsetX, offsetY) => {
            for (const node of doc.elementsFromPoint(x, y)) {
                if (node === this._btn || this._btn.contains(node) || this._panel.contains(node)) continue;
                if (node.tagName === 'IFRAME') {
                    // Same-origin gallery frame: look at the controls inside it.
                    let inner = null;
                    try { inner = node.contentDocument; } catch (_) { /* cross-origin */ }
                    if (!inner) continue;
                    const frame = node.getBoundingClientRect();
                    const hit = probe(inner, x - frame.left, y - frame.top, offsetX + frame.left, offsetY + frame.top);
                    if (hit) return hit;
                    continue;
                }
                const control = node.closest?.(selector);
                if (!control || !this._isAnchored(control)) continue;
                const box = control.getBoundingClientRect();
                if (box.width && box.height) return { top: box.top + offsetY, bottom: box.bottom + offsetY };
            }
            return null;
        };
        for (const [x, y] of points) {
            const hit = probe(document, x, y, 0, 0);
            if (hit) return hit;
        }
        return null;
    }

    /**
     * Whether a control is page chrome pinned to the viewport (fixed or sticky) rather than
     * content that scrolls under the launcher. Only chrome is worth climbing over: photos in a
     * grid fill the whole page, and climbing over them would carry the launcher up onto the
     * top-right menu trigger of a framed gallery.
     */
    _isAnchored(el) {
        const view = el.ownerDocument.defaultView;
        if (!view) return false;
        for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
            const style = view.getComputedStyle(node);
            // Inside a scrolling box (the gallery's photo grid, say) it is content, wherever the box sits.
            const scrolls = node !== el && /auto|scroll/.test(style.overflowY + style.overflowX)
                && (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1);
            if (scrolls) return false;
            if (style.position === 'fixed' || style.position === 'sticky') return true;
        }
        return false;
    }

    /**
     * Make room for the docked panel (desktop only).
     * Strategy: write a `--vlm-pane-width` CSS variable on the document root.
     * Gallery CSS uses `right: var(--vlm-pane-width)` on full-viewport fixed
     * elements so the canvas / grid / overlays shrink alongside the panel.
     * The home page's `.iframe-container` uses the same var so iframe-mode
     * galleries shrink with their wrapper. About / direct-gallery pages also
     * fall back to body.paddingRight for normal-flow content.
     *
     * The width comes from `_dockWidth`, never from measuring the panel, so
     * opening and closing causes no forced reflow.
     */
    _setPush(open) {
        this._syncTogglePlacement(open);
        if (this._iframeMode) return;
        // Lets page-level chrome that would sit on top of the phone sheet step aside (see inspectorStyles.js).
        document.documentElement.classList.toggle('vlm-panel-open', !!open);
        this._btn.style.right = '';
        const sheet = this._isSheet() || this._panel.classList.contains('vlm-fullscreen');
        const width = open && !sheet ? Math.min(this._dockWidth, window.innerWidth) : 0;
        if (this._pushedWidth === width && this._pushedFrame === !!this._iframeEl) return;
        this._pushedWidth = width;
        this._pushedFrame = !!this._iframeEl;
        // Parent doc only — drives .iframe-container's `right: var(...)` so
        // the iframe element flexes to (viewport - panel) width.
        document.documentElement.style.setProperty('--vlm-pane-width', `${width}px`);
        // For about / direct-gallery pages where there's no wrapper iframe,
        // push body content via padding so normal-flow children shift.
        document.body.style.paddingRight = !this._iframeEl && width ? `${width}px` : '';
        // Nudge the inner gallery (three.js + 2D grid) to pick up its new viewport.
        this._fireInnerResize();
    }

    /**
     * Fire `resize` on the inner-iframe window so its three.js render loop
     * picks up the new viewport size after the CSS transition.
     */
    _fireInnerResize() {
        const fire = () => {
            const cw = this._iframeEl?.contentWindow;
            if (cw) { try { cw.dispatchEvent(new Event('resize')); } catch (_) {} }
        };
        fire();
        clearTimeout(this._innerResizeTimer);
        this._innerResizeTimer = setTimeout(fire, 240);
    }

    _toggleFullscreen() {
        const isFs = this._panel.classList.toggle('vlm-fullscreen');
        const btn  = this._q('-fs');
        btn.title = isFs ? 'Exit Fullscreen' : 'Enter Fullscreen';
        btn.innerHTML = isFs ? ICONS.collapse : ICONS.expand;
        btn.setAttribute('aria-label', btn.title);
        btn.setAttribute('aria-pressed', String(isFs));
        this._syncFullscreenPhoto();
        if (this._panel.classList.contains('vlm-open')) {
            this._setPush(true);
            this._syncViewport();
        }
    }

    /** The large preview beside the chat only loads its image while fullscreen is on. */
    _syncFullscreenPhoto() {
        const preview = this._q('-fullscreen-photo');
        if (!preview) return;
        if (!this._imageSrc) { preview.removeAttribute('src'); return; }
        if (!this._panel.classList.contains('vlm-fullscreen')) return;
        if (preview.getAttribute('src') !== this._imageSrc) preview.src = this._imageSrc;
        preview.alt = this._imageName ?? '';
    }

    /** Open the main settings modal, expand the Advanced/AI section, and scroll to VLM. */
    _openSettings() {
        if (typeof window.openAISettings === 'function') {
            this._closePanel(); window.openAISettings(); return;
        }
        try {
            if (window.parent !== window && typeof window.parent.openAISettings === 'function') {
                this._closePanel(); window.parent.openAISettings(); return;
            }
        } catch (_) { /* Standalone navigation also works for cross-origin embeds. */ }
        const settingsBtn = document.getElementById('btn-open-settings')
            ?? document.getElementById('settings-btn')
            ?? document.querySelector('.settings-toggle, [data-target="settings"]');
        if (!settingsBtn) {
            const settingsURL = new URL('../index.html', import.meta.url);
            settingsURL.searchParams.set('settings', 'ai');
            settingsURL.searchParams.set('returnTo', location.pathname + location.search + location.hash);
            settingsURL.searchParams.set('mode', new URLSearchParams(location.search).get('mode') === '2d' ? '2d' : '3d');
            location.assign(settingsURL.href);
            return;
        }
        settingsBtn.click();
        document.querySelector('.settings-tab[data-tab="ai"]')?.click();
        setTimeout(() => {
            // Expand the collapsible "Advanced / AI Backend" section if collapsed
            const advancedSection = document.getElementById('settings-advanced');
            if (advancedSection && advancedSection.style.display === 'none') {
                advancedSection.style.display = '';
            }
            const vlmSection = document.getElementById('vlm-backend-row')
                ?? document.getElementById('select-vlm-backend')
                ?? document.querySelector('[id^="vlm-"]');
            vlmSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 120);
    }

    /**
     * Step font size up (+1) or down (−1) through a fixed scale.
     * Persists the choice to localStorage so it survives page reloads.
     */
    _changeFontSize(dir) {
        const sizes = [12, 13, 14, 15, 16, 18, 20];
        const cur = parseFloat(this._panel.style.getPropertyValue('--vlm-font-sz') || '14');
        const idx  = sizes.reduce((best, s, i) =>
            Math.abs(s - cur) < Math.abs(sizes[best] - cur) ? i : best, 0);
        const next = sizes[Math.max(0, Math.min(sizes.length - 1, idx + dir))];
        const val  = `${next}px`;
        this._panel.style.setProperty('--vlm-font-sz', val);
        _storageSet('vlm-font-sz', val);
    }

    /**
     * Phone sheet gestures on the header.
     *   pull down  → close the sheet (or leave fullscreen first)
     *   pull up    → fill the screen
     * Active only at sheet width while the panel is open. Moves are applied once
     * per frame; the listeners never block scrolling.
     */
    _initHeaderDrag() {
        const header = this._panel?.querySelector('.vlm-header');
        if (!header) return;
        let startY = 0;
        let dy = 0;
        let dragging = false;
        let frame = 0;
        // Ignore drags that start on a header button (close / fullscreen / settings)
        const isInteractive = (el) => !!el?.closest('button, a, input, [role="button"]');
        const paint = () => {
            frame = 0;
            if (dragging) this._panel.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
        };

        header.addEventListener('pointerdown', (e) => {
            if (!this._isSheet()) return;
            if (!this._panel.classList.contains('vlm-open')) return;
            if (isInteractive(e.target)) return;
            if (e.button != null && e.button !== 0) return;
            startY = e.clientY;
            dy = 0;
            dragging = true;
            this._panel.classList.add('vlm-dragging');
            try { header.setPointerCapture(e.pointerId); } catch (_) {}
        }, { passive: true });
        header.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            dy = e.clientY - startY;
            if (!frame) frame = requestAnimationFrame(paint);
        }, { passive: true });
        const endHeaderDrag = (e) => {
            if (!dragging) return;
            dragging = false;
            if (frame) { cancelAnimationFrame(frame); frame = 0; }
            this._panel.classList.remove('vlm-dragging');
            const pulled = (e?.clientY ?? startY) - startY;
            this._panel.style.transform = '';
            if (e?.pointerId != null) { try { header.releasePointerCapture(e.pointerId); } catch (_) {} }
            const fullscreen = this._panel.classList.contains('vlm-fullscreen');
            if (pulled > 100) {
                if (navigator.vibrate) try { navigator.vibrate(15); } catch (_) {}
                if (fullscreen) this._toggleFullscreen();
                else this._closePanel();
            } else if (pulled < -60 && !fullscreen && e?.type === 'pointerup') {
                this._toggleFullscreen();
            }
        };
        header.addEventListener('pointerup', endHeaderDrag, { passive: true });
        header.addEventListener('pointercancel', endHeaderDrag, { passive: true });
    }

    /**
     * Drag the panel's left edge to change its width.
     *
     * While dragging only the panel itself changes (one write per frame). The page
     * behind it is re-laid-out once, when the handle is released: updating the
     * `--vlm-pane-width` variable restyles the whole document, and resizing the
     * gallery frame makes three.js rebuild its buffers, so neither is done per move.
     */
    _initResize() {
        const handle = this._panel.querySelector('.vlm-resize-handle');
        if (!handle) return;

        let startX = 0, startW = 0, width = 0, frame = 0;
        let dragging    = false;
        let cursorStyle = null;

        const paint = () => {
            frame = 0;
            if (!dragging) return;
            if (this._iframeMode) {
                // In iframe mode the panel fills the iframe — the parent owns the column width.
                if (window.innerWidth > SHEET_BREAKPOINT) window.parent.postMessage({ type: 'vlm-resize', width }, '*');
                return;
            }
            this._panel.style.width = `${width}px`;
        };

        const endDrag = (e) => {
            if (!dragging) return;
            dragging = false;
            if (frame) { cancelAnimationFrame(frame); frame = 0; }
            if (e?.pointerId != null) {
                try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
            }
            this._panel.classList.remove('vlm-resizing');
            if (cursorStyle) { cursorStyle.remove(); cursorStyle = null; }
            if (this._iframeMode) return;
            this._panel.style.width = `${width}px`;
            this._dockWidth = width;
            // Commit once: the page makes room and the inner gallery re-measures.
            if (this._panel.classList.contains('vlm-open')) this._setPush(true);
        };

        // ── Pointer Events (mouse + touch unified) ──────────────────────────
        // setPointerCapture keeps all pointer events routed to the handle even
        // when the cursor moves far outside it — this is what makes pointerup
        // fire reliably instead of getting "stuck".
        handle.addEventListener('pointerdown', (e) => {
            if (this._panel.classList.contains('vlm-fullscreen')) return;
            if (e.button != null && e.button !== 0) return; // left / primary only
            e.preventDefault();
            handle.setPointerCapture(e.pointerId);
            startX = e.clientX;
            startW = width = this._iframeMode ? window.innerWidth : Math.min(this._dockWidth, window.innerWidth);
            dragging = true;
            this._panel.classList.add('vlm-resizing');
            // Keep the resize cursor even when the pointer outruns the handle.
            cursorStyle = document.createElement('style');
            cursorStyle.textContent = '* { cursor: ew-resize !important; user-select: none !important; }';
            document.head.appendChild(cursorStyle);
        });

        handle.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            // drag left = wider
            width = Math.round(Math.max(300, Math.min(window.innerWidth - 40, startW + (startX - e.clientX))));
            if (!frame) frame = requestAnimationFrame(paint);
        }, { passive: true });

        handle.addEventListener('pointerup',     (e) => endDrag(e), { passive: true });
        handle.addEventListener('pointercancel', (e) => endDrag(e), { passive: true });

        // Safety net: end drag when window loses focus (e.g. Alt-Tab mid-drag)
        window.addEventListener('blur', () => endDrag(), { passive: true, signal: this._lifecycle.signal });
    }

    _newChat() {
        this._abortController?.abort();  // cancel any in-flight API request
        this._generation++;              // invalidate any in-flight callbacks
        this._history   = [];
        this._streaming = false;         // abandon any streaming state
        _setVlmRunning(false);
        this._liveMode  = false;
        this._syncLiveButton();
        this._stopTTS();
        this.manager.setSystemPrompt(this._buildSystemPrompt());
        this._disposeMapCards();
        const msgs = this._q('-msgs');
        msgs.textContent = '';
        msgs.removeAttribute('aria-busy');
        this._panel.classList.remove('vlm-has-chat');
        this._pinnedToEnd = true;
        this._renderEmptyState();
        this._syncOptionButtons();
        this._refreshSendBtn();
    }

    /** Remove every live map in the conversation (library objects, listeners and DOM). */
    _disposeMapCards() {
        for (const card of this._mapCards) card.destroy();
        this._mapCards = [];
    }

    _refreshSendBtn() {
        const input   = this._q('-input');
        const sendBtn = this._q('-send');
        const stopBtn = this._q('-stop');
        if (!input || !sendBtn) return;
        // Suggestions and Send need a photo, an idle chat and a model that can answer.
        const blocked = !this._imageSrc || !this._gate.canChat || this._streaming;
        for (const button of this._suggestionBtns) button.disabled = blocked;
        sendBtn.disabled = blocked || !input.value.trim();
        if (stopBtn) stopBtn.hidden = !this._streaming;
        // Live mode: restart mic once generation ends, but only if TTS is not playing
        if (this._liveMode && !this._streaming && !this._sttActive && this._ttsPending === 0)
            this._toggleSTT();
    }

    _flashLabel(button, text) {
        if (!button) return;
        const original = button.dataset.label ?? button.textContent;
        button.dataset.label = original;
        button.textContent = text;
        clearTimeout(button._vlmFlash);
        button._vlmFlash = setTimeout(() => { button.textContent = original; }, 1500);
    }

    _copyChat() {
        if (!this._history.length) return;
        const lines = this._history.map(turn => {
            const label = turn.role === 'user' ? 'You' : 'Assistant';
            return `${label}:\n${turn.content}`;
        });
        navigator.clipboard?.writeText(lines.join('\n\n'))
            .then(() => this._flashLabel(this._q('-copy-chat'), 'Copied!'))
            .catch(() => this._flashLabel(this._q('-copy-chat'), 'Copy Failed'));
    }

    _exportLog() {
        if (!this._history.length) return;
        const header = [
            'VLM Chat Export',
            `Date: ${new Date().toLocaleString()}`,
            `Image: ${this._imageName ?? 'unknown'}`,
            '',
        ];
        const body = [];
        for (const turn of this._history) {
            const label = turn.role === 'user' ? '--- You ---' : '--- Assistant ---';
            body.push(label, turn.content, '');
        }
        const blob = new Blob([[...header, ...body].join('\n')], { type: 'text/plain' });
        const url  = URL.createObjectURL(blob);
        const a    = Object.assign(document.createElement('a'), { href: url, download: 'chat.log' });
        a.click();
        URL.revokeObjectURL(url);
    }
    // ── Image Extraction ───────────────────────────────────────────────────

    // ── Iframe / Document Watching ─────────────────────────────────────────

    /**
     * Parent-portfolio mode: watch the gallery iframe for content changes.
     * One overlay lives in the parent page and persists across gallery switches.
     * Called once by initGalleryVLM() when #exhibit-iframe is found.
     */
    _watchIframe(iframeEl) {
        this._iframeEl = iframeEl;

        // ── Critical mobile fix ────────────────────────────────────────────
        // The toggle button is hoisted into #iframe-container so it composites above
        // the gallery iframe on iOS Safari (which buries position:fixed siblings
        // behind transformed compositing layers regardless of z-index).
        // The PANEL must stay in document.body: #iframe-container has perspective:1000px
        // which makes it a containing block for position:fixed children, causing the
        // panel to be positioned relative to the container instead of the viewport.
        // The panel's own will-change:transform creates its own compositing layer so it
        // renders above #iframe-container (z-index 4500 > 4000).
        const container = document.getElementById('iframe-container') ?? iframeEl.parentElement;
        if (container) {
            container.appendChild(this._btn);  // button inside container (iOS safe)
            // panel stays in document.body — positioned relative to true viewport
        }

        // Fullscreen fix: when the gallery inside the iframe requests browser fullscreen,
        // the browser makes the <iframe> element the top-layer fullscreen element and hides
        // everything else on the parent page — including the VLM overlay.
        // Re-hoist to document.documentElement so the parent page (and VLM overlay) stays
        // in the top layer.  Works for both the gallery's "Go Fullscreen" button and the
        // viewer's per-image fullscreen toggle.
        const fsHandler = () => {
            if (document.fullscreenElement === iframeEl) {
                document.documentElement.requestFullscreen().catch(() => {});
            }
        };
        document.addEventListener('fullscreenchange', fsHandler);
        document.addEventListener('webkitfullscreenchange', fsHandler);
        this._observers.push({
            disconnect: () => {
                document.removeEventListener('fullscreenchange', fsHandler);
                document.removeEventListener('webkitfullscreenchange', fsHandler);
            },
        });

        // Primary trigger: iframe load event (desktop + most Android)
        const loadHandler = () => this._onIframeLoad();
        iframeEl.addEventListener('load', loadHandler);
        this._observers.push({ disconnect: () => iframeEl.removeEventListener('load', loadHandler) });

        // Secondary trigger: watch the container for the .active class toggle.
        // iOS Safari sometimes suppresses the iframe load event or fires it too early.
        if (container) {
            let fallbackTimer = null;
            let fallbackAttempts = 0;
            const attachWhenReady = () => {
                if (!container.classList.contains('active')) return;
                let doc = null;
                try { doc = this._iframeEl?.contentDocument; } catch (_) { /* cross-origin */ }
                if (doc && doc.location.href !== 'about:blank') {
                    this._onIframeLoad();
                    return;
                }
                if (++fallbackAttempts < 20) {
                    fallbackTimer = setTimeout(attachWhenReady, 250);
                }
            };
            const containerObs = new MutationObserver(() => {
                clearTimeout(fallbackTimer);
                if (container.classList.contains('active')) {
                    // Expose the control immediately. iOS Safari can suppress the
                    // iframe load event or report about:blank while the slide-up
                    // transition is already visible.
                    if ((window.VLM_SETTINGS ?? {}).enabled !== false) {
                        this._btn.style.display = '';
                    }
                    fallbackAttempts = 0;
                    fallbackTimer = setTimeout(attachWhenReady, 100);
                } else {
                    fallbackAttempts = 0;
                    this._clearImage();
                }
            });
            containerObs.observe(container, { attributes: true, attributeFilter: ['class'] });
            this._observers.push({
                disconnect: () => {
                    clearTimeout(fallbackTimer);
                    containerObs.disconnect();
                },
            });
        }
    }

    _onIframeLoad() {
        this._detachIframeObservers();
        let doc;
        try { doc = this._iframeEl?.contentDocument; } catch (_) { return; } // cross-origin guard
        if (!doc || doc.location.href === 'about:blank') {
            this._clearImage();
            return;
        }
        this._iframeDoc = doc;


        // (No inner-doc var manipulation: the iframe element itself shrinks
        // when .iframe-container does, so the gallery's `width: 100%` fills
        // the already-narrower iframe naturally.)

        // Gallery is open — show button and kick off model loading,
        // but only if VLM is enabled in settings (default: enabled).
        const settings = window.VLM_SETTINGS ?? {};
        if (settings.enabled === false) return;

        this._btn.style.display = '';

        const isApi    = settings.type === 'api' || settings.type === 'ollama';
        const firstLoad = isApi ? !this.manager.isReady : !this.manager._worker;

        if (settings.type === 'ollama') {
            this.manager.setOllamaMode(settings.ollamaEndpoint, settings.ollamaModel, settings.ollamaThink ?? null);
        } else if (isApi) {
            this.manager.setApiMode(
                settings.apiEndpoint,
                settings.apiKey,
                settings.apiModel,
            );
        } else {
            const modelId = settings.model ?? 'HuggingFaceTB/SmolVLM-256M-Instruct';
            // manager.init() is idempotent: only the very first call spawns the Worker
            this.manager.init(modelId);
            if (window.VLM_SETTINGS) window.VLM_SETTINGS._workerStarted = true;
        }

        // On the very first gallery open, auto-open the panel and push the container left
        if (firstLoad) this._autoOpen();

        // iframe load fires after all scripts have run, so readyState is 'complete'.
        // DOMContentLoaded branch is a safety net for edge cases.
        if (doc.readyState === 'loading') {
            const onReady = () => { doc.removeEventListener('DOMContentLoaded', onReady); this._attachIframeObservers(doc); };
            doc.addEventListener('DOMContentLoaded', onReady);
        } else {
            this._attachIframeObservers(doc);
        }
    }

    /**
     * Direct-gallery mode: no iframe, VLM runs in the gallery page itself.
     * Fallback for local gallery testing or single-gallery deployments.
     */
    _attachDocObservers(doc) {
        this._iframeDoc = doc;
        this._attachIframeObservers(doc);
    }

    /**
     * Attach MutationObservers and delegated click listeners to a gallery document.
     * Safe to call each time a new gallery loads — old observers are already cleared.
     * Routes to _attachAboutObservers when the about page is detected.
     */
    _attachIframeObservers(doc) {
        // ── About page: profile + card images, no gallery viewer ─────────────
        if (doc.querySelector('.info-grid, .profile-img')) {
            this._attachAboutObservers(doc);
            return;
        }

        // ── Gallery page: restore gallery context ─────────────────────────────
        this._pageContext = null;
        this.manager.setSystemPrompt(this._buildSystemPrompt());

        const viewer  = doc.querySelector('#imageViewer');
        const imgCont = doc.querySelector('#full-image-container');

        if (!viewer && !imgCont) {
            // Elements aren't in the DOM yet — wait for them (gallery initialises async)
            const bodyObs = new MutationObserver(() => {
                if (doc.querySelector('#imageViewer') || doc.querySelector('#full-image-container')) {
                    bodyObs.disconnect();
                    this._iframeObservers = this._iframeObservers.filter(o => o !== bodyObs);
                    this._attachIframeObservers(doc);
                }
            });
            bodyObs.observe(doc.body ?? doc, { childList: true, subtree: true });
            this._iframeObservers.push(bodyObs);
            return;
        }

        // Strategy 1: MutationObserver on #imageViewer / #full-image-container
        const obs = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.type === 'attributes' && m.attributeName === 'hidden') {
                    if (!viewer?.hasAttribute('hidden')) {
                        setTimeout(() => this._tryExtractFromViewer(), 120);
                    }
                }
                if (m.type === 'childList') this._tryExtractFromViewer();
                if (m.type === 'attributes' && m.attributeName === 'src') this._tryExtractFromViewer();
            }
        });
        if (viewer)  obs.observe(viewer,  { attributes: true });
        if (imgCont) obs.observe(imgCont, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
        this._iframeObservers.push(obs);

        // Strategy 1b: watch #thumbnail-selector for active-class changes.
        // In 3D-preview mode the fullImageContainer is empty; the active thumbnail
        // is the only reliable signal that the user switched to a different photo.
        // This catches the case where the active class changes but fullImageContainer
        // doesn't change (e.g. after exiting magnify mode and clicking a new thumb).
        const thumbSel = doc.querySelector('#thumbnail-selector');
        if (thumbSel) {
            const thumbObs = new MutationObserver(() => this._tryExtractFromViewer());
            thumbObs.observe(thumbSel, { attributes: true, childList: true, subtree: true });
            this._iframeObservers.push(thumbObs);
        }

        // Strategy 1c: document-wide click listener to capture 3D mesh & thumbnail clicks
        const globalClickHandler = () => {
            setTimeout(() => this._tryExtractFromViewer(), 50);
            setTimeout(() => this._tryExtractFromViewer(), 200);
            setTimeout(() => this._tryExtractFromViewer(), 500);
        };
        doc.addEventListener('click', globalClickHandler, true);
        this._iframeObservers.push({ disconnect: () => doc.removeEventListener('click', globalClickHandler, true) });

        // Strategy 2: capture-phase click delegation on #gallery-2d
        const grid = doc.querySelector('#gallery-2d');
        if (grid) {
            const clickHandler = (e) => {
                const thumb = e.target.closest('.thumb');
                if (!thumb) return;
                const img = thumb.querySelector('img');
                if (img?.src) {
                    this._pendingThumbSrc  = img.src.replace('/thumbs/', '/fulls/');
                    this._pendingThumbName = img.src.split('/').pop().replace(/\.[^.]+$/, '');
                }
            };
            grid.addEventListener('click', clickHandler, true);
            this._iframeObservers.push({ disconnect: () => grid.removeEventListener('click', clickHandler, true) });
        }
    }

    /**
     * About page: extract images from the profile photo, info-grid cards,
     * and the lightbox.  Sets photographer biography as context for both
     * local-model prompts (_pageContext) and API / Ollama system prompt.
     */
    _attachAboutObservers(doc) {
        const base = this._iframeEl?.src || location.href;

        // Set photographer context injected into the first local-model message
        this._pageContext =
            'About the photographer: Timothy Do (TheDoShoots) — astrophotographer and ' +
            'landscape photographer. UCLA ECE Master\'s graduate, works in Computer Vision ' +
            'and Image Processing. Eagle Scout with photography merit badge. Primary camera: ' +
            'Sony Alpha A7 IV (Sony FE 28-70mm F/3.5-5.6, Sony FE 50mm F/1.8, Tamron 70-300mm F/4.5-6.3, Samyang 12mm F/2.0); ' +
            'secondary: Canon EOS Rebel T5 (Canon EF 70-300mm F/4-5.6, Canon EF 18-55mm F/3.5-5.6). Known for Milky Way, Orion Nebula, and ' +
            'National Parks photography.';

        // Override system prompt for API / Ollama modes
        this.manager.setSystemPrompt(_ABOUT_SYSTEM_PROMPT);

        // Default context: profile headshot
        const profileImg = doc.querySelector('.profile-img');
        if (profileImg?.src && !profileImg.src.startsWith('data:')) {
            this._setImage(new URL(profileImg.src, base).href, 'Timothy Do');
        }

        // Card click → switch context to that card's photo
        const grid = doc.querySelector('.info-grid');
        if (grid) {
            const clickHandler = (e) => {
                const card = e.target.closest('.card');
                if (!card) return;
                const img    = card.querySelector('.card-img');
                const rawSrc = img?.dataset.src ||
                               (img?.src && !img.src.startsWith('data:') ? img.src : null);
                if (!rawSrc) return;
                const name = img?.alt || 'photo';
                this._setImage(new URL(rawSrc, base).href, name);
            };
            grid.addEventListener('click', clickHandler, true);
            this._iframeObservers.push({ disconnect: () => grid.removeEventListener('click', clickHandler, true) });
        }

        // Lightbox open → switch to the full-resolution lightbox image
        const lightbox = doc.getElementById('lightbox');
        if (lightbox) {
            const lbObs = new MutationObserver(() => {
                if (!lightbox.classList.contains('active')) return;
                const img     = doc.getElementById('lightbox-img');
                const caption = doc.getElementById('lightbox-caption')?.textContent?.trim();
                if (img?.src && !img.src.startsWith('data:image/gif')) {
                    this._setImage(new URL(img.src, base).href, caption || 'photo');
                }
            });
            lbObs.observe(lightbox, { attributes: true, attributeFilter: ['class'] });
            this._iframeObservers.push(lbObs);
        }
    }

    _detachIframeObservers() {
        this._iframeObservers.forEach(o => o.disconnect());
        this._iframeObservers  = [];
        this._iframeDoc        = null;
        this._pendingThumbSrc  = null;
        this._pendingThumbName = null;
    }

    /** Reset the image state and hide the overlay when the gallery is closed. */
    _clearImage() {
        if (this._imageSrc) this._newChat();
        this._imageSrc  = null;
        this._imageName = null;
        this._q('-fullscreen-photo')?.removeAttribute('src');
        this._panel.classList.remove('vlm-has-preview');
        const nameEl  = this._q('-imgname');
        const exifBtn = this._q('-exif-toggle');
        const drawer  = this._q('-exif-drawer');
        if (nameEl)  nameEl.classList.remove('vlm-has-photo');
        if (exifBtn) { exifBtn.style.display = 'none'; exifBtn.classList.remove('vlm-exif-open'); }
        if (drawer)  { drawer.innerHTML = ''; drawer.classList.remove('vlm-exif-open'); }
        this._refreshSendBtn();
        if (!this._iframeMode) {
            this._closePanel();
            this._btn.style.display = 'none';  // gallery closed — hide until next gallery opens
        }
    }

    /**
     * Resolve the current image using prioritised fallback chain.
     * Called automatically by observers; also exposed for manual calls.
     */
    _tryExtractFromViewer() {
        const baseUrl = this._iframeDoc?.location?.href || location.href;

        // Priority 1 — full-res img inside the viewer.
        // Skip if the container is explicitly hidden (e.g. after exiting magnify mode in 3D —
        // the gallery sets display:none but leaves the old <img> in the DOM).
        // Prefer img.active so a fading-out old image never wins over the incoming one.
        const imgCont = this._scopedEl('#full-image-container');
        if (imgCont && imgCont.style.display !== 'none') {
            const img = imgCont.querySelector('img.active[src]:not([src=""])') ??
                        imgCont.querySelector('img[src]:not([src=""])');
            if (img?.src && !img.src.startsWith('data:,')) {
                this._setImage(new URL(img.src, baseUrl).href,
                               img.alt || img.src.split('/').pop().replace(/\.[^.]+$/, ''));
                return;
            }
        }

        // Priority 2 — active thumbnail in #thumbnail-selector.
        // Covers 3D-preview mode (fullImageContainer is empty/hidden; the active
        // thumbnail class is the canonical source of truth for which image is shown).
        const strip = this._scopedEl('#thumbnail-selector');
        if (strip) {
            const active = strip.querySelector('img.active, .thumb.active img, img[aria-selected="true"]');
            if (active?.src) {
                const full = active.src.replace('/thumbs/', '/fulls/');
                this._setImage(new URL(full, baseUrl).href,
                               active.src.split('/').pop().replace(/\.[^.]+$/, ''));
                return;
            }
        }

        // Priority 3 — last-clicked 2D thumbnail (from delegated listener)
        if (this._pendingThumbSrc) {
            this._setImage(this._pendingThumbSrc, this._pendingThumbName ?? 'photo');
            this._pendingThumbSrc  = null;
            this._pendingThumbName = null;
            return;
        }

        // Priority 4 — canvas snapshot scoped to this wrapper
        // Only attempt when the gallery has an active selection; without this guard
        // the WebGL initialisation frame (captured before any image is shown) would
        // be sent as a data-URI that has no entry in metadata.json.
        const hasActiveThumb = strip?.querySelector('img.active, .thumb.active img, img[aria-selected="true"]');
        if (!hasActiveThumb) return;
        const canvas = this.wrapper.querySelector('canvas');
        if (canvas) {
            try {
                const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                // Heuristic: a real frame encodes to > ~8 KB; a blank frame is tiny
                if (dataUrl.length > 8000) {
                    this._setImage(dataUrl, 'viewport-capture');
                }
            } catch (_) { /* tainted canvas — skip */ }
        }
    }

    /**
     * Look up a selector inside the wrapper first; fall back to document-level.
     * This ensures correct scoping when multiple galleries share a page.
     */
    _scopedEl(selector) {
        return (this._iframeDoc ?? document).querySelector(selector);
    }

    _updateCropUI() {
        const cropBtn   = this._q('-crop-btn');
        const cropBadge = this._q('-crop-badge');
        const cropThumb = this._q('-crop-thumb');

        if (cropBtn) {
            cropBtn.hidden = !this._imageSrc;
            cropBtn.classList.toggle('vlm-on', !!this._croppedImageSrc);
        }
        if (cropBadge) {
            cropBadge.hidden = !this._croppedImageSrc;
            if (cropThumb) {
                if (this._croppedImageSrc) cropThumb.src = this._croppedImageSrc;
                else cropThumb.removeAttribute('src');
            }
        }
    }

    _setImage(src, name) {
        if (src === this._imageSrc) return;

        // Always reset conversation when the image changes, even when switching
        // from a null state — ensures stale streaming/history state is never
        // carried into a fresh image context.
        this._newChat();

        this._imageSrc  = src;
        // Callers may pass an empty alt text: fall back to the file name, then a generic word.
        const stem = src && !src.startsWith('data:') ? decodeURIComponent(src.split(/[?#]/)[0].split('/').pop() || '').replace(/\.[^.]+$/, '') : '';
        this._imageName = (name && String(name).trim()) || stem || 'photo';
        this._panel.classList.add('vlm-has-preview');
        this._syncFullscreenPhoto();
        this._croppedImageSrc  = null;
        this._cropRect         = null;
        this._updateCropUI();
        this._imageExif        = null;
        this._imageGps         = null;
        this._imageExifPromise = null;

        // For API/Ollama: reset system prompt with filename now so any
        // in-progress query sees the right image context immediately.
        if (this.manager._mode === 'api') {
            this.manager.setSystemPrompt(this._buildSystemPrompt());
        }

        // Kick off EXIF extraction; store the promise so _sendMessage can await it
        this._imageExifPromise = _extractExif(src).then(result => {
            if (this._imageSrc !== src) return;
            this._imageExif = result?.text ?? null;
            this._imageGps  = result?.gps  ?? null;
        });

        // Photo strip: a small thumbnail keeps the photo in view while the sheet covers it.
        const nameEl   = this._q('-imgname');
        const nameSpan = this._q('-photoname');
        const thumb    = this._q('-photothumb');
        const exifBtn  = this._q('-exif-toggle');
        const drawer   = this._q('-exif-drawer');
        if (nameEl) nameEl.classList.add('vlm-has-photo');
        if (nameSpan) nameSpan.textContent = this._imageName;
        if (thumb) {
            const small = thumbnailFor(src);
            thumb.onerror = small ? () => { thumb.onerror = null; if (this._imageSrc === src) thumb.src = src; } : null;
            thumb.src = small ?? src;
        }
        if (exifBtn) exifBtn.hidden = true;
        if (drawer) drawer.textContent = '';
        this._toggleExifDrawer(false);
        this._renderEmptyState();

        this._imageExifPromise.then(() => {
            // Guard: image may have changed while EXIF was loading
            if (this._imageSrc !== src) return;
            if (!this._imageExif || !exifBtn) return;
            exifBtn.hidden = false;   // the table itself is built when the drawer is opened

            // For API/Ollama: promote EXIF into the system prompt so the model
            // treats these values as authoritative ground truth — not a visual guess.
            if (this.manager._mode === 'api') {
                this.manager.setSystemPrompt(this._buildSystemPrompt());
            }
        });

        this._refreshSendBtn();
    }

    // ── Messaging ──────────────────────────────────────────────────────────

    _appendMsg(role, text, streaming = false) {
        const msgs = this._q('-msgs');
        msgs.querySelector('.vlm-empty')?.remove();

        const div = document.createElement('div');
        div.className = `vlm-msg vlm-msg-${role}${streaming ? ' vlm-streaming' : ''}`;
        if (text) div.textContent = text;
        msgs.appendChild(div);
        this._panel.classList.add('vlm-has-chat');

        // Long conversations: keep the newest messages, let the oldest leave the DOM.
        while (msgs.childElementCount > MAX_DOM_MESSAGES) {
            const oldest = msgs.firstElementChild;
            this._mapCards = this._mapCards.filter(card => {
                if (!oldest.contains(card.el)) return true;
                card.destroy();
                return false;
            });
            oldest.remove();
        }
        this._stickToEnd(role === 'user');
        return div;
    }

    /**
     * Bring a tall answer (one with a map) into view: its top when it is taller than
     * the chat window, so the map is what the visitor sees first; otherwise the end.
     */
    _revealInChat(el) {
        const msgs = this._q('-msgs');
        if (!msgs || !el?.isConnected || !this._pinnedToEnd) return;
        if (el.offsetHeight <= msgs.clientHeight) { this._stickToEnd(); return; }
        const top = el.getBoundingClientRect().top - msgs.getBoundingClientRect().top + msgs.scrollTop - 8;
        const card = el.querySelector('.vlm-map-card');
        const target = card ? card.getBoundingClientRect().top - msgs.getBoundingClientRect().top + msgs.scrollTop - 8 : top;
        msgs.scrollTop = Math.max(0, target);
        // The visitor is now reading this answer, not following the end of the chat.
        this._pinnedToEnd = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 56;
    }

    /** Scroll the chat to its end, unless the visitor has scrolled up to read (force overrides). */
    _stickToEnd(force = false) {
        if (force) this._pinnedToEnd = true;
        if (!this._pinnedToEnd) return;
        const msgs = this._q('-msgs');
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
    }

    /**
     * Downsample an image URL to a JPEG data-URI capped at maxDim on the
     * longest side.  Uses the browser's native canvas for speed — the decoded
     * image is almost always already in the browser cache since the gallery
     * viewer just displayed it at full resolution.
     *
     * SmolVLM's SigLIP vision encoder operates at ~384 px natively; the
     * Transformers.js processor will resize again anyway, so sending a 4 K
     * source image wastes decode + preprocessing time in the worker.
     *
     * @param {string} src     Original image URL or data-URI.
     * @param {number} maxDim  Longest-side cap in pixels (default 384).
     *                         384 px is SmolVLM's SigLIP encoder native resolution —
     *                         sending anything larger just wastes decode time in the worker.
     *                         Nearest-neighbour interpolation (imageSmoothingEnabled=false)
     *                         is used because quality is irrelevant at this stage; the
     *                         model's own processor normalises pixel values before inference.
     * @returns {Promise<string>} Downsampled JPEG data-URI, or original src on error.
     */
    _downsample(src, maxDim, useThumbnail = true) {
        // Default maxDim by mode:
        //   local  — 384 px  (SmolVLM's SigLIP encoder native resolution)
        //   api    — 1120 px (default input size expected by Ollama/llava vision models)
        if (maxDim == null) maxDim = this.manager._mode === 'api' ? 1120 : 384;

        // A local model reads 384 px: start from the site's 480 px thumbnail instead of
        // decoding the multi-megapixel original on the main thread.
        const source = useThumbnail && maxDim <= 480 ? (thumbnailFor(src) ?? src) : src;

        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const scale = Math.min(1, maxDim / img.naturalWidth, maxDim / img.naturalHeight);
                if (scale === 1) { resolve(source); return; }     // already small enough
                const w = Math.round(img.naturalWidth  * scale);
                const h = Math.round(img.naturalHeight * scale);
                const canvas = document.createElement('canvas');
                canvas.width  = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                // Use bilinear for API (quality > speed); nearest-neighbour for local (speed > quality)
                ctx.imageSmoothingEnabled = this.manager._mode === 'api';
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, w, h);
                try { resolve(canvas.toDataURL('image/jpeg', 0.88)); } catch (_) { resolve(src); }
            };
            // The thumbnail may be missing: fall back to the original, then to the URL itself.
            img.onerror = () => (source !== src ? this._downsample(src, maxDim, false).then(resolve) : resolve(src));
            img.src = source;
        });
    }

    /**
     * Returns true if the prompt is specifically asking about camera/EXIF metadata.
     * Always intercepts these questions — _answerFromExif handles the no-EXIF case
     * by explaining the data is unavailable, rather than letting the model refuse.
     */
    _isMetadataQuestion(prompt) {
        return /\b(what\s+(camera|lens|iso|aperture|shutter|focal|gear|settings|exif|specs)|which\s+(camera|lens)|what\s+(was|were|is|are)\s+the\s+(camera|lens|iso|aperture|shutter|focal|settings|specs|exif)|camera\s+(model|make|brand|used|settings?)|lens\s+(used|model)|iso\s+(setting|value|used|speed)?|shutter\s+speed|exposure\s+time|focal\s+length|f[\/-]?stop|f\/[\d.]+|camera\s+settings?|photo\s+settings?|shot\s+settings?|exif\s+data|metadata|what\s+settings?|camera\s+specs?|taken\s+with\s+what|shot\s+with\s+what|what\s+gear|where\s+(was|is)\s+(this\s+)?(photo|image|picture|shot|taken)|where\s+was\s+this|gps\s+(coordinates?|data|location)?|coordinates?|what\s+(location|place|city|country|state)|location\s+of\s+(this\s+)?(photo|image|picture)|shot\s+location|photo\s+location|taken\s+where|where\s+taken)\b/i.test(prompt);
    }

    /** True when the question is about where the photo was taken (so the answer gets a map). */
    _isLocationQuestion(prompt) {
        return /\b(where|location|located|gps|coordinates?|map|what\s+(place|city|country|state|park))\b/i.test(prompt);
    }

    /**
     * Answer a metadata question directly from EXIF — no VLM call, no CDN library.
     * Location questions get the place and an interactive map; camera questions get
     * the EXIF list (with the map one tap away). If EXIF is unavailable says so
     * clearly rather than letting the model guess.
     */
    _answerFromExif(prompt) {
        const wantsLocation = this._isLocationQuestion(prompt);
        const gps   = this._imageGps;
        const lines = this._imageExif ? this._imageExif.split('\n') : [];
        const links = gps ? locationLinks(gps.lat, gps.lon) : null;
        const el    = this._appendMsg('assistant', '');
        const body  = Object.assign(document.createElement('div'), { className: 'vlm-msg-text' });
        el.appendChild(body);

        const addList = (title, rows) => {
            body.appendChild(Object.assign(document.createElement('p'), { className: 'vlm-fact-title', textContent: title }));
            const list = Object.assign(document.createElement('dl'), { className: 'vlm-fact-list' });
            for (const row of rows) {
                const sep = row.indexOf(': ');
                list.appendChild(Object.assign(document.createElement('dt'), { textContent: sep === -1 ? '' : row.slice(0, sep) }));
                list.appendChild(Object.assign(document.createElement('dd'), { textContent: sep === -1 ? row : row.slice(sep + 2) }));
            }
            body.appendChild(list);
        };
        const linkSuffix = () => (this._directLinks && links
            ? ` ([OpenStreetMap](${links.openStreetMap}), [Google Maps](${links.googleMaps}), [Light Pollution](${links.lightPollution}))`
            : '');

        let answer;
        if (wantsLocation && gps) {
            const locationRow = lines.find(line => line.startsWith('Location:')) ?? '';
            body.textContent = 'Here is where this photo was taken, from the GPS position saved by the camera.';
            answer = `**Photo Location**\n\n• **Coordinates:** ${locationRow.replace(/^Location:\s*/, '')}${linkSuffix()}`;
        } else if (wantsLocation && lines.length) {
            body.textContent = 'This photo has no GPS position in its metadata, so there is no location or map to show.';
            answer = body.textContent;
        } else if (lines.length) {
            addList('EXIF Metadata', lines);
            const formatted = lines.map(line => {
                const sep = line.indexOf(': ');
                if (sep === -1) return `• **${line}**`;
                return `• **${line.slice(0, sep)}:** ${line.slice(sep + 2)}${line.startsWith('Location:') ? linkSuffix() : ''}`;
            }).join('\n');
            answer = `**EXIF Metadata**\n\n${formatted}`;
        } else {
            answer = 'No EXIF metadata was found for this image — the file may not contain embedded camera data.';
            body.textContent = answer;
        }
        this._history.push({ role: 'user',      content: prompt });
        this._history.push({ role: 'assistant', content: answer });
        if (this._history.length > 10) this._history = this._history.slice(-10);

        if (gps) this._attachLocation(el, { live: wantsLocation });
        el.classList.add('vlm-msg-settled');
        this._syncOptionButtons();
        this._stickToEnd();
    }

    /**
     * Put the photo's location under an answer.
     *   Direct Links on  → plain links (no map library is loaded)
     *   otherwise        → an interactive map card. `live` draws it straight away;
     *                      without it the card waits behind a "Show Map" button.
     * The map module, the map library and the tiles are only requested from here.
     */
    async _attachLocation(msgEl, { live = true } = {}) {
        const gps = this._imageGps;
        if (!gps || !msgEl?.isConnected) return;
        const generation = this._generation;
        const host = document.createElement('div');
        host.className = 'vlm-map-embeds';
        msgEl.appendChild(host);
        const astronomy = this._currentGalleryName() === 'astronomy';
        const links = locationLinks(gps.lat, gps.lon);

        const showLinks = () => {
            const row = document.createElement('div');
            row.className = 'vlm-map-actions';
            const entries = [['Open In OpenStreetMap', links.openStreetMap], ['Open In Google Maps', links.googleMaps]];
            if (astronomy) entries.push(['Light Pollution', links.lightPollution]);
            for (const [label, href] of entries) {
                const a = Object.assign(document.createElement('a'), { className: 'vlm-btn', textContent: label, href, target: '_blank', rel: 'noopener noreferrer' });
                row.appendChild(a);
            }
            host.replaceChildren(row);
        };
        if (this._directLinks) { showLinks(); this._stickToEnd(); return; }

        let mapModule;
        try {
            mapModule = await (this._mapModule ??= import('./InspectorMap.js?v=2'));
        } catch (_) {
            this._mapModule = null;
            if (host.isConnected) showLinks();
            return;
        }
        if (this._generation !== generation || !host.isConnected) return;

        // One live map at a time: earlier cards fold down to a "Show Map" button.
        for (const card of this._mapCards) card.collapse();
        const altitude = Number.isFinite(gps.alt) && gps.alt > 0 ? `${Math.round(gps.alt).toLocaleString('en-US')} m` : '';
        const card = new mapModule.LocationCard({
            lat: gps.lat,
            lon: gps.lon,
            altitude,
            photoName: this._imageName ?? '',
            thumbUrl: thumbnailFor(this._imageSrc) ?? (this._imageSrc?.startsWith('data:') ? null : this._imageSrc),
            showLightPollution: astronomy,
        });
        this._mapCards.push(card);
        msgEl.classList.add('vlm-has-map');
        host.appendChild(card.el);
        if (live) card.start();
        else { card.resolvePlace(false); card.collapse(); }
        this._revealInChat(msgEl);
    }

    async _sendMessage() {
        const input  = this._q('-input');
        const prompt = input.value.trim();
        if (!prompt || !this._imageSrc || !this._gate.canChat || this._streaming) return;

        input.value             = '';
        if (!this._nativeAutosize) input.style.height = 'auto';
        this._streaming         = true;
        _setVlmRunning(true);
        this._abortController   = new AbortController();
        this._ttsBuf            = '';   // reset streaming TTS sentence buffer
        this._refreshSendBtn();

        const userEl = this._appendMsg('user', prompt);

        // Snapshot the conversation generation. If the visitor switches photos or clears
        // the chat while anything below is pending, every later step sees a different
        // number and stops without touching the new chat.
        const gen = this._generation;

        // Short-circuit: answer camera/EXIF questions directly from metadata.
        // Only fires when EXIF auto-answer is enabled; otherwise the VLM answers
        // using the EXIF data already injected into the prompt context.
        await this._imageExifPromise;
        if (this._generation !== gen) return;
        if (this._exifBypass && this._isMetadataQuestion(prompt)) {
            this._answerFromExif(prompt);
            this._streaming = false;
            _setVlmRunning(false);
            this._refreshSendBtn();
            return;
        }

        // Assistant bubble: text, then one meta row (live stats, later the copy button).
        const msgs        = this._q('-msgs');
        const assistantEl = this._appendMsg('assistant', '', true);
        const textEl  = Object.assign(document.createElement('div'), { className: 'vlm-msg-text' });
        const metaEl  = Object.assign(document.createElement('div'), { className: 'vlm-msg-meta' });
        const statsEl = Object.assign(document.createElement('div'), { className: 'vlm-gen-stats' });
        const statTtft = Object.assign(document.createElement('span'), { className: 'vlm-stat-ttft' });
        const statTok  = Object.assign(document.createElement('span'), { className: 'vlm-stat-tok' });
        const statTps  = Object.assign(document.createElement('span'), { className: 'vlm-stat-tps vlm-stat-live', textContent: 'Generating…' });
        const statBack = Object.assign(document.createElement('span'), { className: 'vlm-stat-back' });
        statsEl.append(statTtft, statTok, statTps, statBack);
        metaEl.appendChild(statsEl);
        assistantEl.append(textEl, metaEl);
        msgs.setAttribute('aria-busy', 'true');
        this._activeTTSTextEl = textEl;  // expose to _speakChunk for inline highlighting

        // Thinking block — created lazily on first onThinking chunk
        let thinkEl   = null;
        let thinkBody = null;   // cached .vlm-thinking-text node
        let thinkText = '';
        let fullText  = '';
        let stream    = null;   // StreamingMarkdown, created once marked is available

        const sendTime = performance.now();
        let   ttftMs   = null;   // set on first token

        // Everything a token changes is written at most once per animation frame:
        // tokens only update these variables and request a frame.
        let frame = 0;
        let textDirty = false, thinkDirty = false, liveStats = null;
        const writeStats = ({ tps, tokenCount, avgTps, done }) => {
            statTtft.textContent = ttftMs != null ? `TTFT ${(ttftMs / 1000).toFixed(1)}s` : '';
            statTok.textContent  = tokenCount ? `${tokenCount} tok` : '';
            const rate = done ? avgTps : tps;
            statTps.textContent  = rate ? `${done ? 'avg ' : ''}${rate} tok/s` : (ttftMs == null ? 'Generating…' : '');
            statBack.textContent = this._backend ?? '';
        };
        const flush = () => {
            frame = 0;
            if (this._generation !== gen) return;
            if (thinkDirty && thinkBody) {
                thinkDirty = false;
                if (_markedReady) {
                    thinkBody.innerHTML = _renderMarkdown(thinkText);
                    thinkBody.classList.add('vlm-md');
                } else {
                    thinkBody.textContent = thinkText;
                }
            }
            if (textDirty) {
                textDirty = false;
                stream ??= new StreamingMarkdown(textEl);
                stream.update(fullText);
            }
            if (liveStats) { writeStats(liveStats); liveStats = null; }
            this._stickToEnd();
        };
        const requestFlush = () => { if (!frame) frame = requestAnimationFrame(flush); };

        // Pre-load markdown BEFORE manager.query so the prefix of the streaming
        // buffer never renders as plain textContent (would otherwise produce a
        // visible plain-text → formatted flip mid-stream). KaTeX is fetched only
        // if the answer turns out to contain math.
        await _loadMarked();
        let mathRequested = false;
        const requestMath = () => {
            if (mathRequested) return;
            mathRequested = true;
            _loadKaTeX().then(() => {
                if (this._generation !== gen || !textEl.isConnected) return;
                if (this._streaming) { if (stream) stream.lastTail = null; textDirty = true; requestFlush(); }
                else if (stream) stream.finish(fullText, { full: true });
            });
        };

        // Wait for EXIF extraction to finish (usually already done by the time
        // the user types a question; guarantees metadata is available on first send)
        await this._imageExifPromise;

        const targetSrc = this._croppedImageSrc || this._imageSrc;
        const imageSrc  = targetSrc ? await this._downsample(targetSrc) : null;
        if (this._generation !== gen || !imageSrc) return;

        // Build a metadata preamble injected at the start of every user prompt.
        // — Local mode: include full EXIF here (only injection point available).
        // — API mode:   EXIF is already in the system prompt (authoritative); user
        //               message carries only the filename as a lightweight anchor.
        const cropNote  = this._croppedImageSrc ? ' (Cropped Region)' : '';
        const metaLines = [`File: ${this._imageName ?? 'unknown'}${cropNote}`];
        if (this.manager._mode !== 'api' && this._imageExif) metaLines.push(this._imageExif);
        const metaBlock = `[Photo metadata]\n${metaLines.join('\n')}\n\n`;

        // Inject about-page photographer bio only on the first turn (local models
        // don't have a system prompt; API mode uses setSystemPrompt instead)
        const pageCtx = (!this._history.length && this._pageContext)
            ? `[About the photographer: ${this._pageContext}]\n\n`
            : '';
        // Local models receive instructions in the query rather than a system message.
        const lengthInstruction = this.manager._mode === 'api' ? '' : _RESPONSE_LENGTH_INSTRUCTION + '\n\n';
        const queryPrompt = lengthInstruction + metaBlock + pageCtx + prompt;

        const finishStream = () => {
            if (frame) { cancelAnimationFrame(frame); frame = 0; }
            assistantEl.classList.remove('vlm-streaming');
            msgs.removeAttribute('aria-busy');
            _setVlmRunning(false);
            this._streaming = false;
        };

        this.manager.query(
            imageSrc,
            queryPrompt,
            this._history.slice(),
            {
                signal: this._abortController.signal,
                onThinking: (chunk) => {
                    if (this._generation !== gen) return;
                    // Lazily create the collapsible think block on first chunk
                    if (!thinkEl) {
                        thinkEl = document.createElement('details');
                        thinkEl.className = 'vlm-thinking';
                        thinkEl.innerHTML = '<summary>Thinking…</summary><div class="vlm-thinking-text"></div>';
                        thinkBody = thinkEl.querySelector('.vlm-thinking-text');
                        assistantEl.insertBefore(thinkEl, textEl);
                    }
                    thinkText += chunk;
                    thinkDirty = true;
                    requestFlush();
                },
                onToken: (tok, tps, tokenCount) => {
                    if (this._generation !== gen) return;
                    if (ttftMs === null) ttftMs = performance.now() - sendTime;
                    fullText += tok;
                    textDirty = true;
                    liveStats = { tps, tokenCount, done: false };
                    if (!mathRequested && tok.includes('$')) requestMath();
                    this._feedTTS(tok);
                    requestFlush();
                },
                onDone: (text, tokenCount, avgTps) => {
                    if (this._generation !== gen) return;
                    finishStream();
                    const finalText = text || fullText;
                    fullText = finalText;

                    // One exact pass over the finished text.
                    stream ??= new StreamingMarkdown(textEl);
                    // Math typeset only after KaTeX arrived needs one full pass; everything else is final already.
                    stream.finish(finalText, { full: mathRequested && _katexReady });
                    if (!mathRequested && mayContainMath(finalText)) requestMath();

                    // Collapse the thinking block and update its label once done.
                    if (thinkEl) {
                        thinkEl.querySelector('summary').textContent = 'Thought Process';
                        if (thinkBody && _markedReady) {
                            thinkBody.innerHTML = _renderMarkdown(thinkText);
                            thinkBody.classList.add('vlm-md');
                        }
                    }

                    // Freeze final stats
                    statTps.classList.remove('vlm-stat-live');
                    writeStats({ tokenCount, avgTps, done: true });

                    this._history.push({ role: 'user',      content: prompt    });
                    this._history.push({ role: 'assistant', content: finalText });
                    if (this._history.length > 10) this._history = this._history.slice(-10);

                    // Per-message copy button
                    const copyBtn = document.createElement('button');
                    copyBtn.type        = 'button';
                    copyBtn.className   = 'vlm-btn vlm-msg-copy';
                    copyBtn.textContent = 'Copy Response';
                    copyBtn.title       = 'Copy This Response To The Clipboard';
                    copyBtn.addEventListener('click', () => {
                        navigator.clipboard?.writeText(finalText)
                            .then(() => this._flashLabel(copyBtn, 'Copied!'))
                            .catch(() => this._flashLabel(copyBtn, 'Copy Failed'));
                    });
                    metaEl.appendChild(copyBtn);

                    // A model answer to "where was this taken?" gets the same map as the EXIF answer.
                    if (this._imageGps && this._isLocationQuestion(prompt)) this._attachLocation(assistantEl, { live: true });
                    assistantEl.classList.add('vlm-msg-settled');

                    this._syncOptionButtons();
                    this._flushTTS();
                    this._refreshSendBtn();
                    this._stickToEnd();
                },
                onError: (msg) => {
                    if (this._generation !== gen) return;
                    finishStream();
                    // Suppress abort — user stopped intentionally
                    if (String(msg).toLowerCase().includes('abort')) {
                        if (!fullText) assistantEl.remove();
                        else { stream ??= new StreamingMarkdown(textEl); stream.finish(fullText); }
                        metaEl.remove();
                        this._refreshSendBtn();
                        return;
                    }
                    assistantEl.classList.add('vlm-msg-error');
                    textEl.classList.remove('vlm-md');
                    textEl.textContent = `Error: ${msg}`;
                    statsEl.remove();
                    const retryBtn = document.createElement('button');
                    retryBtn.type        = 'button';
                    retryBtn.className   = 'vlm-btn vlm-msg-copy';
                    retryBtn.textContent = 'Retry';
                    retryBtn.title       = 'Ask The Same Question Again';
                    retryBtn.addEventListener('click', () => {
                        if (this._streaming || this._generation !== gen) return;
                        assistantEl.remove();
                        userEl.remove();
                        input.value = prompt;
                        this._sendMessage();
                    });
                    metaEl.appendChild(retryBtn);
                    this._refreshSendBtn();
                    this._stickToEnd();
                },
            },
        );
    }

    // ── Model state (download contract) ────────────────────────────────────

    /**
     * 'vlm-model-state' events from the runtime drive the download notice.
     * Without window.VLM_MODELS nothing here changes how the panel behaves.
     */
    _bindModelEvents() {
        const { signal } = this._lifecycle;
        window.addEventListener('vlm-model-state', (event) => {
            const before = this._gate.state;
            if (!this._gate.handleEvent(event.detail)) return;
            // The download just finished while the panel is in use: start the model.
            if (this._gate.state === 'downloaded' && before !== 'downloaded') this._startDownloadedModel();
        }, { signal });
        // Coming back from the settings page (including from the back/forward cache).
        window.addEventListener('pageshow', () => {
            if (this._panel.classList.contains('vlm-open')) this._gate.refresh();
        }, { signal, passive: true });
    }

    /** init()/restart() never download under the contract, so this only loads what is already stored. */
    _startDownloadedModel() {
        if (!this._gate.applies || !this._panel.classList.contains('vlm-open')) return;
        if (this.manager.isReady || this.manager.isLoading) return;
        try {
            if (this.manager._worker) this.manager.restart(this._gate.modelId);
            else this.manager.init(this._gate.modelId);
        } catch (_) { /* the runtime reports failures through 'vlm-model-state' */ }
    }

    /** Model name and size for the notices, from whatever list the page exposes. */
    _modelInfo() {
        let pageList = null;
        try { pageList = typeof VLM_LOCAL_MODELS !== 'undefined' ? VLM_LOCAL_MODELS : null; } catch (_) {}   // eslint-disable-line no-undef
        let catalog = null;
        try { catalog = window.VLM_MODELS?.catalog ?? null; } catch (_) {}
        return describeModel(this._gate.modelId, [catalog, window.VLM_SETTINGS?.models, window.VLM_LOCAL_MODELS, pageList]);
    }

    /** Show the notice that matches the gate (download needed / downloading / starting / error). */
    _renderGate() {
        if (this._destroyed) return;
        const box = this._q('-gate');
        if (!box) return;
        const gate = this._gate;
        const view = gate.view;
        const model = this._modelInfo();
        const signature = `${view}|${model.id}`;

        if (signature !== this._gateSignature) {
            this._gateSignature = signature;
            box.textContent = '';
            box.hidden = view === 'none' || view === 'checking';
            this._panel.classList.toggle('vlm-gated', !box.hidden);
            // The phone sheet is taller while gated; keep the photo viewer's reserved space in step.
            if (this._viewportApplied) this._syncViewport();
            if (!box.hidden) {
                const notice = Object.assign(document.createElement('div'), { className: `vlm-notice${view === 'error' ? ' vlm-notice-error' : ''}` });
                notice.setAttribute('role', view === 'error' ? 'alert' : 'status');
                const title = Object.assign(document.createElement('p'), { className: 'vlm-notice-title' });
                const body  = Object.assign(document.createElement('p'), { className: 'vlm-notice-body' });
                const actions = Object.assign(document.createElement('div'), { className: 'vlm-notice-actions' });
                const settingsBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'vlm-btn', textContent: 'Open AI Settings' });
                settingsBtn.addEventListener('click', () => this._openSettings());
                notice.append(title, body);

                if (view === 'not-downloaded') {
                    title.textContent = 'This model needs a one-time download';
                    body.textContent = `${model.name} runs entirely in your browser, so its files${model.size ? ` (${model.size})` : ''} have to be downloaded once before it can answer. Nothing is downloaded until you start it in AI Settings.`;
                    settingsBtn.classList.add('vlm-btn-primary');
                    actions.appendChild(settingsBtn);
                } else if (view === 'downloading' || view === 'loading') {
                    title.textContent = view === 'downloading' ? `Downloading ${model.name}` : `Starting ${model.name}`;
                    body.textContent = view === 'downloading'
                        ? 'You can keep browsing while this finishes. The assistant is ready as soon as the download completes.'
                        : 'The model is loading from this browser\'s storage. The first answer can take a little longer.';
                    const meter = Object.assign(document.createElement('div'), { className: 'vlm-meter' });
                    meter.innerHTML = '<div class="vlm-meter-track"><div class="vlm-meter-fill"></div></div><div class="vlm-meter-text"><span class="vlm-meter-amount"></span><span class="vlm-meter-pct"></span></div>';
                    const track = meter.firstElementChild;
                    track.setAttribute('role', 'progressbar');
                    track.setAttribute('aria-label', view === 'downloading' ? 'Model Download Progress' : 'Model Loading');
                    notice.appendChild(meter);
                    if (view === 'downloading') actions.appendChild(settingsBtn);
                } else if (view === 'error') {
                    title.textContent = 'The model could not start';
                    const retryBtn = Object.assign(document.createElement('button'), { type: 'button', className: 'vlm-btn vlm-btn-primary', textContent: 'Retry' });
                    retryBtn.addEventListener('click', () => {
                        try { this.manager.restart(this._gate.modelId); } catch (_) {}
                        this._gate.refresh();
                    });
                    actions.append(retryBtn, settingsBtn);
                }
                if (actions.childElementCount) notice.appendChild(actions);
                box.appendChild(notice);
            }
        }

        // Values that change often (progress, detail text) only touch their own nodes.
        if (view === 'downloading') {
            const { pct, text } = describeProgress(gate.progress);
            const track = box.querySelector('.vlm-meter-track');
            track.classList.toggle('vlm-meter-indeterminate', pct == null);
            box.querySelector('.vlm-meter-fill').style.width = pct == null ? '' : `${pct}%`;
            if (pct == null) track.removeAttribute('aria-valuenow');
            else track.setAttribute('aria-valuenow', String(pct));
            box.querySelector('.vlm-meter-amount').textContent = text;
            box.querySelector('.vlm-meter-pct').textContent = pct == null ? '' : `${pct}%`;
            this._setStatus('loading', pct == null ? 'Downloading…' : `Downloading ${pct}%`);
        } else if (view === 'loading') {
            box.querySelector('.vlm-meter-track').classList.add('vlm-meter-indeterminate');
            box.querySelector('.vlm-meter-amount').textContent = this._loadDetail ?? '';
            this._setStatus('loading', this._loadDetail ?? 'Loading model…');
        } else if (view === 'error') {
            box.querySelector('.vlm-notice-body').textContent = gate.message || 'Something went wrong while loading the model.';
            this._setStatus('error', 'Could not start');
        } else if (view === 'not-downloaded') {
            this._setStatus('idle', 'Model not downloaded');
        } else if (view === 'checking') {
            this._setStatus('idle', 'Checking model…');
        }
        this._refreshSendBtn();
    }

    /**
     * First gallery of the visit: open the panel on its own when it can actually
     * answer. A local model that still needs downloading stays behind the launcher.
     */
    _autoOpen() {
        const open = () => {
            if (this._destroyed || this._iframeMode) return;
            if (this._btn.style.display === 'none') return;   // the gallery closed in the meantime
            this._openPanel();
        };
        if (!this._gate.applies) { open(); return; }
        this._gate.refresh().then(view => {
            if (view === 'none' || view === 'loading' || !this._gate.applies) open();
        });
    }

    // ── Manager Event Wiring ───────────────────────────────────────────────

    _bindManagerEvents() {
        this._backend = 'WASM';   // updated on 'ready'

        // The runtime reports 'proc' (processor) and then 'compile' (session start) while a
        // stored model loads. Downloads are reported through 'vlm-model-state' instead.
        this.manager.on('progress', ({ stage } = {}) => {
            if (this._destroyed) return;
            if (this._gate.state === 'downloading' || this._gate.state === 'not-downloaded') return;
            this._loadDetail = stage === 'proc' ? 'Loading processor…'
                : stage === 'compile' ? 'Starting the runtime…' : 'Reading model files…';
            if (this._gate.view === 'loading') this._renderGate();
            else this._setStatus('loading', this._loadDetail);
        });

        this.manager.on('ready', ({ device } = {}) => {
            if (this._destroyed) return;
            this._backend = (device ?? 'wasm').toUpperCase();
            this._loadDetail = null;
            this._setStatus('ready', `Ready · ${this._backend}`);
            if (device === 'api') this._renderGate();
            else this._gate.markReady();
            this._refreshSendBtn();
        });

        this.manager.on('restart', () => {
            if (this._destroyed) return;
            // Worker was restarted (model changed) — reset the status and the conversation
            this._resetLoadingUI();
            this._newChat();
            this._gate.refresh();
        });

        this.manager.on('error', ({ message } = {}) => {
            if (this._destroyed) return;
            this._setStatus('error', 'Load failed');
            if (this._gate.applies) { this._gate.refresh(); return; }   // the notice card reports it
            // Without the model-state contract, put the error in the chat so it is impossible to miss.
            const msgs = this._q('-msgs');
            if (msgs) {
                msgs.querySelector('.vlm-empty')?.remove();
                const errDiv = document.createElement('div');
                errDiv.className = 'vlm-msg vlm-msg-assistant vlm-msg-error vlm-load-error';
                errDiv.style.whiteSpace = 'pre-wrap';
                errDiv.textContent = `Model load error:\n${message ?? 'Unknown error'}`;
                msgs.appendChild(errDiv);
            }
        });
    }

    // ── Settings Events ────────────────────────────────────────────────────

    /**
     * Listen for changes broadcast from the parent page's settings modal.
     * The 'vlmsettingschanged' CustomEvent carries { enabled, model }.
     */
    _bindSettingsEvents() {
        window.addEventListener('vlmsettingschanged', (e) => {
            const { enabled, type, model, apiEndpoint, apiKey, apiModel, ollamaEndpoint, ollamaModel, ollamaThink, systemPrompt } = e.detail ?? {};
            // Update stored system prompt before any mode-switch (mode code reads _baseSystemPrompt())
            if (systemPrompt !== undefined) this._customSystemPrompt = systemPrompt ?? '';
            const galleryOpen = this._iframeMode
                ? this._galleryOpen
                : !!(this._iframeDoc && this._iframeDoc.location?.href !== 'about:blank');

            if (!enabled) {
                if (!this._iframeMode) this._btn.style.display = 'none';
                this._closePanel();
                return;
            }

            if (!galleryOpen) { this._gate.refresh(); return; }

            if (!this._iframeMode) this._btn.style.display = '';

            if (type === 'ollama') {
                // Switch to (or update) Ollama mode — setOllamaMode fires 'ready'
                // synchronously, which updates the status bar. Don't reset UI after.
                this.manager.setOllamaMode(ollamaEndpoint, ollamaModel, ollamaThink ?? null);
                this.manager.setSystemPrompt(this._buildSystemPrompt());
                this._newChat();
            } else if (type === 'api') {
                // Switch to (or update) API mode — setApiMode fires 'ready'
                // synchronously, which updates the status bar. Don't reset UI after.
                this.manager.setApiMode(apiEndpoint, apiKey, apiModel);
                this.manager.setSystemPrompt(this._buildSystemPrompt());
                this._newChat();
            } else {
                // Local model mode
                if (this.manager._mode === 'api') {
                    // Switching from API → local: tear down api state and spawn worker
                    this._resetLoadingUI();
                    this.manager.restart(model ?? 'HuggingFaceTB/SmolVLM-256M-Instruct');
                } else if (this.manager._modelId && this.manager._modelId !== model && this.manager._worker) {
                    // Local model changed while worker is running
                    this._resetLoadingUI();
                    this.manager.restart(model);
                } else {
                    this.manager.init(model);
                }
            }
            this._gate.refresh();
        }, { signal: this._lifecycle.signal });
    }

    /** Reset the status line when the worker restarts. */
    _resetLoadingUI() {
        this._loadDetail = null;
        this._setStatus('loading', 'Loading model…');
        this._refreshSendBtn();
    }

    // ── Cleanup ────────────────────────────────────────────────────────────

    destroy() {
        this._destroyed = true;
        this._abortController?.abort();
        this._cancelRecommendations();
        this._lifecycle.abort();
        this._openScope?.abort();
        this._observers.forEach(o => o.disconnect());
        this._observers = [];
        this._detachIframeObservers();
        this._disposeMapCards();
        clearTimeout(this._clearanceTimer);
        clearTimeout(this._innerResizeTimer);
        cancelAnimationFrame(this._clearanceFrame);
        this._stopTTS();
        this._stt?.stop();
        document.documentElement.style.setProperty('--vlm-pane-width', '0px');
        document.documentElement.classList.remove('vlm-panel-open');
        document.body.style.paddingRight = '';
        this._btn?.remove();
        this._panel?.remove();
    }
}

// ─── Page-Level Initialisation ────────────────────────────────────────────────

/**
 * Initialise one page-level VLMManager and one GalleryVLMOverlay.
 *
 * Parent-portfolio mode (index.html):
 *   The overlay is attached to document.body and watches the #exhibit-iframe.
 *   When the user switches galleries the iframe reloads; the overlay stays alive,
 *   re-attaches observers to the new document, and the model Worker is never torn down.
 *
 * Direct-gallery mode (single gallery page / local testing):
 *   No iframe found — observers attach directly to the current document.
 */
const pageOverlayKey = Symbol.for('thedoshoots.galleryVLMOverlays');
function initGalleryVLM({ autoStart = true } = {}) {
    if (window[pageOverlayKey]) return window[pageOverlayKey];
    injectCSS();
    patchThreeRenderer();

    const manager = VLMManager.getInstance();

    const overlay = new GalleryVLMOverlay(document.body, manager);

    if (overlay._iframeMode) {
        // ── Iframe-panel mode (vlm/panel.html) ──────────────────────────────
        // The panel fills the entire #vlm-iframe viewport and stays permanently open.
        // All gallery context arrives via postMessage from the parent; layout is
        // driven by --vlm-pane-width on the parent's #vlm-iframe element.
        overlay._btn.style.display = 'none';
        overlay._panel.classList.add('vlm-iframe-mode');
        overlay._openPanel();

        // Settings modal lives in the parent page
        overlay._openSettings = () => {
            window.parent.postMessage({ type: 'vlm-open-settings' }, '*');
        };

        window.addEventListener('message', (e) => {
            if (!e.data?.type) return;
            const d = e.data;
            if (d.type === 'gallery-opened') {
                overlay._galleryOpen = true;
                // Init manager using current settings (vlm-config will have arrived at page load)
                const cfg = window.VLM_SETTINGS ?? {};
                if (cfg.enabled !== false) {
                    if (cfg.type === 'ollama') {
                        manager.setOllamaMode(cfg.ollamaEndpoint, cfg.ollamaModel, cfg.ollamaThink ?? null);
                    } else if (cfg.type === 'api') {
                        manager.setApiMode(cfg.apiEndpoint, cfg.apiKey, cfg.apiModel);
                    } else {
                        manager.init(cfg.model ?? 'HuggingFaceTB/SmolVLM-256M-Instruct');
                    }
                    overlay._gate.refresh();
                }
            } else if (d.type === 'gallery-closed') {
                overlay._galleryOpen = false;
                overlay._clearImage();
            } else if (d.type === 'gallery-image-changed') {
                overlay._setImage(d.src, d.name || 'photo');
            } else if (d.type === 'vlm-config') {
                if (!window.VLM_SETTINGS) window.VLM_SETTINGS = {};
                Object.assign(window.VLM_SETTINGS, d.config);
                window.dispatchEvent(new CustomEvent('vlmsettingschanged', { detail: d.config }));
            }
        }, { signal: overlay._lifecycle.signal });

        // Signal readiness so parent immediately sends current vlm-config
        window.parent.postMessage({ type: 'vlm-iframe-ready' }, '*');

    } else {
        const iframeEl = document.getElementById('exhibit-iframe');
        if (iframeEl) {
            // Parent-portfolio mode: button hidden, model deferred until iframe loads.
            overlay._watchIframe(iframeEl);
        } else {
            // Direct-gallery mode (local testing / single-gallery deployment):
            overlay._btn.style.display = '';
            if (autoStart) manager.init();
            overlay._attachDocObservers(document);
        }
    }

    window[pageOverlayKey] = [overlay];
    return window[pageOverlayKey];
}

// Auto-init after DOM is parsed (module scripts are deferred, so DOM is ready).
if (window.VLM_MANUAL_INIT) {
    // The explicit inspector entry point initializes on demand.
} else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGalleryVLM);
} else {
    initGalleryVLM();
}

export { GalleryVLMOverlay, initGalleryVLM };
