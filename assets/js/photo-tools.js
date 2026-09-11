const read = (key, fallback = "") => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
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
let overlay, initializing;
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
