import assert from 'node:assert/strict';
import { chromium } from '../.cache/browser/node_modules/playwright/index.mjs';
const base = process.env.SITE_URL || 'http://127.0.0.1:8765/build';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
    for (const route of ['/index.html?mode=3d', '/portfolios/astronomy/index.html?mode=2d']) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
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
            await page.waitForFunction(() => lastCameraPhoto?.image && !cameraPhotoBusy);
            await page.locator('#btn-controls-toggle').click();
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
        assert.ok(bounds.x >= 0 && bounds.y + bounds.height <= 844);
        await page.locator('.vlm-toggle-btn').click();
        assert.equal(await page.locator('.vlm-panel.vlm-open').count(), 0);
        await page.locator('.vlm-toggle-btn').click();
        assert.equal(await page.locator('.vlm-panel.vlm-open').count(), 1);
        if (route.startsWith('/index')) {
            await page.locator('#btn-controls-toggle').click();
            await page.waitForTimeout(350);
            assert.ok(await page.locator('#btn-open-settings').evaluate(button => {
                const rect = button.getBoundingClientRect();
                return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
            }), 'Open mobile menu must be above the inspector');
            await page.locator('#btn-open-settings').click();
            assert.ok(await page.locator('#settings-overlay').evaluate(el => el.classList.contains('visible')));
            await page.locator('#btn-close-settings').click();
        } else {
            await page.locator('.vlm-panel [id$="-gear"]').click();
            assert.ok(await page.locator('dialog.photo-settings').evaluate(el => el.open));
            await page.locator('dialog.photo-settings [data-close]').click();
        }
        assert.equal(requests.some(url => /vlmWorker|huggingface|test-api/.test(url)), false);
        assert.deepEqual(errors, []);
        await page.screenshot({ path: `.cache/inspector-${route.startsWith('/index') ? 'home' : 'gallery'}-mobile.png` });
        console.log(`${route}: inspector opens, accepts input, closes and reopens without duplicate panels or model downloads`);
        await context.close();
    }
} finally { await browser.close(); }
