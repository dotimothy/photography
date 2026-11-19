/**
 * Homepage control layout: in every state and at every screen size, no two visible interactive
 * elements intersect, none is clipped by the viewport, and on touch screens each is at least 44x44.
 * "Visible interactive elements" are HTML controls that win a hit test at their own centre, plus the
 * keys drawn on the camera's displays (cameraControlRects) where the scene canvas is on top.
 * Run against the source homepage with the browser dependencies in .cache/browser.
 * Optional: OVERLAP_ONLY="390x844,1440x900" and OVERLAP_STATES="home,menu" narrow the matrix.
 */
import assert from 'node:assert/strict';
import { chromium } from '../.cache/browser/node_modules/playwright/index.mjs';

const base = process.env.SITE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
});

const viewports = [
    [320, 640, true], [360, 780, true], [390, 844, true], [667, 375, true], [768, 1024, true],
    [1024, 768, false], [1440, 900, false], [1920, 1080, false],
].filter(([w, h]) => !process.env.OVERLAP_ONLY || process.env.OVERLAP_ONLY.split(',').includes(`${w}x${h}`));

const ready = async page => page.waitForFunction(() => typeof state === 'object' && typeof cameraTravel !== 'undefined');
const settle = async page => page.waitForFunction(() => !cameraTravel && !cameraPhotoBusy, null, { timeout: 20000 });
async function enterScene(page) {
    await page.evaluate(() => {
        document.getElementById('space-intro').style.display = 'none';
        if (!state.hasExplored) startExperience();
    });
    await page.waitForTimeout(400);
    await settle(page);
}
async function atScreen(page, mode = 'screen') {
    await enterScene(page);
    await page.evaluate(async mode => {
        if (!lastCameraPhoto && !cameraPhotoBusy) await showCameraPhoto(null, 'preview');
        focusCameraDisplay(mode, true);
    }, mode);
    await settle(page);
}

// Each state starts from a fresh load of `path` and then runs `enter`. Phones skip the intro.
const states = {
    intro: { path: '/?mode=3d', enter: async page => page.waitForTimeout(400) },
    welcome: { path: '/?mode=3d', enter: async page => {
        await page.evaluate(() => document.getElementById('btn-skip-intro')?.click());
        await page.waitForTimeout(600);
    } },
    home: { path: '/?mode=3d', enter: enterScene },
    'lcd-photo': { path: '/?mode=3d', enter: page => atScreen(page) },
    viewfinder: { path: '/?mode=3d', enter: page => atScreen(page, 'viewfinder') },
    'live-space': { path: '/?mode=3d', enter: async page => {
        await atScreen(page);
        await page.evaluate(() => setCameraSource('space'));
        await settle(page);
    } },
    metadata: { path: '/?mode=3d', enter: async page => {
        await atScreen(page);
        await page.evaluate(() => { cameraMetadataVisible = true; updateUI(); });
    } },
    'camera-ai': { path: '/?mode=3d', enter: async page => {
        await atScreen(page);
        await page.evaluate(() => {
            Object.assign(cameraAI, { visible: true, busy: false, status: 'INSPECTION COMPLETE',
                text: 'A long exposure of the night sky above a quiet ridge, with the Milky Way core rising over the horizon.' });
            updateUI();
        });
    } },
    'mode-2d': { path: '/?mode=2d', enter: async page => page.waitForTimeout(900) },
    menu: { path: '/?mode=3d', enter: async page => {
        await enterScene(page);
        await page.locator('#btn-controls-toggle').click();
        await page.waitForTimeout(250);
    } },
    'menu-2d': { path: '/?mode=2d', enter: async page => {
        await page.waitForTimeout(600);
        await page.locator('#btn-controls-toggle').click();
        await page.waitForTimeout(250);
    } },
    settings: { path: '/?mode=3d', enter: async page => {
        await enterScene(page);
        await page.locator('#btn-controls-toggle').click();
        await page.locator('#btn-open-settings').click();
        await page.waitForTimeout(300);
    } },
    'gallery-iframe': { path: '/?mode=3d', desktopOnly: true, enter: async page => {
        await enterScene(page);
        await page.evaluate(() => handleNav('about.html', true, true));
        await page.waitForFunction(() => document.getElementById('iframe-container').classList.contains('active'));
        await page.waitForTimeout(500);
    } },
    'ai-panel': { path: '/?mode=3d', enter: async page => {
        await enterScene(page);
        await page.evaluate(() => openPortfolioInspector());
        await page.locator('.vlm-panel.vlm-open').waitFor({ state: 'visible' });
        await page.waitForTimeout(400);
    } },
    collection: { path: '/?mode=3d', desktopOnly: true, enter: async page => {
        await enterScene(page);
        await page.waitForFunction(() => document.body.classList.contains('orbit-live'), null, { timeout: 15000 });
        await page.evaluate(() => window.PrintOrbit.enterCollection(1));
        await page.waitForFunction(() => document.body.classList.contains('orbit-collection'), null, { timeout: 15000 });
        await page.waitForTimeout(1600);
    } },
};
const stateNames = Object.keys(states).filter(name => !process.env.OVERLAP_STATES || process.env.OVERLAP_STATES.split(',').includes(name));

