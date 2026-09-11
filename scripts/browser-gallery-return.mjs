import assert from 'node:assert/strict';
import { chromium } from '../.cache/browser/node_modules/playwright/index.mjs';

const base = process.env.SITE_URL || 'http://127.0.0.1:8765/build';
const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
});
try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.route('**/fulls/**', route => route.fulfill({ path: 'assets/photographer.jpg', contentType: 'image/jpeg' }));
    for (const gallery of ['astronomy', 'landscape', 'wildlife', 'planes', 'food']) {
        for (const mode of ['2d', '3d']) {
            await page.goto(`${base}/portfolios/${gallery}/index.html?mode=${mode}`, { waitUntil: 'domcontentloaded' });
            const back = page.getByRole('link', { name: 'Back to Camera' });
            assert.ok(await back.isVisible());
            assert.ok((await back.boundingBox()).height >= 44);
            await back.click();
            await page.waitForURL(`${base}/index.html?mode=3d`);
            await page.waitForFunction(() => state.is3D && state.hasExplored);
        }
        console.log(`${gallery}: 2D and 3D return to the main camera`);
    }
    await page.goto(`${base}/portfolios/astronomy/immersive.html`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: 'Back to Camera' }).click();
    await page.waitForURL(`${base}/index.html?mode=3d`);
    // A shared link works even without JavaScript or a previous history entry.
    const plain = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 568 } });
    const direct = await plain.newPage();
    await direct.goto(`${base}/portfolios/food/index.html`, { waitUntil: 'domcontentloaded' });
    await direct.getByRole('link', { name: 'Back to Camera' }).click();
    await direct.waitForURL(`${base}/index.html?mode=3d`);
    console.log('Immersive viewer and direct links without JavaScript return home');
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    const host = await desktop.newPage();
    await host.goto(`${base}/index.html?mode=2d`, { waitUntil: 'domcontentloaded' });
    await host.evaluate(() => {
        window.returnToMainProbe = true;
        handleNav('./portfolios/astronomy/index.html', true);
    });
    const embeddedReturn = host.frameLocator('#exhibit-iframe').getByRole('link', { name: 'Back to Main Page' });
    await embeddedReturn.click();
    await host.waitForFunction(() => !els.iframeOverlay.classList.contains('active') && !state.isPaused);
    assert.equal(await host.evaluate(() => window.returnToMainProbe), true);
    assert.equal(await host.evaluate(() => state.is3D), false);
    assert.equal(host.url(), `${base}/index.html?mode=2d`);
    console.log('Iframe return closes the gallery and reveals the existing main page');
} finally {
    await browser.close();
}
