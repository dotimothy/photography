import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    ModelGate,
    describeModel,
    describeProgress,
    findStableBoundary,
    formatCoordinates,
    galleryFromUrl,
    isTitleCase,
    locationLinks,
    mayContainMath,
    placeKey,
    placeLabelFromAddress,
    thumbnailFor,
    titleCase,
} from './InspectorCore.js';
import { getModel } from './modelCatalog.js';

const read = (name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
const overlaySource = read('./GalleryVLMOverlay.js');
const mapSource = read('./InspectorMap.js');
const styleSource = read('./inspectorStyles.js');

// ─── Markup and wiring ───────────────────────────────────────────────────────

test('every directly wired panel control exists in the rendered markup', () => {
    const wired = new Set([...overlaySource.matchAll(/this\._q\('([^']+)'\)\.addEventListener/g)].map(m => m[1]));
    const rendered = new Set([...overlaySource.matchAll(/id="\$\{id\}([^"$]+)"/g)].map(m => m[1]));
    assert.ok(rendered.size > 20);
    assert.deepEqual([...wired].filter(control => !rendered.has(control)).sort(), []);
});

test('every method the overlay calls on itself is defined', () => {
    const called = new Set([...overlaySource.matchAll(/this\.(_[A-Za-z0-9]+)\(/g)].map(m => m[1]));
    const defined = new Set([...overlaySource.matchAll(/^ {4}(?:async |get )?(_[A-Za-z0-9]+)\(/gm)].map(m => m[1]));
    // Methods page scripts replace at runtime are allowed to be absent from the class body.
    assert.deepEqual([...called].filter(name => !defined.has(name)).sort(), []);
});

test('search mode has controls and isolates the chat content', () => {
    assert.match(overlaySource, /id="\$\{id\}-mode-chat"/);
    assert.match(overlaySource, /id="\$\{id\}-mode-search"/);
    assert.match(overlaySource, /class="vlm-messages vlm-chat-only"/);
    assert.match(overlaySource, /class="vlm-composer vlm-chat-only"/);
});

test('the launcher is exposed as soon as the gallery container activates, and hides while the panel is open', () => {
    assert.match(overlaySource, /container\.classList\.contains\('active'\)[\s\S]*?this\._btn\.style\.display = ''/);
    assert.match(overlaySource, /fallbackAttempts < 20/);
    assert.match(overlaySource, /classList\.toggle\('vlm-toggle-hidden', !!open\)/);
    assert.match(styleSource, /\.vlm-toggle-hidden \{ display: none !important; \}/);
    assert.match(styleSource, /bottom: calc\(16px \+ env\(safe-area-inset-bottom/);
});

test('the panel uses the site font and the space theme, and CDN code is pinned with integrity', () => {
    assert.match(styleSource, /'Roboto'/);
    assert.doesNotMatch(overlaySource + styleSource, /family=Inter|'Inter'/);
    assert.match(styleSource, /--vlm-accent: #00e5ff/);
    for (const source of [overlaySource, mapSource]) {
        for (const [, url] of source.matchAll(/'(https:\/\/cdn\.jsdelivr\.net\/npm\/[^']+)'/g)) {
            assert.match(url, /@\d+\.\d+\.\d+\//, `${url} names an exact version`);
        }
    }
    assert.match(overlaySource, /integrity: 'sha384-/);
    assert.match(mapSource, /jsIntegrity: 'sha384-/);
});

// ─── Title Case ──────────────────────────────────────────────────────────────

test('titleCase capitalises every word and keeps existing capitals', () => {
    assert.equal(titleCase('Describe the image'), 'Describe The Image');
    assert.equal(titleCase('Where was this taken?'), 'Where Was This Taken?');
    assert.equal(titleCase('What camera settings were used?'), 'What Camera Settings Were Used?');
    assert.equal(titleCase('open AI settings'), 'Open AI Settings');
    assert.equal(titleCase('read aloud: off'), 'Read Aloud: Off');
    assert.equal(isTitleCase('Back To Camera'), true);
    assert.equal(isTitleCase('Back to Camera'), false);
    assert.equal(isTitleCase('EXIF'), true);
});

test('every static button label, title and aria-label in the inspector is Title Case', () => {
    const labels = [];
    const sources = overlaySource + mapSource;
    for (const [, tag] of sources.matchAll(/<button\b([^>]*)>/g)) {
        for (const [, value] of tag.matchAll(/(?:title|aria-label)="([^"$]+)"/g)) labels.push(value);
    }
    for (const [, inner] of sources.matchAll(/<button\b[^>]*>([^<$]+)<\/button>/g)) labels.push(inner.trim());
    for (const [, value] of sources.matchAll(/button\(doc, '([^']+)'/g)) labels.push(value);
    for (const [, value] of sources.matchAll(/(?:Btn|btn|button|Button|Tab)\.(?:title|textContent)\s*=\s*'([^']+)'/g)) labels.push(value);
    for (const [, value] of sources.matchAll(/className: 'vlm-btn[^']*', textContent: '([^']+)'/g)) labels.push(value);
    const lower = labels.filter(label => label && !/^[^A-Za-z]*$/.test(label) && !isTitleCase(label));
    // Sentences shown as body text (not labels) are allowed; everything here is a control label.
    const sentences = lower.filter(label => /[.…]$/.test(label) && label.split(' ').length > 3);
    assert.deepEqual(lower.filter(label => !sentences.includes(label)), []);
});

test('suggestion buttons show Title Case but submit the original prompt', () => {
    assert.match(overlaySource, /'Describe the image'/);
    assert.match(overlaySource, /data-prompt="\$\{this\._escapeHtml\(prompt\)\}"/);
    assert.match(overlaySource, /\$\{this\._escapeHtml\(titleCase\(prompt\)\)\}/);
    assert.match(overlaySource, /input\.value = button\.dataset\.prompt/);
});

// ─── Model gate (download contract) ──────────────────────────────────────────

function stubWorld({ status = 'not-downloaded', progress = null, type = 'local', model = 'HuggingFaceTB/SmolVLM-256M-Instruct' } = {}) {
    const world = {
        status,
        progress,
        calls: [],
        manager: { _mode: 'local', isReady: false, isLoading: false, _modelId: null },
        settings: { type, model },
        changes: 0,
    };
    world.models = {
        status: async (id) => { world.calls.push(['status', id]); return world.status; },
        progress: (id) => { world.calls.push(['progress', id]); return world.progress; },
        download: () => { throw new Error('the panel must never download'); },
    };
    world.gate = new ModelGate({
        getModels: () => world.models,
        getSettings: () => world.settings,
        getManager: () => world.manager,
        onChange: () => { world.changes++; },
    });
    return world;
}

test('a local model that is not downloaded blocks chat and asks for AI Settings', async () => {
    const world = stubWorld();
    assert.equal(world.gate.view, 'checking');
    assert.equal(world.gate.canChat, false);
    assert.equal(await world.gate.refresh(), 'not-downloaded');
    assert.equal(world.gate.canChat, false);
    assert.deepEqual(world.calls, [['status', 'HuggingFaceTB/SmolVLM-256M-Instruct']]);
});

test('download progress comes from the event, and a finished download is "loading" until the manager is ready', async () => {
    const world = stubWorld({ status: 'downloading', progress: { loaded: 50e6, total: 211e6 } });
    assert.equal(await world.gate.refresh(), 'downloading');
    assert.deepEqual(world.gate.progress, { loaded: 50e6, total: 211e6 });
    world.gate.handleEvent({ modelId: world.settings.model, state: 'downloading', loaded: 100e6, total: 211e6 });
    assert.deepEqual(describeProgress(world.gate.progress), { pct: 47, text: '100 MB of 211 MB' });
    assert.equal(world.gate.canChat, false);
    world.gate.handleEvent({ modelId: world.settings.model, state: 'downloaded' });
    assert.equal(world.gate.view, 'loading');
    world.gate.handleEvent({ modelId: world.settings.model, state: 'loading' });
    assert.equal(world.gate.view, 'loading');
    world.manager.isReady = true;
    world.gate.markReady();
    assert.equal(world.gate.view, 'none');
    assert.equal(world.gate.canChat, true);
});

test('a model released after idling ({state: ready, suspended: true}) still counts as ready', async () => {
    const world = stubWorld({ status: 'downloaded' });
    world.manager.isReady = true;
    assert.equal(await world.gate.refresh(), 'none');
    world.gate.handleEvent({ modelId: world.settings.model, state: 'ready', suspended: true });
    assert.equal(world.gate.view, 'none');
    assert.equal(world.gate.canChat, true);
});

test('events for other models are ignored; errors and deletions are reported', async () => {
    const world = stubWorld({ status: 'downloaded' });
    world.manager.isReady = true;
    await world.gate.refresh();
    assert.equal(world.gate.handleEvent({ modelId: 'someone/else', state: 'not-downloaded' }), false);
    assert.equal(world.gate.canChat, true);
    world.gate.handleEvent({ modelId: world.settings.model, state: 'error', message: 'WebGPU lost' });
    assert.equal(world.gate.view, 'error');
    assert.equal(world.gate.message, 'WebGPU lost');
    world.manager.isReady = false;
    world.gate.handleEvent({ modelId: world.settings.model, state: 'not-downloaded' });
    assert.equal(world.gate.view, 'not-downloaded');
    assert.equal(world.gate.canChat, false);
});

test('a live event outranks a status() answer that arrives later', async () => {
    const world = stubWorld();
    let release;
    world.models.status = () => new Promise(resolve => { release = resolve; });
    const pending = world.gate.refresh();
    world.gate.handleEvent({ modelId: world.settings.model, state: 'downloading', loaded: 1, total: 2 });
    release('not-downloaded');
    await pending;
    assert.equal(world.gate.view, 'downloading');
});

test('API and Ollama backends, and pages without VLM_MODELS, are never gated', async () => {
    for (const type of ['api', 'ollama']) {
        const world = stubWorld({ type });
        world.manager.isReady = true;
        assert.equal(world.gate.applies, false);
        assert.equal(await world.gate.refresh(), 'none');
        assert.equal(world.gate.canChat, true);
        assert.deepEqual(world.calls, []);
    }
    const legacy = stubWorld();
    legacy.models = undefined;
    legacy.manager.isReady = true;
    assert.equal(legacy.gate.view, 'none');
    assert.equal(legacy.gate.canChat, true);
});

test('changing the selected model resets what is known about it', async () => {
    const world = stubWorld({ status: 'downloaded' });
    world.manager.isReady = true;
    await world.gate.refresh();
    world.settings.model = 'HuggingFaceTB/SmolVLM-500M-Instruct';
    world.manager.isReady = false;
    world.status = 'not-downloaded';
    assert.equal(await world.gate.refresh(), 'not-downloaded');
    assert.deepEqual(world.calls.at(-1), ['status', 'HuggingFaceTB/SmolVLM-500M-Instruct']);
});

test('model names and sizes come from the runtime catalogue', () => {
    const catalog = [getModel('HuggingFaceTB/SmolVLM-256M-Instruct'), getModel('onnx-community/FastVLM-0.5B-ONNX')];
    assert.deepEqual(describeModel('HuggingFaceTB/SmolVLM-256M-Instruct', [catalog]), {
        id: 'HuggingFaceTB/SmolVLM-256M-Instruct', name: 'SmolVLM 256M', size: '211 MB',
    });
    assert.equal(describeModel('onnx-community/FastVLM-0.5B-ONNX', [catalog]).size, '1.1 GB');
    assert.equal(describeModel('unknown/Model-X').name, 'Model-X');
});

// ─── Streaming markdown ──────────────────────────────────────────────────────

test('findStableBoundary commits finished blocks only', () => {
    const text = '## Title\n\nFirst paragraph.\n\nSecond';
    const b = findStableBoundary(text);
    assert.equal(text.slice(0, b), '## Title\n\nFirst paragraph.\n\n');
    assert.equal(findStableBoundary(text, b), b);
});

test('findStableBoundary keeps code fences, math and loose lists together', () => {
    const fence = '```\ncode\n\nmore\n';
    assert.equal(findStableBoundary(fence), 0);
    const math = 'Intro\n\n$$\na\n\nb\n';
    assert.equal(math.slice(0, findStableBoundary(math)), 'Intro\n\n');
    const list = '- one\n\n- two\n\nAfter list';
    assert.equal(list.slice(0, findStableBoundary(list)), '- one\n\n- two\n\n');
    // An unfinished first line could still become a list item.
    assert.equal(findStableBoundary('Para\n\n-'), 0);
});

test('streaming in small pieces renders the same blocks as rendering the whole answer', () => {
    const answer = '## Tunnel View\n\nThe frame shows **El Capitan**.\n\n- one\n- two\n\n```\nISO 3200\n```\n\nThe end.';
    let committed = 0;
    const blocks = [];
    for (let i = 1; i <= answer.length; i++) {
        const next = findStableBoundary(answer.slice(0, i), committed);
        if (next > committed) { blocks.push(answer.slice(committed, next)); committed = next; }
    }
    blocks.push(answer.slice(committed));
    assert.equal(blocks.join(''), answer);
    assert.ok(blocks.length >= 4);
    assert.equal(mayContainMath('cost is $5 and $6'), true);
    assert.equal(mayContainMath('no math here'), false);
});

// ─── Location helpers ────────────────────────────────────────────────────────

test('location text and links use the coordinate only', () => {
    assert.equal(formatCoordinates(37.71557, -119.67689), '37.71557° N, 119.67689° W');
    assert.equal(formatCoordinates(-33.5, 151.25, 2), '33.50° S, 151.25° E');
    assert.equal(placeKey(37.71557, -119.67689), '37.716,-119.677');
    const links = locationLinks(37.71557, -119.67689);
    assert.match(links.openStreetMap, /^https:\/\/www\.openstreetmap\.org\/\?mlat=37\.715570&mlon=-119\.676890/);
    assert.match(links.lightPollution, /lightpollution\?lat=37\.715570&lon=-119\.676890$/);
    assert.equal(placeLabelFromAddress({ town: 'Bishop', county: 'Inyo County', state: 'California', country_code: 'us', country: 'United States', road: 'Main St' }), 'Bishop, Inyo County, California');
    assert.equal(placeLabelFromAddress(null), '');
});

test('photo thumbnails and gallery names are derived from portfolio URLs', () => {
    assert.equal(thumbnailFor('https://x/portfolios/astronomy/fulls/A.jpg'), 'https://x/portfolios/astronomy/thumbs/480/A.jpg');
    assert.equal(thumbnailFor('data:image/jpeg;base64,xx'), null);
    assert.equal(galleryFromUrl('https://x/portfolios/astronomy/index.html'), 'astronomy');
    assert.equal(galleryFromUrl('https://x/about.html'), null);
});

test('the map module loads only on demand and follows the tile and geocoder policies', () => {
    assert.match(overlaySource, /import\('\.\/InspectorMap\.js\?v=\d+'\)/);
    assert.doesNotMatch(overlaySource, /^import .*InspectorMap/m);
    assert.match(mapSource, /https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png/);
    assert.match(mapSource, /openstreetmap\.org\/copyright/);
    assert.match(mapSource, /minIntervalMs: 1500/);
    const places = JSON.parse(read('./places.json'));
    assert.ok(Object.keys(places.places).length >= 10);
    for (const key of Object.keys(places.places)) assert.match(key, /^-?\d+\.\d{3},-?\d+\.\d{3}$/);
});