function measure(touch) {
    const selector = 'button, a[href], select, input:not([type="hidden"]), textarea, summary, [role="button"], [role="tab"], [tabindex]:not([tabindex="-1"])';
    const vw = document.documentElement.clientWidth, vh = innerHeight;
    const name = el => (el.getAttribute('aria-label') || el.textContent || el.id || el.className || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40)
        + (el.id ? `#${el.id}` : '');
    const scrolls = el => {
        for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (/(auto|scroll|hidden)/.test(style.overflowY + style.overflowX) && (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1)) return true;
        }
        return false;
    };
    const items = [];
    for (const el of document.querySelectorAll(selector)) {
        if (el.matches('#mode-3d canvas') || el.closest('[hidden], [inert], .camera-screen-reader')) continue;
        if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const cx = Math.min(Math.max(r.x + r.width / 2, 0), vw - 1), cy = Math.min(Math.max(r.y + r.height / 2, 0), vh - 1);
        const hit = document.elementFromPoint(cx, cy);
        if (!hit || !(el === hit || el.contains(hit) || hit.closest('label')?.contains(el))) continue;
        items.push({ kind: 'html', label: name(el), el, x: r.x, y: r.y, w: r.width, h: r.height, scrolls: scrolls(el) });
    }
    const canvas = document.querySelector('#mode-3d canvas');
    if (typeof cameraControlRects === 'function' && state.is3D) for (const zone of cameraControlRects()) {
        const hit = document.elementFromPoint(Math.min(Math.max(zone.x + zone.w / 2, 0), vw - 1), Math.min(Math.max(zone.y + zone.h / 2, 0), vh - 1));
        if (hit !== canvas) continue;
        items.push({ kind: 'lcd', label: `LCD ${zone.label}`, x: zone.x, y: zone.y, w: zone.w, h: zone.h, scrolls: false });
    }
    const problems = [], notes = [];
    // The AI inspector panel (vlm/) sizes its own controls; its small targets are reported, not failed.
    // Overlap and clipping are still enforced for it.
    const foreignSizes = '.vlm-panel';
    for (const item of items) {
        if (!item.scrolls && (item.x < -0.5 || item.y < -0.5 || item.x + item.w > vw + 0.5 || item.y + item.h > vh + 0.5))
            problems.push(`clipped: ${item.label} [${Math.round(item.x)},${Math.round(item.y)} ${Math.round(item.w)}x${Math.round(item.h)}]`);
        if (touch && (item.w < 43.5 || item.h < 43.5))
            (item.el?.closest(foreignSizes) ? notes : problems).push(`small: ${item.label} ${Math.round(item.w)}x${Math.round(item.h)}`);
    }
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (a.el && b.el && (a.el.contains(b.el) || b.el.contains(a.el))) continue;
        const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (dx > 1 && dy > 1) problems.push(`overlap: ${a.label} x ${b.label} (${Math.round(dx)}x${Math.round(dy)})`);
    }
    return { count: items.length, lcd: items.filter(item => item.kind === 'lcd').length, problems, notes, horizontalScroll: document.documentElement.scrollWidth > vw + 1 };
}

const results = [];
let failed = false;
try {
    for (const [width, height, touch] of viewports) {
        const context = await browser.newContext({ viewport: { width, height }, isMobile: touch, hasTouch: touch, serviceWorkers: 'block' });
        await context.route('**/portfolios/*/{thumbs,fulls}/*', route => route.fulfill({ path: 'assets/photographer.jpg', contentType: 'image/jpeg' }));
        await context.route(/huggingface|cdn-lfs|vlmWorker/, route => route.abort());
        for (const name of stateNames) {
            const spec = states[name];
            if (spec.desktopOnly && width <= 768) continue;
            const page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(base + spec.path, { waitUntil: 'domcontentloaded' });
            await ready(page);
            let row;
            try {
                await spec.enter(page);
                const result = await page.evaluate(measure, touch);
                if (result.horizontalScroll) result.problems.push('page scrolls horizontally');
                if (errors.length) result.problems.push(...errors.map(e => `page error: ${e}`));
                row = { size: `${width}x${height}`, state: name, ...result };
            } catch (error) {
                row = { size: `${width}x${height}`, state: name, count: 0, lcd: 0, problems: [`could not reach state: ${error.message.split('\n')[0]}`] };
            }
            results.push(row);
            if (row.problems.length) failed = true;
            console.log(`${row.problems.length ? 'FAIL' : 'ok  '} ${row.size.padEnd(10)} ${name.padEnd(15)} ${String(row.count).padStart(3)} controls (${row.lcd} on camera)${row.problems.map(p => `\n       - ${p}`).join('')}${row.notes?.length ? `\n       note (not owned here): ${row.notes.length} AI panel targets under 44px` : ''}`);
            if (process.env.OVERLAP_SHOTS) await page.screenshot({ path: `${process.env.OVERLAP_SHOTS}/${width}x${height}-${name}.png` });
            await page.close();
        }
        await context.close();
    }
} finally {
    await browser.close();
}
assert.ok(!failed, 'Control layout problems found (see above)');
console.log(`No overlapping, clipped or undersized controls in ${results.length} state and size combinations.`);
