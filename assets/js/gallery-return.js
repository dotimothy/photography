// Back: the one top-left control on gallery pages, the immersive viewer and About.
// It steps out one level at a time: zoomed photo -> photo -> gallery -> camera.
// Without this script the link still works as a plain link to the camera.
(() => {
    const link = document.getElementById('portfolio-return');
    if (!link) return;
    const root = document.documentElement;
    const label = link.querySelector('.portfolio-return-label');

    // Who is framing this page, if anyone?
    //   home  - the homepage (#exhibit-iframe): Back closes the frame
    //   page  - another portfolio page that has its own Back (a gallery framing immersive.html)
    //   other - an embed we cannot see into: Back is an ordinary link to the homepage
    let host = null;
    if (window.parent !== window) {
        host = 'other';
        try {
            if (typeof window.parent.closeiFrame === 'function') host = 'home';
            else if (window.parent.document.getElementById('portfolio-return')) host = 'page';
        } catch {
            // Cross-origin parent.
        }
    }

    if (host === 'page') {
        // The framing page's Back already leads out of here.
        link.hidden = true;
        root.classList.add('portfolio-nested');
        try {
            if (window.parent.document.documentElement.classList.contains('portfolio-back-steps')) {
                root.classList.add('portfolio-nested-steps');
            }
        } catch {
            // Keep the viewer's own close button.
        }
        return;
    }

    let homeLabel = (label ? label.textContent : link.textContent).trim() || 'Back To Camera';
    if (host) {
        // Embedded pages return to the homepage that is already open behind them.
        root.classList.add('portfolio-embedded');
        homeLabel = 'Back To Main Page';
        link.href = link.href.split('?')[0];
    }
    if (host === 'home') {
        // The homepage parks its frame-rate readout in its bottom-left corner, over this page.
        // The bottom strip is told how much of that corner it covers, so the two never stack.
        try {
            const parentDoc = window.parent.document;
            let current = '';
            const measure = () => {
                const hud = parentDoc.getElementById('site-performance-hud');
                const frame = window.frameElement && window.frameElement.getBoundingClientRect();
                let reserve = 0;
                if (hud && frame) {
                    const rect = hud.getBoundingClientRect();
                    const style = window.parent.getComputedStyle(hud);
                    const visible = rect.height && style.display !== 'none' && style.visibility !== 'hidden';
                    if (visible && rect.bottom > frame.bottom - 120 && rect.top < frame.bottom && rect.left < frame.left + frame.width / 2) {
                        reserve = Math.max(0, rect.right - frame.left + 8);
                    }
                }
                const value = `${Math.round(reserve)}px`;
                if (value !== current) {
                    current = value;
                    root.style.setProperty('--pg-hud-reserve', value);
                }
            };
            new MutationObserver(measure).observe(parentDoc.body, { childList: true, subtree: false });
            const hud = parentDoc.getElementById('site-performance-hud');
            if (hud) new MutationObserver(measure).observe(hud, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
            window.addEventListener('resize', measure);
            measure();
            setTimeout(measure, 1500);
        } catch {
            // Nothing of the homepage's to dodge.
        }
    }

    const levels = { viewer: 'Back To Gallery', immersive: 'Back To Photo' };
    const stepsBack = () => (levels[root.dataset.galleryState] ? document.getElementById('exitViewer') : null);
    let levelChanged = 0;
    let pendingStep = 0;
    const sync = () => {
        const text = stepsBack() ? levels[root.dataset.galleryState] : homeLabel;
        if (label) label.textContent = text;
        link.setAttribute('aria-label', text);
        link.title = text;
    };
    root.classList.add('portfolio-back-steps');
    new MutationObserver(() => { levelChanged = performance.now(); sync(); })
        .observe(root, { attributes: true, attributeFilter: ['data-gallery-state'] });
    sync();

    link.addEventListener('click', (event) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        if (stepsBack()) {
            // The template's own close handler knows how to leave each viewer level. It drops
            // level changes that follow one another within 300ms, so a quick second tap waits its turn.
            event.preventDefault();
            clearTimeout(pendingStep);
            pendingStep = setTimeout(() => stepsBack()?.click(), Math.max(0, 340 - (performance.now() - levelChanged)));
            return;
        }
        if (host !== 'home') return;
        try {
            window.parent.closeiFrame();
            event.preventDefault();
        } catch {
            // Fall through to the ordinary homepage link.
        }
    });
})();
