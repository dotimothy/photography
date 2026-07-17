import test from 'node:test';
import assert from 'node:assert/strict';
import {
    loadBuildSearchIndex,
    normalizeSearchText,
    parseVLMRecommendation,
    rankImageRecords,
} from './ImageSearch.js';

test('parses a fenced VLM recommendation', () => {
    const value = parseVLMRecommendation('```json\n{"score":87,"reason":"The image visibly contains a fox."}\n```');
    assert.equal(value.score, 87);
    assert.equal(value.reason, 'The image visibly contains a fox.');
    assert.equal(value.parseFallback, false);
});

test('safely handles malformed recommendation output', () => {
    const value = parseVLMRecommendation('possibly relevant');
    assert.equal(value.score, 0);
    assert.equal(value.reason, 'possibly relevant');
    assert.equal(value.parseFallback, true);
});

test('normalizes punctuation and accents', () => {
    assert.equal(normalizeSearchText('Café — ISO 3,200'), 'cafe iso 3 200');
});

test('ranks strong visual fields over metadata and respects gallery scope', () => {
    const records = [
        { id: 'wildlife/fox', gallery: 'wildlife', name: 'fox', subjects: ['red fox'], tags: ['animal'], caption: '', metadata: {} },
        { id: 'planes/fox', gallery: 'planes', name: 'fox-airfield', subjects: ['aircraft'], tags: [], caption: '', metadata: { Note: 'fox' } },
    ];
    const all = rankImageRecords(records, 'fox');
    assert.equal(all[0].record.id, 'wildlife/fox');
    const scoped = rankImageRecords(records, 'fox', { gallery: 'planes' });
    assert.deepEqual(scoped.map(x => x.record.id), ['planes/fox']);
});

test('searches EXIF text', () => {
    const records = [{ id: 'astronomy/a', gallery: 'astronomy', name: 'a', caption: 'stars', metadata: { 'EXIF ISOSpeedRatings': 3200 } }];
    assert.equal(rankImageRecords(records, 'iso 3200')[0].record.id, 'astronomy/a');
});

test('clamps VLM recommendation scores', () => {
    assert.equal(parseVLMRecommendation('{"score":999,"reason":"match"}').score, 100);
    assert.equal(parseVLMRecommendation('{"score":-5,"reason":"miss"}').score, 0);
});

test('resolves the build index from the site root in VLM panel mode', async () => {
    const originalFetch = globalThis.fetch;
    let requested = null;
    globalThis.fetch = async url => {
        requested = String(url);
        return { ok: true, json: async () => ({ records: [] }) };
    };
    try {
        await loadBuildSearchIndex('https://example.com/vlm/panel.html');
        assert.equal(requested, 'https://example.com/assets/search-index.json');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
