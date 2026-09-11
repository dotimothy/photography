/** Camera rendering controls: run against the source site with the existing browser dependencies. */
import assert from 'node:assert/strict';
import { chromium } from '../.cache/browser/node_modules/playwright/index.mjs';

const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true
});
const base = process.env.SITE_URL || 'http://127.0.0.1:8765';
const pointCount = (page) => page.evaluate(() => starSystem.children
    .filter((object) => object.isPoints)
    .reduce((total, stars) => total + stars.geometry.attributes.position.count, 0));
async function openRendering(page, mobile) {
    await page.evaluate(() => {
        document.getElementById('space-intro').style.display = 'none';
        els.welcome.style.display = 'none';
    });
    if (mobile) await page.locator('#btn-controls-toggle').click();
    await page.locator('#btn-open-settings').click();
    await page.locator('[data-tab="rendering"]').click();
    assert.ok(await page.locator('[data-tab="rendering"]').evaluate((el) => el.classList.contains('active')));
}
try {
    for (const mobile of [false, true]) {
        const context = await browser.newContext({
            viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
            isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block'
        });
        const page = await context.newPage(), errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
            if (message.type() === 'error' && /shader|init3D/i.test(message.text())) errors.push(message.text());
        });
        await page.goto(`${base}/?mode=3d`, { waitUntil: 'networkidle' });
        await openRendering(page, mobile);
        await page.locator('#settings-performance-profile').selectOption('quality');
        assert.equal(await pointCount(page), 36000);
        assert.equal(await page.evaluate(() => asteroidSystem.userData.rocks.length), 128);
        for (const [density, count] of [['low', 32], ['medium', 64], ['ultra', 256], ['high', 128]]) {
            await page.locator('#render-asteroid-density').selectOption(density);
            assert.equal(await page.evaluate(() => asteroidSystem.userData.rocks.length), count);
            assert.equal(await pointCount(page), 36000, 'Asteroid density leaves star density unchanged');
            assert.match(await page.locator('#rendering-status').textContent(), new RegExp(`${count} asteroids`));
        }
        assert.ok(await page.evaluate(() => asteroidSystem.userData.rocks.every((rock) =>
            rock.position.length() - rock.size * rock.mesh.geometry.boundingSphere.radius > controls.maxDistance + 20)));
        const spinning = await page.evaluate(() => asteroidSystem.userData.rocks[0].rotation.x);
        await page.waitForTimeout(150);
        assert.notEqual(await page.evaluate(() => asteroidSystem.userData.rocks[0].rotation.x), spinning);
        await page.locator('#render-star-density').selectOption('ultra');
        assert.equal(await pointCount(page), 65000);
        const fullRatio = await page.evaluate(() => renderer.getPixelRatio());
        await page.locator('#settings-performance-profile').selectOption('performance');
        assert.equal(await pointCount(page), 16250);
        assert.equal(await page.evaluate(() => asteroidSystem.userData.rocks.length), 32);
        await page.locator('#render-asteroid-density').selectOption('ultra');
        assert.equal(await page.evaluate(() => asteroidSystem.userData.rocks.length), 64, 'Performance preset scales asteroid density');
        await page.locator('#render-asteroid-density').selectOption('high');
        const still = await page.evaluate(() => asteroidSystem.userData.rocks[0].rotation.x);
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(() => asteroidSystem.userData.rocks[0].rotation.x), still);
        assert.ok(await page.evaluate((ratio) => renderer.getPixelRatio() < ratio, fullRatio));
        assert.match(await page.locator('#rendering-status').textContent(), /Motion is paused/);
        await page.locator('#settings-performance-profile').selectOption('quality');
        await page.locator('#render-star-density').selectOption('off');
        assert.equal(await pointCount(page), 0);
        assert.equal(await page.locator('#render-star-brightness').isDisabled(), true);
        await page.locator('#render-star-density').selectOption('medium');
        assert.equal(await pointCount(page), 18000);
        await page.locator('#render-star-brightness').focus();
        await page.keyboard.press('Home');
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.locator('#render-brightness-value').textContent(), '55%');
        assert.ok(await page.evaluate(() => Math.abs(starSystem.getObjectByName('star-layer-0').material.opacity - 0.264) < 0.001));
        await page.locator('#render-atmosphere').uncheck();
        assert.equal(await page.evaluate(() => starSystem.getObjectByName('atmosphere').visible), false);
        await page.locator('#render-star-motion').uncheck();
        await page.locator('#render-camera-motion').uncheck();
        await page.locator('#render-asteroid-motion').uncheck();
        const pose = () => page.evaluate(() => [starSystem.rotation.y, camGroup.position.y, camGroup.rotation.z,
            camGroup.scale.x, asteroidSystem.rotation.y, asteroidSystem.userData.rocks[0].rotation.x]);
        const frozen = await pose();
        await page.waitForTimeout(150);
        assert.deepEqual(await pose(), frozen);
        await page.locator('#render-asteroid-density').selectOption('medium');
        await page.locator('#render-asteroids').uncheck();
        assert.ok(await page.locator('#render-asteroid-density').isDisabled());
        assert.equal(await page.evaluate(() => asteroidSystem.visible), false);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

        await page.reload({ waitUntil: 'networkidle' });
        await openRendering(page, mobile);
        assert.equal(await page.locator('#render-star-density').inputValue(), 'medium');
        assert.equal(await pointCount(page), 18000);
        assert.equal(await page.locator('#render-star-brightness').inputValue(), '55');
        for (const id of ['render-atmosphere', 'render-star-motion', 'render-camera-motion', 'render-asteroids', 'render-asteroid-motion'])
            assert.equal(await page.locator(`#${id}`).isChecked(), false);
        assert.equal(await page.evaluate(() => asteroidSystem.visible), false);
        await page.locator('#render-asteroids').check();
        assert.equal(await page.locator('#render-asteroid-density').inputValue(), 'medium', 'Density persists across reloads and field toggles');
        assert.equal(await page.evaluate(() => asteroidSystem.userData.rocks.length), 64);
        assert.equal(await page.locator('#render-asteroid-density').isDisabled(), false);

        // Rebuilding dense/sparse scenes must not accumulate GPU resources.
        const memory = await page.evaluate(() => {
            renderer.render(scene, camera);
            return { ...renderer.info.memory };
        });
        for (const value of ['ultra', 'off', 'low', 'high']) await page.locator('#render-star-density').selectOption(value);
        for (const value of ['ultra', 'low', 'high', 'medium']) await page.locator('#render-asteroid-density').selectOption(value);
        for (const profile of ['balanced', 'performance', 'quality'])
            await page.locator('#settings-performance-profile').selectOption(profile);
        assert.deepEqual(await page.evaluate(() => {
            renderer.render(scene, camera);
            return { ...renderer.info.memory };
        }), memory);
        await page.locator('#reset-rendering').click();
        assert.equal(await page.locator('#render-star-density').inputValue(), 'high');
        assert.equal(await page.locator('#render-asteroid-density').inputValue(), 'high');
        assert.equal(await page.evaluate(() => asteroidSystem.userData.rocks.length === renderedAsteroidCount()), true);
        assert.equal(await page.locator('#render-star-brightness').inputValue(), '100');
        assert.equal(await page.locator('#settings-performance-profile').inputValue(), 'auto');
        assert.equal(await page.locator('#render-atmosphere').isChecked(), true);
        assert.equal(await page.locator('#render-asteroids').isChecked(), true);
        assert.equal(await page.locator('#render-asteroid-motion').isChecked(), true);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.locator('#settings-performance-profile').selectOption('quality');
        const reduced = await pose();
        await page.waitForTimeout(150);
        assert.deepEqual(await pose(), reduced);
        assert.match(await page.locator('#rendering-status').textContent(), /reduced-motion preference/);
        assert.deepEqual(errors, []);
        console.log(`${mobile ? 'Mobile' : 'Desktop'} rendering controls, persistence, motion, and GPU cleanup passed.`);
        await context.close();
    }
} finally {
    await browser.close();
}
