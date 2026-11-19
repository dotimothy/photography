// Local AI models are downloaded only on request: nothing on page load, on opening the
// inspector or from the camera LCD; then download with progress, cancel, failure, resume,
// delete and state after reload. The model host and CDN are replaced by small fakes, so
// no real weights are fetched.
import assert from 'node:assert/strict';
import { chromium } from '../.cache/browser/node_modules/playwright/index.mjs';
const base = process.env.SITE_URL || 'http://127.0.0.1:8765/build';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });

const SMOL = 'HuggingFaceTB/SmolVLM-256M-Instruct';
const FAST = 'onnx-community/FastVLM-0.5B-ONNX';
const RUNTIME_BYTES = 21_596_019;   // vlm/modelCatalog.js RUNTIME_FILE.size
const MODEL_REQUEST = /huggingface\.co|hf\.co\/|vlmWorker|cdn\.jsdelivr\.net\/npm\/@huggingface|onnxruntime/;

// A repository listing in the shape of the Hugging Face tree API.
const listing = [
    ...['config.json', 'generation_config.json', 'preprocessor_config.json', 'processor_config.json', 'tokenizer_config.json', 'chat_template.json']
        .map((path, i) => ({ type: 'file', path, size: 300 + i })),
    { type: 'file', path: 'tokenizer.json', size: 400_000 },
    { type: 'file', path: 'README.md', size: 1000 },
    ...['embed_tokens', 'vision_encoder', 'decoder_model_merged'].flatMap((module, m) => ['', '_fp16', '_q4', '_quantized']
        .map((suffix, s) => ({ type: 'file', path: `onnx/${module}${suffix}.onnx`, size: 1_500_000 + m * 400_000 + s * 1000, lfs: { size: 1_500_000 + m * 400_000 + s * 1000 } }))),
];
const sizes = new Map(listing.map(file => [file.path, file.size]));
const DECODER = /decoder_model_merged/;

/** Serve the fake model host. `control` is mutated by the test to slow or break one file. */
async function fakeModelHost(context, control, log) {
    await context.route(/^https:\/\/(huggingface\.co|[\w.-]+\.hf\.co|cdn\.jsdelivr\.net\/npm\/@huggingface)\//, async (route) => {
        const url = route.request().url();
        log.push(url);
        const cors = { 'access-control-allow-origin': '*' };
        if (url.includes('/api/models/')) return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(listing) });
        if (url.endsWith('ort-wasm-simd-threaded.jsep.wasm')) return route.fulfill({ status: 200, headers: cors, contentType: 'application/wasm', body: Buffer.alloc(RUNTIME_BYTES) });
        const path = url.split('/resolve/main/')[1];
        if (!path || !sizes.has(path)) return route.fulfill({ status: 404, headers: cors, body: 'not found' });
        if (DECODER.test(path)) {
            if (control.slow) await new Promise(resolve => setTimeout(resolve, control.slow));
            if (control.fail) return route.fulfill({ status: 503, headers: cors, body: 'unavailable' });
        } else if (control.pace) await new Promise(resolve => setTimeout(resolve, control.pace));
        return route.fulfill({ status: 200, headers: cors, contentType: 'application/octet-stream', body: Buffer.alloc(sizes.get(path)) });
    });
}

const row = (page, id) => page.locator(`#vlm-model-list .vlm-model-item[data-id="${id}"]`);
const cachedFiles = (page, id) => page.evaluate(async (modelId) => {
    if (!(await caches.has('transformers-cache'))) return [];
    return (await (await caches.open('transformers-cache')).keys()).map(request => request.url).filter(url => url.includes(modelId));
}, id);
const fileRequests = log => log.filter(url => url.includes('/resolve/main/')).map(url => url.split('/resolve/main/')[1]);

async function openHome(context) {
    const page = await context.newPage(), requests = [], errors = [];
    page.on('request', request => requests.push(request.url()));
    page.on('pageerror', error => errors.push(error.message));
    return { page, requests, errors };
}

