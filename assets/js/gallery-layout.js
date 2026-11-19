// Tidies the gallery template's controls into one layout (see gallery-return.css).
// The template cannot be edited from this repository, so this only relabels and
// re-files what it finds; every step is skipped when its element is missing.
(() => {
    const root = document.documentElement;
    const byId = (id) => document.getElementById(id);

    // --- Which level is the visitor on? Back and the menus key off this. ---
    const viewer = byId('imageViewer');
    const frame = byId('immersive-frame');
    if (viewer || frame) {
        const readState = () => {
            if (frame && !frame.classList.contains('hidden')) return 'immersive';
            if (viewer && viewer.classList.contains('visible')) return 'viewer';
            return 'explore';
        };
        const syncState = () => {
            const state = readState();
            if (root.dataset.galleryState !== state) root.dataset.galleryState = state;
        };
        const watcher = new MutationObserver(syncState);
        if (viewer) watcher.observe(viewer, { attributes: true, attributeFilter: ['class', 'hidden'] });
        if (frame) watcher.observe(frame, { attributes: true, attributeFilter: ['class'] });
        syncState();
    }

    // --- Every button label has each word capitalised. ---
    const titleCase = (text) => text.replace(/(^|[\s/(-])([a-z])/g, (match, lead, letter) => lead + letter.toUpperCase());
    // Short names for the menu rows; the template only has tooltips, some of them sentences.
    const rowNames = {
        refresh: () => 'Reload Gallery',
        toggleSettings: () => 'Settings',
        'global-fullscreen': (button) => (/exit/i.test(button.title) ? 'Exit Fullscreen' : 'Fullscreen'),
        exitViewer: () => 'Close Viewer',
        fullscreenToggle: () => 'Fullscreen',
        zoomBtn: (button) => (/return|back/i.test(button.title) ? 'Back To Preview' : /reset/i.test(button.title) ? 'Reset Zoom' : 'Magnify'),
        toggleMetadata: () => 'Photo Info',
        'viewer-slideshow': (button) => (/stop/i.test(button.title) ? 'Stop Slideshow' : 'Start Slideshow'),
        toggleThumbs: () => 'Thumbnails',
        leftArrow: () => 'Previous',
        rightArrow: () => 'Next',
    };
    const relabel = (button) => {
        if (button.id === 'portfolio-inspector' || button.classList.contains('portfolio-menu-item')) return;
        if (button.title) {
            const title = titleCase(button.title);
            if (title !== button.title) button.title = title;
        }
        const name = rowNames[button.id];
        if (name) {
            const text = name(button);
            if (button.dataset.label !== text) button.dataset.label = text;
            if (!button.title) button.title = text;
        }
        if (button.id === 'mode-toggle') {
            // The template writes the bare target mode ("2D" / "3D") on every switch.
            const mode = button.textContent.trim().match(/^[23]D/i);
            if (mode) {
                const text = `${mode[0].toUpperCase()} View`;
                if (button.textContent !== text) button.textContent = text;
                if (button.getAttribute('aria-label') !== `Switch To ${text}`) button.setAttribute('aria-label', `Switch To ${text}`);
            }
            return;
        }
        // Plain text buttons ("Reset to Defaults", "View Sphere", "Load").
        if (!button.children.length) {
            const text = titleCase(button.textContent);
            if (text !== button.textContent) button.textContent = text;
        }
    };
    const labelWatcher = new MutationObserver((records) => {
        const seen = new Set();
        records.forEach((record) => {
            const button = record.target.nodeType === 1 ? record.target.closest('button') : record.target.parentElement?.closest('button');
            if (button && !seen.has(button)) {
                seen.add(button);
                relabel(button);
            }
        });
    });
    const adopt = (button) => {
        relabel(button);
        labelWatcher.observe(button, { attributes: true, attributeFilter: ['title'], childList: true, characterData: true, subtree: true });
    };
    document.querySelectorAll('button').forEach(adopt);
    // The 3D view adds its shape toggle ("View Sphere") after the photos have loaded.
    const scene = byId('gallery-3d');
    if (scene) {
        new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach((node) => {
            if (node.nodeName === 'BUTTON') adopt(node);
        }))).observe(scene, { childList: true });
    }

    // --- The frame line shows exposure the way a camera does: "f/1.7", not the stored "f/17/10". ---
    const strip = byId('viewer-exif-strip');
    if (strip) {
        const tidy = () => strip.querySelectorAll('span').forEach((chip) => {
            const text = chip.textContent.replace(/(\d+)\/(\d+)/, (match, top, bottom) => (Number(bottom) ? String(Math.round((top / bottom) * 10) / 10) : match));
            if (text !== chip.textContent) chip.textContent = text;
        });
        new MutationObserver(tidy).observe(strip, { childList: true });
        tidy();
    }

    // --- Credits and the frame-rate readout move from the page edges into the menu. ---
    const list = byId('controls-list');
    if (list) {
        const footer = byId('gallery-footer');
        const fps = byId('fps-counter');
        if (footer) list.append(footer);
        if (fps) list.append(fps);
    }

    // --- Menus behave like menus: they close after a choice, on an outside tap, and on Escape. ---
    const menus = [['controls-container', 'controls-toggle'], ['viewer-controls-container', 'viewer-controls-toggle']]
        .map(([box, toggle]) => ({ box: byId(box), toggle: byId(toggle) }))
        .filter((menu) => menu.box && menu.toggle);
    const isOpen = (menu) => menu.box.classList.contains('expanded');
    // Clicking the template's own trigger keeps its icon and aria-expanded in step.
    const collapse = (menu) => { if (isOpen(menu)) menu.toggle.click(); };
    document.addEventListener('click', (event) => {
        menus.forEach((menu) => {
            if (!isOpen(menu) || menu.toggle.contains(event.target)) return;
            const choice = menu.box.contains(event.target) && event.target.closest('button, a');
            // Capture phase: some template handlers stop the click before it bubbles.
            if (choice || !menu.box.contains(event.target)) setTimeout(() => collapse(menu), 0);
        });
    }, true);
    window.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        const open = menus.find(isOpen);
        const settings = byId('settingsModal');
        const closeSettings = byId('closeSettings');
        if (open) {
            collapse(open);
            open.toggle.focus({ preventScroll: true });
        } else if (settings && closeSettings && settings.classList.contains('visible')) {
            closeSettings.click();
        } else {
            return;
        }
        // Escape closed a layer; the template must not also close the photo underneath.
        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);
})();
