import assert from 'node:assert/strict';
import { chromium } from '../.cache/browser/node_modules/playwright/index.mjs';

const base = process.env.SITE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
});
try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    const disturb = () => page.evaluate(() => {
        window.resetProbe = true;
        camera.position.set(9, 8, 14);
        cameraZoom = cameraLens.focalLength = 135;
        localStorage.setItem('datasaver', 'true');
    });
    const assertReset = async () => {
        await page.waitForFunction(() => !window.resetProbe && typeof camera !== 'undefined' && camera && state.is3D);
        assert.equal(await page.evaluate(() => cameraZoom), 18);
        assert.ok(await page.evaluate(() => Math.abs(camera.position.x) < 0.001 && camera.position.z < 0));
        assert.equal(await page.evaluate(() => localStorage.getItem('datasaver')), 'true');
    };
    await page.goto(`${base}/?mode=2d`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => toggleMode(true));
    await disturb();
    await page.locator('#btn-controls-toggle').click();
    await page.locator('#btn-reset-view').click();
    await assertReset();
    assert.equal(new URL(page.url()).searchParams.get('mode'), '3d');
    console.log('Reset View clears camera state, keeps the active mode and saved settings');

    await disturb();
    await page.goto(`${base}/about.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/about\.html/);
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await assertReset();
    console.log('Returning from About resets the camera');

    // Exercise the cache-restoration branch even where the browser declines BFCache.
    await disturb();
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await assertReset();
    await page.evaluate(() => {
        window.resetProbe = 'ordinary-pageshow';
        dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    });
    assert.equal(await page.evaluate(() => window.resetProbe), 'ordinary-pageshow');
    console.log('Cached restoration reloads once; a normal pageshow does not reload');
} finally {
    await browser.close();
}