try {
    // ── 1. Nothing model-related is requested until Download is pressed ─────────────────────
    for (const mobile of [false, true]) {
        const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
        const log = [];
        await fakeModelHost(context, {}, log);
        const { page, requests, errors } = await openHome(context);
        const silent = (when) => {
            assert.deepEqual(requests.filter(url => MODEL_REQUEST.test(url)), [], `model request ${when}`);
            assert.deepEqual(log, [], `model host contacted ${when}`);
        };

        await page.goto(`${base}/index.html?mode=3d`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !!window.VLM_MODELS);
        assert.equal(await page.evaluate(() => state.vlmType), 'local', 'local backend is the default under test');
        await page.waitForTimeout(800);
        silent('on page load');

        await page.evaluate(async () => {
            document.getElementById('space-intro').style.display = 'none'; els.welcome.style.display = 'none'; state.hasExplored = true;
            if (!lastCameraPhoto && !cameraPhotoBusy) await showCameraPhoto(null, 'preview');
        });
        await page.waitForFunction(() => lastCameraPhoto?.image && !cameraPhotoBusy);
        await page.locator('#btn-controls-toggle').click();
        await page.locator('#btn-open-inspector').click();
        await page.locator('.vlm-panel.vlm-open').waitFor({ state: 'visible' });
        await page.waitForTimeout(800);
        const engine = await page.evaluate(async () => {
            const { VLMManager } = await import('./vlm/VLMManager.js?v=12');
            const manager = VLMManager.getInstance();
            return { ready: manager.isReady, loading: manager.isLoading, worker: !!manager._worker, status: await window.VLM_MODELS.status(state.vlmModel) };
        });
        assert.deepEqual(engine, { ready: false, loading: false, worker: false, status: 'not-downloaded' }, 'opening the inspector loads nothing');
        silent('after opening the inspector');

        // Switching model in settings is allowed and still loads nothing.
        await page.evaluate((id) => selectVLMModel(id), SMOL);
        await page.waitForTimeout(400);
        silent('after switching model');

        // The camera's own AI INSPECT reports what is needed instead of downloading.
        await page.evaluate(() => inspectCameraPhoto());
        await page.waitForFunction(() => !cameraAI.busy);
        assert.equal(await page.evaluate(() => cameraAI.status), 'Download A Model In Settings');
        silent('after camera AI INSPECT');
        assert.deepEqual(errors, []);
        await context.close();
    }

    {   // A gallery page opened directly behaves the same.
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
        const log = [];
        await fakeModelHost(context, {}, log);
        const { page, requests } = await openHome(context);
        await page.goto(`${base}/portfolios/astronomy/index.html?mode=2d`, { waitUntil: 'domcontentloaded' });
        // The gallery's AI Inspector now lives in the gallery menu.
        if (!await page.locator('#portfolio-inspector').isVisible()) await page.locator('#controls-toggle').click();
        await page.locator('#portfolio-inspector').click();
        await page.locator('.vlm-panel.vlm-open').waitFor({ state: 'visible' });
        await page.waitForFunction(() => !!window.VLM_MODELS);
        await page.waitForTimeout(800);
        assert.equal(await page.evaluate(id => window.VLM_MODELS.status(id), FAST), 'not-downloaded');
        assert.deepEqual([...requests.filter(url => MODEL_REQUEST.test(url)), ...log], [], 'gallery inspector requested a model');
        await context.close();
    }
    console.log('No model, tokenizer or config request on page load, inspector open, model switch, camera AI INSPECT or gallery inspector');

    // ── 2. Download, progress, modal close, reload, delete, cancel, failure, resume ─────────
    {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
        const control = { pace: 250 }, log = [];
        await fakeModelHost(context, control, log);
        await context.addInitScript(() => {
            window.__vlmEvents = [];
            window.addEventListener('vlm-model-state', event => window.__vlmEvents.push({ ...event.detail, at: performance.now() }));
        });
        const { page, errors } = await openHome(context);
        await page.goto(`${base}/index.html?settings=ai`, { waitUntil: 'domcontentloaded' });
        await page.locator('#settings-overlay.visible #settings-pane-ai.active').waitFor({ state: 'visible' });
        await row(page, SMOL).and(page.locator('[data-state="not-downloaded"]')).waitFor();
        assert.equal(await page.locator('#vlm-model-list .vlm-model-item').count(), 7);
        assert.match(await row(page, SMOL).locator('[data-action="download"]').innerText(), /^Download\s*2\d\d MB$/);
        assert.match(await row(page, FAST).locator('[data-action="download"]').innerText(), /^Download\s*1\.\d+ GB$/, 'the real size of the largest model is stated');
        assert.equal(await row(page, 'LiquidAI/LFM2.5-VL-450M-ONNX').locator('button').count(), 0, 'a model that cannot run offers no download');
        assert.deepEqual(log, [], 'rendering the list contacts nobody');

        // Every button label in the pane has each word capitalised.
        const labels = await page.locator('#settings-pane-ai button').evaluateAll(buttons => buttons
            .map(button => [...button.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('').trim()).filter(text => /[a-z]/i.test(text)));
        for (const label of labels) assert.match(label, /^[A-Z][A-Za-z]*( [A-Z][A-Za-z]*)*$/, `button label "${label}"`);
        for (const expected of ['Download', 'Refresh', 'Clear All Cache', 'Fetch Models', 'Active Models', 'Reset To Default']) assert.ok(labels.includes(expected), expected);

        // Download with progress.
        await row(page, SMOL).locator('[data-action="download"]').click();
        const bar = row(page, SMOL).locator('[role="progressbar"]');
        await bar.waitFor();
        assert.equal(await row(page, SMOL).locator('[data-action="cancel"]').innerText(), 'Cancel');
        await page.waitForFunction(id => /MB of [\d.]+ MB · \d+%/.test(document.querySelector(`.vlm-model-item[data-id="${id}"] [data-role="progress-label"]`)?.textContent ?? ''), SMOL);
        assert.equal(await page.evaluate(id => window.VLM_MODELS.status(id), SMOL), 'downloading');
        const mid = await page.evaluate(id => window.VLM_MODELS.progress(id), SMOL);
        assert.ok(mid.total > RUNTIME_BYTES && mid.loaded > 0 && mid.loaded < mid.total, JSON.stringify(mid));

        // The download belongs to the page, not the modal.
        await page.locator('#btn-close-settings').click();
        await page.waitForFunction(() => !document.querySelector('#settings-overlay').classList.contains('visible'));
        await page.waitForFunction(id => window.VLM_MODELS.status(id).then(status => status === 'downloaded'), SMOL, { timeout: 30000, polling: 200 });
        await page.locator('#btn-controls-toggle').click();
        await page.locator('#btn-open-settings').click();
        await page.locator('[data-tab="ai"]').click();
        await row(page, SMOL).and(page.locator('[data-state="downloaded"]')).waitFor();
        assert.match(await row(page, SMOL).locator('.vlm-model-status').innerText(), /^Downloaded · [\d.]+ MB/);
        assert.deepEqual(await row(page, SMOL).locator('button').allInnerTexts(), ['Use This Model', 'Delete']);
        assert.match(await page.locator('#vlm-cache-total').innerText(), /of models stored .* used of .* available to this site/);

        const events = (await page.evaluate(() => window.__vlmEvents)).filter(event => event.modelId === SMOL);
        const ticks = events.filter(event => event.state === 'downloading');
        assert.equal(events.at(-1).state, 'downloaded');
        assert.ok(ticks.length >= 3, 'progress events were dispatched');
        for (let i = 3; i < ticks.length; i++) assert.ok(ticks[i].at - ticks[i - 1].at >= 240, 'at most four progress events per second');
        const wanted = fileRequests(log);
        assert.equal(new Set(wanted).size, wanted.length, 'each file fetched once');
        assert.equal(wanted.length, 10, 'six config files, tokenizer, three weights');
        assert.ok(wanted.every(path => !/README|_quantized/.test(path)), 'only the files this device loads');
        assert.equal(await page.evaluate(() => navigator.storage.estimate().then(estimate => estimate.usage > 20e6)), true);

        // Use This Model selects it.
        await row(page, SMOL).locator('[data-action="use"]').click();
        assert.equal(await page.evaluate(() => localStorage.getItem('vlmModel')), SMOL);
        await row(page, SMOL).and(page.locator('.selected')).waitFor();
        assert.match(await row(page, SMOL).locator('.vlm-model-status').innerText(), /in use/);

        // State after reload comes from browser storage, with no request.
        log.length = 0;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await row(page, SMOL).and(page.locator('[data-state="downloaded"]')).waitFor();
        assert.equal(await page.evaluate(id => window.VLM_MODELS.status(id), SMOL), 'downloaded');
        assert.deepEqual(log.filter(url => !url.includes('cdn.jsdelivr.net')), [], 'reload re-checked storage without the network');

        // Delete.
        await row(page, SMOL).locator('[data-action="delete"]').click();
        await row(page, SMOL).and(page.locator('[data-state="not-downloaded"]')).waitFor();
        assert.deepEqual(await cachedFiles(page, SMOL), []);
        assert.equal(await page.evaluate(id => window.VLM_MODELS.status(id), SMOL), 'not-downloaded');

        // Cancel in the middle of a file: nothing is kept, nothing counts as downloaded.
        control.slow = 4000;
        await row(page, SMOL).locator('[data-action="download"]').click();
        await page.waitForFunction(id => (window.VLM_MODELS.progress(id)?.loaded ?? 0) > 1e6, SMOL, { polling: 100 });
        await row(page, SMOL).locator('[data-action="cancel"]').click();
        await row(page, SMOL).and(page.locator('[data-state="not-downloaded"]')).waitFor();
        assert.deepEqual(await cachedFiles(page, SMOL), [], 'cancel returns the storage it used');
        assert.equal(await page.evaluate(id => window.VLM_MODELS.progress(id), SMOL), null);
        assert.equal(await row(page, SMOL).locator('[data-action="download"]').innerText().then(text => text.startsWith('Download')), true);
        control.slow = 0;

        // Failure: the model is not downloaded, the reason is shown, and it stays that way after reload.
        control.fail = true;
        await row(page, SMOL).locator('[data-action="download"]').click();
        await row(page, SMOL).locator('.vlm-model-status.error').waitFor({ timeout: 30000 });
        assert.match(await row(page, SMOL).locator('.vlm-model-status.error').innerText(), /HTTP 503/);
        assert.equal(await page.evaluate(id => window.VLM_MODELS.status(id), SMOL), 'not-downloaded');
        const partial = await cachedFiles(page, SMOL);
        assert.ok(partial.length === 9 && !partial.some(url => DECODER.test(url)), 'finished files are kept, the failed one is absent');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await row(page, SMOL).and(page.locator('[data-state="not-downloaded"]')).waitFor();
        assert.equal(await page.evaluate(id => window.VLM_MODELS.status(id), SMOL), 'not-downloaded', 'a half-downloaded model never counts');
        assert.match(await row(page, SMOL).locator('.vlm-model-status').innerText(), /Download incomplete/);
        assert.deepEqual(await row(page, SMOL).locator('button').allInnerTexts().then(texts => texts.map(text => text.replace(/\s*[\d.]+ [MG]B$/, ''))), ['Resume Download', 'Delete']);
        await page.waitForTimeout(600);
        assert.deepEqual(fileRequests(log).length, 19, 'a failed download does not restart by itself after reload');

        // Resume fetches only what is missing.
        control.fail = false;
        log.length = 0;
        await row(page, SMOL).locator('[data-action="download"]').click();
        await row(page, SMOL).and(page.locator('[data-state="downloaded"]')).waitFor({ timeout: 30000 });
        assert.deepEqual(fileRequests(log), ['onnx/decoder_model_merged_q4.onnx']);
        assert.deepEqual(errors, []);
        await page.screenshot({ path: '.cache/model-downloads-desktop.png' });
        await context.close();
    }
    console.log('Download with progress survives closing settings; reload, delete, cancel, failure and resume keep storage and status consistent');

    // ── 3. A download interrupted by navigation continues on the next page ──────────────────
    {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
        const control = { slow: 2500 }, log = [];
        await fakeModelHost(context, control, log);
        const { page } = await openHome(context);
        await page.goto(`${base}/index.html?settings=ai`, { waitUntil: 'domcontentloaded' });
        await row(page, SMOL).locator('[data-action="download"]').click();
        await page.waitForFunction(id => (window.VLM_MODELS.progress(id)?.loaded ?? 0) > 1e6, SMOL, { polling: 100 });
        control.slow = 0;
        await page.goto(`${base}/index.html?mode=2d`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(id => window.VLM_MODELS?.status(id).then(status => status === 'downloaded'), SMOL, { timeout: 30000, polling: 200 });
        await context.close();
    }
    console.log('A download in progress resumes after navigating to another page of the site');

    // ── 3b. A download is visible, and cancellable, from another tab of the site ────────────
    {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
        const control = { slow: 6000 }, log = [];
        await fakeModelHost(context, control, log);
        const { page } = await openHome(context);
        await page.goto(`${base}/index.html?settings=ai`, { waitUntil: 'domcontentloaded' });
        const other = await context.newPage();
        await other.goto(`${base}/index.html?settings=ai`, { waitUntil: 'domcontentloaded' });
        await row(other, SMOL).and(other.locator('[data-state="not-downloaded"]')).waitFor();
        await row(page, SMOL).locator('[data-action="download"]').click();
        await page.waitForFunction(id => (window.VLM_MODELS.progress(id)?.loaded ?? 0) > 1e6, SMOL, { polling: 100 });
        await row(other, SMOL).locator('[role="progressbar"]').waitFor();
        assert.equal(await other.evaluate(id => window.VLM_MODELS.status(id), SMOL), 'downloading');
        // Progress is mirrored to the other tab (within the four-per-second throttle).
        await other.waitForFunction(id => (window.VLM_MODELS.progress(id)?.loaded ?? 0) > 1e6, SMOL, { polling: 100, timeout: 5000 });
        await row(other, SMOL).locator('[data-action="cancel"]').click();
        await row(page, SMOL).and(page.locator('[data-state="not-downloaded"]')).waitFor();
        await row(other, SMOL).and(other.locator('[data-state="not-downloaded"]')).waitFor();
        assert.deepEqual(await cachedFiles(page, SMOL), []);
        await context.close();
    }
    console.log('Another tab sees the download, mirrors its progress and can cancel it');

    // ── 4. Phones are warned before a large download and pointed at the smallest model ──────
    for (const width of [390, 320]) {
        const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true, serviceWorkers: 'block',
            userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' });
        const control = { pace: 150 }, log = [];
        await fakeModelHost(context, control, log);
        const { page, errors } = await openHome(context);
        await page.goto(`${base}/index.html?settings=ai`, { waitUntil: 'domcontentloaded' });
        await row(page, FAST).and(page.locator('[data-state="not-downloaded"]')).waitFor();
        const overflow = () => page.locator('.settings-modal').evaluate(el => el.scrollWidth > el.clientWidth);
        assert.equal(await page.locator('#vlm-model-list .vlm-model-item').first().getAttribute('data-id'), SMOL, 'smallest model is listed first on a phone');
        assert.equal(await row(page, SMOL).locator('.vlm-model-tag.recommended').count(), 1);

        await row(page, FAST).locator('[data-action="download"]').click();
        const warning = row(page, FAST).locator('.vlm-model-warning');
        await warning.waitFor();
        assert.match(await warning.innerText(), /too large for a phone[\s\S]*SmolVLM 256M \(211 MB\) is recommended/);
        assert.deepEqual(await row(page, FAST).locator('button').allInnerTexts(), ['Download Anyway', 'Cancel']);
        assert.equal(await overflow(), false, `${width}px warning overflow`);
        assert.deepEqual(log, [], 'the warning comes before any request');
        await row(page, FAST).locator('[data-action="dismiss"]').click();
        await warning.waitFor({ state: 'detached' });

        // The smallest model downloads without a warning; no state of its row overflows.
        await row(page, SMOL).locator('[data-action="download"]').click();
        await row(page, SMOL).locator('[role="progressbar"]').waitFor();
        assert.equal(await overflow(), false, `${width}px progress overflow`);
        await page.screenshot({ path: `.cache/model-downloads-${width}-progress.png` });
        await row(page, SMOL).and(page.locator('[data-state="downloaded"]')).waitFor({ timeout: 30000 });
        assert.equal(await overflow(), false, `${width}px downloaded overflow`);
        await page.screenshot({ path: `.cache/model-downloads-${width}.png` });
        assert.deepEqual(errors, []);
        await context.close();
    }
    console.log('Phones get a size warning with a recommendation, and the download rows fit at 390px and 320px');
} finally { await browser.close(); }
