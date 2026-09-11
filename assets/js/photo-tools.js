const read = (key, fallback = "") => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Optional persistence. */
  }
};
const fields = {
  type: ["vlmType", "local"],
  model: ["vlmModel", "onnx-community/FastVLM-0.5B-ONNX"],
  apiEndpoint: ["vlmApiEndpoint", "https://api.openai.com/v1"],
  apiKey: ["vlmApiKey", ""],
  apiModel: ["vlmApiModel", "gpt-4o"],
  ollamaEndpoint: ["vlmOllamaEndpoint", "http://localhost:11434"],
  ollamaModel: ["vlmOllamaModel", "gemma3"],
  systemPrompt: ["vlmSystemPrompt", ""],
};
const config = () => ({
  enabled: true,
  ...Object.fromEntries(Object.entries(fields).map(([key, [storage, fallback]]) => [key, read(storage, fallback)])),
  ollamaThink: read("vlmOllamaThink") === "true" ? true : read("vlmOllamaThink") === "false" ? false : null,
});
let overlay, initializing, settings;
function applyConfig() {
  window.VLM_SETTINGS = config();
  if (!overlay) return;
  const c = window.VLM_SETTINGS,
    manager = overlay.manager;
  if (c.type === "api") manager.setApiMode(c.apiEndpoint, c.apiKey, c.apiModel);
  else if (c.type === "ollama") manager.setOllamaMode(c.ollamaEndpoint, c.ollamaModel, c.ollamaThink);
  else if (manager._modelId && manager._modelId !== c.model) manager.restart(c.model);
  else manager.init(c.model);
  overlay._customSystemPrompt = c.systemPrompt;
}
export async function openInspector(container = document.body, image = null) {
  if (!overlay) {
    if (!initializing)
      initializing = (async () => {
        window.VLM_MANUAL_INIT = true;
        window.VLM_SETTINGS = config();
        const module = await import("../../vlm/GalleryVLMOverlay.js");
        [overlay] = module.initGalleryVLM({ autoStart: false });
        if (!document.getElementById('btn-open-settings')) overlay._openSettings = openSettings;
        window.addEventListener("gallery-image-changed", (event) =>
          overlay._setImage(event.detail.src, event.detail.name),
        );
        window.addEventListener("gallery-viewer", (event) => {
          if (!event.detail.open) {
            overlay._closePanel();
            document.body.append(overlay._panel, overlay._btn);
            overlay._btn.style.display = "none";
          }
        });
        applyConfig();
      })().finally(() => {
        initializing = null;
      });
    await initializing;
  }
  if (!overlay.manager.isReady && !overlay.manager.isLoading) applyConfig();
  container.append(overlay._panel, overlay._btn);
  const active = image || document.querySelector("#imageViewer[open] #active-photo, #full-image-container img") || document.querySelector(".main-photo img");
  if (active?.src) overlay._setImage(active.src, active.alt);
  overlay._btn.style.display = "";
  if (!overlay._panel.classList.contains("vlm-open")) overlay._togglePanel();
  overlay._syncTogglePlacement(true);
  document.querySelectorAll("details[open]").forEach((details) => {
    details.open = false;
  });
}

