import test from 'node:test';
import assert from 'node:assert/strict';
import { VLMManager } from './VLMManager.js';

test('camera request instructions stay isolated from the gallery across API, Ollama, and local backends', async t => {
    const manager = VLMManager.getInstance(), requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        requests.push(JSON.parse(options.body));
        return new Response(url.endsWith('/api/chat') ? '{"message":{"content":"Stars."},"done":true}\n'
            : 'data: {"choices":[{"delta":{"content":"Stars."}}]}\n\ndata: [DONE]\n\n', { status: 200 });
    });
    manager.setSystemPrompt('Gallery instructions');
    const query = options => new Promise((resolve, reject) => manager.query('data:image/jpeg;base64,fixture', 'Describe this.', [], { ...options, onDone: resolve, onError: reject }));
    for (const backend of ['api', 'ollama']) {
        if (backend === 'api') manager.setApiMode('http://fixture.invalid/v1', '', 'fixture');
        else manager.setOllamaMode('http://fixture.invalid', 'fixture');
        assert.equal(await query({ systemPrompt: 'Describe only. No tips. Forty words maximum.' }), 'Stars.');
        assert.equal(requests.at(-1).messages[0].content, 'Describe only. No tips. Forty words maximum.');
        await query({});
        assert.equal(requests.at(-1).messages[0].content, 'Gallery instructions', `${backend} retains the gallery prompt`);
    }
    const messages = [];
    manager._mode = 'local'; manager._worker = { postMessage: message => messages.push(message) };
    manager.query('data:image/jpeg;base64,fixture', 'Describe this.', [], { systemPrompt: 'Camera instructions' });
    assert.equal(messages.at(-1).prompt, 'Camera instructions\n\nDescribe this.');
    manager.query('data:image/jpeg;base64,fixture', 'Gallery question', [], {});
    assert.equal(messages.at(-1).prompt, 'Gallery question');
    assert.equal(manager._systemPrompt, 'Gallery instructions');
    manager._worker = null; manager._callbacks.clear();
});
