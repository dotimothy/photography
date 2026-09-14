import assert from 'node:assert/strict';
import {chromium} from '../.cache/browser/node_modules/playwright/index.mjs';

const browser = await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true});
try {
    for (const viewport of [{width:1440,height:900},{width:390,height:844}]) {
        const context = await browser.newContext({viewport, reducedMotion:'reduce', serviceWorkers:'block'});
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', async route => {
            const url = route.request().url();
            if (url.includes('three.min.js')) return route.fulfill({path:'tmp/three.min.js',contentType:'application/javascript'});
            if (url.includes('gsap.min.js')) return route.fulfill({path:'tmp/gsap.min.js',contentType:'application/javascript'});
            if (!url.startsWith('http://127.0.0.1:8765/')) return route.abort();
            if (url.includes('/fulls/')) return route.fulfill({path:'assets/photographer.jpg',contentType:'image/jpeg'});
            return route.continue();
        });
        for (const [gallery, emoji] of [['astronomy','⭐'],['food','🍎'],['landscape','🌳'],['planes','✈'],['wildlife','🐕']]) {
            await page.goto(`http://127.0.0.1:8765/build/portfolios/${gallery}/index.html?mode=3d`, {waitUntil:'domcontentloaded'});
            await page.waitForFunction(() => window.galleryApp?.view3d?.frames.length > 0);
            const state = await page.evaluate(() => {
                const view = galleryApp.view3d;
                return {emoji:view.shapeEmoji, shape:view.useShape, count:view.frames.length, images:view.images.length};
            });
            assert.equal(state.emoji, emoji);
            assert.equal(state.shape, true);
            assert.equal(state.count, state.images);
            // Use 25 existing frames for visual and interaction checks without changing curation.
            await page.evaluate(() => {
                const v=galleryApp.view3d;
                v.frames.slice(25).forEach(f=>v.pivot.remove(f));
                v.frames=v.frames.slice(0,25);
                v.applyArrangement();
                document.getElementById('loading-screen').style.display='none';
            });
            await page.waitForTimeout(150);
            await page.screenshot({path:`tmp/shape-${gallery}-${viewport.width}.png`});
            await page.getByRole('button',{name:'View Sphere',exact:true}).click();
            assert.equal(await page.evaluate(()=>galleryApp.view3d.useShape),false);
            await page.getByRole('button',{name:`View ${emoji} Shape`,exact:true}).click();
            await page.evaluate(()=>galleryApp.view3d.enterLineView(0));
            await page.waitForTimeout(850);
            await page.evaluate(()=>galleryApp.view3d.exitLineView());
            await page.waitForTimeout(150);
            assert.ok(await page.evaluate(()=>galleryApp.view3d.frames.every(f=>f.position.distanceTo(f.userData.originalPos)<.001)));
            await page.evaluate(()=>galleryApp.switchMode('2D'));
            assert.equal(await page.getByRole('button',{name:'View Sphere',exact:true}).isVisible(),false);
            await page.evaluate(()=>galleryApp.switchMode('3D'));
            assert.ok(await page.getByRole('button',{name:'View Sphere',exact:true}).isVisible());
            console.log(`${gallery}: ${viewport.width}px configuration, switching, return, and 2D isolation passed`);
        }
        for (const value of ['', 'unsupported']) {
            await page.route('**/astronomy/index.html?*', async route => {
                const response = await route.fetch();
                const html = (await response.text()).replace(/<meta name="gallery-shape-emoji"[^>]*>/,
                    value ? `<meta name="gallery-shape-emoji" content="${value}">` : '');
                await route.fulfill({response, body:html});
            });
            await page.goto('http://127.0.0.1:8765/build/portfolios/astronomy/index.html?mode=3d', {waitUntil:'domcontentloaded'});
            await page.waitForFunction(()=>window.galleryApp?.view3d?.frames.length>0);
            assert.equal(await page.evaluate(()=>galleryApp.view3d.useShape),false);
            assert.equal(await page.evaluate(()=>galleryApp.view3d.shapeButton),undefined);
            await page.unroute('**/astronomy/index.html?*');
        }
        console.log(`${viewport.width}px: missing and unsupported emoji sphere fallbacks passed`);
        await page.emulateMedia({reducedMotion:'no-preference'});
        await page.goto('http://127.0.0.1:8765/build/portfolios/astronomy/index.html?mode=3d', {waitUntil:'domcontentloaded'});
        await page.waitForFunction(()=>window.galleryApp?.view3d?.frames.length>0);
        await page.evaluate(() => {
            const view = galleryApp.view3d;
            view.enterLineView(0);
            view.exitLineView();
            view.useShape = false;
            view.applyArrangement(true);
            view.useShape = true;
            view.applyArrangement(true);
        });
        await page.waitForTimeout(1100);
        assert.ok(await page.evaluate(()=>galleryApp.view3d.frames.every(f=>f.position.distanceTo(f.userData.originalPos)<.001)));
        assert.equal(await page.evaluate(()=>galleryApp.view3d.isTransitioning),false);
        console.log(`${viewport.width}px: interrupted transitions settle on the selected shape`);
        assert.deepEqual(errors, []);
        await context.close();
    }
} finally { await browser.close(); }
