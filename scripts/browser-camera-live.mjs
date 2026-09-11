/** Live capture, in-camera AI, Home navigation, and native mobile gestures. */
import assert from 'node:assert/strict';
import { chromium } from '../.cache/browser/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const base = process.env.SITE_URL || 'http://127.0.0.1:8765';
async function settle(page) { await page.waitForFunction(() => !cameraTravel && !cameraPhotoBusy); }
async function point(page, label, photo = false) {
    return page.evaluate(({ label, photo }) => {
        const finder = cameraInspection === 'viewfinder', surface = finder ? finderMesh : screenMesh;
        const rect = photo ? (finder ? finderCtx : uiCtx).cameraPhotoLayout.photoRect
            : (finder ? finderClickZones : uiClickZones).find(z => z.label === label);
        if (!rect) throw new Error(`Missing control: ${label}`);
        const p = new THREE.Vector3(((rect.x + rect.w / 2) / 1500 - .5) * surface.geometry.parameters.width,
            (.5 - (rect.y + rect.h / 2) / 1500) * surface.geometry.parameters.height, 0);
        surface.localToWorld(p); p.project(camera);
        return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 };
    }, { label, photo });
}
async function tap(page, mobile, label) {
    const p = await point(page, label);
    if (mobile) await page.touchscreen.tap(p.x, p.y); else await page.mouse.click(p.x, p.y);
}
try {
    for (const mobile of [false, true]) {
        const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
        await context.addInitScript(() => localStorage.setItem('sitePerformanceProfile', 'quality'));
        const page = await context.newPage(), errors = [], requests = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.route('**/metadata/metadata.json', r => r.fulfill({ json: { image_order: ['Fixture'], Fixture: {} } }));
        await page.route('**/fulls/*.jpg', r => r.fulfill({ path: 'assets/photographer.jpg', contentType: 'image/jpeg' }));
        let responseMode = 'success';
        const answer = '**Space scene:** Bright stars surround rugged asteroids against a deep blue background.\n\n- *Foreground:* Pale, irregular rocks.\n- Smaller golden fragments and scattered points of light fill the distance.';
        await page.route('**/mock-ai/v1/chat/completions', async r => {
            requests.push(r.request().postDataJSON());
            const mode = responseMode;
            if (mode === 'delay') await new Promise(resolve => setTimeout(resolve, 500));
            if (mode === 'error') return r.fulfill({ status: 503, body: 'Unavailable' });
            const text = mode === 'long' ? answer + ' Extra words that should never overflow the one page camera display. '.repeat(15) : answer;
            await r.fulfill({ contentType: 'text/event-stream', body: text.split(/(?<=\s)/).map(token => `data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`).join('') + 'data: [DONE]\n\n' }).catch(() => {});
        });
        await page.goto(base + '/?mode=3d', { waitUntil: 'networkidle' });
        await page.evaluate(() => {
            document.getElementById('space-intro').style.display = 'none'; els.welcome.style.display = 'none'; state.hasExplored = true;
            state.rendering.cameraMotion = false; applySceneRenderingSettings();
            state.vlmEnabled = false; state.vlmType = 'api'; state.vlmApiEndpoint = location.origin + '/mock-ai/v1'; state.vlmApiModel = 'fixture'; state.vlmApiKey = ''; syncVLMSettings();
            TWEEN.removeAll(); controls.enableDamping = false; camera.position.set(0, 0, innerWidth < 768 ? -44 : -25); controls.target.set(0, 0, 0); controls.update();
            setCameraSource('space');
        });
        await settle(page);
        assert.ok(await page.evaluate(async () => {
            const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 1200;
            const ctx = canvas.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1600, 1200);
            await watermarkCameraCapture(ctx, 1600, 1200);
            const roi = ctx.getImageData(1180, 1000, 400, 180).data;
            const bright = Array.from(roi).filter((v, i) => i % 4 !== 3 && v > 80).length;
            return bright > 1000 && ctx.getImageData(10, 10, 1, 1).data[0] === 0;
        }), 'Existing watermark is embedded at the lower right without changing the rest of the image');
        await page.waitForFunction(() => cameraLiveLastFrame > 0);
        assert.ok(await page.evaluate(() => uiCtx.cameraPhotoLayout.live && screenMesh.userData.livePlane.visible));
        const livePixels = await page.evaluate(() => {
            const data = new Uint8Array(cameraLiveTarget.width * cameraLiveTarget.height * 4);
            renderer.readRenderTargetPixels(cameraLiveTarget, 0, 0, cameraLiveTarget.width, cameraLiveTarget.height, data);
            return new Set(Array.from(data).filter((_, i) => i % 4 !== 3)).size;
        });
        assert.ok(livePixels > 20, 'Live framebuffer contains varied scene pixels');
        const p = await point(page, '', true);
        let cdp;
        if (mobile) {
            cdp = await context.newCDPSession(page);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x + 30, y: p.y + 12 }] });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else {
            await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 40, p.y + 20, { steps: 5 }); await page.mouse.up();
        }
        assert.ok(await page.evaluate(() => cameraAim.yaw !== 0 && cameraAim.pitch !== 0), 'Dragging aims live camera on both axes');
        await page.screenshot({ path: `.cache/camera-live-${mobile ? 'mobile' : 'desktop'}.png` });
        await tap(page, mobile, 'CAPTURE'); await settle(page);
        assert.ok(await page.evaluate(() => lastCameraPhoto.gallery === 'space' && lastCameraPhoto.src.startsWith('data:image/jpeg') && lastCameraPhoto.image.naturalWidth === 1600 && lastCameraPhoto.image.naturalHeight === 1200));
        assert.equal(await page.evaluate(() => cameraCaptureCount), 1);
        assert.equal(await page.evaluate(() => cameraLiveView), false);
        assert.equal(await page.evaluate(() => lastCameraPhoto.metadata['Image Copyright']), 'TheDoShoots / Timothy Do');
        assert.ok(await page.evaluate(() => !uiClickZones.some(z => z.label === 'AI INSPECT')));
        await page.evaluate(() => inspectCameraPhoto()); assert.equal(requests.length, 0, 'Disabled inspector makes no request');
        const download = page.waitForEvent('download'); await tap(page, mobile, 'SAVE PHOTO');
        assert.match((await download).suggestedFilename(), /^Space_.*\.jpg$/);
        const capturedSource = await page.evaluate(() => lastCameraPhoto.src);
        await tap(page, mobile, 'FULL SCREEN');
        await page.waitForFunction(() => document.querySelector('#camera-capture-viewer').open);
        await page.screenshot({ path: `.cache/camera-capture-${mobile ? 'mobile' : 'desktop'}.png` });
        assert.equal(await page.locator('#camera-capture-viewer img').getAttribute('src'), capturedSource);
        assert.ok(await page.locator('#camera-capture-viewer').evaluate(el => el.clientWidth >= innerWidth - 2 && el.clientHeight >= innerHeight - 2));
        const popupEvent = page.waitForEvent('popup');
        await page.locator('#camera-capture-viewer [data-tab]').click();
        const popup = await popupEvent;
        await popup.waitForFunction(() => document.querySelector('img')?.naturalWidth === 1600);
        assert.equal(await popup.locator('img').getAttribute('src'), capturedSource, 'New tab embeds the same watermarked base64 JPEG');
        assert.equal(await popup.evaluate(() => window.opener), null);
        await popup.close();
        await page.locator('#camera-capture-viewer [data-close]').click();
        await page.waitForFunction(() => !document.fullscreenElement);
        assert.equal(await page.evaluate(() => cameraInspection), 'screen', 'Closing full screen returns to the camera');
        await page.evaluate(() => { state.vlmEnabled = true; syncVLMSettings(); });
        await tap(page, mobile, 'AI INSPECT');
        await page.waitForFunction(() => cameraAI.visible && !cameraAI.busy && cameraAI.text);
        assert.equal(requests.length, 1);
        assert.equal(requests[0].messages.at(-1).content[0].image_url.url, await page.evaluate(() => lastCameraPhoto.src), 'AI sees the captured image');
        assert.match(requests[0].messages.at(-1).content[1].text, /40 words/);
        assert.match(requests[0].messages.at(-1).content[1].text, /Do not give photography advice/);
        assert.match(requests[0].messages[0].content, /Do not give photography advice/);
        assert.ok(await page.evaluate(() => {
            const runs = cameraMarkdownRuns(cameraAI.text);
            return runs.some(r => r.bold) && runs.some(r => r.italic) && runs.some(r => r.text?.includes('•')) && !runs.some(r => r.text?.includes('**'));
        }), 'Markdown emphasis and bullets render as styled canvas text');
        for (const finder of [false, true]) {
            await page.evaluate(finder => { focusCameraDisplay(finder ? 'viewfinder' : 'screen', true); updateUI(); }, finder);
            assert.ok(await page.evaluate(() => [uiCtx, finderCtx].every(ctx => ctx.cameraAILayout.height <= ctx.cameraAILayout.box.h)), 'Response fits one screen on both displays');
            assert.ok(await page.evaluate(() => {
                const ctx = cameraInspection === 'viewfinder' ? finderCtx : uiCtx;
                const pixels = ctx.getImageData(55, 145, 425, 725).data;
                return new Set(Array.from(pixels).filter((_, i) => i % 4 !== 3)).size > 30;
            }), 'Image stays visible beside AI response');
            await page.screenshot({ path: `.cache/camera-ai-${finder ? 'finder' : 'lcd'}-${mobile ? 'mobile' : 'desktop'}.png` });
        }
        await tap(page, mobile, 'HOME'); await settle(page);
        assert.equal(await page.evaluate(() => cameraDisplay), 'menu');
        assert.equal(await page.evaluate(() => cameraInspection), 'screen');
        assert.equal(await page.evaluate(() => cameraAI.visible), false);
        await page.evaluate(() => { cameraDisplay = 'photo'; cameraAI.photo = null; updateUI(); });
        responseMode = 'long';
        await tap(page, mobile, 'AI INSPECT'); await page.waitForFunction(() => !cameraAI.busy);
        assert.ok(await page.evaluate(() => cameraAI.text.trim().split(/\s+/).length <= 40));
        assert.ok(await page.evaluate(() => [uiCtx, finderCtx].every(ctx => ctx.cameraAILayout.height <= ctx.cameraAILayout.box.h)));
        await tap(page, mobile, 'CLOSE AI');
        responseMode = 'delay'; await page.evaluate(() => { cameraAI.photo = null; inspectCameraPhoto(); });
        await page.waitForFunction(() => cameraAI.busy); await page.evaluate(() => cameraHome());
        await page.waitForTimeout(650);
        assert.equal(await page.evaluate(() => cameraAI.visible || cameraAI.busy), false, 'Home cancels inspection and late responses stay closed');
        await page.evaluate(() => { cameraDisplay = 'photo'; updateUI(); });
        responseMode = 'error'; await tap(page, mobile, 'AI INSPECT'); await page.waitForFunction(() => !cameraAI.busy);
        assert.match(await page.evaluate(() => cameraAI.status), /unavailable/);
        await tap(page, mobile, 'CLOSE AI'); responseMode = 'success'; await tap(page, mobile, 'AI INSPECT');
        await page.waitForFunction(() => !cameraAI.busy && cameraAI.text);
        await page.evaluate(() => { state.vlmEnabled = false; syncVLMSettings(); });
        assert.equal(await page.evaluate(() => cameraAI.visible), false);
        await page.evaluate(async () => { await showCameraPhoto(); focusCameraDisplay('screen', true); setCameraLensZoom(18, true); });
        if (mobile) {
            const p = await point(page, '', true), before = await page.evaluate(() => ({ history: cameraHistory.length, position: camera.position.toArray() }));
            const touches = distance => [{ x: p.x - distance / 2, y: p.y, id: 1 }, { x: p.x + distance / 2, y: p.y, id: 2 }];
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touches(40) });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touches(100) });
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            assert.ok(await page.evaluate(() => cameraZoom > 40), 'Native pinch zooms the lens');
            assert.deepEqual(await page.evaluate(() => ({ history: cameraHistory.length, position: camera.position.toArray() })), before, 'Pinch never orbits or changes photos');
            const center = await point(page, '', true);
            await page.touchscreen.tap(center.x, center.y); await page.touchscreen.tap(center.x, center.y);
            assert.equal(await page.evaluate(() => cameraZoom), 18, 'Double tap resets zoom');
            await page.touchscreen.tap(5, 250);
            assert.equal(await page.evaluate(() => cameraInspection), 'screen', 'Near-miss touch does not leave the screen');
            for (const button of await page.locator('.mobile-camera-shortcuts button:visible').all()) {
                const box = await button.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44);
            }
            await page.locator('.mobile-camera-shortcuts [data-camera-action="menu"]').click(); await settle(page);
            assert.equal(await page.evaluate(() => cameraDisplay), 'menu');
            await cdp.detach();
        } else {
            await page.locator('#mode-3d canvas').focus(); await page.keyboard.press('h'); await settle(page);
            assert.equal(await page.evaluate(() => cameraDisplay), 'menu');
        }
        const shutterPoint = async () => page.evaluate(() => {
            leaveCameraInspection(true); cameraSource = 'portfolio'; cameraDisplay = 'menu';
            TWEEN.removeAll(); controls.enableDamping = false; camera.position.set(-22, 22, 32); controls.target.set(0, 0, 0); controls.update(); renderer.render(scene, camera);
            const p = cameraControls.get('shutter').meshes.at(-1).getWorldPosition(new THREE.Vector3()).project(camera);
            return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 };
        });
        const shutter = await shutterPoint();
        if (mobile) await page.touchscreen.tap(shutter.x, shutter.y); else await page.mouse.click(shutter.x, shutter.y);
        await settle(page); assert.equal(await page.evaluate(() => cameraLiveView), true, 'Physical shutter enters live mode');
        const count = await page.evaluate(() => cameraCaptureCount);
        await page.evaluate(() => {
            leaveCameraInspection(true); TWEEN.removeAll(); camera.position.set(-22, 22, 32); controls.target.set(0, 0, 0); controls.update(); renderer.render(scene, camera);
        });
        if (mobile) await page.touchscreen.tap(shutter.x, shutter.y); else await page.mouse.click(shutter.x, shutter.y);
        await settle(page); assert.equal(await page.evaluate(() => cameraCaptureCount), count + 1, 'Physical shutter actually takes a live space picture');
        const firstCapture = await page.evaluate(() => cameraCaptures[0].src);
        while (await page.evaluate(() => cameraCaptures.length) < 13) {
            const before = await page.evaluate(() => cameraCaptureCount);
            await tap(page, mobile, 'CAPTURE AGAIN'); await settle(page);
            assert.equal(await page.evaluate(() => cameraCaptureCount), before, 'Capture Again returns to composition without taking a shot');
            assert.ok(await page.evaluate(() => cameraLiveView && uiCtx.cameraPhotoLayout.live && screenMesh.userData.livePlane.visible), 'Capture Again restores the live preview');
            await tap(page, mobile, 'CAPTURE'); await settle(page);
            assert.equal(await page.evaluate(() => cameraCaptureCount), before + 1, 'Capture takes the next photograph after reframing');
        }
        assert.equal(await page.evaluate(() => cameraCaptures[0].src), firstCapture, 'Captures survive the twelve-item browsing history limit');
        assert.equal(await page.evaluate(() => new Set(cameraCaptures.map(photo => photo.name)).size), 13);
        await tap(page, mobile, 'FULL SCREEN');
        assert.equal(await page.locator('#camera-capture-viewer [data-count]').textContent(), 'Shot 13 of 13');
        assert.ok(await page.locator('#camera-capture-viewer [data-next]').isDisabled());
        await page.locator('#camera-capture-viewer [data-previous]').click(); await settle(page);
        assert.equal(await page.locator('#camera-capture-viewer [data-count]').textContent(), 'Shot 12 of 13');
        assert.equal(await page.locator('#camera-capture-viewer [data-save]').getAttribute('href'), await page.evaluate(() => cameraCaptures[11].src), 'Saving uses the selected shot');
        await page.locator('#camera-capture-viewer [data-next]').click(); await settle(page);
        assert.equal(await page.locator('#camera-capture-viewer [data-count]').textContent(), 'Shot 13 of 13');
        await page.locator('#camera-capture-viewer [data-previous]').click(); await settle(page);
        await page.locator('#camera-capture-viewer [data-live]').click();
        await page.waitForFunction(() => !document.fullscreenElement); await settle(page);
        assert.equal(await page.evaluate(() => cameraLiveView), true);
        await tap(page, mobile, 'CAPTURE'); await settle(page);
        assert.equal(await page.evaluate(() => cameraCaptures.length), 14, 'Shooting from an older photo appends without discarding later shots');
        await page.evaluate(() => setCameraSource('space')); await settle(page);
        await tap(page, mobile, 'REVIEW / 14'); await settle(page);
        assert.equal(await page.evaluate(() => lastCameraPhoto.src === cameraCaptures.at(-1).src), true, 'Live view can review the latest capture');
        assert.deepEqual(errors, []);
        console.log(`${mobile ? 'Mobile' : 'Desktop'} live capture, download, Markdown AI, word cap, cancellation, Home, and gestures passed.`);
        await context.close();
    }
} finally { await browser.close(); }
