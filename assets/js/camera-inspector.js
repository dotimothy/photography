import { VLMManager } from '../../vlm/VLMManager.js?v=12';

// Share the gallery engine and its configured backend; load a local model only on request.
const manager = VLMManager.getInstance();
let engineError = null;
manager.on('error', ({ message } = {}) => { engineError = new Error(message || 'Inspector unavailable'); });
manager.on('ready', () => { engineError = null; });

export async function inspectCameraImage({ imageSrc, prompt, settings, signal, onToken, onStatus }) {
    if (!settings.enabled || signal.aborted) throw new DOMException('Inspection cancelled', 'AbortError');
    engineError = null;
    if (settings.type === 'api') {
        const current = manager._apiConfig;
        if (manager._mode !== 'api' || current?.isOllama || current?.endpoint !== settings.apiEndpoint.replace(/\/$/, '') ||
            current?.model !== settings.apiModel || current?.apiKey !== settings.apiKey)
            manager.setApiMode(settings.apiEndpoint, settings.apiKey, settings.apiModel);
    } else if (settings.type === 'ollama') {
        const current = manager._apiConfig;
        const base = settings.ollamaEndpoint.replace(/\/$/, '').replace(/\/v1$/, '');
        if (!current?.isOllama || current.ollamaBase !== base || current.model !== settings.ollamaModel || current.think !== settings.ollamaThink)
            manager.setOllamaMode(settings.ollamaEndpoint, settings.ollamaModel, settings.ollamaThink);
    } else if (manager._mode === 'api' || (manager._modelId && manager._modelId !== settings.model)) {
        manager.restart(settings.model);
    } else manager.init(settings.model);

    onStatus('Loading inspector…');
    const deadline = performance.now() + 180000;
    while (!manager.isReady) {
        if (signal.aborted) throw new DOMException('Inspection cancelled', 'AbortError');
        if (engineError) throw engineError;
        if (performance.now() > deadline) throw new Error('Model loading timed out. Check AI settings and retry.');
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (signal.aborted) throw new DOMException('Inspection cancelled', 'AbortError');
    onStatus('Inspecting image…');
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        let settled = false, response = '';
        const limit = text => {
            const words = [...String(text || '').matchAll(/\S+/g)];
            return words.length > 40 ? text.slice(0, words[39].index + words[39][0].length).replace(/[\s*_`#]+$/, '') + '…' : text;
        };
        const finish = (error, result) => {
            if (settled) return;
            settled = true; clearTimeout(timeout); signal.removeEventListener('abort', abort);
            if (error) reject(error); else resolve(result);
        };
        const abort = () => { controller.abort(); finish(new DOMException('Inspection cancelled', 'AbortError')); };
        const timeout = setTimeout(() => { controller.abort(); finish(new Error('Inspection timed out. Please retry.')); }, 120000);
        signal.addEventListener('abort', abort, { once: true });
        try {
            manager.query(imageSrc, prompt, [], {
                systemPrompt: `${settings.systemPrompt || ''}\nYou are the in-camera image inspector. Describe only visible image content in concise Markdown, using at most 40 words total. Do not give photography advice, capture tips, suggestions, or recommendations. Do not invent facts.`,
                signal: controller.signal,
                onToken: token => {
                    if (settled) return;
                    response += token; onToken(token);
                    if ([...response.matchAll(/\S+/g)].length > 40) {
                        finish(null, limit(response)); controller.abort();
                    }
                },
                onDone: result => finish(null, limit(result || response)),
                onError: message => finish(new Error(message || 'Inspection failed')),
            });
        } catch (error) { finish(error); }
    });
}
