import assert from 'node:assert/strict';
import { chromium } from '../.cache/browser/node_modules/playwright/index.mjs';
const base = process.env.SITE_URL || 'http://127.0.0.1:8765/build';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
    for (const mobile of [false, true]) {
    for (const route of ['/index.html?mode=3d', '/portfolios/astronomy/index.html?mode=2d']) {
        const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
        // Configure an API backend without sending an image or downloading a model.
        await context.addInitScript(() => {
            localStorage.setItem('vlmType', 'api');
            localStorage.setItem('vlmApiEndpoint', 'http://127.0.0.1:8765/test-api');
            localStorage.setItem('vlmApiKey', 'test-only');
        });
        const page = await context.newPage(), requests = [], errors = [];
        page.on('request', request => requests.push(request.url()));
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(base + route, { waitUntil: 'domcontentloaded' });
        assert.equal(requests.some(url => /vlmWorker|huggingface|test-api/.test(url)), false);
        if (route.startsWith('/index')) {
            await page.evaluate(async () => {
                document.getElementById('space-intro').style.display = 'none'; els.welcome.style.display = 'none'; state.hasExplored = true;
                if (!lastCameraPhoto && !cameraPhotoBusy) await showCameraPhoto(null, 'preview');
            });
            await page.waitForFunction(() => lastCameraPhoto?.image && !cameraPhotoBusy);
            if (mobile) await page.locator('#btn-controls-toggle').click();
            await page.locator('#btn-open-inspector').click();
        } else {
            await page.locator('#portfolio-inspector').click();
        }
        await page.locator('.vlm-panel.vlm-open').waitFor({ state: 'visible' });
        assert.equal(await page.locator('.vlm-panel').count(), 1);
        if (!route.startsWith('/index')) {
            await page.evaluate(() => {
                const photo = document.createElement('img');
                photo.src = new URL('../../assets/photographer.jpg', location.href).href;
                photo.alt = 'Selected gallery photo';
                document.querySelector('#full-image-container').replaceChildren(photo);
            });
        }
        await page.locator('.vlm-input').fill('What is in this photograph?');
        assert.ok(await page.locator('.vlm-send-btn').isVisible());
        await page.waitForFunction(() => !document.querySelector('.vlm-send-btn').disabled);
        const bounds = await page.locator('.vlm-input').boundingBox();
        assert.ok(bounds.x >= 0 && bounds.y + bounds.height <= (mobile ? 844 : 1000));
        await page.locator('.vlm-toggle-btn').click();
        assert.equal(await page.locator('.vlm-panel.vlm-open').count(), 0);
        await page.locator('.vlm-toggle-btn').click();
        assert.equal(await page.locator('.vlm-panel.vlm-open').count(), 1);
        if (mobile && route.startsWith('/index')) {
            if (mobile) await page.locator('#btn-controls-toggle').click();
            await page.waitForTimeout(350);
            assert.ok(await page.locator('#btn-open-settings').evaluate(button => {
                const rect = button.getBoundingClientRect();
                return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
            }), 'Open mobile menu must be above the inspector');
            await page.locator('#btn-open-settings').click();
            assert.ok(await page.locator('#settings-overlay').evaluate(el => el.classList.contains('visible')));
            await page.locator('#btn-close-settings').click();
        }
        const returnURL = page.url();
        await page.locator('.vlm-panel [id$="-gear"]').click();
        if (!route.startsWith('/index')) await page.waitForURL('**/index.html?settings=ai&**');
        await page.locator('#settings-overlay.visible #settings-pane-ai.active').waitFor({ state: 'visible' });
        assert.equal(await page.locator('dialog.photo-settings').count(), 0, 'Duplicate settings dialog was removed');
        assert.equal(await page.locator('#settings-overlay').count(), 1);
        await page.locator('#vlm-api-model').fill('settings-roundtrip-fixture');
        await page.locator('#vlm-api-model').press('Tab');
        await page.locator('#btn-close-settings').click();
        if (!route.startsWith('/index')) await page.waitForURL(returnURL);
        assert.equal(page.url(), returnURL, 'Closing settings returns to the original page');
        assert.equal(await page.evaluate(() => localStorage.getItem('vlmApiModel')), 'settings-roundtrip-fixture');
        assert.equal(requests.some(url => /vlmWorker|huggingface|test-api/.test(url)), false);
        assert.deepEqual(errors, []);
        await page.screenshot({ path: `.cache/inspector-${route.startsWith('/index') ? 'home' : 'gallery'}-${mobile ? 'mobile' : 'desktop'}.png` });
        console.log(`${mobile ? 'Mobile' : 'Desktop'} ${route}: inspector uses existing AI settings, preserves changes, and returns to the original page without model downloads`);
        await context.close();
    }
    }
} finally { await browser.close(); }
