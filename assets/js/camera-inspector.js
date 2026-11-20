import { VLMManager } from '../../vlm/VLMManager.js?v=12';

// Share the page's one engine and worker with the inspector panel. A local model
// is used only if the visitor already downloaded it in Settings > AI Inspector;
// the camera never starts a download.
const manager = VLMManager.getInstance();
let engineError = null;
manager.on('error', ({ message } = {}) => { engineError = new Error(message || 'Inspector unavailable'); });
manager.on('unavailable', ({ state } = {}) => { engineError = needsDownload(state); });
manager.on('ready', () => { engineError = null; });

/** Short enough for the camera LCD; index.html shows `cameraStatus` as the status line. */
function needsDownload(state) {
    const message = state === 'downloading' ? 'Model Downloading In Settings' : 'Download A Model In Settings';
    return Object.assign(new Error(message), { cameraStatus: message });
}

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
    } else {
        // Local model: ask browser storage first, so the LCD can say what is needed instead of waiting.
        const status = await window.VLM_MODELS.status(settings.model);
        if (signal.aborted) throw new DOMException('Inspection cancelled', 'AbortError');
        if (status !== 'downloaded') {
            const error = needsDownload(status);
            onStatus(error.cameraStatus);
            throw error;
        }
        if (manager._mode === 'api' || (manager._modelId && manager._modelId !== settings.model)) manager.restart(settings.model);
        else manager.init(settings.model);
    }

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
    const tokenLimit = Number(settings.maxNewTokens);
    const maxNewTokens = Number.isInteger(tokenLimit) && tokenLimit > 0 ? Math.min(tokenLimit, 96) : 96;
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
                // Forty words is about sixty tokens; a local model stops here even if it ignores the instruction.
                maxNewTokens,
                temperature: settings.temperature,
                onToken: token => {
                    if (settled) return;
                    response += token; onToken(token);
                    if ([...response.matchAll(/\S+/g)].length > 40) {
                        finish(null, limit(response)); controller.abort();
                    }
                },
                onDone: result => finish(null, limit(result || response)),
                onError: message => {
                    const error = new Error(message || 'Inspection failed');
                    if (/Download A Model/.test(error.message)) error.cameraStatus = error.message;
                    finish(error);
                },
            });
        } catch (error) { finish(error); }
    });
}
