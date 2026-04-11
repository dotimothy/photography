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

import { VLMManager } from './VLMManager.js';

// ─── Three.js render freeze during inference ──────────────────────────────────
// THREE is loaded as a global <script> tag (non-module) so it is accessible here.
// We patch WebGLRenderer.prototype.render once per page: while _vlmIsRunning is
// true the render call is skipped entirely, freeing the GPU for ONNX Runtime.
// The animation loop (requestAnimationFrame) keeps ticking so the gallery's
// state machine and input handling remain intact — only pixel output is frozen.

let _threePatched  = false;
let _vlmIsRunning  = false;

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
    bottom: 80px;
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

/* ── VLM Panel ────────────────────────────────────────────────── */
.vlm-panel {
    position: fixed;
    bottom: 138px;
    right: 20px;
    width: 340px;
    max-height: 530px;
    display: flex;
    flex-direction: column;
    background: rgba(10, 10, 18, 0.96);
    border: 1px solid rgba(79, 195, 247, 0.2);
    border-radius: 13px;
    z-index: 4500;
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    box-shadow: 0 10px 40px rgba(0,0,0,0.7), 0 0 0 1px rgba(79,195,247,0.07);
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
    transform: scale(0.95) translateY(8px);
    transition: opacity 0.2s ease, transform 0.2s ease;
    font-family: 'Roboto', system-ui, sans-serif;
    font-size: 13px;
    color: #cfd8dc;
    will-change: transform, opacity;
    touch-action: auto;
}
.vlm-panel.vlm-open {
    opacity: 1;
    pointer-events: auto;
    transform: scale(1) translateY(0);
}

