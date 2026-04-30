/**
 * GalleryVLMOverlay.js — Instance-Aware VLM Chat UI
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
 */

import { VLMManager } from './VLMManager.js?v=11';

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
            gps = { lat: latDec, lon: lonDec };
        }

        return lines.length ? { text: lines.join('\n'), gps } : null;
    } catch (_) {
        return null;
    }
}

function _loadMarked() {
    if (_markedLoadPromise) return _markedLoadPromise;
    _markedLoadPromise = new Promise(resolve => {
        if (typeof marked !== 'undefined') { _markedReady = true; resolve(); return; }
        const s = document.createElement('script');
        s.src     = 'https://cdn.jsdelivr.net/npm/marked@13/marked.min.js';
        s.onload  = () => { _markedReady = true; resolve(); };
        s.onerror = () => resolve();   // graceful fallback — plain text
        document.head.appendChild(s);
    });
    return _markedLoadPromise;
}

function _loadKaTeX() {
    if (_katexLoadPromise) return _katexLoadPromise;
    _katexLoadPromise = new Promise(resolve => {
        if (typeof katex !== 'undefined') { _katexReady = true; resolve(); return; }
        const link  = Object.assign(document.createElement('link'), {
            rel: 'stylesheet',
            href: 'https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css',
        });
        document.head.appendChild(link);
        const s    = document.createElement('script');
        s.src      = 'https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.js';
        s.onload   = () => { _katexReady = true; resolve(); };
        s.onerror  = () => resolve();
        document.head.appendChild(s);
    });
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

// ─── CSS (injected once per page) ────────────────────────────────────────────

let _cssInjected = false;

function injectCSS() {
    if (_cssInjected) return;
    _cssInjected = true;

    const style = document.createElement('style');
    style.textContent = `
/* ── VLM Toggle Button ────────────────────────────────────────── */
.vlm-toggle-btn {
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 46px;
    height: 46px;
    border-radius: 50%;
    background: rgba(14, 14, 22, 0.92);
    border: 1px solid rgba(79, 195, 247, 0.35);
    color: #4fc3f7;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 4500;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    box-shadow: 0 2px 14px rgba(0,0,0,0.6), 0 0 0 1px rgba(79,195,247,0.12);
    transition: transform 0.18s ease, background 0.18s ease;
    padding: 0;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
}
.vlm-toggle-btn:hover  { transform: scale(1.1); background: rgba(22, 22, 38, 0.98); }
.vlm-toggle-btn:active { transform: scale(0.96); }
.vlm-toggle-btn.vlm-model-loading {
    animation: vlm-pulse-ring 1.8s ease-in-out infinite;
}
@keyframes vlm-pulse-ring {
    0%, 100% { box-shadow: 0 0 0 0 rgba(79,195,247,0.5); }
    50%       { box-shadow: 0 0 0 9px rgba(79,195,247,0); }
}

/* ── VLM Panel — full-height right sidebar ────────────────────── */
.vlm-panel {
    position: fixed;
    top: 0;
    right: 0;
    width: 360px;
    height: 100vh;
    height: 100dvh;
    max-height: none;
    display: flex;
    flex-direction: column;
    background: rgba(10, 10, 18, 0.96);
    border: none;
    border-left: 1px solid rgba(79, 195, 247, 0.2);
    border-radius: 0;
    z-index: 4500;
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    box-shadow: -4px 0 30px rgba(0,0,0,0.6), -1px 0 0 rgba(79,195,247,0.07);
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
    transform: translateX(100%);
    transition: opacity 0.22s ease, transform 0.22s ease, width 0.25s ease;
    font-family: 'Roboto', system-ui, sans-serif;
    font-size: var(--vlm-font-sz, 13px);
    color: #cfd8dc;
    will-change: transform, opacity;
    touch-action: auto;
}
.vlm-panel.vlm-open {
    opacity: 1;
    pointer-events: auto;
    transform: translateX(0);
}
/* ── Resize handle (left edge, drags to resize width) ──────────── */
.vlm-resize-handle {
    position: absolute;
    top: 0;
    left: 0;
    width: 6px;
    height: 100%;
    cursor: ew-resize;
    z-index: 2;
    opacity: 0.35;
    transition: opacity 0.15s, background 0.15s;
}
.vlm-resize-handle:hover { opacity: 0.85; background: rgba(79,195,247,0.08); }
/* Kill all transitions while dragging so the panel tracks the cursor exactly */
.vlm-panel.vlm-resizing { transition: none !important; }
.vlm-panel.vlm-resizing * { transition: none !important; }
.vlm-resize-handle::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 1px;
    transform: translateY(-50%);
    width: 3px;
    height: 36px;
    background-image:
        radial-gradient(circle, rgba(79,195,247,0.9) 1px, transparent 1px),
        radial-gradient(circle, rgba(79,195,247,0.9) 1px, transparent 1px),
        radial-gradient(circle, rgba(79,195,247,0.9) 1px, transparent 1px),
        radial-gradient(circle, rgba(79,195,247,0.9) 1px, transparent 1px),
        radial-gradient(circle, rgba(79,195,247,0.9) 1px, transparent 1px);
    background-size: 3px 8px;
    background-position: 0 0, 0 8px, 0 16px, 0 24px, 0 32px;
    background-repeat: no-repeat;
}

/* ── Header ──────────────────────────────────────────────────── */
.vlm-header {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 7px 10px;
    border-bottom: 1px solid rgba(255,255,255,0.07);
    background: rgba(79, 195, 247, 0.05);
    flex-shrink: 0;
}
.vlm-header-row {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
}
.vlm-header-btns {
    gap: 3px;
}
.vlm-header-title {
    flex: 1;
    color: #e0f7fa;
    font-size: 12.5px;
    font-weight: 500;
    letter-spacing: 0.2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.vlm-status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #ef5350;
    flex-shrink: 0;
    transition: background 0.4s;
}
.vlm-status-dot.vlm-dot-loading {
    background: #ffa726;
    animation: vlm-blink 1.1s ease-in-out infinite;
}
.vlm-status-dot.vlm-dot-ready { background: #66bb6a; }
@keyframes vlm-blink { 0%,100%{opacity:1} 50%{opacity:0.25} }

.vlm-status-label {
    color: #546e7a;
    font-size: 10.5px;
    flex-shrink: 0;
}
.vlm-new-btn, .vlm-close-btn, .vlm-fs-btn, .vlm-gear-btn {
    background: none;
    border: 1px solid rgba(255,255,255,0.1);
    color: #78909c;
    cursor: pointer;
    border-radius: 4px;
    font-size: 10px;
    padding: 1px 5px;
    line-height: 1.4;
    flex-shrink: 0;
    transition: color 0.15s, border-color 0.15s;
}
.vlm-new-btn:hover  { color: #4fc3f7; border-color: rgba(79,195,247,0.4); }
.vlm-close-btn      { font-size: 14px; padding: 0 4px; border-color: transparent; }
.vlm-close-btn:hover { color: #fff; background: rgba(255,255,255,0.08); }
.vlm-fs-btn, .vlm-gear-btn { font-size: 13px; padding: 0 4px; border-color: transparent; display: flex; align-items: center; }
.vlm-fs-btn:hover, .vlm-gear-btn:hover { color: #fff; background: rgba(255,255,255,0.08); }
.vlm-font-btns { display: flex; gap: 1px; flex-shrink: 0; }
.vlm-font-btn { background: none; border: 1px solid rgba(255,255,255,0.1); color: #78909c; cursor: pointer; border-radius: 4px; padding: 1px 4px; line-height: 1.4; transition: color 0.15s, border-color 0.15s; }
.vlm-font-btn:hover { color: #4fc3f7; border-color: rgba(79,195,247,0.4); }
.vlm-font-btn-sm { font-size: 8px; }
.vlm-font-btn-lg { font-size: 11px; }

/* ── Progress bar ─────────────────────────────────────────────── */
.vlm-progress-bar { height: 2px; background: transparent; flex-shrink: 0; }
.vlm-progress-fill {
    height: 100%;
    width: 0%;
    background: linear-gradient(90deg, #4fc3f7 0%, #7c4dff 100%);
    transition: width 0.5s ease;
    border-radius: 1px;
}

/* ── Current photo label + EXIF drawer ───────────────────────── */
.vlm-current-photo {
    display: none;
    align-items: center;
    gap: 6px;
    padding: 3px 8px 3px 12px;
    font-size: 10.5px;
    color: #546e7a;
    background: rgba(0,0,0,0.18);
    border-bottom: 1px solid rgba(255,255,255,0.05);
    flex-shrink: 0;
    min-width: 0;
}
.vlm-current-photo.vlm-has-photo { display: flex; }
.vlm-photo-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.vlm-exif-toggle {
    background: none;
    border: 1px solid rgba(255,255,255,0.1);
    color: #546e7a;
    cursor: pointer;
    border-radius: 3px;
    font-size: 9.5px;
    padding: 1px 5px;
    flex-shrink: 0;
    white-space: nowrap;
    transition: color 0.15s, border-color 0.15s;
}
.vlm-exif-toggle:hover { color: #4fc3f7; border-color: rgba(79,195,247,0.4); }
.vlm-exif-toggle.vlm-exif-open { color: #4fc3f7; border-color: rgba(79,195,247,0.35); }
.vlm-exif-bypass-btn {
    background: none;
    border: 1px solid rgba(255,255,255,0.1);
    color: #546e7a;
    cursor: pointer;
    border-radius: 3px;
    font-size: 9px;
    padding: 1px 4px;
    flex-shrink: 0;
    white-space: nowrap;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.vlm-direct-links-btn {
    background: none;
    border: 1px solid rgba(255,255,255,0.1);
    color: #546e7a;
    cursor: pointer;
    border-radius: 3px;
    font-size: 9px;
    padding: 1px 4px;
    flex-shrink: 0;
    white-space: nowrap;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.vlm-direct-links-btn:hover { color: #4fc3f7; border-color: rgba(79,195,247,0.4); }
.vlm-direct-links-btn.vlm-dl-on {
    color: #4fc3f7;
    border-color: rgba(79,195,247,0.35);
    background: rgba(79,195,247,0.08);
}
.vlm-map-embeds {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 8px;
}
.vlm-map-embeds iframe {
    width: 100%;
    border: none;
    border-radius: 6px;
    display: block;
}
.vlm-map-embeds .vlm-embed-label {
    font-size: 9.5px;
    color: #546e7a;
    margin-bottom: 2px;
}
.vlm-exif-bypass-btn:hover { color: #4fc3f7; border-color: rgba(79,195,247,0.4); }
.vlm-exif-bypass-btn.vlm-bypass-on {
    color: #4fc3f7;
    border-color: rgba(79,195,247,0.35);
    background: rgba(79,195,247,0.08);
}
.vlm-exif-drawer {
    display: none;
    padding: 6px 12px 8px;
    background: rgba(0,0,0,0.22);
    border-bottom: 1px solid rgba(255,255,255,0.05);
    flex-shrink: 0;
}
.vlm-exif-drawer.vlm-exif-open { display: block; }
.vlm-exif-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 10.5px;
}
.vlm-exif-table td {
    padding: 1px 0;
    vertical-align: top;
    line-height: 1.5;
}
.vlm-exif-table td:first-child {
    color: #455a64;
    width: 44%;
    padding-right: 8px;
    white-space: nowrap;
}
.vlm-exif-table td:last-child { color: #90a4ae; }

/* ── Messages ────────────────────────────────────────────────── */
.vlm-messages {
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 90px;
    scroll-behavior: smooth;
    touch-action: pan-y;
    -webkit-overflow-scrolling: touch;
}
.vlm-messages::-webkit-scrollbar { width: 3px; }
.vlm-messages::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,0.12);
    border-radius: 2px;
}
.vlm-empty {
    color: #37474f;
    font-size: 1em;
    text-align: center;
    padding: 16px 0;
    font-style: italic;
    user-select: none;
}
.vlm-msg {
    max-width: 93%;
    font-size: 1em;
    line-height: 1.55;
    padding: 6px 10px;
    border-radius: 8px;
    word-break: break-word;
}
.vlm-msg-user {
    align-self: flex-end;
    background: rgba(79, 195, 247, 0.12);
    color: #e0f7fa;
    border: 1px solid rgba(79, 195, 247, 0.18);
}
.vlm-msg-assistant {
    align-self: flex-start;
    background: rgba(255,255,255,0.04);
    color: #b0bec5;
    border: 1px solid rgba(255,255,255,0.07);
    white-space: pre-wrap;
}
.vlm-msg-assistant.vlm-streaming::after {
    content: '▊';
    display: inline-block;
    animation: vlm-cursor 0.7s step-end infinite;
    color: #4fc3f7;
    margin-left: 1px;
}
@keyframes vlm-cursor { 0%,100%{opacity:1} 50%{opacity:0} }

/* ── Input area ───────────────────────────────────────────────── */
.vlm-input-area {
    display: flex;
    gap: 6px;
    padding: 8px 12px;
    border-top: 1px solid rgba(255,255,255,0.07);
    flex-shrink: 0;
    align-items: flex-end;
}
.vlm-input {
    flex: 1;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 7px;
    color: #e0e0e0;
    font-size: 16px; /* 16px prevents iOS auto-zoom on focus */
    touch-action: auto;
    padding: 6px 9px;
    resize: none;
    min-height: 32px;
    max-height: 90px;
    font-family: inherit;
    outline: none;
    transition: border-color 0.18s;
    line-height: 1.45;
}
.vlm-input:focus { border-color: rgba(79, 195, 247, 0.45); }
.vlm-input::placeholder { color: #37474f; }
.vlm-send-btn {
    background: rgba(79, 195, 247, 0.13);
    border: 1px solid rgba(79, 195, 247, 0.28);
    color: #4fc3f7;
    border-radius: 7px;
    padding: 5px 11px;
    cursor: pointer;
    font-size: 1em;
    font-family: inherit;
    white-space: nowrap;
    transition: background 0.18s;
    line-height: 1.45;
    min-height: 32px;
}
.vlm-send-btn:hover:not(:disabled) { background: rgba(79, 195, 247, 0.24); }
.vlm-send-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.vlm-stop-btn {
    background: rgba(239, 83, 80, 0.12);
    border: 1px solid rgba(239, 83, 80, 0.35);
    color: #ef5350;
    border-radius: 7px;
    padding: 5px 10px;
    cursor: pointer;
    font-size: 0.95em;
    font-family: inherit;
    white-space: nowrap;
    transition: background 0.18s;
    line-height: 1.45;
    min-height: 32px;
}
.vlm-stop-btn:hover { background: rgba(239, 83, 80, 0.24); }

/* ── Voice buttons (mic / TTS) ─────────────────────────────────── */
.vlm-voice-btn {
    background: none;
    border: 1px solid rgba(255,255,255,0.1);
    color: #78909c;
    cursor: pointer;
    border-radius: 7px;
    padding: 0 9px;
    font-size: 15px;
    line-height: 1;
    min-height: 32px;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
}
.vlm-voice-btn:hover { color: #4fc3f7; border-color: rgba(79,195,247,0.4); }
.vlm-mic-btn.vlm-mic-active {
    color: #ef5350;
    border-color: rgba(239,83,80,0.4);
    background: rgba(239,83,80,0.1);
    animation: vlm-mic-pulse 1s ease-in-out infinite;
}
@keyframes vlm-mic-pulse {
    0%,100% { box-shadow: 0 0 0 0 rgba(239,83,80,0.45); }
    50%      { box-shadow: 0 0 0 6px rgba(239,83,80,0); }
}
.vlm-tts-btn.vlm-tts-on { color: #4fc3f7; border-color: rgba(79,195,247,0.35); background: rgba(79,195,247,0.08); }
.vlm-tts-btn.vlm-tts-speaking { color: #66bb6a; border-color: rgba(102,187,106,0.4); background: rgba(102,187,106,0.08); animation: vlm-blink 1.1s ease-in-out infinite; }

/* ── Live mode button ──────────────────────────────────────────── */
.vlm-live-btn {
    background: none;
    border: 1px solid rgba(255,255,255,0.1);
    color: #78909c;
    cursor: pointer;
    border-radius: 7px;
    padding: 0 9px;
    font-size: 11px;
    font-family: inherit;
    line-height: 1;
    min-height: 32px;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
    flex-shrink: 0;
    white-space: nowrap;
}
.vlm-live-btn:hover { color: #ef5350; border-color: rgba(239,83,80,0.4); }
.vlm-live-btn.vlm-live-on {
    color: #ef5350;
    border-color: rgba(239,83,80,0.4);
    background: rgba(239,83,80,0.08);
    animation: vlm-mic-pulse 1.5s ease-in-out infinite;
}

/* ── TTS caption bar (shows current spoken sentence + word highlight) */
.vlm-tts-bar {
    display: none;
    padding: 4px 12px 5px;
    font-size: 11px;
    color: #78909c;
    background: rgba(79,195,247,0.04);
    border-top: 1px solid rgba(79,195,247,0.1);
    line-height: 1.5;
    flex-shrink: 0;
    max-height: 60px;
    overflow: hidden;
}
.vlm-tts-bar.vlm-tts-bar-on { display: block; }
.vlm-tts-hl {
    background: rgba(79,195,247,0.25);
    border-radius: 2px;
    color: #b2ebf2;
    padding: 0 1px;
}

/* ── Per-message copy button ───────────────────────────────────── */
.vlm-msg-copy {
    display: block;
    margin-top: 7px;
    background: none;
    border: 1px solid rgba(79,195,247,0.18);
    border-radius: 5px;
    color: #546e7a;
    font-size: 0.74em;
    padding: 2px 8px;
    cursor: pointer;
    font-family: inherit;
    transition: color 0.15s, border-color 0.15s;
    width: fit-content;
}
.vlm-msg-copy:hover { color: #4fc3f7; border-color: rgba(79,195,247,0.45); }

/* ── Chat-level action bar (Copy Chat / Export Log) ────────────── */
.vlm-chat-actions {
    display: flex;
    gap: 6px;
    padding: 5px 10px;
    border-top: 1px solid rgba(79,195,247,0.1);
    flex-shrink: 0;
}
.vlm-action-btn {
    background: rgba(79,195,247,0.07);
    border: 1px solid rgba(79,195,247,0.18);
    border-radius: 6px;
    color: #78909c;
    font-size: 0.76em;
    padding: 3px 9px;
    cursor: pointer;
    font-family: inherit;
    transition: color 0.15s, background 0.15s;
}
.vlm-action-btn:hover { color: #4fc3f7; background: rgba(79,195,247,0.15); }

/* ── Responsive / Mobile — bottom sheet ───────────────────────── */
@media (max-width: 600px) {
    .vlm-panel {
        width: 100% !important;
        left: 0;
        right: 0;
        top: auto;
        bottom: 0;
        height: auto;
        max-height: 75vh;
        max-height: 75dvh;  /* dynamic viewport height — handles toolbars + keyboard */
        padding-bottom: env(safe-area-inset-bottom, 0px);
        border-left: none;
        border-top: 1px solid rgba(79, 195, 247, 0.2);
        border-radius: 16px 16px 0 0;
        box-shadow: 0 -4px 30px rgba(0,0,0,0.6);
        transform: translateY(12px);
        transition: transform 0.25s ease, opacity 0.22s ease;
    }
    .vlm-panel.vlm-open { transform: translateY(0); }
    .vlm-panel.vlm-dragging { transition: none; }
    .vlm-resize-handle  { display: none; }
    .vlm-toggle-btn {
        bottom: calc(20px + env(safe-area-inset-bottom, 0px));
        right: 20px !important;
        width: 52px;
        height: 52px;
    }
    /* Header is the drag handle — hint to users with cursor + tiny grab tab */
    .vlm-header { cursor: grab; touch-action: none; position: relative; }
    .vlm-header::before {
        content: '';
        position: absolute;
        top: 6px; left: 50%;
        transform: translateX(-50%);
        width: 36px; height: 4px;
        background: rgba(255,255,255,0.18);
        border-radius: 2px;
    }
    /* Sticky composer: input row pinned to bottom of the sheet so the
       send/stop buttons never disappear under the virtual keyboard. */
    .vlm-input-row {
        position: sticky;
        bottom: 0;
        z-index: 2;
        padding-bottom: max(8px, env(safe-area-inset-bottom));
        background: rgba(10, 10, 18, 0.96);
        -webkit-backdrop-filter: blur(18px);
        backdrop-filter: blur(18px);
    }
}

/* ── Download progress track (inside stage 2) ────────────────── */
.vlm-dl-track {
    display: none;
    margin-top: 5px;
}
.vlm-dl-track.vlm-dl-active { display: block; }
.vlm-dl-bar-bg {
    position: relative;
    height: 6px;
    background: rgba(255,255,255,0.06);
    border-radius: 3px;
    overflow: hidden;
}
.vlm-dl-bar-fill {
    height: 100%;
    width: 0%;
    background: linear-gradient(90deg, #0288d1, #4fc3f7);
    border-radius: 3px;
    transition: width 0.35s ease;
}
.vlm-dl-totals {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-top: 3px;
    font-size: 10px;
    color: #546e7a;
}
.vlm-dl-totals .vlm-dl-mb  { color: #78909c; }
.vlm-dl-totals .vlm-dl-pct { color: #4fc3f7; font-weight: 500; }
.vlm-dl-file {
    margin-top: 2px;
    font-size: 9.5px;
    color: #37474f;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

/* ── Loading Stage Panel ──────────────────────────────────────── */
.vlm-loading-section {
    padding: 10px 14px 6px;
    display: flex;
    flex-direction: column;
    gap: 9px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    flex-shrink: 0;
    transition: opacity 0.4s ease;
}
.vlm-loading-section.vlm-stages-done { display: none; }
.vlm-stage-row {
    display: flex;
    align-items: flex-start;
    gap: 9px;
}
.vlm-stage-icon {
    width: 16px;
    flex-shrink: 0;
    font-size: 13px;
    margin-top: 1px;
    text-align: center;
    transition: color 0.2s;
}
.vlm-stage-icon.pending { color: #37474f; }
.vlm-stage-icon.active  { color: #ffa726; animation: vlm-stage-spin 1s linear infinite; display: inline-block; }
.vlm-stage-icon.done    { color: #66bb6a; }
.vlm-stage-icon.error   { color: #ef5350; }
@keyframes vlm-stage-spin { to { transform: rotate(360deg); } }
.vlm-stage-body { flex: 1; overflow: hidden; }
.vlm-stage-name {
    font-size: 12px;
    color: #546e7a;
    transition: color 0.2s;
}
.vlm-stage-name.active { color: #e0f7fa; font-weight: 500; }
.vlm-stage-name.done   { color: #78909c; }
.vlm-stage-detail {
    font-size: 10.5px;
    color: #37474f;
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: monospace;
    transition: color 0.2s;
}
.vlm-stage-detail.active { color: #546e7a; }
.vlm-stage-hint {
    font-size: 10px;
    color: #263238;
    padding-top: 2px;
    font-style: italic;
}

/* ── Expanded (wider panel) ────────────────────────────────────── */
.vlm-panel.vlm-fullscreen {
    width: min(680px, 50vw) !important;
}
.vlm-panel.vlm-fullscreen.vlm-open { transform: translateX(0) !important; }

/* ── Iframe-panel mode: fills the host iframe viewport ────────── */
.vlm-panel.vlm-iframe-mode {
    position: fixed;
    inset: 0;
    width: 100% !important;
    transform: none !important;
    opacity: 1 !important;
    pointer-events: auto !important;
    border-left: none;
    z-index: 1;
}
.vlm-panel.vlm-iframe-mode .vlm-resize-handle { display: none; }

/* ── Per-message generation stats bar ────────────────────────── */
.vlm-msg-text { display: block; white-space: pre-wrap; word-break: break-word; }

/* ── Markdown-rendered assistant messages ────────────────────── */
.vlm-msg-text.vlm-md { white-space: normal; }
.vlm-msg-text.vlm-md > p { margin: 0 0 6px; }
.vlm-msg-text.vlm-md > p:last-child { margin-bottom: 0; }
.vlm-msg-text.vlm-md h1,
.vlm-msg-text.vlm-md h2,
.vlm-msg-text.vlm-md h3 { color: #e0f7fa; font-size: 13px; font-weight: 600; margin: 8px 0 4px; }
.vlm-msg-text.vlm-md code {
    background: rgba(255,255,255,0.08);
    padding: 1px 5px; border-radius: 3px;
    font-family: monospace; font-size: 11px;
}
.vlm-msg-text.vlm-md pre {
    background: rgba(0,0,0,0.35); padding: 8px 10px; border-radius: 5px;
    overflow-x: auto; margin: 6px 0;
}
.vlm-msg-text.vlm-md pre code { background: none; padding: 0; white-space: pre; }
.vlm-msg-text.vlm-md ul,
.vlm-msg-text.vlm-md ol { margin: 4px 0 4px 16px; padding: 0; }
.vlm-msg-text.vlm-md li { margin: 2px 0; }
.vlm-msg-text.vlm-md strong { color: #e0f7fa; font-weight: 600; }
.vlm-msg-text.vlm-md em { font-style: italic; }
.vlm-msg-text.vlm-md blockquote {
    border-left: 2px solid rgba(79,195,247,0.4);
    margin: 6px 0; padding: 0 0 0 10px; color: #78909c;
}
.vlm-msg-text.vlm-md a { color: #4fc3f7; text-decoration: underline; }
.vlm-msg-text.vlm-md hr { border: none; border-top: 1px solid rgba(255,255,255,0.1); margin: 8px 0; }
/* KaTeX dark-theme tweak */
.vlm-msg-text.vlm-md .katex { color: #e0f7fa; font-size: 1em; }
.vlm-msg-text.vlm-md .katex-display { overflow-x: auto; margin: 8px 0; }

/* ── Thinking block (Ollama extended thinking) ───────────────────── */
.vlm-thinking {
    margin-bottom: 5px;
    border: 1px solid rgba(79,195,247,0.12);
    border-radius: 6px;
    overflow: hidden;
    background: rgba(79,195,247,0.03);
}
.vlm-thinking summary {
    cursor: pointer;
    padding: 4px 8px;
    font-size: 10.5px;
    color: #546e7a;
    user-select: none;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 5px;
}
.vlm-thinking summary::-webkit-details-marker { display: none; }
.vlm-thinking summary::before {
    content: '▶';
    font-size: 7px;
    transition: transform 0.15s;
    flex-shrink: 0;
}
.vlm-thinking[open] summary::before { transform: rotate(90deg); }
.vlm-thinking-text {
    padding: 5px 8px 7px;
    font-size: 10.5px;
    color: #455a64;
    white-space: pre-wrap;
    word-break: break-word;
    border-top: 1px solid rgba(79,195,247,0.08);
    max-height: 180px;
    overflow-y: auto;
}
.vlm-thinking-text.vlm-md       { white-space: normal; }
.vlm-thinking-text.vlm-md > p   { margin: 0 0 4px; }
.vlm-thinking-text.vlm-md ul,
.vlm-thinking-text.vlm-md ol    { margin: 3px 0 3px 14px; padding: 0; }
.vlm-thinking-text.vlm-md code  { background: rgba(255,255,255,0.06); padding: 0 3px; border-radius: 3px; font-size: 10px; }
.vlm-thinking-text.vlm-md pre   { background: rgba(0,0,0,0.3); padding: 5px 7px; border-radius: 4px; overflow-x: auto; font-size: 10px; margin: 4px 0; }
.vlm-thinking-text.vlm-md .katex { font-size: 0.95em; }
.vlm-thinking-text.vlm-md h1,
.vlm-thinking-text.vlm-md h2,
.vlm-thinking-text.vlm-md h3    { font-size: 1em; margin: 4px 0 2px; font-weight: 600; }

.vlm-gen-stats {
    margin-top: 5px;
    font-size: 10px;
    font-family: monospace;
    color: #ffa726;
    letter-spacing: 0.2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.vlm-gen-stats.vlm-gen-stats-done { color: #546e7a; }
    `;
    document.head.appendChild(style);
}

// ─── System Prompts ───────────────────────────────────────────────────────────

const _GALLERY_SYSTEM_PROMPT =
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
    'You are an AI assistant in a live voice conversation about a photograph. ' +
    'Keep every reply to 2–3 sentences maximum — you are being read aloud. ' +
    'Be direct and conversational. No lists, no headings, no markdown. ' +
    'Do not mention, guess, or estimate camera settings unless explicitly asked.';

const _ABOUT_SYSTEM_PROMPT =
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
        this._imageExif        = null;   // EXIF text string for the current image, or null
        this._imageGps         = null;   // { lat, lon } signed decimals, or null
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
        this._dlMaxPct         = 0;     // monotonic download progress (never decreases)
        this._exifBypass       = localStorage.getItem('vlm-exif-bypass') !== 'off'; // default on
        this._directLinks      = localStorage.getItem('vlm-direct-links') === 'on'; // default off (embeds)
        this._iframeMode       = window.VLM_PANEL_MODE === true;  // running inside vlm/panel.html
        this._galleryOpen      = false;  // tracks gallery state in iframe mode
        // User-editable system prompt override (empty = use built-in default)
        this._customSystemPrompt = window.VLM_SETTINGS?.systemPrompt ?? '';
        // Default system prompt for API / Ollama modes (gallery context)
        manager.setSystemPrompt(this._baseSystemPrompt());

        // Voice I/O state
        this._ttsEnabled = localStorage.getItem('vlm-tts') === 'on';
        this._sttActive  = false;
        this._stt        = null;
        this._liveMode         = false;
        this._ttsBuf           = '';
        this._ttsPending       = 0;   // number of utterances queued or playing
        this._activeTTSTextEl  = null;
        this._ttsHLMark        = null;

        this._buildUI();
        this._bindManagerEvents();
        this._bindSettingsEvents();
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
        this._stt.onresult = (e) => {
            let interim = '', final = '';
            for (const r of e.results) {
                if (r.isFinal) final += r[0].transcript;
                else interim += r[0].transcript;
            }
            input.value = final || interim;
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 90) + 'px';
            this._refreshSendBtn();
        };
        this._stt.onend = () => {
            this._sttActive = false;
            micBtn.classList.remove('vlm-mic-active');
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
        localStorage.setItem('vlm-tts', this._ttsEnabled ? 'on' : 'off');
        const btn = this._q('-tts');
        btn.classList.toggle('vlm-tts-on', this._ttsEnabled);
        btn.textContent = this._ttsEnabled ? '🔊' : '🔇';
        btn.title = this._ttsEnabled ? 'Read aloud: on (click to stop)' : 'Read aloud: off';
    }

    _selectedVoice() {
        const uri = localStorage.getItem('vlm-voice-uri');
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
        const btn = this._q('-live');
        btn.classList.toggle('vlm-live-on', this._liveMode);
        btn.title = this._liveMode ? 'Live mode on — click to stop' : 'Live conversation mode';
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
                localStorage.setItem('vlm-tts', 'on');
                const ttsBtn = this._q('-tts');
                ttsBtn.classList.add('vlm-tts-on');
                ttsBtn.textContent = '🔊';
                ttsBtn.title = 'Read aloud: on (click to stop)';
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
        utt.rate = parseFloat(localStorage.getItem('vlm-voice-speed') ?? '1');
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
        // ── Toggle button ──────────────────────────────────────────────────
        this._btn = document.createElement('button');
        this._btn.className = 'vlm-toggle-btn vlm-model-loading';
        this._btn.title     = 'TheDoInspector';
        this._btn.setAttribute('aria-label', 'Toggle TheDoInspector panel');
        // Magnifying-glass icon — inline single-path, no multi-line d attributes
        this._btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>';
        this._btn.style.display = 'none';   // hidden until a gallery iframe loads
        this._btn.addEventListener('click', () => this._togglePanel());
        document.body.appendChild(this._btn);

        // Cut TTS and STT on page unload so audio never bleeds through a refresh
        window.addEventListener('beforeunload', () => {
            window.speechSynthesis?.cancel();
            this._stt?.stop();
        }, { once: true });

        // ── Panel ──────────────────────────────────────────────────────────
        this._panel = document.createElement('div');
        this._panel.className = 'vlm-panel';
        this._panel.setAttribute('role', 'dialog');
        this._panel.setAttribute('aria-label', 'TheDoInspector');
        this._panel.innerHTML = `
<div class="vlm-resize-handle" aria-hidden="true"></div>
<div class="vlm-header">
    <div class="vlm-header-row">
        <span class="vlm-header-title">TheDoInspector</span>
        <span class="vlm-status-dot vlm-dot-loading" id="${this._id}-dot"></span>
        <span class="vlm-status-label" id="${this._id}-status">Loading model…</span>
        <button class="vlm-gear-btn"  id="${this._id}-gear"  title="VLM Settings" aria-label="Open VLM settings"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
        <button class="vlm-fs-btn"    id="${this._id}-fs"    title="Expand panel" aria-label="Toggle fullscreen"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg></button>
        <button class="vlm-close-btn" id="${this._id}-close" title="Close panel" aria-label="Close">×</button>
    </div>
    <div class="vlm-header-row vlm-header-btns">
        <button class="vlm-new-btn" id="${this._id}-new" title="Start new conversation">New</button>
        <div class="vlm-font-btns" title="Adjust font size">
            <button class="vlm-font-btn vlm-font-btn-sm" id="${this._id}-font-dn" aria-label="Decrease font size">A−</button>
            <button class="vlm-font-btn vlm-font-btn-lg" id="${this._id}-font-up" aria-label="Increase font size">A+</button>
        </div>
        <button class="vlm-exif-bypass-btn vlm-bypass-on" id="${this._id}-bypass"
                title="EXIF auto-answer ON — camera/settings questions answered directly from metadata. Click to let the VLM answer instead."
                aria-label="Toggle EXIF auto-answer">EXIF auto</button>
        <button class="vlm-direct-links-btn${this._directLinks ? ' vlm-dl-on' : ''}" id="${this._id}-dlbtn"
                title="${this._directLinks ? 'Direct links ON — maps shown as links. Click to show as embeds.' : 'Direct links OFF — maps shown as embeds. Click to use plain links.'}"
                aria-label="Toggle map embeds">Direct links</button>
    </div>
</div>
<div class="vlm-progress-bar">
    <div class="vlm-progress-fill" id="${this._id}-prog"></div>
</div>
<div class="vlm-current-photo" id="${this._id}-imgname">
    <span class="vlm-photo-name" id="${this._id}-photoname"></span>
    <button class="vlm-exif-toggle" id="${this._id}-exif-toggle" style="display:none">EXIF</button>
</div>
<div class="vlm-exif-drawer" id="${this._id}-exif-drawer"></div>

<!-- Loading stage panel — visible until model is ready -->
<div class="vlm-loading-section" id="${this._id}-loading">
    <div class="vlm-stage-row" id="${this._id}-s1">
        <span class="vlm-stage-icon pending" id="${this._id}-s1i">○</span>
        <div class="vlm-stage-body">
            <div class="vlm-stage-name" id="${this._id}-s1n">Processor &amp; tokenizer</div>
            <div class="vlm-stage-detail" id="${this._id}-s1d"></div>
        </div>
    </div>
    <div class="vlm-stage-row" id="${this._id}-s2">
        <span class="vlm-stage-icon pending" id="${this._id}-s2i">○</span>
        <div class="vlm-stage-body">
            <div class="vlm-stage-name" id="${this._id}-s2n">Model weights</div>
            <div class="vlm-stage-detail" id="${this._id}-s2d">Waiting…</div>
            <div class="vlm-dl-track" id="${this._id}-dltrack">
                <div class="vlm-dl-bar-bg">
                    <div class="vlm-dl-bar-fill" id="${this._id}-dlbar"></div>
                </div>
                <div class="vlm-dl-totals">
                    <span class="vlm-dl-mb"  id="${this._id}-dlmb"></span>
                    <span class="vlm-dl-pct" id="${this._id}-dlpct"></span>
                </div>
                <div class="vlm-dl-file" id="${this._id}-dlfile"></div>
            </div>
        </div>
    </div>
    <div class="vlm-stage-row" id="${this._id}-s3">
        <span class="vlm-stage-icon pending" id="${this._id}-s3i">○</span>
        <div class="vlm-stage-body">
            <div class="vlm-stage-name" id="${this._id}-s3n">ONNX runtime init</div>
            <div class="vlm-stage-detail" id="${this._id}-s3d"></div>
        </div>
    </div>
    <div class="vlm-stage-hint">First load downloads ~300 MB. Runtime ops compile in the background — first query may take a moment longer.</div>
</div>

<div class="vlm-messages" id="${this._id}-msgs">
    <div class="vlm-empty">Open a photo, then ask anything about it.</div>
</div>
<div class="vlm-chat-actions" id="${this._id}-chat-actions" style="display:none">
    <button class="vlm-action-btn" id="${this._id}-copy-chat">&#128203; Copy Chat</button>
    <button class="vlm-action-btn" id="${this._id}-export-log">&#128229; Export Log</button>
</div>
<div class="vlm-tts-bar" id="${this._id}-tts-bar"></div>
<div class="vlm-input-area">
    <textarea class="vlm-input" id="${this._id}-input" rows="1"
        placeholder="What camera settings? What's the subject? …"
        aria-label="Ask about the photo"></textarea>
    <button class="vlm-voice-btn vlm-mic-btn" id="${this._id}-mic" title="Voice input" style="display:none">🎤</button>
    <button class="vlm-voice-btn vlm-tts-btn" id="${this._id}-tts" title="Read aloud: off">🔇</button>
    <button class="vlm-live-btn" id="${this._id}-live" title="Live conversation mode" style="display:none">⏺ Live</button>
    <button class="vlm-stop-btn" id="${this._id}-stop" style="display:none">&#9632; Stop</button>
    <button class="vlm-send-btn" id="${this._id}-send" disabled>Send</button>
</div>`;
        document.body.appendChild(this._panel);

        // ── Panel event wiring ─────────────────────────────────────────────
        this._q('-close').addEventListener('click',    () => this._closePanel());
        this._q('-new').addEventListener('click',      () => this._newChat());
        this._q('-fs').addEventListener('click',       () => this._toggleFullscreen());

        // Mobile drag-to-dismiss: pulldown on the header closes the bottom sheet.
        this._initHeaderDrag();
        this._q('-gear').addEventListener('click',     () => this._openSettings());
        this._q('-font-dn').addEventListener('click',  () => this._changeFontSize(-1));
        this._q('-font-up').addEventListener('click',  () => this._changeFontSize(+1));
        this._q('-exif-toggle').addEventListener('click', () => {
            const btn    = this._q('-exif-toggle');
            const drawer = this._q('-exif-drawer');
            const open   = drawer.classList.toggle('vlm-exif-open');
            btn.classList.toggle('vlm-exif-open', open);
        });
        this._q('-bypass').addEventListener('click', () => {
            this._exifBypass = !this._exifBypass;
            localStorage.setItem('vlm-exif-bypass', this._exifBypass ? 'on' : 'off');
            const btn = this._q('-bypass');
            btn.classList.toggle('vlm-bypass-on', this._exifBypass);
            btn.title = this._exifBypass
                ? 'EXIF auto-answer ON — camera/settings questions answered directly from metadata. Click to let the VLM answer instead.'
                : 'EXIF auto-answer OFF — camera/settings questions answered by the VLM using injected metadata. Click to restore direct answers.';
        });
        this._q('-dlbtn').addEventListener('click', () => {
            this._directLinks = !this._directLinks;
            localStorage.setItem('vlm-direct-links', this._directLinks ? 'on' : 'off');
            const btn = this._q('-dlbtn');
            btn.classList.toggle('vlm-dl-on', this._directLinks);
            btn.title = this._directLinks
                ? 'Direct links ON — maps shown as links. Click to show as embeds.'
                : 'Direct links OFF — maps shown as embeds. Click to use plain links.';
        });

        // Restore saved font size
        const saved = localStorage.getItem('vlm-font-sz');
        if (saved) this._panel.style.setProperty('--vlm-font-sz', saved);

        this._initResize();

        // Re-sync layout vars when the window crosses the 600px push/sheet boundary
        // or when desktop layout otherwise resizes. Uses _setPush so all the
        // inner-iframe propagation runs through one path.
        const winResize = () => {
            if (this._panel.classList.contains('vlm-open')) {
                this._setPush(true);
            } else if (window.innerWidth <= 600) {
                // Ensure no stale var is left over after closing on mobile
                document.documentElement.style.setProperty('--vlm-pane-width', '0px');
                if (this._iframeDoc?.documentElement) {
                    this._iframeDoc.documentElement.style.setProperty('--vlm-pane-width', '0px');
                }
            }
        };
        window.addEventListener('resize', winResize);
        this._observers.push({ disconnect: () => window.removeEventListener('resize', winResize) });

        const sendBtn = this._q('-send');
        const input   = this._q('-input');

        sendBtn.addEventListener('click',   () => {
            if (navigator.vibrate) try { navigator.vibrate(8); } catch (_) {}
            this._sendMessage();
        });
        this._q('-stop').addEventListener('click', () => { this._abortController?.abort(); this._stopTTS(); });
        this._q('-mic').addEventListener('click',  () => this._toggleSTT());
        this._q('-tts').addEventListener('click',  () => this._toggleTTS());
        this._q('-live').addEventListener('click', () => this._toggleLiveMode());
        // Show mic/live buttons only when SpeechRecognition is available
        if (window.SpeechRecognition || window.webkitSpeechRecognition) {
            this._q('-mic').style.display = '';
            if (window.speechSynthesis) this._q('-live').style.display = '';
        }
        // Restore TTS button state
        if (this._ttsEnabled) {
            const ttsBtn = this._q('-tts');
            ttsBtn.classList.add('vlm-tts-on');
            ttsBtn.textContent = '🔊';
            ttsBtn.title = 'Read aloud: on (click to stop)';
        }
        this._q('-copy-chat').addEventListener('click', () => this._copyChat());
        this._q('-export-log').addEventListener('click', () => this._exportLog());
        // stopPropagation on all keyboard events so typing in the chat never
        // triggers the gallery's own keyboard shortcuts (arrow keys, escape, etc.)
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._sendMessage(); }
        });
        input.addEventListener('keyup',    (e) => e.stopPropagation());
        input.addEventListener('keypress', (e) => e.stopPropagation());
        input.addEventListener('input', () => {
            // Auto-grow textarea up to max-height
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 90) + 'px';
            this._refreshSendBtn();
        });

        // ── Virtual-keyboard lift (iOS / Android) ──────────────────────────
        // When the on-screen keyboard appears the visual viewport shrinks.
        // Shift the panel up so it sits just above the keyboard.
        if (window.visualViewport) {
            const vvHandler = () => {
                // Bottom adjustment only applies to the mobile bottom-sheet layout
                if (window.innerWidth > 600) return;
                if (!this._panel.classList.contains('vlm-open')) return;
                const kbHeight = window.innerHeight - window.visualViewport.height;
                this._panel.style.bottom = kbHeight > 50 ? `${kbHeight + 8}px` : '';
            };
            window.visualViewport.addEventListener('resize', vvHandler);
            window.visualViewport.addEventListener('scroll', vvHandler);
            this._observers.push({ disconnect: () => {
                window.visualViewport.removeEventListener('resize', vvHandler);
                window.visualViewport.removeEventListener('scroll', vvHandler);
            }});
        }
    }

    /** Shorthand: query by id suffix within this panel. */
    _q(suffix) {
        return document.getElementById(`${this._id}${suffix}`);
    }

    // ── Panel State ────────────────────────────────────────────────────────

    _togglePanel() {
        const open = this._panel.classList.toggle('vlm-open');
        this._setPush(open);
    }
    _closePanel() {
        this._panel.classList.remove('vlm-open');
        this._setPush(false);
    }

    /**
     * Push the page content left when the sidebar opens (desktop only).
     * Strategy: write a `--vlm-pane-width` CSS variable on the document root.
     * Gallery CSS uses `right: var(--vlm-pane-width)` on full-viewport fixed
     * elements so the canvas / grid / overlays shrink alongside the panel.
     * The home page's `.iframe-container` uses the same var so iframe-mode
     * galleries shrink with their wrapper. About / direct-gallery pages also
     * fall back to body.paddingRight for normal-flow content.
     */
    _setPush(open) {
        if (window.innerWidth <= 600) {
            // Mobile bottom-sheet: never push; clear any leftover state.
            document.documentElement.style.setProperty('--vlm-pane-width', '0px');
            document.body.style.paddingRight = '';
            this._btn.style.right = '';
            return;
        }
        const w = open ? this._panel.offsetWidth : 0;
        // Shift the toggle button to sit just outside the panel's left edge
        this._btn.style.transition = 'right 0.22s ease';
        this._btn.style.right = open ? `${w + 12}px` : '';
        // Parent doc only — drives .iframe-container's `right: var(...)` so
        // the iframe element flexes to (viewport - panel) width. The gallery
        // INSIDE the iframe stays unchanged: its own `window.innerWidth`
        // already reflects the iframe's new size, so its `width: 100%`
        // canvases fill the iframe correctly.
        document.documentElement.style.setProperty('--vlm-pane-width', `${w}px`);
        // For about / direct-gallery pages where there's no wrapper iframe,
        // push body content via padding so normal-flow children shift.
        if (!this._iframeEl) {
            document.body.style.transition = 'padding-right 0.25s ease';
            document.body.style.paddingRight = open ? `${w}px` : '';
        }
        // Fire a resize event into the inner iframe so its three.js + 2D grid
        // pick up the new viewport. (window.innerWidth inside the iframe
        // already reflects the smaller box; the resize event just nudges
        // listeners to re-read it.)
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
        setTimeout(fire, 240);
    }

    _toggleFullscreen() {
        const isFs = this._panel.classList.toggle('vlm-fullscreen');
        const btn  = this._q('-fs');
        if (isFs) {
            btn.title = 'Narrow panel';
            btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>';
        } else {
            btn.title = 'Expand panel';
            btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
        }
        // Re-sync body push after CSS transition settles
        if (this._panel.classList.contains('vlm-open')) {
            setTimeout(() => this._setPush(true), 260);
        }
    }

    /** Open the main settings modal and scroll to the VLM section. */
    _openSettings() {
        const settingsBtn = document.getElementById('btn-open-settings')
            ?? document.getElementById('settings-btn')
            ?? document.querySelector('.settings-toggle, [data-target="settings"]');
        if (!settingsBtn) return;
        settingsBtn.click();
        // Scroll the VLM section into view after the modal animates in
        setTimeout(() => {
            const vlmSection = document.getElementById('select-vlm-backend')
                ?? document.getElementById('vlm-backend-row')
                ?? document.querySelector('[id^="vlm-"]');
            vlmSection?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 120);
    }

    /**
     * Step font size up (+1) or down (−1) through a fixed scale.
     * Persists the choice to localStorage so it survives page reloads.
     */
    _changeFontSize(dir) {
        const sizes = [10, 11, 12, 13, 14, 15, 16, 18];
        const cur = parseFloat(
            getComputedStyle(this._panel).getPropertyValue('--vlm-font-sz') || '13'
        );
        const idx  = sizes.reduce((best, s, i) =>
            Math.abs(s - cur) < Math.abs(sizes[best] - cur) ? i : best, 0);
        const next = sizes[Math.max(0, Math.min(sizes.length - 1, idx + dir))];
        const val  = `${next}px`;
        this._panel.style.setProperty('--vlm-font-sz', val);
        localStorage.setItem('vlm-font-sz', val);
    }

    /**
     * Mobile bottom-sheet: drag the header downward to dismiss the panel.
     * Active only when window <= 600 px (matches the bottom-sheet media query)
     * and only when the panel is open. Translates the panel during drag,
     * commits a close above 100 px of pull, snaps back otherwise.
     */
    _initHeaderDrag() {
        const header = this._panel?.querySelector('.vlm-header');
        if (!header) return;
        let startY = 0;
        let dragging = false;
        // Ignore drags that start on a header button (close/fs/font-up etc.)
        const isInteractive = (el) => !!el?.closest('button, a, input, [role="button"]');

        header.addEventListener('pointerdown', (e) => {
            if (window.innerWidth > 600) return;
            if (!this._panel.classList.contains('vlm-open')) return;
            if (isInteractive(e.target)) return;
            if (e.button != null && e.button !== 0) return;
            startY = e.clientY;
            dragging = true;
            this._panel.classList.add('vlm-dragging');
            try { header.setPointerCapture(e.pointerId); } catch (_) {}
        });
        header.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const dy = e.clientY - startY;
            if (dy <= 0) {
                this._panel.style.transform = '';
            } else {
                this._panel.style.transform = `translateY(${dy}px)`;
            }
        });
        const endHeaderDrag = (e) => {
            if (!dragging) return;
            dragging = false;
            this._panel.classList.remove('vlm-dragging');
            const dy = (e?.clientY ?? startY) - startY;
            this._panel.style.transform = '';
            if (e?.pointerId != null) { try { header.releasePointerCapture(e.pointerId); } catch (_) {} }
            if (dy > 100) {
                if (navigator.vibrate) try { navigator.vibrate(15); } catch (_) {}
                this._closePanel();
            }
        };
        header.addEventListener('pointerup', endHeaderDrag);
        header.addEventListener('pointercancel', endHeaderDrag);
    }

    /**
     * Wire up the top-left resize handle so the user can drag the panel to any
     * size.  Dragging leftward / upward expands; rightward / downward shrinks.
     * Disabled while the panel is in fullscreen mode.
     */
    _initResize() {
        const handle = this._panel.querySelector('.vlm-resize-handle');
        if (!handle) return;

        let startX, startY, startW, startH;
        let dragging    = false;
        let cursorStyle = null;

        const startDrag = (clientX, clientY) => {
            startX   = clientX; startY = clientY;
            startW   = this._panel.offsetWidth;
            startH   = this._panel.offsetHeight;
            dragging = true;
            this._panel.classList.add('vlm-resizing');
            // Inject a global style so the cursor stays nw-resize even when the
            // pointer outruns the handle, and selection is suppressed everywhere.
            cursorStyle = document.createElement('style');
            cursorStyle.textContent = '* { cursor: ew-resize !important; user-select: none !important; }';
            document.head.appendChild(cursorStyle);
        };

        const onMove = (clientX, _clientY) => {
            if (!dragging) return;
            const dx = startX - clientX;   // drag left = positive = wider
            const w  = Math.max(280, Math.min(window.innerWidth - 40, startW + dx));
            if (this._iframeMode) {
                // In iframe mode the panel fills the iframe — resize by telling parent to
                // adjust the VLM iframe column width via --vlm-pane-width.
                if (window.innerWidth > 600) {
                    window.parent.postMessage({ type: 'vlm-resize', width: w }, '*');
                }
                return;
            }
            this._panel.style.width = `${w}px`;
            // Drive the parent doc's var — iframe-container shrinks via CSS,
            // the iframe element flexes with it.
            if (window.innerWidth > 600 && this._panel.classList.contains('vlm-open')) {
                document.documentElement.style.setProperty('--vlm-pane-width', `${w}px`);
                if (!this._iframeEl) document.body.style.paddingRight = `${w}px`;
                this._btn.style.right = `${w + 12}px`;
            }
        };

        const endDrag = (e) => {
            if (!dragging) return;
            dragging = false;
            if (e?.pointerId != null) {
                try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
            }
            this._panel.classList.remove('vlm-resizing');
            if (cursorStyle) { cursorStyle.remove(); cursorStyle = null; }
            // Final renderer/grid sync after the user releases the handle
            if (this._panel.classList.contains('vlm-open')) this._fireInnerResize();
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
            startDrag(e.clientX, e.clientY);
        });

        handle.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            onMove(e.clientX, e.clientY);  // clientY unused but kept for signature parity
        });

        handle.addEventListener('pointerup',     (e) => endDrag(e));
        handle.addEventListener('pointercancel', (e) => endDrag(e));

        // Safety net: end drag when window loses focus (e.g. Alt-Tab mid-drag)
        window.addEventListener('blur', () => endDrag());
    }

    _newChat() {
        this._abortController?.abort();  // cancel any in-flight API request
        this._generation++;              // invalidate any in-flight callbacks
        this._history   = [];
        this._streaming = false;         // abandon any streaming state
        _setVlmRunning(false);
        this._liveMode  = false;
        this._q('-live')?.classList.remove('vlm-live-on');
        this._stopTTS();
        this.manager.setSystemPrompt(this._buildSystemPrompt());
        const msgs = this._q('-msgs');
        msgs.innerHTML = '<div class="vlm-empty">Open a photo, then ask anything about it.</div>';
        this._q('-chat-actions').style.display = 'none';
        this._refreshSendBtn();
    }

    _refreshSendBtn() {
        const input   = this._q('-input');
        const sendBtn = this._q('-send');
        const stopBtn = this._q('-stop');
        sendBtn.disabled = (
            !this._imageSrc          ||
            !input.value.trim()      ||
            !this.manager.isReady    ||
            this._streaming
        );
        if (stopBtn) stopBtn.style.display = this._streaming ? '' : 'none';
        // Live mode: restart mic once generation ends, but only if TTS is not playing
        if (this._liveMode && !this._streaming && !this._sttActive && this._ttsPending === 0)
            this._toggleSTT();
    }

    _copyChat() {
        if (!this._history.length) return;
        const lines = this._history.map(turn => {
            const label = turn.role === 'user' ? 'You' : 'Assistant';
            return `${label}:\n${turn.content}`;
        });
        navigator.clipboard.writeText(lines.join('\n\n')).then(() => {
            const btn = this._q('-copy-chat');
            const orig = btn.textContent;
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = orig; }, 1500);
        }).catch(() => {});
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
        // The button and panel are created in document.body, but #iframe-container
        // has `transform: translateY() translateZ(0)` which creates a GPU
        // compositing layer. On iOS Safari and some Android browsers, position:fixed
        // elements that live OUTSIDE that layer get buried underneath it regardless
        // of z-index. Moving the button and panel INTO the container guarantees they
        // are composited above the gallery iframe on every browser.
        // (#iframe-container is position:fixed covering 100% viewport, so fixed
        // children positioned relative to it land in the same visual location.)
        const container = document.getElementById('iframe-container') ?? iframeEl.parentElement;
        if (container) {
            container.appendChild(this._btn);
            container.appendChild(this._panel);
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
            const containerObs = new MutationObserver(() => {
                clearTimeout(fallbackTimer);
                if (container.classList.contains('active')) {
                    // Container just slid open — ensure button appears even if
                    // the load event never fires (iOS Safari edge case).
                    fallbackTimer = setTimeout(() => {
                        if (this._btn.style.display === 'none') this._onIframeLoad();
                    }, 600);
                } else {
                    this._clearImage();
                }
            });
            containerObs.observe(container, { attributes: true, attributeFilter: ['class'] });
            this._observers.push(containerObs);
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

        // On the very first gallery open, auto-open the panel
        if (firstLoad) this._panel.classList.add('vlm-open');

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
            thumbObs.observe(thumbSel, { attributes: true, subtree: true, attributeFilter: ['class'] });
            this._iframeObservers.push(thumbObs);
        }

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
        // Priority 1 — full-res img inside the viewer.
        // Skip if the container is explicitly hidden (e.g. after exiting magnify mode in 3D —
        // the gallery sets display:none but leaves the old <img> in the DOM).
        // Prefer img.active so a fading-out old image never wins over the incoming one.
        const imgCont = this._scopedEl('#full-image-container');
        if (imgCont && imgCont.style.display !== 'none') {
            const img = imgCont.querySelector('img.active[src]:not([src=""])') ??
                        imgCont.querySelector('img[src]:not([src=""])');
            if (img?.src && !img.src.startsWith('data:,')) {
                this._setImage(new URL(img.src, location.href).href,
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
                this._setImage(new URL(full, location.href).href,
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

    _setImage(src, name) {
        if (src === this._imageSrc) return;

        // Always reset conversation when the image changes, even when switching
        // from a null state — ensures stale streaming/history state is never
        // carried into a fresh image context.
        this._newChat();

        this._imageSrc  = src;
        this._imageName = name ?? 'photo';
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

        // Show image name in the label bar; populate EXIF drawer once extraction finishes
        const nameEl   = this._q('-imgname');
        const nameSpan = this._q('-photoname');
        const exifBtn  = this._q('-exif-toggle');
        const drawer   = this._q('-exif-drawer');
        if (nameEl) nameEl.classList.add('vlm-has-photo');
        if (nameSpan) nameSpan.textContent = this._imageName;
        if (exifBtn) exifBtn.style.display = 'none';
        if (drawer)  { drawer.innerHTML = ''; drawer.classList.remove('vlm-exif-open'); }
        if (exifBtn) exifBtn.classList.remove('vlm-exif-open');

        this._imageExifPromise.then(() => {
            // Guard: image may have changed while EXIF was loading
            if (this._imageSrc !== src) return;
            if (!this._imageExif || !exifBtn || !drawer) return;

            // Build a two-column table from the newline-delimited EXIF string
            const rows = this._imageExif.split('\n').map(line => {
                const sep = line.indexOf(': ');
                if (sep === -1) return `<tr><td colspan="2">${line}</td></tr>`;
                return `<tr><td>${line.slice(0, sep)}</td><td>${line.slice(sep + 2)}</td></tr>`;
            }).join('');
            drawer.innerHTML = `<table class="vlm-exif-table">${rows}</table>`;
            exifBtn.style.display = '';

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
        const empty = msgs.querySelector('.vlm-empty');
        if (empty) empty.remove();

        const div = document.createElement('div');
        div.className = `vlm-msg vlm-msg-${role}${streaming ? ' vlm-streaming' : ''}`;
        div.textContent = text;
        msgs.appendChild(div);
        msgs.scrollTop = msgs.scrollHeight;
        return div;
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
    _downsample(src, maxDim) {
        // Default maxDim by mode:
        //   local  — 384 px  (SmolVLM's SigLIP encoder native resolution)
        //   api    — 1120 px (default input size expected by Ollama/llava vision models)
        if (maxDim == null) maxDim = this.manager._mode === 'api' ? 1120 : 384;

        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                const scale = Math.min(1, maxDim / img.naturalWidth, maxDim / img.naturalHeight);
                if (scale === 1) { resolve(src); return; }     // already small enough
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
                resolve(canvas.toDataURL('image/jpeg', 0.88));
            };
            img.onerror = () => resolve(src);   // fallback: send original
            img.src = src;
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

    /**
     * Answer a metadata question directly from EXIF — no VLM call.
     * If EXIF is unavailable says so clearly rather than letting the model guess.
     */
    _answerFromExif(prompt) {
        let answer;
        if (this._imageExif) {
            const lines = this._imageExif.split('\n');
            const formatted = lines.map(l => {
                const sep = l.indexOf(': ');
                if (sep === -1) return `• **${l}**`;
                // In direct-links mode, append Google Maps + Light Pollution links to the Location line
                if (this._directLinks && l.startsWith('Location:') && this._imageGps) {
                    const { lat, lon } = this._imageGps;
                    return `• **${l.slice(0, sep)}:** ${l.slice(sep + 2)} ` +
                        `([Google Maps](https://maps.google.com/?q=${lat.toFixed(6)},${lon.toFixed(6)}) · ` +
                        `[Light Pollution](https://timothydo.me/astronomy/lightpollution?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}))`;
                }
                return `• **${l.slice(0, sep)}:** ${l.slice(sep + 2)}`;
            }).join('\n');
            answer = `**EXIF Metadata**\n\n${formatted}`;
        } else {
            answer = 'No EXIF metadata was found for this image — the file may not contain embedded camera data.';
        }
        this._history.push({ role: 'user',      content: prompt });
        this._history.push({ role: 'assistant', content: answer });
        const el = this._appendMsg('assistant', answer);

        // Render markdown text (_loadMarked already awaited by _sendMessage before this call)
        const textEl = Object.assign(document.createElement('span'), { className: 'vlm-msg-text vlm-md' });
        textEl.innerHTML = _markedReady ? _renderMarkdown(answer) : answer;
        el.innerHTML = '';
        el.appendChild(textEl);

        // Embed mode: inject iframes for Google Maps and Light Pollution when GPS is available
        if (!this._directLinks && this._imageGps) {
            const { lat, lon } = this._imageGps;
            const embedDiv = document.createElement('div');
            embedDiv.className = 'vlm-map-embeds';
            embedDiv.innerHTML =
                `<div class="vlm-embed-label">Google Maps</div>` +
                `<iframe src="https://maps.google.com/maps?q=${lat.toFixed(6)},${lon.toFixed(6)}&z=13&output=embed" height="200" loading="lazy" referrerpolicy="no-referrer"></iframe>` +
                `<div class="vlm-embed-label">Light Pollution</div>` +
                `<iframe src="https://timothydo.me/astronomy/lightpollution?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}" height="220" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
            el.appendChild(embedDiv);
        }

        this._q('-msgs').scrollTop = this._q('-msgs').scrollHeight;
    }

    async _sendMessage() {
        const input  = this._q('-input');
        const prompt = input.value.trim();
        if (!prompt || !this._imageSrc || !this.manager.isReady || this._streaming) return;

        input.value             = '';
        input.style.height      = 'auto';
        this._streaming         = true;
        _setVlmRunning(true);
        this._abortController   = new AbortController();
        this._ttsBuf            = '';   // reset streaming TTS sentence buffer
        this._refreshSendBtn();

        this._appendMsg('user', prompt);

        // Short-circuit: answer camera/EXIF questions directly from metadata.
        // Only fires when EXIF auto-answer is enabled; otherwise the VLM answers
        // using the EXIF data already injected into the prompt context.
        await this._imageExifPromise;
        if (this._exifBypass && this._isMetadataQuestion(prompt)) {
            await _loadMarked();
            this._answerFromExif(prompt);
            this._streaming = false;
            _setVlmRunning(false);
            this._refreshSendBtn();
            return;
        }

        // Create assistant bubble with a separate text node and a live stats bar
        const assistantEl = this._appendMsg('assistant', '', true);
        // Thinking block — created lazily on first onThinking chunk
        let thinkEl   = null;
        let thinkBody = null;   // cached .vlm-thinking-text node
        let thinkText = '';
        let pendingTokenFlush = false;
        let pendingThinkFlush = false;
        const textEl  = Object.assign(document.createElement('span'), { className: 'vlm-msg-text' });
        this._activeTTSTextEl = textEl;  // expose to _speakChunk for inline highlighting
        const statsEl = Object.assign(document.createElement('div'),  { className: 'vlm-gen-stats' });
        statsEl.textContent = 'Generating…';
        assistantEl.appendChild(textEl);
        assistantEl.appendChild(statsEl);

        // Pre-load markdown BEFORE manager.query so the prefix of the streaming
        // buffer never renders as plain textContent (would otherwise produce a
        // visible plain-text → formatted flip mid-stream). KaTeX stays
        // un-awaited as a graceful fallback.
        await _loadMarked();
        _loadKaTeX();

        // Wait for EXIF extraction to finish (usually already done by the time
        // the user types a question; guarantees metadata is available on first send)
        await this._imageExifPromise;

        const imageSrc = await this._downsample(this._imageSrc);
        let fullText   = '';

        // Build a metadata preamble injected at the start of every user prompt.
        // — Local mode: include full EXIF here (only injection point available).
        // — API mode:   EXIF is already in the system prompt (authoritative); user
        //               message carries only the filename as a lightweight anchor.
        const metaLines = [`File: ${this._imageName ?? 'unknown'}`];
        if (this.manager._mode !== 'api' && this._imageExif) metaLines.push(this._imageExif);
        const metaBlock = `[Photo metadata]\n${metaLines.join('\n')}\n\n`;

        // Inject about-page photographer bio only on the first turn (local models
        // don't have a system prompt; API mode uses setSystemPrompt instead)
        const pageCtx = (!this._history.length && this._pageContext)
            ? `[About the photographer: ${this._pageContext}]\n\n`
            : '';
        const queryPrompt = metaBlock + pageCtx + prompt;

        // Snapshot generation at send-time. If the user switches images or clicks
        // "New" before this query finishes, _generation increments and these
        // callbacks become stale — they exit early without touching the new chat.
        const gen = this._generation;

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
                    if (!pendingThinkFlush) {
                        pendingThinkFlush = true;
                        requestAnimationFrame(() => {
                            pendingThinkFlush = false;
                            if (this._generation !== gen) return;
                            if (_markedReady) {
                                thinkBody.innerHTML = _renderMarkdown(thinkText);
                                thinkBody.classList.add('vlm-md');
                            } else {
                                thinkBody.textContent = thinkText;
                            }
                            this._q('-msgs').scrollTop = this._q('-msgs').scrollHeight;
                        });
                    }
                },
                onToken: (tok, tps, tokenCount) => {
                    if (this._generation !== gen) return;
                    fullText += tok;
                    if (tps != null) {
                        statsEl.textContent = `${tokenCount} tok · ${tps} tok/s · ${this._backend}`;
                    }
                    this._feedTTS(tok);
                    if (!pendingTokenFlush) {
                        pendingTokenFlush = true;
                        requestAnimationFrame(() => {
                            pendingTokenFlush = false;
                            if (this._generation !== gen) return;
                            if (_markedReady) {
                                textEl.innerHTML = _renderMarkdown(fullText);
                                textEl.classList.add('vlm-md');
                            } else {
                                textEl.textContent = fullText;
                            }
                            this._q('-msgs').scrollTop = this._q('-msgs').scrollHeight;
                        });
                    }
                },
                onDone: (text, tokenCount, avgTps) => {
                    if (this._generation !== gen) return;
                    // Skip any queued RAF — we'll flush synchronously below
                    pendingTokenFlush = true;
                    pendingThinkFlush = true;
                    const finalText = text || fullText;
                    assistantEl.classList.remove('vlm-streaming');

                    // Ensure final text is always markdown-rendered
                    if (_markedReady) {
                        textEl.innerHTML = _renderMarkdown(finalText);
                        textEl.classList.add('vlm-md');
                    } else {
                        textEl.textContent = finalText;
                    }

                    // Collapse the thinking block and update its label once done.
                    // Final markdown re-render guarantees the collapsed details
                    // element has fully markdown-rendered content even if a RAF
                    // flush was pending or marked loaded mid-stream.
                    if (thinkEl) {
                        thinkEl.querySelector('summary').textContent = 'Thought process';
                        if (thinkBody && _markedReady) {
                            thinkBody.innerHTML = _renderMarkdown(thinkText);
                            thinkBody.classList.add('vlm-md');
                        }
                    }

                    // Freeze final stats
                    const parts = [];
                    if (tokenCount) parts.push(`${tokenCount} tok`);
                    if (avgTps)     parts.push(`avg ${avgTps} tok/s`);
                    if (this._backend) parts.push(this._backend);
                    statsEl.textContent = parts.join(' · ');
                    statsEl.classList.add('vlm-gen-stats-done');

                    this._history.push({ role: 'user',      content: prompt    });
                    this._history.push({ role: 'assistant', content: finalText });
                    if (this._history.length > 10) this._history = this._history.slice(-10);

                    // Per-message copy button
                    const copyBtn = document.createElement('button');
                    copyBtn.className   = 'vlm-msg-copy';
                    copyBtn.textContent = 'Copy response';
                    copyBtn.title       = 'Copy this response to clipboard';
                    copyBtn.addEventListener('click', () => {
                        navigator.clipboard.writeText(finalText).then(() => {
                            copyBtn.textContent = 'Copied!';
                            setTimeout(() => { copyBtn.textContent = 'Copy response'; }, 1500);
                        }).catch(() => {});
                    });
                    assistantEl.appendChild(copyBtn);

                    // Show chat-level action bar
                    this._q('-chat-actions').style.display = '';

                    this._flushTTS();
                    _setVlmRunning(false);
                    this._streaming = false;
                    this._refreshSendBtn();
                    this._q('-msgs').scrollTop = this._q('-msgs').scrollHeight;
                },
                onError: (msg) => {
                    if (this._generation !== gen) return;
                    assistantEl.classList.remove('vlm-streaming');
                    _setVlmRunning(false);
                    this._streaming = false;
                    // Suppress abort — user stopped intentionally
                    if (String(msg).toLowerCase().includes('abort')) {
                        if (!fullText) assistantEl.remove();
                        statsEl.remove();
                        this._refreshSendBtn();
                        return;
                    }
                    textEl.textContent = `Error: ${msg}`;
                    textEl.style.color = '#ef5350';
                    statsEl.remove();
                    this._refreshSendBtn();
                },
            },
        );
    }

    // ── Loading Stage Helpers ──────────────────────────────────────────────

    /**
     * Update a numbered loading stage row.
     * @param {1|2|3}                          num
     * @param {'pending'|'active'|'done'|'error'} status
     * @param {string}                          [detail]
     */
    _setStage(num, status, detail) {
        const icon   = this._q(`-s${num}i`);
        const name   = this._q(`-s${num}n`);
        const det    = this._q(`-s${num}d`);
        if (!icon) return;

        const ICONS = { pending: '○', active: '◉', done: '✓', error: '✗' };
        icon.textContent = ICONS[status] ?? '○';
        icon.className   = `vlm-stage-icon ${status}`;
        name.className   = `vlm-stage-name ${status}`;
        if (detail !== undefined) {
            det.textContent = detail;
            det.className   = `vlm-stage-detail ${status === 'active' ? 'active' : ''}`;
        }
    }

    // ── Manager Event Wiring ───────────────────────────────────────────────

    _bindManagerEvents() {
        this._backend = 'WASM';   // updated on 'ready'

        this.manager.on('progress', (data) => {
            const { stage, pct, file, fileMB, downloadedMB, loadedMB, heapMB } = data;

            switch (stage) {
                case 'proc':
                    this._q('-status').textContent = 'Loading processor…';
                    this._setStage(1, 'active', '');
                    break;

                case 'proc_done':
                    this._q('-status').textContent = 'Downloading model weights…';
                    this._setStage(1, 'done', '');
                    this._setStage(2, 'active', 'Starting download…');
                    break;

                case 'download': {
                    // Advance the top progress bar monotonically — never go backwards.
                    // pct from the worker is per-file (resets to ~10% each new file).
                    if (pct != null && pct > this._dlMaxPct) {
                        this._dlMaxPct = pct;
                        this._q('-prog').style.width = `${pct}%`;
                    }

                    // Stable header: overall MB + percentage, not the filename
                    const mbLabel  = downloadedMB ? `${downloadedMB} MB` : '';
                    const pctLabel = this._dlMaxPct ? `${this._dlMaxPct}%` : '';
                    this._q('-status').textContent =
                        `Downloading model… ${[mbLabel, pctLabel].filter(Boolean).join(' · ')}`;

                    // Activate the download track on the first download event
                    this._q('-dltrack')?.classList.add('vlm-dl-active');
                    this._setStage(1, 'done', '');
                    this._setStage(2, 'active', '');   // clear detail — track shows the info

                    // Download track: bar fill, totals row, current file
                    if (this._q('-dlbar'))  this._q('-dlbar').style.width = `${this._dlMaxPct}%`;
                    if (this._q('-dlmb'))   this._q('-dlmb').textContent  = downloadedMB ? `↓ ${downloadedMB} MB` : '';
                    if (this._q('-dlpct'))  this._q('-dlpct').textContent  = pctLabel;
                    if (this._q('-dlfile')) {
                        // Show filename + its own progress; this line is expected to change
                        const fileInfo = [file, fileMB ? `${fileMB} MB` : null].filter(Boolean).join(' — ');
                        this._q('-dlfile').textContent = fileInfo;
                    }
                    break;
                }

                case 'compile': {
                    this._q('-status').textContent = 'Initialising ONNX runtime…';
                    this._q('-prog').style.width   = `${pct ?? 85}%`;
                    this._q('-dltrack')?.classList.remove('vlm-dl-active');
                    this._setStage(1, 'done', '');
                    this._setStage(2, 'done', downloadedMB ? `${downloadedMB} MB downloaded` : '');
                    const parts = ['Compiling ONNX graph'];
                    if (loadedMB) parts.push(`${loadedMB} MB in memory`);
                    if (heapMB)   parts.push(`Heap: ${heapMB} MB`);
                    this._setStage(3, 'active', parts.join('  ·  '));
                    break;
                }
            }
        });

        this.manager.on('ready', ({ device, heapMB }) => {
            this._backend = (device ?? 'wasm').toUpperCase();

            this._q('-dot').className      = 'vlm-status-dot vlm-dot-ready';
            this._q('-status').textContent = `Ready · ${this._backend}`;
            this._btn.classList.remove('vlm-model-loading');
            if (this._iframeMode) window.parent.postMessage({ type: 'vlm-btn-state', loading: false }, '*');

            if (device === 'api') {
                // API mode — no model download stages; collapse loading section right away
                this._q('-loading')?.classList.add('vlm-stages-done');
                this._q('-prog').style.width = '0%';
            } else {
                this._setStage(1, 'done', '');
                this._setStage(2, 'done', '');
                const readyDetail = [this._backend, heapMB ? `Heap: ${heapMB} MB` : null]
                    .filter(Boolean).join('  ·  ');
                this._setStage(3, 'done', readyDetail);

                const prog = this._q('-prog');
                prog.style.width = '100%';
                setTimeout(() => { prog.style.width = '0%'; }, 800);
                setTimeout(() => { this._q('-loading')?.classList.add('vlm-stages-done'); }, 1800);
            }

            this._refreshSendBtn();
        });

        this.manager.on('restart', () => {
            // Worker was restarted (model changed) — reset all loading indicators
            this._resetLoadingUI();
            this._newChat();
        });

        this.manager.on('error', ({ message } = {}) => {
            this._q('-dot').className      = 'vlm-status-dot';
            this._q('-status').textContent = 'Load failed';

            // Show the real error message on whichever stage was in progress
            const s1i = this._q('-s1i');
            const s2i = this._q('-s2i');
            const s3i = this._q('-s3i');
            // Find the first non-done stage and mark it error
            const activeStage =
                s3i?.className.includes('active') ? 3 :
                s2i?.className.includes('active') ? 2 : 1;
            this._setStage(activeStage, 'error', message ?? 'Unknown error');

            // Also append an error message into the chat so it's impossible to miss
            const msgs = this._q('-msgs');
            if (msgs) {
                const errDiv = document.createElement('div');
                errDiv.style.cssText = 'color:#ef5350;font-size:12px;padding:8px 12px;white-space:pre-wrap;word-break:break-all;';
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

            if (!galleryOpen) return;

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
        });
    }

    /** Reset the loading UI to its initial state (used when worker restarts). */
    _resetLoadingUI() {
        this._dlMaxPct = 0;
        this._q('-dltrack')?.classList.remove('vlm-dl-active');
        this._setStage(1, 'pending', '');
        this._setStage(2, 'pending', 'Waiting…');
        this._setStage(3, 'pending', '');
        this._q('-loading')?.classList.remove('vlm-stages-done');
        this._q('-dot').className      = 'vlm-status-dot vlm-dot-loading';
        this._q('-status').textContent = 'Loading model…';
        this._q('-prog').style.width   = '0%';
        this._btn.classList.add('vlm-model-loading');
        if (this._iframeMode) window.parent.postMessage({ type: 'vlm-btn-state', loading: true }, '*');
        this._refreshSendBtn();
    }

    // ── Cleanup ────────────────────────────────────────────────────────────

    destroy() {
        this._observers.forEach(o => o.disconnect());
        this._detachIframeObservers();
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
function initGalleryVLM() {
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
        overlay._panel.classList.add('vlm-open', 'vlm-iframe-mode');

        // No-op: parent drives #vlm-iframe width, not this doc's CSS var
        overlay._setPush = () => {};

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
        });

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
            manager.init();
            overlay._attachDocObservers(document);
        }
    }

    return [overlay];
}

// Auto-init after DOM is parsed (module scripts are deferred, so DOM is ready).
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGalleryVLM);
} else {
    initGalleryVLM();
}

export { GalleryVLMOverlay, initGalleryVLM };
