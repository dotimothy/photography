# TheDoShoots

Timothy Do's photography portfolio (astronomy, landscape, wildlife, planes, food), live at https://thedoshoots.me. A static site on GitHub Pages: no framework, no bundler, no backend. `.github/workflows/deploy-pages.yml` builds and deploys on every push to `main`, so work happens on branches and reaches `main` only when the owner decides.

## Owner's direction (fixed; do not relitigate)
- Dark space theme: black/navy space, cyan `#00e5ff` accent, Roboto, plus a monospaced face allowed for camera data (ISO, f-stop, shutter).
- Heavily 3D and animation-forward, but a photography portfolio first: the photographs lead, motion serves them.
- No game mechanics and no light themes. A gamified light-table redesign was built and rejected (Nov 2026).
- Every button label has each word capitalized ("Open AI Settings", "Back To Camera"). The 3D camera LCD's all-caps canvas labels are fine.
- No stacked or overlapping buttons. Mobile controls should feel part of the camera experience, not generic pills.
- AI models download only when the visitor presses Download in Settings > AI Inspector. Never automatically.
- No emoji in text labels; the emoji-shaped 3D gallery layouts (`GALLERY_SHAPE_EMOJIS`) stay.
- Contact, cover copy, selects and socials: see the "Owner's answers" section at the end of `docs/design/review-brief.md`.

Shared look for HTML controls: dark glass `rgba(8,12,20,.72)` + `backdrop-filter: blur(12px)`, 1px `rgba(255,255,255,.14)` border, text `#eef4f8`, cyan only for active/focus (focus ring `2px solid #00e5ff`, offset 3px), 44px minimum targets. Placement: top-left = back (at most one), top-right = one menu trigger, bottom edge = actions for the current state, AI launcher bottom-right.

## Layout of the code
- `index.html`: homepage. A Three.js r128 scene of a 3D camera in space (keep r128). The camera LCD is a canvas texture and is the main navigation. "Print Orbit" (`assets/js/print-orbit.js`) puts real photo prints in orbit around the camera, one arc per collection, with camera flights between states. 2D mode: `assets/js/browse-scene.js` + `assets/css/space-scene.css`. Phone layout: `assets/css/mobile-home.css`. Performance HUD and profiles: `assets/js/live-fps.js` (`window.SitePerformance`).
- `vlm/`: in-browser AI assistant "TheDoInspector". `GalleryVLMOverlay.js` + `InspectorCore.js` + `inspectorStyles.js` (panel UI), `InspectorMap.js` (interactive maps for photos with GPS), `VLMManager.js` (backends: local transformers.js 3.8.1 in a worker, OpenAI-compatible API, Ollama; `window.VLM_MODELS`), `modelCatalog.js`, `modelStore.js` (explicit downloads into Cache Storage), `vlmRuntime.js`, `vlmWorker.js`.
- Gallery pages are generated at build time from a separate template repo (github.com/dotimothy/gallery, cloned to `tmp/gallery`, read-only here). This repo controls only what `modules/builder.py: add_gallery_return_navigation` injects: `assets/css/gallery-return.css`, `assets/css/portfolio-controls.css`, `assets/js/gallery-return.js`, `gallery-inspector.js`, `gallery-layout.js`.
- `about.html`, `linktree.html`, `license.html`: standalone pages. `license.html` is also copied into each gallery, where `./assets/` does not resolve.
- `preparePortfolio.py` (+ `modules/`): downloads photos from Google Drive via `assets/portfolio.csv`, watermarks, builds `build/`. `make build` (full), `make incremental`, `make web` (HTML only).

## Running and testing
- First time on a machine: `make install`, `npm install`, then `make build` once (downloads every photo; needs network access to the Drive manifest).
- Preview: `scripts/dev/preview.sh` syncs your source into `build/`, regenerates gallery pages with the current builder, and serves http://127.0.0.1:8765/build/. Re-run it after every edit.
- Unit tests: `npm test` (the vlm/*.test.mjs files) and `.venv/bin/python -X utf8 -m unittest discover -s tests`.
- Browser tests: `scripts/dev/test-browser.sh` runs every `scripts/browser-*.mjs` (or name some: `scripts/dev/test-browser.sh browser-mobile browser-camera-live`). It installs Playwright into `.cache/browser` and uses the local Google Chrome (`CHROME_PATH` to override). A full run takes about 12 minutes; run it in the background.
- Run only one browser suite at a time against the shared preview port: two runs at once collide and time out. To run in parallel, use a separate checkout and `PORT=...`.
- `scripts/browser-control-overlap.mjs` (homepage) and `scripts/browser-gallery-overlap.mjs` (galleries, viewer, About) assert that no two visible controls overlap, none is clipped, and touch targets are at least 44px, across many states and sizes. Keep them green; fix layouts rather than weakening assertions.
- Headless Chrome renders WebGL in software at about 10 fps: judge composition and logic, not smoothness. Real devices are still needed for feel, touch and frame rate.
- `browser-camera-live` once had a 2e-15 camera-position race; `moveCameraTo` calls `controls.update()` after instant moves to prevent it. Re-run it a few times after touching camera code.

## Working agreements
- Branch: `redesign/space-3d-overhaul`. Commit there; never push to `main` (that deploys).
- Never send the owner's name, email or other personal details to outside services (search queries, tile servers, APIs).
- Keep `build/`, `tmp/`, `.cache/`, `.venv/` and `.claude/worktrees/` out of commits (all git-ignored).
- Subagent definitions live in `.claude/agents/` (`design-lead`, `integration-qa`).
