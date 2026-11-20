/**
 * ImageCrop.js — Image cropping utilities and interactive Crop Modal for VLM Search.
 */

/**
 * Clamp a number between min and max.
 */
function clamp(val, min = 0, max = 1) {
    return Math.max(min, Math.min(max, val));
}

/**
 * Normalise and sanitize crop rectangle coordinates (normalized 0..1 range).
 * Ensures width and height are at least 0.02 (2%) and fit within image bounds.
 *
 * @param {object} rect { x, y, width, height }
 * @returns {object} { x, y, width, height }
 */
export function normalizeCropRect(rect = {}) {
    let width = clamp(rect.width ?? 0.8, 0.02, 1);
    let height = clamp(rect.height ?? 0.8, 0.02, 1);
    let x = clamp(rect.x ?? 0.1, 0, 1 - width);
    let y = clamp(rect.y ?? 0.1, 0, 1 - height);

    return { x, y, width, height };
}

/**
 * Crop an image source (URL or Data-URI) using specified normalized coordinates.
 * Returns a Promise that resolves to a JPEG data-URI of the crop.
 *
 * @param {string} imageSource  Original image URL or data-URI
 * @param {object} cropRect     { x, y, width, height } in 0..1 range
 * @param {object} options      { maxDim, quality }
 * @returns {Promise<string>}   Cropped JPEG Data-URI
 */
export function cropImage(imageSource, cropRect, { maxDim = 1120, quality = 0.90 } = {}) {
    return new Promise((resolve, reject) => {
        if (!imageSource) {
            reject(new Error('No image source provided for cropping'));
            return;
        }

        const norm = normalizeCropRect(cropRect);
        const img = new Image();
        img.crossOrigin = 'anonymous';

        img.onload = () => {
            try {
                const nw = img.naturalWidth || img.width;
                const nh = img.naturalHeight || img.height;

                if (!nw || !nh) {
                    reject(new Error('Invalid image dimensions'));
                    return;
                }

                const px = Math.round(norm.x * nw);
                const py = Math.round(norm.y * nh);
                const pw = Math.max(1, Math.round(norm.width * nw));
                const ph = Math.max(1, Math.round(norm.height * nh));

                // Determine target scale if maxDim is requested
                const scale = Math.min(1, maxDim / pw, maxDim / ph);
                const targetW = Math.max(1, Math.round(pw * scale));
                const targetH = Math.max(1, Math.round(ph * scale));

                const canvas = document.createElement('canvas');
                canvas.width = targetW;
                canvas.height = targetH;
                const ctx = canvas.getContext('2d');

                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, px, py, pw, ph, 0, 0, targetW, targetH);

                resolve(canvas.toDataURL('image/jpeg', quality));
            } catch (err) {
                reject(err);
            }
        };

        img.onerror = () => {
            reject(new Error('Failed to load image for cropping'));
        };

        img.src = imageSource;
    });
}

/**
 * Interactive Crop Modal UI Component
 */
