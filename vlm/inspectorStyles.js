/**
 * inspectorStyles.js — the visual system for TheDoInspector (CSS in JS, no build step).
 *
 * Two sheets so pages that never open the assistant pay almost nothing:
 *   TOGGLE_CSS  the floating launcher only; injected when the overlay initialises
 *   PANEL_CSS   everything else; injected the first time the panel is shown
 *
 * One system, in the site's space theme: near-black navy surfaces, hairline
 * blue-grey rules, cyan (#00e5ff) as the single accent, Roboto throughout.
 * Controls share one height token (--vlm-hit: 36px with a mouse, 44px on touch).
 */

const TOKENS = `
    --vlm-ink: #03060d;
    --vlm-surface: #070c18;
    --vlm-raised: #0d1526;
    --vlm-raised-2: #142037;
    --vlm-line: rgba(148, 190, 220, 0.16);
    --vlm-line-strong: rgba(148, 190, 220, 0.32);
    --vlm-accent: #00e5ff;
    --vlm-accent-ink: #021318;
    --vlm-accent-soft: rgba(0, 229, 255, 0.12);
    --vlm-accent-line: rgba(0, 229, 255, 0.5);
    --vlm-text: #eef4f8;
    --vlm-text-2: #a9bccb;
    --vlm-text-3: #8196a8;
    --vlm-danger: #ff7b72;
    --vlm-ok: #56e3a1;
    --vlm-warn: #ffbd5c;
    --vlm-radius: 14px;
    --vlm-glass: rgba(8, 12, 20, 0.72);
    --vlm-glass-line: rgba(255, 255, 255, 0.14);
    --vlm-hit: 36px;
    --vlm-gutter: 12px;
    --vlm-font: 'Roboto', system-ui, -apple-system, 'Segoe UI', sans-serif;
`;

export const TOGGLE_CSS = `
.vlm-toggle-btn {
    ${TOKENS}
    position: fixed;
    right: calc(16px + env(safe-area-inset-right, 0px));
    bottom: calc(16px + env(safe-area-inset-bottom, 0px) + var(--vlm-toggle-lift, 0px));
    width: 44px;
    height: 44px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    border: 1px solid var(--vlm-glass-line);
    background: var(--vlm-glass);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
    color: var(--vlm-text);
    cursor: pointer;
    z-index: 4500;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    font-family: var(--vlm-font);
}
.vlm-toggle-btn:hover { border-color: var(--vlm-accent-line); color: var(--vlm-accent); }
.vlm-toggle-btn:active { background: var(--vlm-accent-soft); }
.vlm-toggle-btn:focus-visible { outline: 2px solid var(--vlm-accent); outline-offset: 3px; }
/* The launcher never sits on top of an open panel. */
.vlm-toggle-btn.vlm-toggle-hidden { display: none !important; }
.vlm-toggle-btn.vlm-model-loading::after {
    content: '';
    position: absolute;
    inset: -4px;
    border-radius: 50%;
    border: 2px solid transparent;
    border-top-color: var(--vlm-accent);
    animation: vlm-spin 1.1s linear infinite;
}
@keyframes vlm-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
    .vlm-toggle-btn { transition: none; }
    .vlm-toggle-btn.vlm-model-loading::after { animation: none; border-color: var(--vlm-accent-line); }
}
`;

