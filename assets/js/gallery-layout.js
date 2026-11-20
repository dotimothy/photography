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

    const metadataPanel = byId('metadataViewer');
    const strip = byId('viewer-exif-strip');
    const gallery = location.pathname.split('/').at(-2)?.replace(/^[a-z]/, (letter) => letter.toUpperCase()) || '';
    const contact = new URL('../../contact.html', location.href);

    function exposureNumber(value) {
        const parts = /^(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?$/.exec(String(value ?? '').trim());
        const number = parts ? Number(parts[1]) / Number(parts[2] ?? 1) : NaN;
        return Number.isFinite(number) && number > 0 ? number : null;
    }

    function addLink(parent, label, href, newTab = true) {
        const link = document.createElement('a');
        link.className = 'gallery-contact-link';
        link.textContent = label;
        link.href = href;
        if (newTab) {
            link.target = '_blank';
            link.rel = 'noopener';
        }
        parent.append(link);
    }

    function updateCaption() {
        const app = window.galleryApp;
        const heading = metadataPanel.querySelector('h2:not([data-frame-caption])');
        const frame = heading?.textContent.replace(/\.jpg$/i, '');
        const index = app?.images.indexOf(frame) ?? -1;
        if (index < 0) return;
        const metadata = app.metadata[frame] || {};
        const model = String(metadata['Image Model'] || '').trim();
        const cameraNames = { 'ILCE-7M4': 'Sony A7 IV', 'ILCE-7RM5': 'Sony A7R V', 'ILCE-6700': 'Sony A6700' };
        const focal = exposureNumber(metadata['EXIF FocalLength']);
        const aperture = exposureNumber(metadata['EXIF FNumber']);
        const shutter = exposureNumber(metadata['EXIF ExposureTime']);
        const iso = exposureNumber(metadata['EXIF ISOSpeedRatings']);
        const date = String(metadata['EXIF DateTimeOriginal'] || metadata['Image DateTime'] || '')
            .match(/^\d{4}[:-]\d{2}[:-]\d{2}/)?.[0].replaceAll(':', '-');
        const formatted = (value) => String(Number(value.toPrecision(3)));
        const count = String(app.images.length);
        const caption = [
            `${String(index + 1).padStart(count.length, '0')} / ${count}`,
            cameraNames[model] || model,
            focal && `${formatted(focal)}mm`,
            aperture && `f/${formatted(aperture)}`,
            shutter && (shutter < 1 ? `1/${formatted(1 / shutter)}` : `${formatted(shutter)}s`),
            iso && `ISO ${iso}`,
        ].filter(Boolean).join(' · ');
        heading.dataset.frameCaption = '';
        heading.textContent = caption;
        if (strip) {
            strip.dataset.frameCaption = '';
            strip.textContent = caption;
            if (date) {
                const stripDate = document.createElement('span');
                stripDate.className = 'viewer-frame-date';
                stripDate.textContent = date;
                strip.append(stripDate);
            }
        }

        // Keep the template's map action alongside the date and inquiry.
        const map = metadataPanel.querySelector('p:has([onclick])');
        metadataPanel.replaceChildren(heading);
        if (date) {
            const dateLine = document.createElement('p');
            dateLine.textContent = date;
            metadataPanel.append(dateLine);
        }
        if (map) {
            map.firstChild.textContent = 'Location: ';
            metadataPanel.append(map);
        }
        const inquiry = new URL(contact);
        inquiry.search = new URLSearchParams({ collection: gallery, frame });
        addLink(metadataPanel, 'Ask About This Photo', inquiry);
        addLink(metadataPanel, 'Browse Prints', 'https://thedoshoots.pixieset.com/');
    }
    if (metadataPanel) {
        new MutationObserver(updateCaption).observe(metadataPanel, { childList: true });
        window.addEventListener('load', () => setTimeout(updateCaption, 0), { once: true });
    }

    // --- Credits and the frame-rate readout move from the page edges into the menu. ---
    const list = byId('controls-list');
    const hasToolbar = Boolean(byId('layout-switch'));
    if (list) {
        const footer = byId('gallery-footer');
        const fps = byId('fps-counter');
        addLink(list, 'Contact', contact);
        if (footer && !hasToolbar) list.append(footer);
        if (fps) list.append(fps);
    }

    const galleryTitle = byId('title');
    if (list && galleryTitle) {
        const addSelectsLink = () => {
            if (!window.galleryApp?.metadata?.selects_order?.length) return;
            const url = new URL(location.href);
            const curated = url.searchParams.get('view') === 'selects';
            url.searchParams.delete('img');
            if (curated) url.searchParams.delete('view');
            else url.searchParams.set('view', 'selects');
            addLink(list, curated ? 'Full Gallery' : 'Selects', url, false);
            list.prepend(list.lastElementChild);
            if (curated) {
                document.title = `${document.title} Selects`;
                if (hasToolbar) galleryTitle.textContent = document.title;
            }
            watcher.disconnect();
        };
        const watcher = new MutationObserver(addSelectsLink);
        watcher.observe(galleryTitle, { childList: true, characterData: true, subtree: true });
        const loader = byId('loading-screen');
        if (loader) watcher.observe(loader, { attributes: true, attributeFilter: ['class'] });
        addSelectsLink();
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