/* ── Header ──────────────────────────────────────────────────── */
.vlm-header {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 9px 12px;
    border-bottom: 1px solid rgba(255,255,255,0.07);
    background: rgba(79, 195, 247, 0.05);
    flex-shrink: 0;
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
.vlm-new-btn, .vlm-close-btn {
    background: none;
    border: 1px solid rgba(255,255,255,0.1);
    color: #78909c;
    cursor: pointer;
    border-radius: 4px;
    font-size: 11px;
    padding: 2px 6px;
    line-height: 1.4;
    flex-shrink: 0;
    transition: color 0.15s, border-color 0.15s;
}
.vlm-new-btn:hover  { color: #4fc3f7; border-color: rgba(79,195,247,0.4); }
.vlm-close-btn      { font-size: 15px; padding: 0 5px; border-color: transparent; }
.vlm-close-btn:hover { color: #fff; background: rgba(255,255,255,0.08); }

/* ── Progress bar ─────────────────────────────────────────────── */
.vlm-progress-bar { height: 2px; background: transparent; flex-shrink: 0; }
.vlm-progress-fill {
    height: 100%;
    width: 0%;
    background: linear-gradient(90deg, #4fc3f7 0%, #7c4dff 100%);
    transition: width 0.5s ease;
    border-radius: 1px;
}

/* ── Image context strip ─────────────────────────────────────── */
.vlm-image-strip {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 8px 12px;
    border-bottom: 1px solid rgba(255,255,255,0.05);
    flex-shrink: 0;
    min-height: 54px;
}
.vlm-image-strip.vlm-no-image {
    color: #37474f;
    font-size: 11.5px;
    font-style: italic;
}
.vlm-thumb {
    width: 58px;
    height: 42px;
    object-fit: cover;
    border-radius: 4px;
    border: 1px solid rgba(255,255,255,0.1);
    flex-shrink: 0;
    background: #111;
}
.vlm-image-meta {
    flex: 1;
    overflow: hidden;
}
.vlm-image-name {
    color: #e0f7fa;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.vlm-image-hint {
    color: #546e7a;
    font-size: 10.5px;
    margin-top: 2px;
}

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
    font-size: 12px;
    text-align: center;
    padding: 16px 0;
    font-style: italic;
    user-select: none;
}
.vlm-msg {
    max-width: 93%;
    font-size: 12px;
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
    font-size: 12px;
    font-family: inherit;
    white-space: nowrap;
    transition: background 0.18s;
    line-height: 1.45;
    min-height: 32px;
}
.vlm-send-btn:hover:not(:disabled) { background: rgba(79, 195, 247, 0.24); }
.vlm-send-btn:disabled { opacity: 0.35; cursor: not-allowed; }

/* ── Responsive / Mobile ──────────────────────────────────────── */
@media (max-width: 600px) {
    /* Bottom-sheet: full width, slides up from the very bottom */
    .vlm-panel {
        width: 100%;
        left: 0;
        right: 0;
        bottom: 0;
        /* Extend into safe area so content isn't clipped by home indicator */
        padding-bottom: env(safe-area-inset-bottom, 0px);
        max-height: 75vh;
        border-radius: 14px 14px 0 0;
        transform: translateY(12px) scale(1);   /* only slide, no scale on mobile */
    }
    .vlm-panel.vlm-open {
        transform: translateY(0) scale(1);
    }
    /* Larger tap target; sit above iOS home indicator */
    .vlm-toggle-btn {
        bottom: calc(20px + env(safe-area-inset-bottom, 0px));
        right: 20px;
        width: 52px;
        height: 52px;
    }
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

/* ── Per-message generation stats bar ────────────────────────── */
.vlm-msg-text { display: block; white-space: pre-wrap; word-break: break-word; }
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
        this._history          = [];    // [{role, content}, ...]
        this._streaming        = false;
        this._generation       = 0;     // incremented on every chat/image reset; stale callbacks bail
        this._observers        = [];    // page-level (permanent) observers
        this._iframeEl         = null;
        this._iframeDoc        = null;
        this._iframeObservers  = [];    // per-gallery observers (reset on each switch)
        this._pendingThumbSrc  = null;
        this._pendingThumbName = null;

        this._buildUI();
        this._bindManagerEvents();
        this._bindSettingsEvents();
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

        // ── Panel ──────────────────────────────────────────────────────────
        this._panel = document.createElement('div');
        this._panel.className = 'vlm-panel';
        this._panel.setAttribute('role', 'dialog');
        this._panel.setAttribute('aria-label', 'TheDoInspector');
        this._panel.innerHTML = `
<div class="vlm-header">
    <span class="vlm-header-title">TheDoInspector</span>
    <span class="vlm-status-dot vlm-dot-loading" id="${this._id}-dot"></span>
    <span class="vlm-status-label"  id="${this._id}-status">Loading model…</span>
    <button class="vlm-new-btn"   id="${this._id}-new"   title="Start new conversation">New</button>
    <button class="vlm-close-btn" id="${this._id}-close" title="Close panel" aria-label="Close">×</button>
</div>
<div class="vlm-progress-bar">
    <div class="vlm-progress-fill" id="${this._id}-prog"></div>
</div>

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

<div class="vlm-image-strip vlm-no-image" id="${this._id}-strip">
    Select a photo in the gallery to begin.
</div>
<div class="vlm-messages" id="${this._id}-msgs">
    <div class="vlm-empty">Open a photo, then ask anything about it.</div>
</div>
<div class="vlm-input-area">
    <textarea class="vlm-input" id="${this._id}-input" rows="1"
        placeholder="What camera settings? What's the subject? …"
        aria-label="Ask about the photo"></textarea>
    <button class="vlm-send-btn" id="${this._id}-send" disabled>Send</button>
</div>`;
        document.body.appendChild(this._panel);

        // ── Panel event wiring ─────────────────────────────────────────────
        this._q('-close').addEventListener('click',   () => this._closePanel());
        this._q('-new').addEventListener('click',     () => this._newChat());

        const sendBtn = this._q('-send');
        const input   = this._q('-input');

        sendBtn.addEventListener('click',   () => this._sendMessage());
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

    _togglePanel() { this._panel.classList.toggle('vlm-open'); }
    _closePanel()  { this._panel.classList.remove('vlm-open'); }

    _newChat() {
        this._generation++;              // invalidate any in-flight callbacks
        this._history   = [];
        this._streaming = false;         // abandon any streaming state
        _vlmIsRunning   = false;
        const msgs = this._q('-msgs');
        msgs.innerHTML = '<div class="vlm-empty">Open a photo, then ask anything about it.</div>';
        this._refreshSendBtn();
    }

    _refreshSendBtn() {
        const input   = this._q('-input');
        const sendBtn = this._q('-send');
        sendBtn.disabled = (
            !this._imageSrc          ||
            !input.value.trim()      ||
            !this.manager.isReady    ||
            this._streaming
        );
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

        // Gallery is open — show button and kick off model loading,
        // but only if VLM is enabled in settings (default: enabled).
        const settings = window.VLM_SETTINGS ?? {};
        if (settings.enabled === false) return;

        this._btn.style.display = '';

        const isApi    = settings.type === 'api';
        const firstLoad = isApi ? !this.manager.isReady : !this.manager._worker;

        if (isApi) {
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
     */
    _attachIframeObservers(doc) {
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
            }
        });
        if (viewer)  obs.observe(viewer,  { attributes: true });
        if (imgCont) obs.observe(imgCont, { childList: true, subtree: true });
        this._iframeObservers.push(obs);

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

    _detachIframeObservers() {
        this._iframeObservers.forEach(o => o.disconnect());
        this._iframeObservers  = [];
        this._iframeDoc        = null;
        this._pendingThumbSrc  = null;
        this._pendingThumbName = null;
    }

    /** Reset the image strip and hide the overlay when the gallery is closed. */
    _clearImage() {
        if (this._imageSrc) this._newChat();
        this._imageSrc  = null;
        this._imageName = null;
        const strip = this._q('-strip');
        if (strip) {
            strip.className = 'vlm-image-strip vlm-no-image';
            strip.innerHTML = 'Select a photo in the gallery to begin.';
        }
        this._refreshSendBtn();
        this._closePanel();
        this._btn.style.display = 'none';  // gallery closed — hide until next gallery opens
    }

    /**
     * Resolve the current image using prioritised fallback chain.
     * Called automatically by observers; also exposed for manual calls.
     */
    _tryExtractFromViewer() {
        // Priority 1 — full-res img inside the viewer
        const imgCont = this._scopedEl('#full-image-container');
        if (imgCont) {
            const img = imgCont.querySelector('img[src]:not([src=""])');
            if (img?.src && !img.src.startsWith('data:,')) {
                this._setImage(new URL(img.src, location.href).href,
                               img.alt || img.src.split('/').pop().replace(/\.[^.]+$/, ''));
                return;
            }
        }

        // Priority 2 — active thumbnail strip inside the viewer
        const strip = this._scopedEl('#thumbnail-selector');
        if (strip) {
            const active = strip.querySelector('.thumb.active img, img.active, img[aria-selected="true"]');
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
        // (preserveDrawingBuffer is false on the gallery renderer so this will
        // usually return a blank/black frame — documented limitation)
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

        // Image changed — clear prior conversation so context stays coherent
        if (this._imageSrc) this._newChat();

        this._imageSrc  = src;
        this._imageName = name ?? 'photo';

        const strip = this._q('-strip');
        strip.className = 'vlm-image-strip';
        strip.innerHTML = `
<img class="vlm-thumb" src="${src}" alt=""
     onerror="this.replaceWith(Object.assign(document.createElement('span'),
                {className:'vlm-image-hint',textContent:'Preview unavailable'}))">
<div class="vlm-image-meta">
    <div class="vlm-image-name">${this._imageName}</div>
    <div class="vlm-image-hint">Ready — ask anything about this photo</div>
</div>`;

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
    _downsample(src, maxDim = 384) {
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
                ctx.imageSmoothingEnabled = false;             // nearest-neighbour — faster
                ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', 0.88));
            };
            img.onerror = () => resolve(src);   // fallback: send original
            img.src = src;
        });
    }

    async _sendMessage() {
        const input  = this._q('-input');
        const prompt = input.value.trim();
        if (!prompt || !this._imageSrc || !this.manager.isReady || this._streaming) return;

        input.value        = '';
        input.style.height = 'auto';
        this._streaming    = true;
        _vlmIsRunning      = true;
        this._refreshSendBtn();

        this._appendMsg('user', prompt);

        // Create assistant bubble with a separate text node and a live stats bar
        const assistantEl = this._appendMsg('assistant', '', true);
        const textEl  = Object.assign(document.createElement('span'), { className: 'vlm-msg-text' });
        const statsEl = Object.assign(document.createElement('div'),  { className: 'vlm-gen-stats' });
        statsEl.textContent = 'Generating…';
        assistantEl.appendChild(textEl);
        assistantEl.appendChild(statsEl);

        const imageSrc = await this._downsample(this._imageSrc);
        let fullText   = '';

        // Snapshot generation at send-time. If the user switches images or clicks
        // "New" before this query finishes, _generation increments and these
        // callbacks become stale — they exit early without touching the new chat.
        const gen = this._generation;

        this.manager.query(
            imageSrc,
            prompt,
            this._history.slice(),
            {
                onToken: (tok, tps, tokenCount) => {
                    if (this._generation !== gen) return;
                    fullText += tok;
                    textEl.textContent = fullText;
                    if (tps != null) {
                        statsEl.textContent = `${tokenCount} tok · ${tps} tok/s · ${this._backend}`;
                    }
                    this._q('-msgs').scrollTop = this._q('-msgs').scrollHeight;
                },
                onDone: (text, tokenCount, avgTps) => {
                    if (this._generation !== gen) return;
                    const finalText = text || fullText;
                    assistantEl.classList.remove('vlm-streaming');
                    textEl.textContent = finalText;

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

                    _vlmIsRunning   = false;
                    this._streaming = false;
                    this._refreshSendBtn();
                },
                onError: (msg) => {
                    if (this._generation !== gen) return;
                    assistantEl.classList.remove('vlm-streaming');
                    textEl.textContent = `Error: ${msg}`;
                    textEl.style.color = '#ef5350';
                    statsEl.remove();

                    _vlmIsRunning   = false;
                    this._streaming = false;
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
            const { stage, message, pct, file, fileMB, downloadedMB, loadedMB, heapMB } = data;

            this._q('-status').textContent = message ?? 'Loading…';
            if (pct != null) this._q('-prog').style.width = `${pct}%`;

            switch (stage) {
                case 'proc':
                    this._setStage(1, 'active', '');
                    break;

                case 'proc_done':
                    this._setStage(1, 'done',  '');
                    this._setStage(2, 'active', 'Starting download…');
                    break;

                case 'download': {
                    this._setStage(1, 'done', '');
                    // e.g.  "decoder_model.onnx — 45.2 MB  |  Total: 234.5 MB"
                    const parts = [];
                    if (file)          parts.push(file);
                    if (fileMB)        parts.push(`${fileMB} MB`);
                    if (downloadedMB)  parts.push(`↓ ${downloadedMB} MB total`);
                    this._setStage(2, 'active', parts.join('  ·  '));
                    break;
                }

                case 'compile': {
                    this._setStage(1, 'done', '');
                    this._setStage(2, 'done', downloadedMB ? `${downloadedMB} MB downloaded` : '');
                    // e.g.  "Compiling ONNX graph  ·  234.5 MB in memory  ·  Heap: 512 MB"
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
            const { enabled, type, model, apiEndpoint, apiKey, apiModel } = e.detail ?? {};
            const galleryOpen = !!(this._iframeDoc &&
                this._iframeDoc.location?.href !== 'about:blank');

            if (!enabled) {
                this._btn.style.display = 'none';
                this._closePanel();
                return;
            }

            if (!galleryOpen) return;

            this._btn.style.display = '';

            if (type === 'api') {
                // Switch to (or update) API mode — setApiMode re-emits 'ready'
                // so the status bar refreshes immediately.
                this.manager.setApiMode(apiEndpoint, apiKey, apiModel);
                this._resetLoadingUI();   // resets btn pulse; ready event follows immediately
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
        this._setStage(1, 'pending', '');
        this._setStage(2, 'pending', 'Waiting…');
        this._setStage(3, 'pending', '');
        this._q('-loading')?.classList.remove('vlm-stages-done');
        this._q('-dot').className      = 'vlm-status-dot vlm-dot-loading';
        this._q('-status').textContent = 'Loading model…';
        this._q('-prog').style.width   = '0%';
        this._btn.classList.add('vlm-model-loading');
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
    // NOTE: do NOT call manager.init() here in parent-portfolio mode.
    // The Worker is spawned lazily when the first gallery opens (_onIframeLoad),
    // so the space loading screen is not burdened by model downloads.

    const overlay = new GalleryVLMOverlay(document.body, manager);

    const iframeEl = document.getElementById('exhibit-iframe');
    if (iframeEl) {
        // Parent-portfolio mode: button hidden, model deferred until iframe loads.
        overlay._watchIframe(iframeEl);
    } else {
        // Direct-gallery mode (local testing / single-gallery deployment):
        // no iframe — show button immediately and start model loading now.
        overlay._btn.style.display = '';
        manager.init();
        overlay._attachDocObservers(document);
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