export const PANEL_CSS = `
/* ── Tokens and base ─────────────────────────────────────────── */
.vlm-panel, .vlm-crop-modal-overlay, .vlm-map-overlay {
    ${TOKENS}
    font-family: var(--vlm-font);
    color: var(--vlm-text);
    -webkit-text-size-adjust: 100%;
}
.vlm-panel *, .vlm-crop-modal-overlay *, .vlm-map-overlay * { box-sizing: border-box; }
.vlm-panel button, .vlm-panel input, .vlm-panel textarea,
.vlm-crop-modal-overlay button, .vlm-map-overlay button { font-family: inherit; }
@media (pointer: coarse), (max-width: 768px) {
    .vlm-panel, .vlm-crop-modal-overlay, .vlm-map-overlay { --vlm-hit: 44px; }
}
.vlm-panel [hidden], .vlm-map-overlay [hidden], .vlm-crop-modal-overlay [hidden] { display: none !important; }
.vlm-panel :focus-visible, .vlm-crop-modal-overlay :focus-visible, .vlm-map-overlay :focus-visible {
    outline: 2px solid var(--vlm-accent);
    outline-offset: 3px;
}
.vlm-sr-only {
    position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/* ── Buttons: one shape, four roles ──────────────────────────── */
.vlm-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: var(--vlm-hit);
    min-width: var(--vlm-hit);
    padding: 0 14px;
    border: 1px solid var(--vlm-glass-line);
    border-radius: 999px;
    background: transparent;
    color: var(--vlm-text);
    font-size: 14px;
    font-weight: 600;
    line-height: 1.1;
    letter-spacing: 0.01em;
    white-space: nowrap;
    text-decoration: none;
    cursor: pointer;
    flex-shrink: 0;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease;
}
.vlm-btn svg { flex-shrink: 0; }
.vlm-btn:hover:not(:disabled) { color: var(--vlm-text); border-color: var(--vlm-accent-line); background: rgba(255, 255, 255, 0.06); }
.vlm-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.vlm-btn.vlm-btn-icon { padding: 0; border-color: transparent; }
.vlm-btn.vlm-btn-icon:hover:not(:disabled) { border-color: var(--vlm-glass-line); }
.vlm-btn.vlm-btn-primary {
    background: var(--vlm-accent);
    border-color: var(--vlm-accent);
    color: var(--vlm-accent-ink);
    font-weight: 700;
}
.vlm-btn.vlm-btn-primary:hover:not(:disabled) { background: #6ff0ff; border-color: #6ff0ff; color: var(--vlm-accent-ink); }
.vlm-btn.vlm-btn-danger { color: var(--vlm-danger); border-color: rgba(255, 123, 114, 0.5); }
.vlm-btn.vlm-btn-danger:hover:not(:disabled) { background: rgba(255, 123, 114, 0.12); border-color: var(--vlm-danger); color: var(--vlm-danger); }
.vlm-btn.vlm-on, .vlm-btn[aria-pressed="true"], .vlm-btn[aria-selected="true"] {
    color: var(--vlm-accent);
    border-color: var(--vlm-accent-line);
    background: var(--vlm-accent-soft);
}

/* ── Panel shell: docked on the right, full height ───────────── */
.vlm-panel {
    position: fixed;
    top: 0;
    right: 0;
    width: 380px;
    max-width: 100vw;
    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    background: var(--vlm-surface);
    border-left: 1px solid var(--vlm-line);
    z-index: 4500;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    overflow: hidden;
    font-size: var(--vlm-font-sz, 14px);
    line-height: 1.5;
    visibility: hidden;
    pointer-events: none;
    transform: translateX(100%);
    transition: transform 0.22s ease, visibility 0s linear 0.22s;
    touch-action: auto;
}
.vlm-panel.vlm-open {
    visibility: visible;
    pointer-events: auto;
    transform: none;
    transition: transform 0.22s ease, visibility 0s;
}
.vlm-resize-handle {
    position: absolute;
    top: 0;
    left: -3px;
    width: 9px;
    height: 100%;
    cursor: ew-resize;
    z-index: 3;
    touch-action: none;
}
.vlm-resize-handle::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 4px;
    width: 3px;
    height: 44px;
    margin-top: -22px;
    border-radius: 2px;
    background: var(--vlm-line-strong);
    transition: background 0.14s ease;
}
.vlm-resize-handle:hover::after, .vlm-panel.vlm-resizing .vlm-resize-handle::after { background: var(--vlm-accent); }
.vlm-panel.vlm-resizing, .vlm-panel.vlm-resizing * { transition: none !important; }

/* ── Header ──────────────────────────────────────────────────── */
.vlm-header {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 6px 8px var(--vlm-gutter);
    padding-top: max(8px, env(safe-area-inset-top, 0px));
    border-bottom: 1px solid var(--vlm-line);
    flex-shrink: 0;
    min-width: 0;
}
.vlm-header-id { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.vlm-header-title {
    font-size: 15px;
    font-weight: 500;
    letter-spacing: 0.01em;
    color: var(--vlm-text);
    line-height: 1.2;
    overflow-wrap: anywhere;
}
.vlm-status { display: flex; align-items: center; gap: 6px; min-width: 0; }
.vlm-status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--vlm-text-3);
    flex-shrink: 0;
}
.vlm-status-dot.vlm-dot-loading { background: var(--vlm-warn); animation: vlm-blink 1.2s ease-in-out infinite; }
.vlm-status-dot.vlm-dot-ready { background: var(--vlm-ok); }
.vlm-status-dot.vlm-dot-error { background: var(--vlm-danger); }
@keyframes vlm-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.vlm-status-label {
    font-size: 12px;
    color: var(--vlm-text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
}

/* ── Toolbar: mode tabs on the left, chat actions on the right ─ */
.vlm-toolbar {
    display: flex;
    flex-shrink:0;
    align-items: center;
    gap: 6px;
    padding: 6px var(--vlm-gutter);
    border-bottom: 1px solid var(--vlm-line);
    min-width: 0;
}
.vlm-mode-tabs { display: flex; flex-shrink:0; gap: 2px; padding: 2px; border: 1px solid var(--vlm-line); border-radius: 999px; }
.vlm-mode-tab.vlm-btn { border-color: transparent; min-height: calc(var(--vlm-hit) - 6px); padding: 0 12px; }
.vlm-mode-tab.vlm-btn[aria-selected="true"] { border-color: var(--vlm-accent-line); }
/* Touch: the tabs themselves are full-size targets; the pill grows around them. */
@media (pointer: coarse), (max-width: 768px) { .vlm-mode-tab.vlm-btn { min-height: var(--vlm-hit); } }
.vlm-toolbar-spacer { flex: 1; min-width: 0; }

.vlm-model-select.vlm-btn {
    display: block;
    flex: 1 1 110px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
    border-color: transparent;
    background: transparent;
}
.vlm-model-select + .vlm-toolbar-spacer { flex: 0; }

/* ── Chat controls ────────────────────────────────────────────── */
.vlm-options {
    position: absolute;
    z-index: 3;
    bottom: calc(100% + 4px);
    inset-inline: var(--vlm-gutter);
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    max-height: min(260px, 45vh);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 12px;
    border: 1px solid var(--vlm-glass-line);
    border-radius: 14px;
    background: var(--vlm-raised);
    box-shadow: 0 10px 28px rgba(0, 0, 0, .35);
}
.vlm-chat-parameters {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    flex: 1 0 100%;
    gap: 10px;
    margin-bottom: 4px;
}
.vlm-chat-parameters label { min-width: 0; color: var(--vlm-text-2); font-size: 12px; }
.vlm-chat-parameters input {
    box-sizing: border-box;
    width: 100%;
    min-height: var(--vlm-hit);
    margin-top: 4px;
    padding: 0 8px;
    border: 1px solid var(--vlm-glass-line);
    border-radius: 8px;
    background: var(--vlm-ink);
    color: var(--vlm-text);
    font: inherit;
    font-size: 16px;
}
.vlm-options-note { flex-basis: 100%; margin: 2px 0 0; font-size: 12px; color: var(--vlm-text-3); line-height: 1.45; }
.vlm-font-btns { display: inline-flex; gap: 2px; }

/* ── Current photo strip + EXIF drawer ───────────────────────── */
.vlm-current-photo {
    display: none;
    align-items: center;
    gap: 8px;
    padding: 6px var(--vlm-gutter);
    border-bottom: 1px solid var(--vlm-line);
    flex-shrink: 0;
    min-width: 0;
}
.vlm-current-photo.vlm-has-photo { display: flex; }
.vlm-photo-thumb {
    width: 36px;
    height: 36px;
    border-radius: 6px;
    object-fit: cover;
    background: var(--vlm-ink);
    border: 1px solid var(--vlm-line);
    flex-shrink: 0;
}
.vlm-photo-name {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    color: var(--vlm-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.vlm-crop-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding-left: 4px;
    border: 1px solid var(--vlm-accent-line);
    border-radius: 8px;
    background: var(--vlm-accent-soft);
    font-size: 12px;
    color: var(--vlm-accent);
    flex-shrink: 0;
}
.vlm-crop-thumb { width: 24px; height: 24px; object-fit: cover; border-radius: 4px; }
.vlm-crop-clear.vlm-btn { min-height: calc(var(--vlm-hit) - 8px); min-width: calc(var(--vlm-hit) - 8px); color: var(--vlm-accent); }
.vlm-exif-drawer {
    display: none;
    max-height: 34%;
    overflow-y: auto;
    padding: 8px var(--vlm-gutter) 10px;
    border-bottom: 1px solid var(--vlm-line);
    background: var(--vlm-ink);
    flex-shrink: 0;
}
.vlm-exif-drawer.vlm-exif-open { display: block; }
.vlm-exif-table { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.vlm-exif-table td { padding: 2px 0; vertical-align: top; line-height: 1.45; }
.vlm-exif-table td:first-child { color: var(--vlm-text-3); width: 42%; padding-right: 10px; }
.vlm-exif-table td:last-child { color: var(--vlm-text); word-break: break-word; }

/* ── Notices: model download, loading, errors ────────────────── */
/* The download notice takes the chat's place until the model can answer. */
.vlm-gate { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; }
.vlm-gate > .vlm-notice { margin-block: auto; }
.vlm-panel.vlm-gated .vlm-messages:not(:has(.vlm-msg)) { display: none; }
.vlm-panel.vlm-gated .vlm-suggestions { display: none; }
.vlm-notice {
    margin: var(--vlm-gutter);
    padding: 14px;
    border: 1px solid var(--vlm-line);
    border-radius: var(--vlm-radius);
    background: var(--vlm-raised);
    flex-shrink: 0;
}
.vlm-notice-title { margin: 0 0 4px; font-size: 15px; font-weight: 500; color: var(--vlm-text); }
.vlm-notice-body { margin: 0; font-size: 13px; color: var(--vlm-text-2); line-height: 1.5; }
.vlm-notice-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.vlm-notice.vlm-notice-error { border-color: rgba(255, 123, 114, 0.45); }
.vlm-meter { margin-top: 12px; }
.vlm-meter-track { height: 6px; border-radius: 3px; background: rgba(148, 190, 220, 0.14); overflow: hidden; }
.vlm-meter-fill { height: 100%; width: 0%; border-radius: 3px; background: var(--vlm-accent); transition: width 0.3s ease; }
.vlm-meter-track.vlm-meter-indeterminate .vlm-meter-fill { width: 35%; animation: vlm-slide 1.4s ease-in-out infinite; }
@keyframes vlm-slide { 0% { transform: translateX(-110%); } 100% { transform: translateX(300%); } }
.vlm-meter-text {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-top: 5px;
    font-size: 12px;
    color: var(--vlm-text-2);
    font-variant-numeric: tabular-nums;
}

/* ── Messages ────────────────────────────────────────────────── */
.vlm-messages {
    flex: 1;
    min-height: 72px;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: var(--vlm-gutter);
    display: flex;
    flex-direction: column;
    gap: 10px;
    touch-action: pan-y;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: thin;
    scrollbar-color: var(--vlm-line-strong) transparent;
}
.vlm-empty {
    margin: auto 0;
    padding: 12px 8px;
    text-align: center;
    color: var(--vlm-text-2);
    font-size: 14px;
    line-height: 1.5;
    user-select: none;
}
.vlm-empty strong { display: block; margin-bottom: 2px; color: var(--vlm-text); font-weight: 500; font-size: 15px; overflow-wrap: anywhere; }
.vlm-msg {
    max-width: 92%;
    font-size: 1em;
    line-height: 1.55;
    padding: 8px 12px;
    border-radius: 12px;
    overflow-wrap: anywhere;
}
.vlm-msg-user {
    align-self: flex-end;
    background: var(--vlm-accent-soft);
    color: var(--vlm-text);
    border: 1px solid rgba(0, 229, 255, 0.28);
    border-bottom-right-radius: 4px;
    white-space: pre-wrap;
}
.vlm-msg-assistant {
    align-self: stretch;
    max-width: 100%;
    background: transparent;
    color: var(--vlm-text);
    border: 1px solid transparent;
    border-bottom-left-radius: 4px;
}
/* Finished answers that are scrolled away cost nothing to keep around. */
.vlm-msg-assistant.vlm-msg-settled:not(.vlm-has-map) { content-visibility: auto; contain-intrinsic-size: auto 120px; }
.vlm-msg-error { border-color: rgba(255, 123, 114, 0.45); color: var(--vlm-danger); }
.vlm-msg-assistant.vlm-streaming .vlm-msg-text::after {
    content: '';
    display: inline-block;
    width: 7px;
    height: 1em;
    margin-left: 2px;
    vertical-align: text-bottom;
    background: var(--vlm-accent);
    animation: vlm-blink 0.9s step-end infinite;
}
.vlm-msg-text { display: block; white-space: pre-wrap; overflow-wrap: anywhere; }
.vlm-msg-text.vlm-md { white-space: normal; }
.vlm-msg-text.vlm-md p { margin: 0 0 8px; }
.vlm-md > :last-child, .vlm-md-tail > :last-child { margin-bottom: 0 !important; }
.vlm-md-tail:empty { display: none; }
.vlm-msg-text.vlm-md h1, .vlm-msg-text.vlm-md h2, .vlm-msg-text.vlm-md h3, .vlm-msg-text.vlm-md h4 {
    margin: 10px 0 4px;
    font-size: 1.05em;
    font-weight: 500;
    color: var(--vlm-text);
    line-height: 1.3;
}
.vlm-msg-text.vlm-md > :first-child, .vlm-msg-text.vlm-md > .vlm-md-tail:first-child > :first-child { margin-top: 0; }
.vlm-msg-text.vlm-md code {
    padding: 1px 5px;
    border-radius: 4px;
    background: rgba(148, 190, 220, 0.14);
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 0.88em;
}
.vlm-msg-text.vlm-md pre { margin: 8px 0; padding: 8px 10px; border-radius: 8px; background: var(--vlm-ink); overflow-x: auto; }
.vlm-msg-text.vlm-md pre code { padding: 0; background: none; white-space: pre; }
.vlm-msg-text.vlm-md ul, .vlm-msg-text.vlm-md ol { margin: 4px 0 8px; padding-left: 20px; }
.vlm-msg-text.vlm-md li { margin: 2px 0; }
.vlm-msg-text.vlm-md strong { font-weight: 700; color: #fff; }
.vlm-msg-text.vlm-md blockquote { margin: 8px 0; padding-left: 10px; border-left: 2px solid var(--vlm-accent-line); color: var(--vlm-text-2); }
.vlm-msg-text.vlm-md a { color: var(--vlm-accent); text-decoration: underline; text-underline-offset: 2px; }
.vlm-msg-text.vlm-md hr { border: none; border-top: 1px solid var(--vlm-line); margin: 10px 0; }
.vlm-msg-text.vlm-md table { border-collapse: collapse; margin: 8px 0; font-size: 0.93em; display: block; overflow-x: auto; }
.vlm-msg-text.vlm-md th, .vlm-msg-text.vlm-md td { border: 1px solid var(--vlm-line); padding: 3px 8px; text-align: left; }
.vlm-msg-text.vlm-md .katex { font-size: 1em; }
.vlm-msg-text.vlm-md .katex-display { overflow-x: auto; margin: 8px 0; }
.vlm-fact-list { margin: 0; display: grid; grid-template-columns: minmax(96px, 38%) 1fr; gap: 3px 10px; font-size: 0.95em; font-variant-numeric: tabular-nums; }
.vlm-fact-list dt { color: var(--vlm-text-3); }
.vlm-fact-list dd { margin: 0; color: var(--vlm-text); overflow-wrap: anywhere; }
.vlm-fact-title { margin: 0 0 6px; font-weight: 500; }
.vlm-thinking { margin-bottom: 6px; border: 1px solid var(--vlm-line); border-radius: 8px; overflow: hidden; }
.vlm-thinking summary {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: calc(var(--vlm-hit) - 8px);
    padding: 2px 10px;
    font-size: 12.5px;
    color: var(--vlm-text-2);
    cursor: pointer;
    user-select: none;
    list-style: none;
}
.vlm-thinking summary::-webkit-details-marker { display: none; }
.vlm-thinking summary::before { content: '▸'; font-size: 11px; transition: transform 0.14s ease; }
.vlm-thinking[open] summary::before { transform: rotate(90deg); }
.vlm-thinking-text {
    max-height: 180px;
    overflow-y: auto;
    padding: 6px 10px 8px;
    border-top: 1px solid var(--vlm-line);
    font-size: 12.5px;
    color: var(--vlm-text-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
.vlm-thinking-text.vlm-md { white-space: normal; }
.vlm-thinking-text.vlm-md p { margin: 0 0 4px; }
.vlm-thinking-text.vlm-md ul, .vlm-thinking-text.vlm-md ol { margin: 3px 0 3px 16px; padding: 0; }
.vlm-msg-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 8px; }
.vlm-gen-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 0 10px;
    font-size: 12px;
    color: var(--vlm-text-3);
    font-variant-numeric: tabular-nums;
    flex: 1;
    min-width: 0;
}
.vlm-gen-stats .vlm-stat-live { color: var(--vlm-warn); }
.vlm-msg-copy.vlm-btn { min-height: calc(var(--vlm-hit) - 8px); font-size: 12px; padding: 0 10px; }

/* ── Location card (interactive map inside an answer) ────────── */
.vlm-map-embeds { margin-top: 10px; }
.vlm-map-card { margin: 0; border: 1px solid var(--vlm-line-strong); border-radius: 14px; overflow: hidden; background: var(--vlm-ink); }
.vlm-map-head {
    position: absolute;
    top: 0; left: 0; right: 0;
    z-index: 450;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 10px 12px 22px;
    background: linear-gradient(to bottom, rgba(3, 6, 13, 0.92) 0%, rgba(3, 6, 13, 0.7) 55%, rgba(3, 6, 13, 0) 100%);
    pointer-events: none;
}
.vlm-map-place { font-size: 14px; font-weight: 500; color: var(--vlm-text); overflow-wrap: anywhere; text-shadow: 0 1px 6px rgba(0, 0, 0, 0.8); }
.vlm-map-place.vlm-map-place-pending { color: var(--vlm-text-2); font-weight: 400; }
.vlm-map-region { font-size: 12.5px; color: var(--vlm-text-2); }
.vlm-map-coords { font-size: 12px; color: var(--vlm-accent); font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
.vlm-map-stage { position: relative; height: 240px; background: #060a14; }
.vlm-map-canvas { position: absolute; inset: 0; background: #060a14; outline-offset: -2px; z-index: 0; }
.vlm-map-stage.vlm-map-engaged { box-shadow: inset 0 0 0 2px var(--vlm-accent); }
.vlm-map-stage.vlm-map-engaged .vlm-map-canvas { cursor: grab; }
.vlm-map-status {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 56px 16px 16px;
    text-align: center;
    font-size: 13px;
    color: var(--vlm-text-2);
    pointer-events: none;
}
.vlm-map-engage.vlm-btn {
    position: absolute;
    left: 8px;
    bottom: 24px;
    z-index: 500;
    min-height: 32px;
    padding: 0 12px;
    border-radius: 999px;
    border-color: rgba(255, 255, 255, 0.14);
    background: rgba(8, 12, 20, 0.72);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
    color: var(--vlm-text);
    font-size: 12.5px;
}
.vlm-map-engaged .vlm-map-engage.vlm-btn { border-color: var(--vlm-accent-line); color: var(--vlm-accent); }
@media (pointer: coarse) { .vlm-map-engage.vlm-btn { min-height: 44px; padding: 0 16px; } }
.vlm-map-actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px; border-top: 1px solid var(--vlm-line); }
.vlm-map-actions .vlm-btn { flex: 1 1 auto; }
.vlm-map-collapsed { padding: 8px; display: flex; }
.vlm-map-collapsed .vlm-btn { flex: 1; }
/* Leaflet, restyled for the space theme. Tiles are darkened in place; markers and controls are not filtered.
   Selectors start with .vlm-map-canvas.leaflet-container so they outrank leaflet.css, which loads later. */
.vlm-map-canvas.leaflet-container { background: #060a14; font-family: var(--vlm-font); }
.vlm-map-canvas.leaflet-container .leaflet-tile-pane { filter: invert(1) hue-rotate(188deg) saturate(0.62) brightness(0.9) contrast(0.92); }
.vlm-map-canvas.leaflet-container .leaflet-bar { border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 10px; overflow: hidden; box-shadow: none; background-clip: padding-box; }
.vlm-map-canvas.leaflet-container .leaflet-bar a {
    width: 34px;
    height: 34px;
    line-height: 32px;
    background: rgba(8, 12, 20, 0.86);
    color: var(--vlm-text);
    border-bottom: 1px solid var(--vlm-line);
}
.vlm-map-canvas.leaflet-container .leaflet-bar a:last-child { border-bottom: none; }
.vlm-map-canvas.leaflet-container .leaflet-bar a:hover { background: var(--vlm-raised-2); color: var(--vlm-accent); }
.vlm-map-canvas.leaflet-container .leaflet-bar a.leaflet-disabled { background: rgba(8, 12, 20, 0.86); color: var(--vlm-text-3); }
@media (pointer: coarse) {
    .vlm-map-canvas.leaflet-container .leaflet-bar a { width: 44px; height: 44px; line-height: 42px; font-size: 22px; }
}
.vlm-map-canvas.leaflet-container .leaflet-control-attribution {
    background: rgba(3, 6, 13, 0.82);
    color: var(--vlm-text-2);
    font-size: 11px;
    line-height: 1.5;
    padding: 1px 6px;
    border-top-left-radius: 6px;
}
.vlm-map-canvas.leaflet-container .leaflet-control-attribution a { color: var(--vlm-text); text-decoration: underline; }
.vlm-map-canvas.leaflet-container .leaflet-control-scale-line {
    background: rgba(3, 6, 13, 0.7);
    color: var(--vlm-text-2);
    border-color: var(--vlm-text-3);
    text-shadow: none;
    font-size: 11px;
}
.vlm-map-pin { position: relative; width: 28px; height: 28px; }
.vlm-map-pin::before {
    content: '';
    position: absolute;
    inset: 8px;
    border-radius: 50%;
    background: var(--vlm-accent);
    box-shadow: 0 0 0 2px #03060d, 0 0 14px 2px rgba(0, 229, 255, 0.8);
}
.vlm-map-pin::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 2px solid var(--vlm-accent);
    opacity: 0.7;
    animation: vlm-ping 2.2s ease-out infinite;
}
@keyframes vlm-ping { 0% { transform: scale(0.45); opacity: 0.9; } 100% { transform: scale(1.5); opacity: 0; } }
.vlm-map-photo-pin { position: relative; width: 84px; height: 98px; filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.7)); }
.vlm-map-photo-pin img {
    display: block;
    width: 84px;
    height: 84px;
    object-fit: cover;
    border-radius: 12px;
    border: 2px solid var(--vlm-accent);
    background: var(--vlm-ink);
}
.vlm-map-photo-pin::after {
    content: '';
    position: absolute;
    left: 50%;
    bottom: 2px;
    width: 14px;
    height: 14px;
    margin-left: -7px;
    background: var(--vlm-accent);
    transform: rotate(45deg);
    border-radius: 2px;
    z-index: -1;
}
.vlm-map-photo-pin.vlm-map-photo-pin-sm { width: 48px; height: 62px; }
.vlm-map-photo-pin.vlm-map-photo-pin-sm img { width: 48px; height: 48px; border-radius: 8px; }
.vlm-map-photo-pin.vlm-map-photo-pin-sm::after { width: 10px; height: 10px; margin-left: -5px; bottom: 9px; }
/* Expanded map: the map fills the viewport; title, actions and links float on glass above it. */
.vlm-map-overlay {
    position: fixed;
    inset: 0;
    z-index: 13000;   /* above every page control, including open menus (12001) */
    background: var(--vlm-ink);
    animation: vlm-map-in 0.24s ease-out;
}
@keyframes vlm-map-in { from { opacity: 0; transform: scale(0.985); } to { opacity: 1; transform: none; } }
.vlm-map-overlay-stage { position: absolute; inset: 0; background: #060a14; }
.vlm-map-overlay-stage .vlm-map-canvas { position: absolute; inset: 0; }
.vlm-map-overlay-stage iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
.vlm-map-overlay-bar {
    position: absolute;
    z-index: 1000;
    top: max(12px, env(safe-area-inset-top, 0px));
    left: max(12px, env(safe-area-inset-left, 0px));
    right: max(12px, env(safe-area-inset-right, 0px));
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    padding: 10px 10px 10px 14px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 14px;
    background: rgba(8, 12, 20, 0.72);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
}
.vlm-map-overlay-title { flex: 1 1 200px; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.vlm-map-overlay-title .vlm-map-place { font-size: 16px; }
.vlm-map-overlay-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.vlm-map-overlay-actions .vlm-btn { border-radius: 999px; }
.vlm-map-overlay .leaflet-top.leaflet-right { top: var(--vlm-map-bar, 84px); }
.vlm-map-close.vlm-btn { order: 2; }
.vlm-map-close.vlm-btn svg { flex: none; }
@media (max-width: 600px) {
    /* Phones: place name and Close on the first line, the view switches below. */
    .vlm-map-overlay-title { order: 0; flex: 1 1 0; }
    .vlm-map-close.vlm-btn { order: 1; width: var(--vlm-hit); padding: 0; justify-content: center; }
    .vlm-map-close.vlm-btn span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .vlm-map-overlay-actions { order: 2; flex: 1 1 100%; }
    .vlm-map-overlay-actions .vlm-btn { flex: 1 1 auto; }
}
.vlm-map-overlay-foot {
    position: absolute;
    z-index: 1000;
    left: max(12px, env(safe-area-inset-left, 0px));
    bottom: calc(max(12px, env(safe-area-inset-bottom, 0px)) + 34px);
    max-width: calc(100% - 24px);
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    padding: 6px 12px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 14px;
    background: rgba(8, 12, 20, 0.72);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
    font-size: 12px;
    color: var(--vlm-text-3);
}
.vlm-map-overlay-foot { align-items: center; }
.vlm-map-overlay-foot a { color: var(--vlm-text); display: inline-flex; align-items: center; min-height: 32px; }
.vlm-map-foot-label { color: var(--vlm-text-3); }
@media (pointer: coarse) { .vlm-map-overlay-foot a { min-height: 44px; } }
.vlm-map-overlay .vlm-map-canvas.leaflet-container .leaflet-bottom.leaflet-left { bottom: 0; }

/* ── Composer ────────────────────────────────────────────────── */
.vlm-tts-bar {
    display: none;
    max-height: 3.2em;
    overflow: hidden;
    padding: 5px var(--vlm-gutter);
    border-top: 1px solid var(--vlm-line);
    font-size: 12.5px;
    color: var(--vlm-text-2);
    line-height: 1.5;
    flex-shrink: 0;
}
.vlm-tts-bar.vlm-tts-bar-on { display: block; }
.vlm-tts-hl { background: rgba(0, 229, 255, 0.24); color: #fff; border-radius: 2px; padding: 0 1px; }
.vlm-composer { position: relative; flex-shrink: 0; background: var(--vlm-surface); padding-bottom: 8px; }
.vlm-suggestions {
    display: flex;
    gap: 6px;
    padding: 8px var(--vlm-gutter) 0;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-x: contain;
}
.vlm-suggestions::-webkit-scrollbar { display: none; }
.vlm-suggestion.vlm-btn { color: var(--vlm-text-2); font-weight: 500; }
.vlm-suggestion.vlm-btn:hover:not(:disabled) { color: var(--vlm-text); }
.vlm-input-area {
    margin: 8px var(--vlm-gutter) 0;
    border: 1px solid var(--vlm-glass-line);
    border-radius: 20px;
    background: var(--vlm-raised);
    transition: border-color 0.14s ease;
}
.vlm-input-area:focus-within { border-color: var(--vlm-accent-line); }
.vlm-input {
    display: block;
    width: 100%;
    min-height: max(40px, var(--vlm-hit));
    max-height: 120px;
    padding: 10px 12px 4px;
    border: 0;
    background: transparent;
    color: var(--vlm-text);
    font-size: 16px; /* 16px prevents iOS auto-zoom on focus */
    line-height: 1.4;
    resize: none;
    outline: none;
    touch-action: auto;
}
.vlm-input:focus-visible { outline: none; }
.vlm-input::placeholder { color: var(--vlm-text-3); opacity: 1; }
.vlm-input-tools { display: flex; align-items: center; gap: 4px; padding: 4px 6px 6px; min-width: 0; }
.vlm-input-tools .vlm-toolbar-spacer { flex: 1; }
.vlm-mic-btn.vlm-mic-active { color: var(--vlm-danger); border-color: rgba(255, 123, 114, 0.5); background: rgba(255, 123, 114, 0.12); }
.vlm-tts-btn.vlm-tts-speaking { color: var(--vlm-ok); border-color: rgba(86, 227, 161, 0.5); background: rgba(86, 227, 161, 0.1); }
.vlm-live-btn.vlm-live-on { color: var(--vlm-danger); border-color: rgba(255, 123, 114, 0.5); background: rgba(255, 123, 114, 0.12); }
.vlm-live-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.vlm-live-btn.vlm-live-on .vlm-live-dot { animation: vlm-blink 1.2s ease-in-out infinite; }
.vlm-send-btn.vlm-btn { padding: 0; border-radius: 50%; font-size: 22px; line-height: 1; }
.vlm-stop-btn.vlm-btn { border-radius: 50%; }

@media (prefers-reduced-motion: no-preference) {
    .vlm-mic-btn.vlm-mic-active { animation: vlm-mic-pulse 3s ease-in-out infinite; }
}

@keyframes vlm-mic-pulse {
    0%, 100% { box-shadow: inset 0 0 0 0 rgba(255, 123, 114, .06); }
    50% { box-shadow: inset 0 0 0 3px rgba(255, 123, 114, .24); }
}

/* ── Portfolio search ────────────────────────────────────────── */
.vlm-search-view { display: none; min-height: 0; flex: 1; flex-direction: column; }
.vlm-panel[data-vlm-mode="search"] .vlm-search-view { display: flex; }
.vlm-panel[data-vlm-mode="search"] .vlm-chat-only { display: none !important; }
.vlm-search-controls { padding: 10px var(--vlm-gutter); border-bottom: 1px solid var(--vlm-line); display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; }
.vlm-search-input {
    width: 100%;
    min-height: var(--vlm-hit);
    padding: 0 12px;
    border: 1px solid var(--vlm-glass-line);
    border-radius: 999px;
    background: var(--vlm-raised);
    color: var(--vlm-text);
    font-size: 16px;
}
.vlm-search-input:focus { outline: none; border-color: var(--vlm-accent-line); }
.vlm-search-input::placeholder { color: var(--vlm-text-3); opacity: 1; }
.vlm-search-scopes { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.vlm-search-coverage { flex: 1 1 100%; color: var(--vlm-text-3); font-size: 12px; font-variant-numeric: tabular-nums; }
.vlm-search-results {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 10px var(--vlm-gutter);
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
    gap: 8px;
    align-content: start;
    scrollbar-width: thin;
    scrollbar-color: var(--vlm-line-strong) transparent;
}
.vlm-search-note { grid-column: 1 / -1; color: var(--vlm-text-2); padding: 18px 8px; text-align: center; line-height: 1.5; font-size: 13.5px; }
.vlm-result {
    appearance: none;
    padding: 0;
    overflow: hidden;
    text-align: left;
    border: 1px solid var(--vlm-line);
    border-radius: var(--vlm-radius);
    background: var(--vlm-raised);
    color: var(--vlm-text);
    cursor: pointer;
    font: inherit;
    content-visibility: auto;
    contain-intrinsic-size: auto 180px;
}
.vlm-result:hover, .vlm-result:focus-visible { border-color: var(--vlm-accent-line); }
.vlm-result img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; display: block; background: var(--vlm-ink); }
.vlm-result-body { display: block; padding: 6px 8px 8px; }
.vlm-result-title { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13px; }
.vlm-result-meta { display: block; color: var(--vlm-text-3); font-size: 12px; text-transform: capitalize; margin-top: 1px; }
.vlm-result-caption { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 12px; line-height: 1.35; margin-top: 3px; color: var(--vlm-text-2); }

/* ── Fullscreen ──────────────────────────────────────────────── */
.vlm-panel.vlm-fullscreen {
    inset: 0 !important;
    width: 100% !important;
    height: 100dvh !important;
    max-height: none !important;
    border-radius: 0;
    border: 0;
    transform: none !important;
}
.vlm-panel.vlm-fullscreen .vlm-resize-handle { display: none; }
.vlm-fullscreen-photo { display: none; }
.vlm-panel.vlm-fullscreen .vlm-fullscreen-photo { -webkit-touch-callout: none; user-select: none; -webkit-user-drag: none; }
.vlm-panel.vlm-fullscreen.vlm-has-preview { padding-left: 55%; }
.vlm-panel.vlm-fullscreen.vlm-has-preview .vlm-fullscreen-photo {
    display: block;
    position: absolute;
    inset: 0 auto 0 0;
    width: 55%;
    height: 100%;
    object-fit: contain;
    background: var(--vlm-ink);
    border-right: 1px solid var(--vlm-line);
}
@media (max-width: 800px) {
    .vlm-panel.vlm-fullscreen.vlm-has-preview { padding-left: 0; }
    .vlm-panel.vlm-fullscreen.vlm-has-preview .vlm-fullscreen-photo {
        position: static;
        width: 100%;
        height: 26dvh;
        flex-shrink: 0;
        border-right: 0;
        border-bottom: 1px solid var(--vlm-line);
    }
    .vlm-panel.vlm-fullscreen.vlm-has-preview .vlm-photo-thumb { display: none; }
}

/* ── Iframe-panel mode: fills the host iframe ────────────────── */
.vlm-panel.vlm-iframe-mode {
    inset: 0;
    width: 100% !important;
    height: 100dvh !important;
    max-height: none !important;
    transform: none !important;
    visibility: visible !important;
    pointer-events: auto !important;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    z-index: 1;
}
.vlm-panel.vlm-iframe-mode .vlm-resize-handle { left: 0; }

/* ── Phones: a bottom sheet ──────────────────────────────────── */
@media (max-width: 600px) {
    .vlm-panel:not(.vlm-iframe-mode):not(.vlm-fullscreen) {
        left: 0;
        right: 0;
        top: auto;
        bottom: var(--vlm-kb, 0px);
        width: 100% !important;
        /* Half height by default so the photo above stays in view; never taller than the visible viewport. */
        height: min(calc(var(--vlm-vvh, 100dvh) - 12px), max(58dvh, 430px));
        padding-bottom: env(safe-area-inset-bottom, 0px);
        border-left: 0;
        border-top: 1px solid var(--vlm-line-strong);
        border-radius: 14px 14px 0 0;
        box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.45);
        transform: translateY(105%);
    }
    .vlm-panel.vlm-open:not(.vlm-iframe-mode):not(.vlm-fullscreen) { transform: none; }
    /* Until the model can answer, the sheet is the download notice: it rises far enough that the
       notice and its action button fit above the composer instead of scrolling under it. */
    .vlm-panel.vlm-gated:not(.vlm-iframe-mode):not(.vlm-fullscreen) { height: min(calc(var(--vlm-vvh, 100dvh) - 12px), max(72dvh, 520px)); }
    .vlm-gate > .vlm-notice { margin: 8px var(--vlm-gutter); padding: 12px; }
    .vlm-panel.vlm-fullscreen { bottom: var(--vlm-kb, 0px) !important; height: auto !important; top: 0 !important; }
    .vlm-panel.vlm-kb-open { padding-bottom: 0 !important; }
    .vlm-panel.vlm-dragging { transition: none !important; }
    .vlm-panel:not(.vlm-iframe-mode) .vlm-resize-handle { display: none; }
    .vlm-panel:not(.vlm-iframe-mode) .vlm-header { cursor: grab; touch-action: none; position: relative; padding-top: 14px; }
    .vlm-panel:not(.vlm-iframe-mode):not(.vlm-fullscreen) .vlm-header::before {
        content: '';
        position: absolute;
        top: 6px;
        left: 50%;
        width: 40px;
        height: 4px;
        margin-left: -20px;
        border-radius: 2px;
        background: var(--vlm-line-strong);
    }
    .vlm-panel.vlm-fullscreen .vlm-header { padding-top: max(8px, env(safe-area-inset-top, 0px)); }
    .vlm-composer { padding-bottom: 8px; }
    /* A gallery photo viewer on the same page keeps its photo in view above the sheet. */
    html.vlm-panel-open #imageViewer { box-sizing: border-box; padding-bottom: var(--vlm-sheet-h, 0px); transition: padding-bottom 0.22s ease; }
    /* The site's performance readout (assets/js/live-fps.js) floats above everything; it would cover the composer. */
    html.vlm-panel-open #site-performance-hud { display: none !important; }
    /* Once a conversation is under way the sample prompts give their room to the answers. */
    .vlm-panel.vlm-has-chat:not(.vlm-fullscreen) .vlm-suggestions { display: none; }
    .vlm-map-stage { height: 200px; }
}
@media (max-width: 359px) {
    .vlm-panel { --vlm-gutter: 10px; }
    .vlm-mode-tab.vlm-btn { padding: 0 9px; }
    .vlm-toolbar { gap: 4px; }
}

/* ── Crop modal ──────────────────────────────────────────────── */
.vlm-crop-modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 13000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: max(12px, env(safe-area-inset-top, 0px)) 12px max(12px, env(safe-area-inset-bottom, 0px));
    background: rgba(3, 6, 13, 0.86);
}
.vlm-crop-modal {
    width: min(720px, 100%);
    height: min(620px, 100%);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--vlm-line-strong);
    border-radius: 14px;
    background: var(--vlm-surface);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
}
.vlm-crop-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 8px 8px 14px; border-bottom: 1px solid var(--vlm-line); }
.vlm-crop-title { font-size: 15px; font-weight: 500; }
.vlm-crop-body {
    flex: 1;
    min-height: 0;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    padding: 14px;
    background: var(--vlm-ink);
    user-select: none;
    -webkit-user-select: none;
}
.vlm-crop-stage { position: relative; max-width: 100%; max-height: 100%; display: flex; align-items: center; justify-content: center; }
.vlm-crop-img { max-width: 100%; max-height: 100%; display: block; object-fit: contain; pointer-events: none; }
.vlm-crop-mask { position: absolute; background: rgba(3, 6, 13, 0.68); pointer-events: none; }
.vlm-crop-box { position: absolute; border: 2px solid var(--vlm-accent); box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6); cursor: move; touch-action: none; }
.vlm-crop-grid {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
        linear-gradient(to right, rgba(255, 255, 255, 0.22) 1px, transparent 1px) 0 0 / 33.33% 100%,
        linear-gradient(to bottom, rgba(255, 255, 255, 0.22) 1px, transparent 1px) 0 0 / 100% 33.33%;
}
.vlm-crop-handle { position: absolute; width: 14px; height: 14px; background: var(--vlm-accent); border: 2px solid var(--vlm-ink); border-radius: 3px; }
/* A finger-sized hit area around each visible handle. */
.vlm-crop-handle::after { content: ''; position: absolute; inset: -15px; }
.vlm-crop-handle.handle-nw { top: -8px; left: -8px; cursor: nwse-resize; }
.vlm-crop-handle.handle-ne { top: -8px; right: -8px; cursor: nesw-resize; }
.vlm-crop-handle.handle-sw { bottom: -8px; left: -8px; cursor: nesw-resize; }
.vlm-crop-handle.handle-se { bottom: -8px; right: -8px; cursor: nwse-resize; }
.vlm-crop-handle.handle-n { top: -8px; left: calc(50% - 7px); cursor: ns-resize; }
.vlm-crop-handle.handle-s { bottom: -8px; left: calc(50% - 7px); cursor: ns-resize; }
.vlm-crop-handle.handle-w { top: calc(50% - 7px); left: -8px; cursor: ew-resize; }
.vlm-crop-handle.handle-e { top: calc(50% - 7px); right: -8px; cursor: ew-resize; }
.vlm-crop-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--vlm-line); }
.vlm-crop-actions-right { display: flex; gap: 8px; margin-left: auto; }
.vlm-crop-error { flex-basis: 100%; margin: 0; font-size: 13px; color: var(--vlm-danger); }

/* ── Motion preferences ──────────────────────────────────────── */
@media (prefers-reduced-motion: reduce) {
    .vlm-panel, .vlm-panel *, .vlm-map-overlay *, .vlm-crop-modal-overlay * {
        animation-duration: 0.001ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.001ms !important;
    }
    .vlm-map-pin::after { display: none; }
    .vlm-meter-track.vlm-meter-indeterminate .vlm-meter-fill { width: 100%; opacity: 0.4; transform: none; }
}
`;

// ─── Icons (inline SVG, 1.8px strokes, currentColor) ─────────────────────────

const svg = (body, size = 18) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICONS = Object.freeze({
    inspect: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/><path d="M11 8v6M8 11h6"/>', 20),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
    expand: svg('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
    collapse: svg('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>'),
    close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    sliders: svg('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
    crop: svg('<path d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14"/>', 16),
    mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
    speakerOn: svg('<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>'),
    speakerOff: svg('<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="m17 9.5 5 5M22 9.5l-5 5"/>'),
    stop: svg('<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/>', 16),
});
