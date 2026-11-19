/**
 * Walks every control state of a gallery page, the immersive viewer and About,
 * opened directly and inside the homepage's iframe, at phone, tablet and desktop
 * sizes, and proves the controls form one layout:
 *   - no two controls intersect, and none sits on top of page content at rest
 *   - no control is half-hidden under a panel, sheet, menu or dialog
 *   - nothing is clipped by the viewport, or by simulated safe-area insets
 *   - on touch viewports every control is at least 44 x 44 CSS px
 *   - no two controls on screen carry the same name (nothing is offered twice)
 *
 * Run against the built site, like the other browser scripts:
 *   node scripts/browser-gallery-overlap.mjs
 * Optional: OVERLAP_SIZES=390x844,1440x900  OVERLAP_ONLY=gallery|immersive|about
 *           OVERLAP_SHOTS=<dir> saves a screenshot of every state.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from '../.cache/browser/node_modules/playwright/index.mjs';

const base = process.env.SITE_URL || 'http://127.0.0.1:8765/build';
const gallery = process.env.OVERLAP_GALLERY || 'astronomy';
const shots = process.env.OVERLAP_SHOTS || '';
const only = (process.env.OVERLAP_ONLY || 'gallery,immersive,about').split(',');
const sizes = [
    { width: 320, height: 568, touch: true },
    { width: 360, height: 740, touch: true },
    { width: 390, height: 844, touch: true },
    { width: 667, height: 375, touch: true },
    { width: 768, height: 1024, touch: true },
    { width: 1024, height: 768, touch: false },
    { width: 1440, height: 900, touch: false },
].filter(size => !process.env.OVERLAP_SIZES || process.env.OVERLAP_SIZES.split(',').includes(`${size.width}x${size.height}`));
// A notched phone, both ways up: the insets the layout must keep its controls inside.
const notches = { '390x844': { top: 59, right: 0, bottom: 34, left: 0 }, '667x375': { top: 0, right: 47, bottom: 21, left: 47 } };
if (shots) mkdirSync(shots, { recursive: true });

/** Runs inside each frame: every interactive element that is really on screen, with its box. */
function collect(host) {
    const interactive = 'a[href], button, select, input:not([type="hidden"]), textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])';
    // Layers that legitimately cover what is beneath them. Anything half under one is a bug.
    const surfaceSelector = [
        '#settingsModal.visible', '#licenseOverlay.visible', '#lightPollutionMapOverlay.visible', '#map-overlay.visible',
        '#controls-container.expanded #controls-list', '#viewer-controls-container.expanded #viewer-controls-list',
        '#loading-screen:not(.hidden)', '#empty-state', '.lightbox.active', '.vlm-panel.vlm-open',
        '.vlm-crop-modal-overlay', '#site-performance-panel:not([hidden])', 'iframe',
        // Passive cards and strips: nothing interactive may end up half underneath them either.
        '#metadataViewer.visible', '#metadata-panel.visible', '#thumbnail-selector:not(.hidden)',
    ].join(',');
    // Photographs and running copy: they scroll, so they are only checked against the controls.
    const contentSelector = '#gallery-2d .thumb, #about-page, #about-page a, #about-page [onclick], #about-page summary, #about-page [tabindex]';
    // Controls other parts of the site own. They must not collide with ours, but their size is not ours to set.
    const foreignSelector = '#site-performance-hud *, .vlm-toggle-btn, .vlm-panel *, .vlm-crop-modal-overlay *, #close-iframe';
    const inside = (rect, x, y) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    const box = rect => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    const shown = el => {
        if (!el.isConnected || el.closest('[hidden], [inert]')) return false;
        if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
    };
    const describe = el => {
        const name = (el.getAttribute('aria-label') || el.dataset.label || el.title || el.innerText || el.value || '').replace(/\s+/g, ' ').trim();
        return { tag: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : el.classList.length ? `.${el.classList[0]}` : ''), name: name.slice(0, 48) };
    };
    const surfaces = [...document.querySelectorAll(surfaceSelector)].filter(shown);
    const items = [];
    const problems = [];
    for (const el of document.querySelectorAll(interactive)) {
        if (!shown(el) || getComputedStyle(el).pointerEvents === 'none') continue;
        const rect = box(el.getBoundingClientRect());
        // What is left of the element after scroll containers and clipping ancestors have had their say.
        const clip = { ...rect };
        let fixed = false, scrolled = false;
        for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.position === 'fixed' || style.position === 'sticky') fixed = true;
            // Overflow set on <body> applies to the viewport, not to the body box.
            if (node === el || node === document.body || (style.overflowX === 'visible' && style.overflowY === 'visible')) continue;
            const bounds = node.getBoundingClientRect();
            if (rect.left < bounds.left - .5 || rect.right > bounds.right + .5 || rect.top < bounds.top - .5 || rect.bottom > bounds.bottom + .5) {
                if (/auto|scroll/.test(style.overflowX + style.overflowY)) scrolled = true;
            }
            clip.left = Math.max(clip.left, bounds.left); clip.top = Math.max(clip.top, bounds.top);
            clip.right = Math.min(clip.right, bounds.right); clip.bottom = Math.min(clip.bottom, bounds.bottom);
        }
        clip.left = Math.max(clip.left, 0); clip.top = Math.max(clip.top, 0);
        clip.right = Math.min(clip.right, innerWidth); clip.bottom = Math.min(clip.bottom, innerHeight);
        if (clip.right - clip.left < 2 || clip.bottom - clip.top < 2) continue;
        const info = describe(el);
        const content = el.matches(contentSelector);
        // Framing a page, the homepage's own controls are another part of the site, wherever they are.
        const foreign = host || el.matches(foreignSelector);
        // Is it under a layer? Five probes: the centre and just inside each corner.
        const points = [[.5, .5], [.2, .2], [.8, .2], [.2, .8], [.8, .8]]
            .map(([x, y]) => [clip.left + (clip.right - clip.left) * x, clip.top + (clip.bottom - clip.top) * y]);
        let buried = false;
        for (const surface of surfaces) {
            if (surface.contains(el) || el.contains(surface)) continue;
            const bounds = surface.getBoundingClientRect();
            const under = points.filter(([x, y]) => {
                if (!inside(bounds, x, y)) return false;
                const hit = document.elementFromPoint(x, y);
                return hit && surface.contains(hit);
            }).length;
            if (under === points.length) buried = true;
            else if (under && !content && !foreign) problems.push(`${info.tag} "${info.name}" is partly covered by ${describe(surface).tag}`);
            else if (under) buried = true;
        }
        if (buried) continue;
        items.push({
            ...info, rect, clip, content, fixed, scrolled, points,
            foreign,
            // Links inside a sentence are exempt from the target-size rule (WCAG 2.5.8, inline exception).
            inline: el.tagName === 'A' && getComputedStyle(el).display === 'inline',
            path: (() => { const path = []; for (let node = el; node; node = node.parentElement) path.push(node); return path; })()
                .map(node => [...(node.parentElement?.children || [])].indexOf(node)).reverse().join('.'),
        });
    }
    const scroller = document.scrollingElement;
    return {
        items, problems,
        pageScrolls: scroller.scrollHeight > innerHeight + 1 && getComputedStyle(document.body).overflowY !== 'hidden',
        sideways: scroller.scrollWidth > innerWidth + 1 ? scroller.scrollWidth - innerWidth : 0,
        frames: [...document.querySelectorAll('iframe')].filter(shown).length,
        // Layers of this document that also cover whatever a framed page draws beneath them.
        covers: surfaces.filter(surface => surface.tagName !== 'IFRAME').map(surface => ({ ...describe(surface), ...box(surface.getBoundingClientRect()) })),
    };
}

