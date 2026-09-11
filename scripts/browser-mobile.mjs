/** Run against the source homepage with the browser dependencies in .cache/browser. */
import assert from 'node:assert/strict';
import { chromium } from '../.cache/browser/node_modules/playwright/index.mjs';

const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
});
const base = process.env.SITE_URL || 'http://127.0.0.1:8765';
try {
    for (const width of [320, 390, 768]) {
        const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/portfolios/*/thumbs/*', route => route.fulfill({ path: 'assets/photographer.jpg', contentType: 'image/jpeg' }));
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        assert.equal(await page.evaluate(() => state.is3D), true);
        assert.equal(await page.evaluate(() => state.hasExplored), true);
        assert.equal(await page.locator('#space-intro').isVisible(), false);
        assert.equal(await page.locator('#welcome-screen').isVisible(), false);
        assert.equal(await page.locator('.mobile-scene-dock').isVisible(), true);
        await page.waitForFunction(() => lastCameraPhoto?.image && !cameraPhotoBusy);
        assert.equal(await page.evaluate(() => cameraDisplay), 'photo');
        // Discover photos on the camera display without leaving the scene.
        await page.route('**/portfolios/*/fulls/*', route => route.fulfill({ path: 'assets/photographer.jpg', contentType: 'image/jpeg' }));
        await page.locator('.mobile-shutter').click();
        await page.waitForFunction(() => lastCameraPhoto?.image && !cameraPhotoBusy && !cameraTravel);
        assert.equal(await page.evaluate(() => cameraInspection), 'screen');
        await page.locator('.mobile-step-back').click();
        await page.waitForFunction(() => !cameraInspection && !cameraTravel);
        assert.equal(await page.evaluate(() => state.is3D), true);
        await page.locator('#mobile-collection-dial').selectOption('food');
        await page.waitForURL('**/portfolios/food/index.html?*');
        await page.goBack({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !cameraInspection && !cameraTravel);
        await page.locator('#btn-controls-toggle').click();
        await page.locator('#btn-home').click();
        assert.equal(await page.evaluate(() => state.is3D), false);
        assert.equal(await page.locator('.mobile-scene-dock').isVisible(), false);
        assert.equal(await page.locator('#mode-2d').evaluate(el => el.scrollWidth > innerWidth), false);
        assert.equal(await page.locator('.nav-card').count(), 6);
        const menu = page.locator('#btn-controls-toggle');
        await menu.click();
        assert.equal(await menu.getAttribute('aria-expanded'), 'true');
        await page.keyboard.press('Escape');
        assert.equal(await menu.getAttribute('aria-expanded'), 'false');
        await menu.click();
        await page.locator('#btn-open-settings').click();
        assert.equal(await menu.getAttribute('aria-expanded'), 'false');
        for (const tab of ['general', 'rendering', 'gallery', 'ai', 'voice']) {
            await page.locator(`[data-tab="${tab}"]`).click();
            assert.equal(await page.locator('.settings-modal').evaluate(el => el.scrollWidth > el.clientWidth), false, `${width}px ${tab} overflow`);
            await page.locator('#btn-close-settings').click();
            await menu.click();
            await page.locator('#btn-open-settings').click();
        }
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('#settings-overlay').classList.contains('visible'));
        // Exercise a real collection link and browser Back, without an iframe.
        await page.locator('.nav-card').filter({ hasText: 'Astronomy' }).click();
        await page.waitForURL(/portfolios\/astronomy\//);
        assert.match(page.mainFrame().url(), /portfolios\/astronomy\//);
        await page.goBack({ waitUntil: 'domcontentloaded' });
        assert.ok(await page.locator('#mode-2d').evaluate(el => el.classList.contains('active')));
        await menu.click();
        await page.locator('#btn-quick-toggle').click();
        assert.equal(await page.evaluate(() => state.is3D), true);
        assert.equal(await page.locator('#welcome-screen').isVisible(), false);
        assert.deepEqual(errors, []);
        console.log(`Mobile browsing, settings, history and mode switching passed at ${width}px`);
        await context.close();
    }
} finally {
    await browser.close();
}