export function openSettings() {
  if (!settings) {
    const style = document.createElement("style");
    style.textContent = `.photo-settings{font-family:'Roboto',system-ui,sans-serif;color:#eef1f6;background:#111621;border:1px solid #ffffff30;border-radius:8px;width:540px;max-width:calc(100% - 30px);max-height:85dvh;padding:28px;overflow:auto}.photo-settings::backdrop{background:#03060bc9}.photo-settings header{display:flex;justify-content:space-between;align-items:center;gap:20px}.photo-settings h2{font-size:25px;font-weight:400;margin:0}.photo-settings form{display:grid;gap:18px;margin-top:24px}.photo-settings label{display:grid;gap:8px;font-size:12px;color:#b5c0d0}.photo-settings input,.photo-settings select,.photo-settings textarea{font:14px 'Roboto',system-ui,sans-serif;width:100%;padding:12px;border:1px solid #ffffff30;background:#080b12;color:#eef1f6;border-radius:3px}.photo-settings p{font-size:12px;color:#a3acba;line-height:1.7}.photo-settings button{font-family:inherit;min-height:44px;color:#eef1f6;background:transparent;border:1px solid #ffffff30;padding:10px 16px;cursor:pointer}.photo-settings textarea{min-height:85px}`;
    document.head.append(style);
    settings = document.createElement("dialog");
    settings.className = "photo-settings";
    settings.setAttribute("aria-labelledby", "photo-settings-title");
    settings.innerHTML = `<header><h2 id="photo-settings-title">Photo Tools</h2><button type="button" data-close aria-label="Close Photo Settings">✕</button></header><p>Choose how the photo inspector runs. Models load only when you open the inspector.</p><form><label>Backend<select name="type"><option value="local">Local model · this browser</option><option value="api">Compatible API</option><option value="ollama">Ollama</option></select></label><label data-backend="local">Model ID<input name="model"></label><label data-backend="api">API endpoint<input type="url" name="apiEndpoint"></label><label data-backend="api">API key<input type="password" name="apiKey" autocomplete="off"></label><label data-backend="api">API model<input name="apiModel"></label><label data-backend="ollama">Ollama endpoint<input type="url" name="ollamaEndpoint"></label><label data-backend="ollama">Ollama model<input name="ollamaModel"></label><label data-backend="ollama">Thinking<select name="think"><option value="">Automatic</option><option value="true">On</option><option value="false">Off</option></select></label><label>Custom system prompt<textarea name="systemPrompt"></textarea></label><label>Voice<select name="voice"><option value="">Browser default</option></select></label><label>Speech speed<input type="number" name="speed" min="0.5" max="2" step="0.1"></label><p>Settings, including an API key if supplied, are saved in this browser. Voice and image-crop controls are available inside the inspector.</p><button type="submit">Save Settings</button><button type="button" data-unload>Unload Active Model</button><p role="status" data-status></p></form>`;
    document.body.append(settings);
    settings.querySelector("[data-close]").onclick = () => settings.close();
    const form = settings.querySelector("form");
    form.elements.type.onchange = () =>
      settings.querySelectorAll("[data-backend]").forEach((label) => {
        label.hidden = label.dataset.backend !== form.elements.type.value;
      });
    const voices = () => {
      const select = form.elements.voice;
      select.replaceChildren(new Option("Browser default", ""));
      for (const voice of speechSynthesis.getVoices())
        select.add(new Option(`${voice.name} (${voice.lang})`, voice.voiceURI));
      select.value = read("vlm-voice-uri");
    };
    if ("speechSynthesis" in window) {
      voices();
      speechSynthesis.addEventListener("voiceschanged", voices);
    }
    form.onsubmit = (event) => {
      event.preventDefault();
      for (const [key, [storage]] of Object.entries(fields)) write(storage, form.elements[key].value);
      write("vlmOllamaThink", form.elements.think.value);
      write("vlm-voice-uri", form.elements.voice.value);
      write("vlm-voice-speed", form.elements.speed.value);
      applyConfig();
      settings.close();
    };
    settings.querySelector("[data-unload]").onclick = async () => {
      try {
        if (overlay && config().type === "ollama")
          await overlay.manager.constructor.unloadOllamaModel(config().ollamaEndpoint, config().ollamaModel);
        overlay?.manager.unload();
        settings.querySelector("[data-status]").textContent = overlay
          ? "Active model unloaded."
          : "No model is loaded.";
      } catch {
        settings.querySelector("[data-status]").textContent =
          "Could not unload the remote model. Check the connection and try again.";
      }
    };
  }
  const form = settings.querySelector("form"),
    c = config();
  for (const key of Object.keys(fields)) form.elements[key].value = c[key];
  form.elements.think.value = read("vlmOllamaThink");
  form.elements.voice.value = read("vlm-voice-uri");
  form.elements.speed.value = read("vlm-voice-speed", "1");
  form.elements.type.onchange();
  settings.showModal();
}
