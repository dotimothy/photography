import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCropRect } from './ImageCrop.js';

test('normalizes crop rect with default values', () => {
    const rect = normalizeCropRect();
    assert.deepEqual(rect, { x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
});

test('clamps crop rect within [0, 1] bounds', () => {
    const rect = normalizeCropRect({ x: -0.5, y: 1.5, width: 2.0, height: -0.1 });
    assert.ok(rect.x >= 0 && rect.x <= 1);
    assert.ok(rect.y >= 0 && rect.y <= 1);
    assert.ok(rect.width >= 0.02 && rect.width <= 1);
    assert.ok(rect.height >= 0.02 && rect.height <= 1);
    assert.ok(rect.x + rect.width <= 1.000001);
    assert.ok(rect.y + rect.height <= 1.000001);
});

test('ensures minimum size for crop rectangle', () => {
    const rect = normalizeCropRect({ x: 0, y: 0, width: 0.001, height: 0.001 });
    assert.equal(rect.width, 0.02);
    assert.equal(rect.height, 0.02);
});
