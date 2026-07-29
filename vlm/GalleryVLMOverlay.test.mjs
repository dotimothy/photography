import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const overlaySource = readFileSync(
    fileURLToPath(new URL('./GalleryVLMOverlay.js', import.meta.url)),
    'utf8',
);

test('every directly wired panel control exists in the rendered markup', () => {
    const wiredControls = new Set(
        [...overlaySource.matchAll(/this\._q\('([^']+)'\)\.addEventListener/g)]
            .map(match => match[1]),
    );
    const renderedControls = new Set(
        [...overlaySource.matchAll(/id="\$\{this\._id\}([^"$]+)"/g)]
            .map(match => match[1]),
    );

    assert.deepEqual(
        [...wiredControls].filter(control => !renderedControls.has(control)).sort(),
        [],
    );
});

test('search mode has controls and isolates the chat content', () => {
    assert.match(overlaySource, /id="\$\{this\._id\}-mode-chat"/);
    assert.match(overlaySource, /id="\$\{this\._id\}-mode-search"/);
    assert.match(overlaySource, /class="vlm-messages vlm-chat-only"/);
    assert.match(overlaySource, /class="vlm-chat-actions vlm-chat-only"/);
});

test('mobile mode keeps tabs visible and exposes the toggle before iframe readiness', () => {
    assert.match(overlaySource, /\.vlm-mode-tabs \{[^}]*flex-shrink:0/);
    assert.match(overlaySource, /height: min\(75dvh, 620px\)/);
    assert.match(
        overlaySource,
        /container\.classList\.contains\('active'\)[\s\S]*?this\._btn\.style\.display = ''/,
    );
    assert.match(overlaySource, /fallbackAttempts < 20/);
});
