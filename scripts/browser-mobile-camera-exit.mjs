import assert from 'node:assert/strict';
import { chromium } from '../.cache/browser/node_modules/playwright/index.mjs';
const base = process.env.SITE_URL || 'http://127.0.0.1:8765/build';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
    for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 667, height: 375 }]) {
        const page = await browser.newPage({ viewport, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
        await page.route('**/portfolios/*/{thumbs,fulls}/*', route => route.fulfill({ path: 'assets/photographer.jpg', contentType: 'image/jpeg' }));
        await page.goto(`${base}/index.html?mode=3d`, { waitUntil: 'domcontentloaded' });
        for (const mode of ['screen', 'viewfinder']) {
            const initial = await page.evaluate(() => camera.position.toArray());
            await page.evaluate(mode => focusCameraDisplay(mode), mode);
            const exit = page.getByRole('button', { name: 'Exit Camera View', exact: true });
            assert.ok(await exit.isVisible());
            const rect = await exit.boundingBox();
            assert.ok(rect.y < 30 && rect.height >= 48 && rect.x + rect.width <= viewport.width);
            assert.ok(await exit.evaluate(button => {
                const rect = button.getBoundingClientRect();
                return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
            }));
            // Leave during the camera transition as well as after arriving.
            if (mode === 'viewfinder') await page.waitForFunction(() => !cameraTravel);
            await exit.click();
            assert.ok(await page.evaluate(() => !cameraInspection && !cameraTravel && controls.enabled));
            const restored = await page.evaluate(() => camera.position.toArray());
            assert.ok(restored.every((value, index) => Math.abs(value - initial[index]) < 0.001));
            assert.equal(await exit.isVisible(), false);
            await page.locator('#btn-controls-toggle').waitFor({ state: 'visible' });
        }
        console.log(`${viewport.width}x${viewport.height}: visible exit restores the main scene from both camera views`);
        await page.close();
    }
} finally { await browser.close(); }
