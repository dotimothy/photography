/**
 * Browse scene: the 2D mode as a CSS-3D wall of prints in a layered starfield.
 * Cards tilt towards the pointer, the sky shifts in depth, and the whole scene makes
 * one entrance when the mode opens. With reduced motion (or the Performance preset)
 * nothing here moves; the wall is simply laid out in perspective.
 *
 * Classic script loaded before the homepage's inline script; its globals are read lazily.
 */
window.BrowseScene = (function () {
    'use strict';

    let wired = false, photosRequested = false, extrasRequested = false, frame = 0, arrivalTimer = 0;
    const current = { x: 0, y: 0 }, goal = { x: 0, y: 0 };
    const root = () => document.getElementById('mode-2d');
    const motionAllowed = () => !matchMedia('(prefers-reduced-motion: reduce)').matches &&
        window.SitePerformance?.current?.animations !== false;
    const finePointer = () => innerWidth > 768 && matchMedia('(hover: hover) and (pointer: fine)').matches;

    function settle() {
        frame = 0;
        current.x += (goal.x - current.x) * 0.12;
        current.y += (goal.y - current.y) * 0.12;
        const scene = root();
        scene.style.setProperty('--px', current.x.toFixed(4));
        scene.style.setProperty('--py', current.y.toFixed(4));
        // The loop runs only while the scene is still catching up with the pointer.
        if (Math.abs(goal.x - current.x) + Math.abs(goal.y - current.y) > 0.002) frame = requestAnimationFrame(settle);
    }

    function release(card) {
        card.classList.remove('is-tilting');
        card.style.removeProperty('--tilt-x');
        card.style.removeProperty('--tilt-y');
    }

    function wire() {
        if (wired) return;
        wired = true;
        const scene = root();
        scene.addEventListener('pointermove', (event) => {
            if (event.pointerType === 'touch' || !finePointer() || !motionAllowed()) return;
            goal.x = event.clientX / innerWidth * 2 - 1;
            goal.y = event.clientY / innerHeight * 2 - 1;
            if (!frame) frame = requestAnimationFrame(settle);
            const card = event.target.closest?.('.nav-card');
            scene.querySelectorAll('.nav-card.is-tilting').forEach((other) => { if (other !== card) release(other); });
            if (!card) return;
            const rect = card.getBoundingClientRect();
            const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
            const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
            card.classList.add('is-tilting');
            card.style.setProperty('--tilt-y', `${((x - 0.5) * 16).toFixed(2)}deg`);
            card.style.setProperty('--tilt-x', `${((0.5 - y) * 12).toFixed(2)}deg`);
            card.style.setProperty('--shine-x', `${(x * 100).toFixed(1)}%`);
            card.style.setProperty('--shine-y', `${(y * 100).toFixed(1)}%`);
        });
        scene.addEventListener('pointerleave', () => {
            goal.x = goal.y = 0;
            if (!frame) frame = requestAnimationFrame(settle);
            scene.querySelectorAll('.nav-card.is-tilting').forEach(release);
        });
        scene.querySelectorAll('.card-photo img').forEach((image) => {
            const reveal = () => image.classList.add('is-loaded');
            if (image.complete && image.naturalWidth) reveal(); else image.addEventListener('load', reveal, { once: true });
        });
    }

    // Covers are 1200 px thumbnails resolved against the same base the camera uses.
    async function loadPhotos() {
        if (photosRequested) return;
        photosRequested = true;
        try { await portfolioBaseReady; } catch (_) { /* The default base still applies. */ }
        root().querySelectorAll('img[data-thumb]').forEach((image) => { image.src = portfolioBase + image.dataset.thumb; });
    }

    // After the covers: photograph counts, and two more prints behind each cover.
    async function loadExtras() {
        if (extrasRequested || state.dataSaver || navigator.connection?.saveData) return;
        extrasRequested = true;
        try { await portfolioBaseReady; } catch (_) { /* The default base still applies. */ }
        for (const card of root().querySelectorAll('.nav-card[data-gallery]')) {
            const gallery = card.dataset.gallery;
            try {
                if (!cameraPhotoCatalogs.has(gallery)) {
                    const response = await fetch(`${portfolioBase}${gallery}/metadata/metadata.json`);
                    if (!response.ok) continue;
                    const metadata = await response.json();
                    const names = (metadata.image_order || Object.keys(metadata)).filter((name) => typeof name === 'string' && name !== 'image_order');
                    if (!names.length) continue;
                    cameraPhotoCatalogs.set(gallery, names);
                    cameraPhotoMetadata.set(gallery, metadata);
                }
                const names = cameraPhotoCatalogs.get(gallery);
                card.querySelector('.card-meta').textContent = `${names.length} photographs`;
                if (innerWidth <= 768) continue;
                const cover = card.querySelector('img[data-thumb]').dataset.thumb;
                const others = names.filter((name) => !cover.endsWith(`/${name}.jpg`));
                const picks = [others[Math.floor(others.length / 3)], others[Math.floor(others.length * 2 / 3)]];
                card.querySelectorAll('.card-sheet').forEach((sheet, index) => {
                    if (!picks[index] || picks[index] === picks[index - 1]) return;
                    const url = `${portfolioBase}${gallery}/thumbs/${encodeURIComponent(picks[index])}.jpg`;
                    const image = new Image();
                    image.onload = () => { sheet.style.backgroundImage = `url("${url}")`; };
                    image.src = url;
                });
            } catch (_) { /* A collection that cannot be read keeps its plain card. */ }
        }
    }

    /** Called each time the 2D mode opens. */
    function enter() {
        const scene = root();
        if (!scene) return;
        wire();
        loadPhotos().then(() => {
            const idle = window.requestIdleCallback || ((callback) => setTimeout(callback, 600));
            idle(() => { loadExtras(); });
        });
        clearTimeout(arrivalTimer);
        scene.classList.remove('is-arriving');
        if (!motionAllowed()) return;
        void scene.offsetWidth;
        scene.classList.add('is-arriving');
        arrivalTimer = setTimeout(() => scene.classList.remove('is-arriving'), 2100);
    }

    return { enter };
}());
