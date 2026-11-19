// AI Inspector is a row in the gallery's own menus rather than a button floating over the page.
const button = document.getElementById('portfolio-inspector');
if (button) {
    const root = document.documentElement;
    // The portfolio already supplies an inspector around embedded galleries.
    const embedded = window.parent !== window;
    const icon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 3l1.8 4.7 4.7 1.8-4.7 1.8L11 16l-1.8-4.7L4.5 9.5l4.7-1.8z"/><path d="M18 14l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/></svg>';
    const items = [];
    const dress = (item, withLabel) => {
        item.type = 'button';
        item.classList.add('portfolio-menu-item');
        item.innerHTML = icon + (withLabel ? '<span class="portfolio-menu-label">AI Inspector</span>' : '');
        item.title = 'AI Inspector';
        item.setAttribute('aria-label', 'AI Inspector');
        item.addEventListener('click', open);
        items.push(item);
        return item;
    };
    const setLabel = (text) => items.forEach((item) => {
        const label = item.querySelector('.portfolio-menu-label');
        if (label) label.textContent = text;
        item.title = text;
        item.setAttribute('aria-label', text);
    });
    // Rows sit above the credits that gallery-layout.js files at the foot of the menu.
    const file = (list, item) => list.insertBefore(item, list.querySelector(':scope > footer, :scope > #fps-counter'));

    const galleryMenu = document.getElementById('controls-list');
    const viewerMenu = document.getElementById('viewer-controls-list');
    const toolbar = document.querySelector('#hud .toolbar');
    if (galleryMenu) file(galleryMenu, dress(button, true));
    if (viewerMenu) {
        const twin = galleryMenu ? document.createElement('button') : button;
        if (twin !== button) twin.id = 'portfolio-viewer-inspector';
        file(viewerMenu, dress(twin, true));
    }
    if (toolbar && !items.length) {
        // immersive.html: one more icon in its zoom toolbar, ahead of Close.
        dress(button, false).classList.add('icon-btn');
        toolbar.insertBefore(button, document.getElementById('btn-close'));
    }
    if (!items.length) {
        // The template has no menu to file it in: a single action on the bottom edge.
        dress(button, true).classList.add('portfolio-floating');
    }

    // Once the panel exists its own round toggle opens and closes it, so the menu rows step aside.
    let watching = false;
    const sync = () => {
        const toggle = document.querySelector('.vlm-toggle-btn');
        const panel = document.querySelector('.vlm-panel');
        const shown = Boolean(toggle && toggle.isConnected && toggle.style.display !== 'none');
        const docked = shown && toggle.classList.contains('vlm-toggle-docked');
        const open = Boolean(panel && panel.classList.contains('vlm-open'));
        root.classList.toggle('portfolio-ai-toggle', shown && !docked);
        root.classList.toggle('portfolio-ai-open', open);
        // On phones the panel is a bottom sheet; the photo moves into the space left above it.
        const sheet = open && window.matchMedia('(max-width: 600px)').matches && !panel.classList.contains('vlm-fullscreen');
        if (sheet) root.style.setProperty('--pg-sheet', `${panel.offsetHeight}px`);
        else root.style.removeProperty('--pg-sheet');
        items.forEach((item) => { item.hidden = embedded || shown; });
        if (!watching && toggle && panel) {
            watching = true;
            const watcher = new MutationObserver(sync);
            watcher.observe(toggle, { attributes: true, attributeFilter: ['class', 'style'] });
            watcher.observe(panel, { attributes: true, attributeFilter: ['class', 'style'] });
            watcher.observe(document.body, { childList: true });
            window.addEventListener('resize', sync);
        }
    };

    async function open() {
        items.forEach((item) => { item.disabled = true; });
        try {
            const { openInspector } = await import('./photo-tools.js');
            const zoomed = document.getElementById('target-image');
            await openInspector(document.body, zoomed && zoomed.getAttribute('src') ? zoomed : null);
            setLabel('AI Inspector');
        } catch {
            setLabel('Retry AI Inspector');
        } finally {
            items.forEach((item) => { item.disabled = false; });
            sync();
        }
    }
    sync();
}