export class ImageCropModal {
    /**
     * @param {object} options
     * @param {string} options.imageSrc  Source image URL or data-URI
     * @param {object} [options.initialCrop] Initial crop rect { x, y, width, height }
     * @param {function} options.onApply  Callback(croppedDataUrl, cropRect)
     * @param {function} [options.onReset] Callback() when user selects full image
     * @param {function} [options.onCancel] Callback()
     * @param {HTMLElement} [options.returnFocus] Element focused again when the dialog closes
     */
    constructor({ imageSrc, initialCrop, onApply, onReset, onCancel, returnFocus = null }) {
        this.imageSrc = imageSrc;
        this.cropRect = normalizeCropRect(initialCrop ?? { x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
        this.onApply = onApply;
        this.onReset = onReset;
        this.onCancel = onCancel;
        this.returnFocus = returnFocus;

        this.modalEl = null;
        this.imgEl = null;
        this.boxEl = null;
        this.stageEl = null;
        this.masks = null;
        this.isDragging = false;
        this.dragMode = null; // 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'
        this.dragStartPos = null;
        this.dragStartRect = null;
        this._frame = 0;
        this._scope = null;
    }

    open() {
        this.close({ restoreFocus: false }); // Ensure clean state

        const overlay = document.createElement('div');
        overlay.className = 'vlm-crop-modal-overlay';
        overlay.innerHTML = `
<div class="vlm-crop-modal" role="dialog" aria-modal="true" aria-label="Crop Image">
    <div class="vlm-crop-header">
        <span class="vlm-crop-title">Crop A Region To Ask About</span>
        <button class="vlm-btn vlm-btn-icon vlm-crop-close-btn" type="button" title="Close Crop" aria-label="Close Crop"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>
    <div class="vlm-crop-body">
        <div class="vlm-crop-stage">
            <img class="vlm-crop-img" alt="Photo being cropped" draggable="false" />
            <div class="vlm-crop-mask vlm-crop-mask-top"></div>
            <div class="vlm-crop-mask vlm-crop-mask-bottom"></div>
            <div class="vlm-crop-mask vlm-crop-mask-left"></div>
            <div class="vlm-crop-mask vlm-crop-mask-right"></div>
            <div class="vlm-crop-box" tabindex="0" role="group" aria-label="Crop Selection: Drag To Move, Arrow Keys To Nudge, Shift With Arrow Keys To Resize">
                <div class="vlm-crop-grid"></div>
                <div class="vlm-crop-handle handle-nw" data-handle="nw"></div>
                <div class="vlm-crop-handle handle-ne" data-handle="ne"></div>
                <div class="vlm-crop-handle handle-sw" data-handle="sw"></div>
                <div class="vlm-crop-handle handle-se" data-handle="se"></div>
                <div class="vlm-crop-handle handle-n"  data-handle="n"></div>
                <div class="vlm-crop-handle handle-s"  data-handle="s"></div>
                <div class="vlm-crop-handle handle-w"  data-handle="w"></div>
                <div class="vlm-crop-handle handle-e"  data-handle="e"></div>
            </div>
        </div>
    </div>
    <div class="vlm-crop-footer">
        <button class="vlm-btn vlm-crop-btn-reset" type="button">Use Full Image</button>
        <div class="vlm-crop-actions-right">
            <button class="vlm-btn vlm-crop-btn-cancel" type="button">Cancel</button>
            <button class="vlm-btn vlm-btn-primary vlm-crop-btn-apply" type="button">Apply Crop</button>
        </div>
        <p class="vlm-crop-error" role="alert" hidden></p>
    </div>
</div>`;

        document.body.appendChild(overlay);
        this.modalEl = overlay;
        this.stageEl = overlay.querySelector('.vlm-crop-stage');
        this.imgEl = overlay.querySelector('.vlm-crop-img');
        this.boxEl = overlay.querySelector('.vlm-crop-box');
        this.masks = ['top', 'bottom', 'left', 'right'].map(side => overlay.querySelector(`.vlm-crop-mask-${side}`));
        this.imgEl.onload = () => this.updateUI();
        this.imgEl.src = this.imageSrc;   // set as a property: never parsed as HTML

        const scope = this._scope = new AbortController();
        const { signal } = scope;
        const cancel = () => { this.close(); this.onCancel?.(); };
        overlay.querySelector('.vlm-crop-close-btn').addEventListener('click', cancel, { signal });
        overlay.querySelector('.vlm-crop-btn-cancel').addEventListener('click', cancel, { signal });
        overlay.querySelector('.vlm-crop-btn-reset').addEventListener('click', () => { this.close(); this.onReset?.(); }, { signal });
        overlay.addEventListener('pointerdown', (event) => { if (event.target === overlay) cancel(); }, { signal });

        const applyBtn = overlay.querySelector('.vlm-crop-btn-apply');
        const errorEl = overlay.querySelector('.vlm-crop-error');
        applyBtn.addEventListener('click', async () => {
            applyBtn.disabled = true;
            applyBtn.textContent = 'Cropping…';
            errorEl.hidden = true;
            try {
                const croppedDataUrl = await cropImage(this.imageSrc, this.cropRect);
                this.close();
                this.onApply?.(croppedDataUrl, this.cropRect);
            } catch (err) {
                errorEl.textContent = `The photo could not be cropped: ${err.message}`;
                errorEl.hidden = false;
                applyBtn.disabled = false;
                applyBtn.textContent = 'Apply Crop';
            }
        }, { signal });

        overlay.addEventListener('keydown', (event) => this._onKeyDown(event), { signal });
        this.boxEl.addEventListener('pointerdown', (event) => this._onPointerDown(event), { signal });
        window.addEventListener('pointermove', (event) => this._onPointerMove(event), { signal, passive: true });
        window.addEventListener('pointerup', () => this._onPointerUp(), { signal, passive: true });
        window.addEventListener('pointercancel', () => this._onPointerUp(), { signal, passive: true });
        window.addEventListener('resize', () => this._scheduleUpdate(), { signal, passive: true });

        this.updateUI();
        applyBtn.focus({ preventScroll: true });
    }

    close({ restoreFocus = true } = {}) {
        if (!this.modalEl) return;
        this._scope?.abort();
        this._scope = null;
        if (this._frame) cancelAnimationFrame(this._frame);
        this._frame = 0;
        this.modalEl.remove();
        this.modalEl = null;
        if (restoreFocus && this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
    }

    _scheduleUpdate() {
        if (this._frame) return;
        this._frame = requestAnimationFrame(() => { this._frame = 0; this.updateUI(); });
    }

    updateUI() {
        if (!this.imgEl || !this.boxEl || !this.stageEl) return;

        // Read everything first, then write: one layout per frame.
        const imgRect = this.imgEl.getBoundingClientRect();
        const stageRect = this.stageEl.getBoundingClientRect();
        if (imgRect.width === 0 || imgRect.height === 0) return;

        const imgLeft = imgRect.left - stageRect.left;
        const imgTop = imgRect.top - stageRect.top;
        const { x, y, width, height } = this.cropRect;
        const boxLeft = imgLeft + x * imgRect.width;
        const boxTop = imgTop + y * imgRect.height;
        const boxWidth = width * imgRect.width;
        const boxHeight = height * imgRect.height;

        const place = (el, left, top, w, h) => {
            el.style.left = `${left}px`;
            el.style.top = `${top}px`;
            el.style.width = `${Math.max(0, w)}px`;
            el.style.height = `${Math.max(0, h)}px`;
        };
        place(this.boxEl, boxLeft, boxTop, boxWidth, boxHeight);
        const [maskTop, maskBottom, maskLeft, maskRight] = this.masks;
        place(maskTop, imgLeft, imgTop, imgRect.width, y * imgRect.height);
        place(maskBottom, imgLeft, boxTop + boxHeight, imgRect.width, (1 - y - height) * imgRect.height);
        place(maskLeft, imgLeft, boxTop, x * imgRect.width, boxHeight);
        place(maskRight, boxLeft + boxWidth, boxTop, (1 - x - width) * imgRect.width, boxHeight);
    }

    _onKeyDown(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.close();
            this.onCancel?.();
            return;
        }
        // Keys used in the dialog never reach the gallery behind it.
        event.stopPropagation();
        if (event.key === 'Tab') {
            const focusable = [...this.modalEl.querySelectorAll('button:not([disabled]), [tabindex="0"]')];
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
            return;
        }
        if (event.target !== this.boxEl) return;
        const step = event.altKey ? 0.002 : 0.02;
        const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
        if (!delta) return;
        event.preventDefault();
        let { x, y, width, height } = this.cropRect;
        if (event.shiftKey) {
            width = clamp(width + delta[0], 0.04, 1 - x);
            height = clamp(height + delta[1], 0.04, 1 - y);
        } else {
            x = clamp(x + delta[0], 0, 1 - width);
            y = clamp(y + delta[1], 0, 1 - height);
        }
        this.cropRect = { x, y, width, height };
        this._scheduleUpdate();
    }

    _onPointerDown(e) {
        if (e.button != null && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();

        const handle = e.target.getAttribute('data-handle');
        this.dragMode = handle || 'move';
        this.isDragging = true;
        this.dragStartPos = { x: e.clientX, y: e.clientY };
        this.dragStartRect = { ...this.cropRect };
        this._dragImage = this.imgEl.getBoundingClientRect();   // measured once per drag

        try { this.boxEl.setPointerCapture(e.pointerId); } catch (_) {}
    }

    _onPointerMove(e) {
        if (!this.isDragging || !this.imgEl) return;

        const imgRect = this._dragImage;
        if (!imgRect || imgRect.width === 0 || imgRect.height === 0) return;

        const dx = (e.clientX - this.dragStartPos.x) / imgRect.width;
        const dy = (e.clientY - this.dragStartPos.y) / imgRect.height;

        let { x, y, width, height } = this.dragStartRect;

        const minSize = 0.04;

        if (this.dragMode === 'move') {
            x = clamp(x + dx, 0, 1 - width);
            y = clamp(y + dy, 0, 1 - height);
        } else {
            if (this.dragMode.includes('e')) {
                width = clamp(width + dx, minSize, 1 - x);
            }
            if (this.dragMode.includes('s')) {
                height = clamp(height + dy, minSize, 1 - y);
            }
            if (this.dragMode.includes('w')) {
                const newX = clamp(x + dx, 0, x + width - minSize);
                width = width + (x - newX);
                x = newX;
            }
            if (this.dragMode.includes('n')) {
                const newY = clamp(y + dy, 0, y + height - minSize);
                height = height + (y - newY);
                y = newY;
            }
        }

        this.cropRect = { x, y, width, height };
        this._scheduleUpdate();   // many pointer events per frame, one write
    }

    _onPointerUp() {
        if (this.isDragging) {
            this.isDragging = false;
            this.dragMode = null;
            this._dragImage = null;
        }
    }
}