const results = [];
/** Collects every frame of the page into one coordinate space and applies the rules. */
async function audit(page, label, { size, mode, inset }) {
    await page.waitForTimeout(650);
    const controls = [], problems = [];
    const visit = async (frame, offset, bounds, depth, covers) => {
        const data = await frame.evaluate(collect, mode === 'embedded' && depth === 0);
        problems.push(...data.problems);
        if (data.sideways) problems.push(`page scrolls sideways by ${data.sideways}px`);
        const shift = rect => ({ left: rect.left + offset.x, top: rect.top + offset.y, right: rect.right + offset.x, bottom: rect.bottom + offset.y });
        for (const item of data.items) {
            // A layer of the framing page (the homepage's AI sheet, say) hides framed controls just the same.
            const under = cover => item.points.filter(([x, y]) => x + offset.x >= cover.left && x + offset.x <= cover.right && y + offset.y >= cover.top && y + offset.y <= cover.bottom).length;
            const hidden = covers.map(cover => [cover, under(cover)]).filter(([, count]) => count);
            if (hidden.some(([, count]) => count === item.points.length) || (hidden.length && item.content)) continue;
            hidden.forEach(([cover]) => problems.push(`${item.tag} "${item.name}" is partly covered by ${cover.tag} of the framing page`));
            controls.push({ ...item, rect: shift(item.rect), clip: shift(item.clip), bounds, depth, pageScrolls: data.pageScrolls, path: `${depth}/${item.path}` });
        }
        const below = [...covers, ...data.covers.map(cover => ({ ...cover, ...shift(cover) }))];
        for (const child of frame.childFrames()) {
            const element = await child.frameElement().catch(() => null);
            // Playwright reports frame boxes in the top page's coordinates.
            const rect = element && await element.boundingBox();
            if (!rect || !data.frames || rect.width < 2) continue;
            await visit(child, { x: rect.x, y: rect.y }, { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height }, depth + 1, below);
        }
    };
    const viewport = { left: 0, top: 0, right: size.width, bottom: size.height };
    await visit(page.mainFrame(), { x: 0, y: 0 }, viewport, 0, []);
    const ours = controls.filter(item => !item.content && !item.foreign);
    const say = item => `${item.tag} "${item.name}"`;
    for (let a = 0; a < controls.length; a++) {
        for (let b = a + 1; b < controls.length; b++) {
            const one = controls[a], two = controls[b];
            if (one.content && two.content) continue;
            if ((one.content || one.foreign) && (two.content || two.foreign)) continue;
            if (one.depth === two.depth && (one.path.startsWith(two.path + '.') || two.path.startsWith(one.path + '.'))) continue;
            const w = Math.min(one.clip.right, two.clip.right) - Math.max(one.clip.left, two.clip.left);
            const h = Math.min(one.clip.bottom, two.clip.bottom) - Math.max(one.clip.top, two.clip.top);
            if (w > 1 && h > 1) problems.push(`${say(one)} overlaps ${say(two)} by ${Math.round(w)}x${Math.round(h)}px`);
        }
    }
    for (const item of ours) {
        const { rect, bounds } = item;
        const anchored = item.fixed || !item.pageScrolls;
        if (anchored && !item.scrolled && (rect.left < bounds.left - .5 || rect.top < bounds.top - .5 || rect.right > bounds.right + .5 || rect.bottom > bounds.bottom + .5)) {
            problems.push(`${say(item)} is clipped by the viewport (${Math.round(rect.left)},${Math.round(rect.top)} to ${Math.round(rect.right)},${Math.round(rect.bottom)})`);
        }
        if (size.touch && !item.inline && (rect.right - rect.left < 43.5 || rect.bottom - rect.top < 43.5)) {
            problems.push(`${say(item)} is ${Math.round(rect.right - rect.left)}x${Math.round(rect.bottom - rect.top)}px, under the 44px touch target`);
        }
        if (inset && anchored && !item.scrolled && (rect.left < inset.left - .5 || rect.top < inset.top - .5 || rect.right > size.width - inset.right + .5 || rect.bottom > size.height - inset.bottom + .5)) {
            problems.push(`${say(item)} enters the safe-area inset`);
        }
    }
    const names = new Map();
    for (const item of ours) if (item.name) names.set(item.name, (names.get(item.name) || 0) + 1);
    for (const [name, count] of names) if (count > 1) problems.push(`"${name}" is offered ${count} times`);
    const id = `${label} | ${size.width}x${size.height} | ${mode}${inset ? ' | safe-area' : ''}`;
    results.push({ id, count: ours.length, problems });
    if (shots) await page.screenshot({ path: `${shots}/${id.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png` });
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${id} (${ours.length} controls)${problems.map(problem => `\n       ${problem}`).join('')}`);
}

const ready = frame => frame.waitForFunction(() => window.galleryApp?.view3d?.frames.length > 0
    && document.getElementById('loading-screen')?.classList.contains('hidden') && Number(getComputedStyle(document.getElementById('controls-container')).opacity) > .99, null, { timeout: 60000 });

/** The gallery page, state by state, through the same controls a visitor uses. */
async function walkGallery(page, g, options) {
    const check = label => audit(page, `gallery ${label}`, options);
    const app = (script, arg) => g.evaluate(script, arg);
    const menu = async (toggle, row) => {
        await g.locator(toggle).click();
        if (row) { await page.waitForTimeout(350); await g.locator(row).click(); }
    };
    await app(() => galleryApp.switchMode('2D'));
    await check('2D grid');
    if (options.mode === 'embedded' && await page.locator('.vlm-panel.vlm-open').count()) {
        // The homepage opens its AI panel beside a framed gallery; park it to reach the layout underneath.
        await page.locator('.vlm-panel.vlm-open .vlm-close-btn').click();
        await page.waitForFunction(() => !document.querySelector('.vlm-panel.vlm-open'));
        await check('2D grid, homepage AI panel parked');
    }
    await menu('#controls-toggle');
    await check('2D grid, menu open');
    await g.locator('#toggleSettings').click();
    await check('settings');
    await page.keyboard.press('Escape');
    assert.equal(await app(() => document.getElementById('settingsModal').classList.contains('visible')), false, 'Escape closes settings');
    assert.equal(await app(() => document.getElementById('controls-container').classList.contains('expanded')), false, 'choosing a menu row closes the menu');
    await menu('#controls-toggle', '#openLicense');
    await g.locator('#licenseOverlay.visible').waitFor({ state: 'visible' });
    await check('license dialog');
    await g.locator('#closeLicense').click();

    await menu('#controls-toggle', '#mode-toggle');
    await g.waitForFunction(() => galleryApp.mode === '3D');
    await check('3D shape');
    const shape = g.locator('#gallery-3d > button');
    if (await shape.isVisible()) {
        await shape.click();
        await check('3D sphere');
        await shape.click();
    }
    await menu('#controls-toggle');
    await check('3D, menu open');
    await page.keyboard.press('Escape');
    assert.equal(await app(() => document.getElementById('controls-container').classList.contains('expanded')), false, 'Escape closes the menu');
    await app(() => galleryApp.selectImage(2, true));
    await page.waitForTimeout(900);
    await check('3D photo');
    await app(() => galleryApp.closeFullscreen());
    await page.waitForTimeout(500);

    await app(() => { galleryApp.switchMode('2D'); galleryApp.selectImage(2, true); });
    await g.locator('#imageViewer.visible').waitFor();
    await check('photo');
    assert.equal(await g.locator('.portfolio-return-label').textContent(), 'Back To Gallery');
    await menu('#viewer-controls-toggle');
    await check('photo, menu open');
    await g.locator('#toggleThumbs').click();
    await check('photo, thumbnails');
    await menu('#viewer-controls-toggle', '#toggleMetadata');
    await check('photo, info and thumbnails');
    await menu('#viewer-controls-toggle', '#toggleThumbs');
    await check('photo, info');
    await menu('#viewer-controls-toggle', '#toggleMetadata');
    await menu('#viewer-controls-toggle', '#viewer-slideshow');
    await check('slideshow starting');
    await page.waitForTimeout(3600);
    await check('slideshow running');
    await app(() => galleryApp.stopSlideshow());

    await menu('#viewer-controls-toggle', '#zoomBtn');
    await g.locator('#immersive-frame:not(.hidden)').waitFor();
    const zoom = g.frameLocator('#immersive-frame');
    await zoom.locator('#target-image').waitFor({ state: 'attached' });
    await page.waitForTimeout(600);
    await check('zoomed photo');
    assert.equal(await g.locator('.portfolio-return-label').textContent(), 'Back To Photo');
    await zoom.locator('#btn-info').click();
    await check('zoomed photo, info');
    // Back leaves one level at a time and ends on the gallery, even when tapped twice in a hurry.
    await g.locator('#portfolio-return').click();
    await g.locator('#imageViewer.visible').waitFor();
    await g.locator('#portfolio-return').click();
    await g.waitForFunction(() => document.documentElement.dataset.galleryState === 'explore');
    assert.equal(await app(() => galleryApp.viewState.getState()), 'explore');

    if (options.mode !== 'direct') return;
    // The AI panel belongs to the page only when the gallery is opened directly.
    await menu('#controls-toggle', '#portfolio-inspector');
    await g.locator('.vlm-panel.vlm-open').waitFor({ state: 'visible', timeout: 30000 });
    await check('2D grid, AI panel open');
    await app(() => galleryApp.selectImage(2, true));
    await g.locator('#imageViewer.visible').waitFor();
    await check('photo, AI panel open');
    await g.locator('.vlm-panel.vlm-open .vlm-close-btn').click();
    await g.waitForFunction(() => !document.querySelector('.vlm-panel.vlm-open'));
    await menu('#viewer-controls-toggle', '#toggleThumbs');
    await menu('#viewer-controls-toggle', '#toggleMetadata');
    await check('photo, info and thumbnails, AI toggle parked');
    await app(() => galleryApp.closeFullscreen());
    await page.waitForTimeout(400);
    await app(() => galleryApp.switchMode('3D'));
    await check('3D shape, AI toggle parked');
}

async function walkAbout(page, a, options) {
    const check = label => audit(page, `about ${label}`, options);
    await a.locator('#about-3d-toggle').waitFor();
    await a.evaluate(() => window.scrollTo(0, 0));
    await check('2D');
    await a.evaluate(() => document.querySelector('[onclick*="openLightbox"]')?.click());
    if (await a.locator('.lightbox.active').count()) {
        await check('lightbox');
        await page.keyboard.press('Escape');
        await a.evaluate(() => closeLightbox());
    }
    await a.locator('#about-3d-toggle').click();
    await check('3D carousel');
    await a.locator('#about-next').click();
    await check('3D carousel, next section');
    if (options.mode === 'direct') {
        await a.locator('#about-inspector').click();
        await a.locator('.vlm-panel.vlm-open').waitFor({ state: 'visible', timeout: 30000 });
        await check('3D carousel, AI panel open');
        await a.locator('.vlm-panel.vlm-open .vlm-close-btn').click();
        await a.waitForFunction(() => !document.querySelector('.vlm-panel.vlm-open'));
        await check('3D carousel, AI toggle parked');
    }
    await a.locator('#about-3d-toggle').click();
    await a.evaluate(() => window.scrollTo(0, 0));
    await check('2D again');
}

const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
});
try {
    for (const size of sizes) {
        const context = await browser.newContext({
            viewport: { width: size.width, height: size.height }, isMobile: size.touch, hasTouch: size.touch,
            reducedMotion: 'reduce', serviceWorkers: 'block',
        });
        // An API backend that is never called keeps the AI panel from downloading a model.
        await context.addInitScript(() => {
            localStorage.setItem('vlmType', 'api');
            localStorage.setItem('vlmApiEndpoint', `${location.origin}/test-api`);
            localStorage.setItem('vlmApiKey', 'test-only');
        });
        await context.route('**/fulls/**', route => route.fulfill({ path: 'assets/photographer.jpg', contentType: 'image/jpeg' }));
        const errors = [];
        const open = async () => {
            const page = await context.newPage();
            page.on('pageerror', error => errors.push(error.message));
            return page;
        };
        const embed = async (page, url) => {
            await page.goto(`${base}/index.html?mode=2d`, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => typeof window.handleNav === 'function');
            await page.evaluate(target => handleNav(target, true, true), url);
            // The frame slides up over the homepage and the homepage then hides what is behind it.
            await page.waitForTimeout(1500);
            return (await page.locator('#exhibit-iframe').elementHandle()).contentFrame();
        };

        if (only.includes('gallery')) {
            let page = await open();
            await page.goto(`${base}/portfolios/${gallery}/index.html?mode=2d`, { waitUntil: 'domcontentloaded' });
            await ready(page.mainFrame());
            await walkGallery(page, page.mainFrame(), { size, mode: 'direct' });
            await page.close();

            page = await open();
            const framed = await embed(page, `./portfolios/${gallery}/index.html`);
            await ready(framed);
            await walkGallery(page, framed, { size, mode: 'embedded' });
            assert.equal(await page.locator('#close-iframe').isVisible(), false, 'the homepage close button yields to the framed Back');
            await page.close();

            const inset = notches[`${size.width}x${size.height}`];
            if (inset) {
                // Headless Chrome reports no safe area, so drive the layout's inset variables directly.
                page = await open();
                await page.addInitScript(area => document.addEventListener('DOMContentLoaded', () => {
                    for (const side of Object.keys(area)) document.documentElement.style.setProperty(`--pc-safe-${side}`, `${area[side]}px`);
                }), inset);
                await page.goto(`${base}/portfolios/${gallery}/index.html?mode=2d`, { waitUntil: 'domcontentloaded' });
                await ready(page.mainFrame());
                await walkGallery(page, page.mainFrame(), { size, mode: 'direct', inset });
                await page.close();
            }
        }

        if (only.includes('immersive')) {
            const page = await open();
            const options = { size, mode: 'direct' };
            await page.goto(`${base}/portfolios/${gallery}/immersive.html`, { waitUntil: 'domcontentloaded' });
            await audit(page, 'immersive empty', options);
            assert.ok(await page.getByRole('link', { name: 'Back To Camera' }).isVisible());
            await page.goto(`${base}/portfolios/${gallery}/immersive.html?img=${encodeURIComponent('../../assets/photographer.jpg')}&meta_model=Test`, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.getElementById('target-image').naturalWidth > 0);
            await page.mouse.move(size.width / 2, size.height / 2);
            await audit(page, 'immersive photo', options);
            await page.locator('#btn-info').click();
            await page.mouse.move(size.width / 2, size.height / 2 + 4);
            await audit(page, 'immersive photo, info', options);
            await page.close();
        }

        if (only.includes('about')) {
            let page = await open();
            await page.goto(`${base}/about.html`, { waitUntil: 'domcontentloaded' });
            await walkAbout(page, page.mainFrame(), { size, mode: 'direct' });
            await page.close();
            page = await open();
            await walkAbout(page, await embed(page, 'about.html'), { size, mode: 'embedded' });
            await page.close();
        }
        assert.deepEqual(errors, [], `${size.width}x${size.height}: page errors`);
        await context.close();
    }
} finally {
    await browser.close();
}
const failed = results.filter(result => result.problems.length);
console.log(`\n${results.length - failed.length} of ${results.length} states pass across ${sizes.length} viewport sizes.`);
assert.equal(failed.length, 0, `${failed.length} states have control layout problems:\n${failed.map(result => `${result.id}: ${result.problems.join('; ')}`).join('\n')}`);
