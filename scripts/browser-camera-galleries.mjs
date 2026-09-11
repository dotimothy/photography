/** Direct gallery navigation from the camera Home, LCD, and viewfinder. */
import assert from 'node:assert/strict';
import { chromium } from '../.cache/browser/node_modules/playwright/index.mjs';
const base = process.env.SITE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
async function boot(page) {
    await page.goto(`${base}/?mode=3d`, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
        document.getElementById('space-intro').style.display = 'none'; els.welcome.style.display = 'none'; state.hasExplored = true;
        state.directLinks = false; state.rendering.cameraMotion = false; applySceneRenderingSettings();
        TWEEN.removeAll(); controls.enableDamping = false; camera.position.set(0, 0, innerWidth < 768 ? -44 : -25); controls.target.set(0, 0, 0); controls.update();
        cameraHome();
    });
    await page.waitForFunction(() => !cameraTravel && !cameraPhotoBusy);
}
async function tap(page, mobile, label) {
    const p = await page.evaluate(label => {
        const finder = cameraInspection === 'viewfinder', surface = finder ? finderMesh : screenMesh;
        const zone = (finder ? finderClickZones : uiClickZones).find(zone => zone.label === label || zone.label?.endsWith(` ${label}`));
        if (!zone) throw new Error(`Missing camera control: ${label}`);
        const point = new THREE.Vector3(((zone.x + zone.w / 2) / 1500 - .5) * surface.geometry.parameters.width,
            (.5 - (zone.y + zone.h / 2) / 1500) * surface.geometry.parameters.height, 0);
        surface.localToWorld(point); point.project(camera);
        return { x: (point.x + 1) * innerWidth / 2, y: (1 - point.y) * innerHeight / 2 };
    }, label);
    if (mobile) await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y);
}
async function checkDestination(page, mobile, gallery) {
    const target = mobile ? page : page.frameLocator('#exhibit-iframe');
    if (mobile) await page.waitForURL(`**/portfolios/${gallery}/index.html?**`);
    else await page.waitForFunction(() => els.iframeOverlay.classList.contains('active'));
    await target.locator('h1').waitFor();
    assert.equal(await target.locator('h1').textContent(), gallery);
    const url = new URL(mobile ? page.url() : await page.locator('#exhibit-iframe').getAttribute('src'), base);
    assert.equal(url.searchParams.get('mode'), '3d');
    if (!mobile) assert.equal(await page.evaluate(() => state.is3D), true, 'Desktop remains in 3D mode');
}
try {
    for (const mobile of [false, true]) {
        const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
        const page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/portfolios/*/index.html*', route => {
            const gallery = new URL(route.request().url()).pathname.split('/').at(-2);
            return route.fulfill({ contentType: 'text/html', body: `<h1>${gallery}</h1><a href="${base}/?mode=3d">Back to Camera</a>` });
        });
        await page.route('**/metadata/metadata.json', route => route.fulfill({ json: { image_order: ['Fixture'], Fixture: {} } }));
        await page.route('**/fulls/*.jpg', route => route.fulfill({ path: 'assets/photographer.jpg', contentType: 'image/jpeg' }));
        for (const gallery of ['astronomy', 'food', 'landscape', 'planes', 'wildlife']) {
            await boot(page);
            await tap(page, mobile, 'FULL GALLERIES');
            assert.equal(await page.evaluate(() => cameraDisplay), 'galleries');
            await tap(page, mobile, `${gallery.toUpperCase()} / FULL GALLERY`);
            await checkDestination(page, mobile, gallery);
        }
        for (const finder of [false, true]) {
            await boot(page);
            await page.evaluate(async finder => {
                await showCameraPhoto({ gallery: 'wildlife', name: 'Fixture', src: './portfolios/wildlife/fulls/Fixture.jpg', metadata: {} });
                cameraCollection = 0; // The selected collection must not override the displayed photo's gallery.
                focusCameraDisplay(finder ? 'viewfinder' : 'screen', true); updateUI();
            }, finder);
            await tap(page, mobile, mobile ? 'FULL GALLERY' : 'OPEN FULL GALLERY');
            await checkDestination(page, mobile, 'wildlife');
        }
        await boot(page);
        await page.evaluate(() => runCameraAction('settings'));
        await page.waitForFunction(() => !cameraTravel);
        await tap(page, mobile, 'FULL GALLERIES');
        await tap(page, mobile, 'HOME');
        assert.equal(await page.evaluate(() => cameraDisplay), 'menu');
        assert.deepEqual(errors, []);
        console.log(`${mobile ? 'Mobile' : 'Desktop'} camera Home, settings, LCD, and viewfinder open full galleries with 3D return mode.`);
        await context.close();
    }
} finally { await browser.close(); }
