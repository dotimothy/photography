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
     */
    constructor({ imageSrc, initialCrop, onApply, onReset, onCancel }) {
        this.imageSrc = imageSrc;
        this.cropRect = normalizeCropRect(initialCrop ?? { x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
        this.onApply = onApply;
        this.onReset = onReset;
        this.onCancel = onCancel;

        this.modalEl = null;
        this.imgEl = null;
        this.boxEl = null;
        this.stageEl = null;
        this.isDragging = false;
        this.dragMode = null; // 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'
        this.dragStartPos = null;
        this.dragStartRect = null;

        this._onPointerDown = this._onPointerDown.bind(this);
        this._onPointerMove = this._onPointerMove.bind(this);
        this._onPointerUp = this._onPointerUp.bind(this);
        this._onResize = this._onResize.bind(this);
    }

    open() {
        this.close(); // Ensure clean state

        const overlay = document.createElement('div');
        overlay.className = 'vlm-crop-modal-overlay';
        overlay.innerHTML = `
<div class="vlm-crop-modal" role="dialog" aria-modal="true" aria-label="Crop Image">
    <div class="vlm-crop-header">
        <span class="vlm-crop-title">Crop Image Region</span>
        <button class="vlm-crop-close-btn" type="button" aria-label="Close">&times;</button>
    </div>
    <div class="vlm-crop-body">
        <div class="vlm-crop-stage">
            <img class="vlm-crop-img" src="${this.imageSrc}" alt="Crop preview" />
            <div class="vlm-crop-mask vlm-crop-mask-top"></div>
            <div class="vlm-crop-mask vlm-crop-mask-bottom"></div>
            <div class="vlm-crop-mask vlm-crop-mask-left"></div>
            <div class="vlm-crop-mask vlm-crop-mask-right"></div>
            <div class="vlm-crop-box" tabindex="0" aria-label="Crop Selection">
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
        <button class="vlm-crop-btn vlm-crop-btn-reset" type="button">Use Full Image</button>
        <div class="vlm-crop-actions-right">
            <button class="vlm-crop-btn vlm-crop-btn-cancel" type="button">Cancel</button>
            <button class="vlm-crop-btn vlm-crop-btn-apply" type="button">Apply Crop</button>
        </div>
    </div>
</div>`;

        document.body.appendChild(overlay);
        this.modalEl = overlay;
        this.stageEl = overlay.querySelector('.vlm-crop-stage');
        this.imgEl = overlay.querySelector('.vlm-crop-img');
        this.boxEl = overlay.querySelector('.vlm-crop-box');

        this.imgEl.onload = () => this.updateUI();

        overlay.querySelector('.vlm-crop-close-btn').addEventListener('click', () => {
            this.close();
            this.onCancel?.();
        });

        overlay.querySelector('.vlm-crop-btn-cancel').addEventListener('click', () => {
            this.close();
            this.onCancel?.();
        });

        overlay.querySelector('.vlm-crop-btn-reset').addEventListener('click', () => {
            this.close();
            this.onReset?.();
        });

        const applyBtn = overlay.querySelector('.vlm-crop-btn-apply');
        applyBtn.addEventListener('click', async () => {
            applyBtn.disabled = true;
            applyBtn.textContent = 'Cropping…';
            try {
                const croppedDataUrl = await cropImage(this.imageSrc, this.cropRect);
                this.close();
                this.onApply?.(croppedDataUrl, this.cropRect);
            } catch (err) {
                alert(`Failed to crop image: ${err.message}`);
                applyBtn.disabled = false;
                applyBtn.textContent = 'Apply Crop';
            }
        });

        this.boxEl.addEventListener('pointerdown', this._onPointerDown);
        window.addEventListener('pointermove', this._onPointerMove);
        window.addEventListener('pointerup', this._onPointerUp);
        window.addEventListener('resize', this._onResize);

        this.updateUI();
    }

    close() {
        if (this.modalEl) {
            window.removeEventListener('pointermove', this._onPointerMove);
            window.removeEventListener('pointerup', this._onPointerUp);
            window.removeEventListener('resize', this._onResize);
            this.modalEl.remove();
            this.modalEl = null;
        }
    }

    updateUI() {
        if (!this.imgEl || !this.boxEl || !this.stageEl) return;

        const imgRect = this.imgEl.getBoundingClientRect();
        const stageRect = this.stageEl.getBoundingClientRect();

        if (imgRect.width === 0 || imgRect.height === 0) return;

        const imgLeft = imgRect.left - stageRect.left;
        const imgTop = imgRect.top - stageRect.top;

        const boxLeft = imgLeft + this.cropRect.x * imgRect.width;
        const boxTop = imgTop + this.cropRect.y * imgRect.height;
        const boxWidth = this.cropRect.width * imgRect.width;
        const boxHeight = this.cropRect.height * imgRect.height;

        this.boxEl.style.left = `${boxLeft}px`;
        this.boxEl.style.top = `${boxTop}px`;
        this.boxEl.style.width = `${boxWidth}px`;
        this.boxEl.style.height = `${boxHeight}px`;

        // Update darken masks
        const maskTop = this.modalEl.querySelector('.vlm-crop-mask-top');
        const maskBottom = this.modalEl.querySelector('.vlm-crop-mask-bottom');
        const maskLeft = this.modalEl.querySelector('.vlm-crop-mask-left');
        const maskRight = this.modalEl.querySelector('.vlm-crop-mask-right');

        if (maskTop && maskBottom && maskLeft && maskRight) {
            maskTop.style.top = `${imgTop}px`;
            maskTop.style.left = `${imgLeft}px`;
            maskTop.style.width = `${imgRect.width}px`;
            maskTop.style.height = `${this.cropRect.y * imgRect.height}px`;

            maskBottom.style.top = `${boxTop + boxHeight}px`;
            maskBottom.style.left = `${imgLeft}px`;
            maskBottom.style.width = `${imgRect.width}px`;
            maskBottom.style.height = `${(1 - this.cropRect.y - this.cropRect.height) * imgRect.height}px`;

            maskLeft.style.top = `${boxTop}px`;
            maskLeft.style.left = `${imgLeft}px`;
            maskLeft.style.width = `${this.cropRect.x * imgRect.width}px`;
            maskLeft.style.height = `${boxHeight}px`;

            maskRight.style.top = `${boxTop}px`;
            maskRight.style.left = `${boxLeft + boxWidth}px`;
            maskRight.style.width = `${(1 - this.cropRect.x - this.cropRect.width) * imgRect.width}px`;
            maskRight.style.height = `${boxHeight}px`;
        }
    }

    _onPointerDown(e) {
        e.preventDefault();
        e.stopPropagation();

        const handle = e.target.getAttribute('data-handle');
        this.dragMode = handle || 'move';
        this.isDragging = true;
        this.dragStartPos = { x: e.clientX, y: e.clientY };
        this.dragStartRect = { ...this.cropRect };

        this.boxEl.setPointerCapture(e.pointerId);
    }

    _onPointerMove(e) {
        if (!this.isDragging || !this.imgEl) return;

        const imgRect = this.imgEl.getBoundingClientRect();
        if (imgRect.width === 0 || imgRect.height === 0) return;

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
        this.updateUI();
    }

    _onPointerUp(e) {
        if (this.isDragging) {
            this.isDragging = false;
            this.dragMode = null;
        }
    }

    _onResize() {
        this.updateUI();
    }
}
