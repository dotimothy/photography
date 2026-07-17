(function () {
    'use strict';

    const PROFILE_KEY = 'sitePerformanceProfile';
    const FPS_KEY = 'siteFpsVisible';
    const profiles = {
        performance: {
            label: 'Performance',
            description: 'Lower resolution, fewer effects, animations off',
            resolutionScale: 0.65,
            pixelRatioCap: 1,
            starDensity: 0.25,
            animations: false,
            effects: 'low'
        },
        balanced: {
            label: 'Balanced',
            description: 'Balanced resolution and visual effects',
            resolutionScale: 0.85,
            pixelRatioCap: 1.5,
            starDensity: 0.6,
            animations: true,
            effects: 'medium'
        },
        quality: {
            label: 'Quality',
            description: 'Full resolution and all visual effects',
            resolutionScale: 1,
            pixelRatioCap: 2,
            starDensity: 1,
            animations: true,
            effects: 'high'
        }
    };

    function safeGet(key) {
        try { return localStorage.getItem(key); } catch (_) { return null; }
    }

    function safeSet(key, value) {
        try { localStorage.setItem(key, value); } catch (_) { }
    }

    function automaticProfile() {
        const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const memory = Number(navigator.deviceMemory || 0);
        const cores = Number(navigator.hardwareConcurrency || 0);
        if (reducedMotion || (memory && memory <= 4) || (cores && cores <= 4)) return 'performance';
        if ((memory && memory <= 8) || (cores && cores <= 8)) return 'balanced';
        return 'quality';
    }

    let selectedProfile = safeGet(PROFILE_KEY) || 'auto';
    if (selectedProfile !== 'auto' && !profiles[selectedProfile]) selectedProfile = 'auto';
    let fpsVisible = safeGet(FPS_KEY) !== 'false';
    let current = null;
    let rafId = 0;
    let frameCount = 0;
    let sampleStarted = performance.now();

    function resolvedConfig(name) {
        const resolvedProfile = name === 'auto' ? automaticProfile() : name;
        return Object.assign({}, profiles[resolvedProfile], {
            selectedProfile: name,
            resolvedProfile
        });
    }

    function syncControls() {
        document.querySelectorAll('[data-site-performance-select]').forEach((select) => {
            select.value = selectedProfile;
        });
        document.querySelectorAll('[data-site-fps-toggle]').forEach((toggle) => {
            toggle.checked = fpsVisible;
        });

        const readout = document.getElementById('site-fps-readout');
        if (readout) readout.hidden = !fpsVisible;
        const button = document.getElementById('site-performance-button');
        if (button) {
            button.hidden = !fpsVisible;
            if (!fpsVisible) button.setAttribute('aria-expanded', 'false');
        }
        if (!fpsVisible) {
            const panel = document.getElementById('site-performance-panel');
            if (panel) panel.hidden = true;
        }
        const summary = document.getElementById('site-performance-summary');
        if (summary && current) {
            const autoSuffix = current.selectedProfile === 'auto' ? ` → ${current.label}` : '';
            summary.textContent = `${Math.round(current.resolutionScale * 100)}% render scale · ${current.pixelRatioCap}× pixel ratio${autoSuffix}`;
        }
    }

    function setProfile(name, persist) {
        if (name !== 'auto' && !profiles[name]) return;
        selectedProfile = name;
        current = resolvedConfig(name);
        if (persist !== false) safeSet(PROFILE_KEY, name);

        const root = document.documentElement;
        root.dataset.performanceProfile = current.resolvedProfile;
        root.dataset.performanceAnimations = current.animations ? 'on' : 'off';
        root.dataset.performanceEffects = current.effects;
        syncControls();
        window.dispatchEvent(new CustomEvent('siteperformancechange', { detail: Object.assign({}, current) }));
    }

    function fpsTick(now) {
        frameCount += 1;
        const elapsed = now - sampleStarted;
        if (elapsed >= 500) {
            const fps = Math.round((frameCount * 1000) / elapsed);
            const readout = document.getElementById('site-fps-readout');
            if (readout) readout.textContent = `FPS ${fps}`;
            frameCount = 0;
            sampleStarted = now;
        }
        rafId = requestAnimationFrame(fpsTick);
    }

    function startFps() {
        if (!fpsVisible || document.hidden || rafId) return;
        frameCount = 0;
        sampleStarted = performance.now();
        rafId = requestAnimationFrame(fpsTick);
    }

    function stopFps() {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
    }

    function setFpsVisible(visible, persist) {
        fpsVisible = Boolean(visible);
        if (persist !== false) safeSet(FPS_KEY, String(fpsVisible));
        syncControls();
        if (fpsVisible) startFps();
        else stopFps();
    }

    function profileOptions() {
        return `
            <option value="auto">Auto (Device Recommended)</option>
            <option value="performance">Performance</option>
            <option value="balanced">Balanced</option>
            <option value="quality">Quality</option>`;
    }

    function mount() {
        if (document.getElementById('site-performance-hud')) return;

        const style = document.createElement('style');
        style.textContent = `
            #site-performance-hud {
                position: fixed; left: 14px; bottom: calc(14px + env(safe-area-inset-bottom));
                z-index: 2147483000; display: flex; align-items: center; gap: 7px;
                color: #fff; font: 600 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            }
            #site-performance-hud button, #site-performance-hud select, #site-performance-hud input { font: inherit; }
            #site-fps-readout, #site-performance-button {
                min-height: 32px; border: 1px solid rgba(255,255,255,.22); border-radius: 9px;
                background: rgba(5,8,14,.82); color: #bff8ff; box-shadow: 0 7px 24px rgba(0,0,0,.3);
                backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); cursor: pointer;
            }
            #site-fps-readout { min-width: 64px; padding: 7px 10px; letter-spacing: .04em; }
            #site-performance-button { width: 34px; padding: 0; font-size: 15px; }
            #site-performance-panel {
                position: absolute; left: 0; bottom: 42px; width: min(300px, calc(100vw - 28px));
                padding: 15px; border: 1px solid rgba(255,255,255,.2); border-radius: 14px;
                background: rgba(6,9,16,.94); box-shadow: 0 18px 60px rgba(0,0,0,.48);
                backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); color: #fff;
            }
            #site-performance-panel[hidden] { display: none; }
            .site-performance-title { margin: 0 0 12px; font: 700 13px/1.2 system-ui, sans-serif; letter-spacing: .04em; }
            .site-performance-label { display: block; margin: 0 0 6px; color: #b9c4d0; font: 600 11px/1.2 system-ui, sans-serif; }
            [data-site-performance-select] {
                width: 100%; padding: 9px 10px; border: 1px solid rgba(255,255,255,.18); border-radius: 8px;
                background: #111923; color: #fff; cursor: pointer;
            }
            .site-fps-toggle-row { display: flex; align-items: center; gap: 8px; margin-top: 13px; cursor: pointer; font-family: system-ui, sans-serif; }
            .site-fps-toggle-row input { accent-color: #00e5ff; }
            #site-performance-summary { margin-top: 11px; color: #7f93a8; font-weight: 500; line-height: 1.45; }
            html[data-performance-animations="off"] *,
            html[data-performance-animations="off"] *::before,
            html[data-performance-animations="off"] *::after {
                animation-duration: .001ms !important; animation-delay: 0ms !important;
                animation-iteration-count: 1 !important; transition-duration: .001ms !important;
                scroll-behavior: auto !important;
            }
            html[data-performance-effects="low"] .bg-aurora::before,
            html[data-performance-effects="low"] .bg-aurora::after,
            html[data-performance-effects="low"] .stars { display: none !important; }
            html[data-performance-effects="low"] .glass-card,
            html[data-performance-effects="low"] .link-card,
            html[data-performance-effects="low"] .settings-modal {
                backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
            }
            @media (max-width: 480px) {
                #site-performance-hud { left: 10px; bottom: calc(10px + env(safe-area-inset-bottom)); }
            }
        `;
        document.head.appendChild(style);

        const hud = document.createElement('div');
        hud.id = 'site-performance-hud';
        hud.innerHTML = `
            <button id="site-fps-readout" type="button" title="Hide live FPS">FPS --</button>
            <button id="site-performance-button" type="button" aria-label="Performance settings" aria-expanded="false">⚙</button>
            <section id="site-performance-panel" aria-label="Performance settings" hidden>
                <h2 class="site-performance-title">Performance</h2>
                <label class="site-performance-label" for="site-performance-profile">Profile</label>
                <select id="site-performance-profile" data-site-performance-select>${profileOptions()}</select>
                <label class="site-fps-toggle-row">
                    <input type="checkbox" data-site-fps-toggle> Show live FPS
                </label>
                <div id="site-performance-summary"></div>
            </section>`;
        document.body.appendChild(hud);

        const generalPane = document.getElementById('settings-pane-general');
        if (generalPane && !document.getElementById('site-performance-settings-row')) {
            const settings = document.createElement('div');
            settings.id = 'site-performance-settings-row';
            settings.innerHTML = `
                <div class="setting-category" style="margin-top:14px">Performance</div>
                <div class="setting-row">
                    <span class="setting-label">Performance Profile</span>
                    <select class="setting-select" data-site-performance-select>${profileOptions()}</select>
                </div>
                <label class="setting-row" style="cursor:pointer">
                    <span class="setting-label">Live FPS Overlay</span>
                    <input type="checkbox" data-site-fps-toggle style="accent-color:#00e5ff">
                </label>`;
            generalPane.appendChild(settings);
        }

        const button = document.getElementById('site-performance-button');
        const panel = document.getElementById('site-performance-panel');
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            panel.hidden = !panel.hidden;
            button.setAttribute('aria-expanded', String(!panel.hidden));
        });
        panel.addEventListener('click', (event) => event.stopPropagation());
        document.getElementById('site-fps-readout').addEventListener('click', () => setFpsVisible(false));
        document.addEventListener('click', () => {
            panel.hidden = true;
            button.setAttribute('aria-expanded', 'false');
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                panel.hidden = true;
                button.setAttribute('aria-expanded', 'false');
            }
        });
        document.querySelectorAll('[data-site-performance-select]').forEach((select) => {
            select.addEventListener('change', () => setProfile(select.value));
        });
        document.querySelectorAll('[data-site-fps-toggle]').forEach((toggle) => {
            toggle.addEventListener('change', () => setFpsVisible(toggle.checked));
        });

        syncControls();
        setFpsVisible(fpsVisible, false);
    }

    window.SitePerformance = {
        profiles,
        get current() { return Object.assign({}, current); },
        get fpsVisible() { return fpsVisible; },
        setProfile,
        setFpsVisible
    };

    setProfile(selectedProfile, false);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopFps();
        else startFps();
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
}());
