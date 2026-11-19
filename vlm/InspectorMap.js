/**
 * InspectorMap.js — the interactive location card shown inside a chat answer.
 *
 * Loaded on demand (dynamic import) the first time an answer contains a location,
 * and only then does it fetch the map library.
 *
 * Stack (no API keys, no paid services):
 *   Leaflet 1.9.4            pinned on jsDelivr with Subresource Integrity
 *   OpenStreetMap tiles      https://tile.openstreetmap.org/{z}/{x}/{y}.png, darkened with a CSS filter
 *   Place names              vlm/places.json (pre-resolved from OpenStreetMap), then the visitor's own
 *                            browser cache, then one Nominatim reverse lookup per new location
 *
 * Usage policies followed here — read them before changing this file:
 *   Tiles      https://operations.osmfoundation.org/policies/tiles/
 *              single canonical HTTPS URL (kept in one constant so it can be switched), the browser's
 *              normal Referer and HTTP cache are left untouched, attribution is always visible,
 *              and only tiles for the visible map are requested (no prefetching).
 *   Nominatim  https://operations.osmfoundation.org/policies/nominatim/
 *              lookups happen only when a visitor asks where a photo was taken, one at a time and at
 *              most one per 1.5 s, results are cached, and nothing is ever looked up in bulk.
 *
 * Only coordinates are sent to either service.
 */

import {
    formatCoordinates,
    locationLinks,
    placeKey,
    placeLabelFromAddress,
} from './InspectorCore.js?v=1';

export const MAP_STACK = Object.freeze({
    leaflet: {
        version: '1.9.4',
        js: 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js',
        jsIntegrity: 'sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH',
        css: 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css',
        cssIntegrity: 'sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H',
    },
    tiles: {
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    },
    geocoder: {
        url: 'https://nominatim.openstreetmap.org/reverse',
        minIntervalMs: 1500,
    },
});

const INLINE_ZOOM = 10;
const EXPANDED_ZOOM = 12;
const PLACE_CACHE_KEY = 'vlm-place-cache-v1';

// ─── Leaflet loader ──────────────────────────────────────────────────────────

let _leafletPromise = null;

/** Load Leaflet once. Rejects (and may be retried) when the CDN cannot be reached. */
export function loadLeaflet(doc = document) {
    const win = doc.defaultView ?? window;
    if (win.L?.map && win.L?.tileLayer) return Promise.resolve(win.L);
    if (_leafletPromise) return _leafletPromise;
    _leafletPromise = new Promise((resolve, reject) => {
        const { js, jsIntegrity, css, cssIntegrity } = MAP_STACK.leaflet;
        if (!doc.querySelector(`link[href="${css}"]`)) {
            const link = doc.createElement('link');
            link.rel = 'stylesheet';
            link.href = css;
            link.integrity = cssIntegrity;
            link.crossOrigin = 'anonymous';
            doc.head.appendChild(link);
        }
        const script = doc.createElement('script');
        script.src = js;
        script.integrity = jsIntegrity;
        script.crossOrigin = 'anonymous';
        script.async = true;
        script.onload = () => (win.L?.map ? resolve(win.L) : reject(new Error('Map library did not initialise')));
        script.onerror = () => { script.remove(); reject(new Error('Map library could not be loaded')); };
        doc.head.appendChild(script);
    }).catch(error => {
        _leafletPromise = null;
        throw error;
    });
    return _leafletPromise;
}

// ─── Place names ─────────────────────────────────────────────────────────────

let _seedPromise = null;
const _memoryPlaces = new Map();      // key → { label, region } | null (looked up this session)
let _geocodeQueue = Promise.resolve();
let _lastGeocodeAt = 0;

function loadSeed() {
    if (!_seedPromise) {
        _seedPromise = fetch(new URL('./places.json', import.meta.url))
            .then(response => (response.ok ? response.json() : null))
            .then(data => data?.places ?? {})
            .catch(() => ({}));
    }
    return _seedPromise;
}

function readPlaceCache() {
    try { return JSON.parse(localStorage.getItem(PLACE_CACHE_KEY) || '{}') ?? {}; } catch (_) { return {}; }
}

function writePlaceCache(key, value) {
    try {
        const cache = readPlaceCache();
        cache[key] = value;
        const keys = Object.keys(cache);
        for (const stale of keys.slice(0, Math.max(0, keys.length - 200))) delete cache[stale];
        localStorage.setItem(PLACE_CACHE_KEY, JSON.stringify(cache));
    } catch (_) { /* private mode or full storage: the lookup still worked for this session */ }
}

/**
 * Resolve a human place name for a coordinate.
 * @returns {Promise<{ label: string, region?: string } | null>}
 */
export async function lookupPlace(lat, lon, { allowNetwork = true } = {}) {
    const key = placeKey(lat, lon);
    const seed = await loadSeed();
    if (seed[key]?.label) return seed[key];
    if (_memoryPlaces.has(key)) return _memoryPlaces.get(key);
    const cached = readPlaceCache()[key];
    if (cached?.label) { _memoryPlaces.set(key, cached); return cached; }
    if (!allowNetwork) return null;

    const run = _geocodeQueue.then(async () => {
        if (_memoryPlaces.has(key)) return _memoryPlaces.get(key);
        const wait = MAP_STACK.geocoder.minIntervalMs - (Date.now() - _lastGeocodeAt);
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        _lastGeocodeAt = Date.now();
        const url = new URL(MAP_STACK.geocoder.url);
        // zoom=14 asks for town / village level, never a street or a building.
        url.search = new URLSearchParams({
            format: 'jsonv2', lat: Number(lat).toFixed(5), lon: Number(lon).toFixed(5), zoom: '14', addressdetails: '1',
        }).toString();
        let place = null;
        try {
            const response = await fetch(url, { headers: { Accept: 'application/json' } });
            if (response.ok) {
                const data = await response.json();
                const label = placeLabelFromAddress(data?.address);
                if (label) place = { label };
            }
        } catch (_) { /* offline or blocked: the card simply shows coordinates */ }
        _memoryPlaces.set(key, place);
        if (place) writePlaceCache(key, place);
        return place;
    });
    _geocodeQueue = run.catch(() => null);
    return run;
}

// ─── Location card ───────────────────────────────────────────────────────────

function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function button(doc, label, className = '') {
    const node = el(doc, 'button', `vlm-btn ${className}`.trim(), label);
    node.type = 'button';
    return node;
}

export class LocationCard {
    /**
     * @param {object}  options
     * @param {number}  options.lat
     * @param {number}  options.lon
     * @param {string}  [options.altitude]            e.g. "1,340 m"
     * @param {string}  [options.photoName]
     * @param {string}  [options.thumbUrl]            photo thumbnail pinned to the location when expanded
     * @param {boolean} [options.showLightPollution]  offer the light-pollution map (astronomy photos)
     * @param {Document} [options.doc]
     */
    constructor({ lat, lon, altitude = '', photoName = '', thumbUrl = null, showLightPollution = false, doc = document }) {
        this.lat = Number(lat);
        this.lon = Number(lon);
        this.altitude = altitude;
        this.photoName = photoName;
        this.thumbUrl = thumbUrl;
        this.showLightPollution = showLightPollution;
        this.doc = doc;
        this.links = locationLinks(this.lat, this.lon);
        this.place = null;
        this._map = null;
        this._engaged = false;
        this._overlay = null;
        this._destroyed = false;
        this._started = false;
        this._abort = new AbortController();
        this._build();
    }

    get _reduceMotion() {
        return !!(this.doc.defaultView ?? window).matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    }

    get coordsText() {
        const coords = formatCoordinates(this.lat, this.lon);
        return this.altitude ? `${coords}, ${this.altitude}` : coords;
    }

    _build() {
        const doc = this.doc;
        const card = el(doc, 'figure', 'vlm-map-card');
        card.setAttribute('aria-label', 'Photo location');

        // The place name sits on the map itself, like a caption on a print.
        const head = el(doc, 'figcaption', 'vlm-map-head');
        this._placeEl = el(doc, 'span', 'vlm-map-place vlm-map-place-pending', 'Finding place name…');
        this._regionEl = el(doc, 'span', 'vlm-map-region');
        this._regionEl.hidden = true;
        this._coordsEl = el(doc, 'span', 'vlm-map-coords', this.coordsText);
        head.append(this._placeEl, this._regionEl, this._coordsEl);

        this._stage = el(doc, 'div', 'vlm-map-stage');
        this._canvas = el(doc, 'div', 'vlm-map-canvas');
        this._status = el(doc, 'div', 'vlm-map-status', 'Loading map…');
        this._engageBtn = button(doc, 'Explore Map', 'vlm-map-engage');
        this._engageBtn.hidden = true;
        this._engageBtn.setAttribute('aria-pressed', 'false');
        this._engageBtn.title = 'Explore Map: Drag And Zoom Inside The Map';
        this._stage.append(this._canvas, this._status, head, this._engageBtn);

        const actions = el(doc, 'div', 'vlm-map-actions');
        this._expandBtn = button(doc, 'Expand Map', 'vlm-btn-primary vlm-map-expand');
        this._expandBtn.title = 'Expand Map: Open A Large Map With The Photo Pinned';
        actions.append(this._expandBtn);
        if (this.showLightPollution) {
            this._lightBtn = button(doc, 'Light Pollution', 'vlm-map-light');
            this._lightBtn.title = 'Light Pollution Map';
            actions.append(this._lightBtn);
        }
        // Outside links live in the expanded view, so the card in the chat stays small.

        card.append(this._stage, actions);
        this.el = card;

        const { signal } = this._abort;
        this._expandBtn.addEventListener('click', () => this.expand('map'), { signal });
        this._lightBtn?.addEventListener('click', () => this.expand('light'), { signal });
        this._engageBtn.addEventListener('click', () => (this._engaged ? this.disengage() : this.engage()), { signal });
    }

    /** Load the map library, draw the map and resolve the place name. Safe to call more than once. */
    async start() {
        if (this._started || this._destroyed) return;
        this._started = true;
        this.resolvePlace(true);
        try {
            this._L = await loadLeaflet(this.doc);
        } catch (_) {
            this._started = false;
            if (!this._destroyed) this._status.textContent = 'The map could not load. The links below still open this location.';
            return;
        }
        if (this._destroyed || this._collapsed) return;
        this._status.hidden = true;
        this._map = this._createMap(this._canvas, { zoom: INLINE_ZOOM, expanded: false });
        this._engageBtn.hidden = false;
        this._wireInlineGestures();
    }

    /**
     * Fill in the place name. With `allowNetwork` false only the shipped list and the
     * visitor's cache are consulted (used when nobody asked where the photo was taken).
     */
    resolvePlace(allowNetwork = true) {
        if (this.place?.label) return;
        lookupPlace(this.lat, this.lon, { allowNetwork }).then(place => this._setPlace(place), () => this._setPlace(null));
    }

    _setPlace(place) {
        if (this._destroyed) return;
        this.place = place;
        this._placeEl.classList.remove('vlm-map-place-pending');
        this._placeEl.textContent = place?.label || 'Photo location';
        this._regionEl.textContent = place?.region ?? '';
        this._regionEl.hidden = !place?.region;
        const name = place?.label ? `${place.label}${place.region ? `, ${place.region}` : ''}` : this.coordsText;
        this._canvas.setAttribute('aria-label', `Interactive map centred on ${name}`);
        if (this._overlay) {
            this._overlay.placeEl.textContent = this._placeEl.textContent;
            this._overlay.regionEl.textContent = [place?.region, this.coordsText].filter(Boolean).join(' — ');
        }
    }

    _createMap(container, { zoom, expanded }) {
        const L = this._L;
        const calm = this._reduceMotion;
        const map = L.map(container, {
            center: [this.lat, this.lon],
            zoom,
            minZoom: 2,
            maxZoom: MAP_STACK.tiles.maxZoom,
            zoomControl: false,
            attributionControl: true,
            // Inline maps start passive so they never trap chat scrolling:
            // one finger scrolls the chat, two fingers pinch-zoom the map, a tap engages it.
            scrollWheelZoom: expanded,
            dragging: expanded,
            touchZoom: true,
            doubleClickZoom: true,
            boxZoom: false,
            keyboard: true,
            worldCopyJump: true,
            zoomAnimation: !calm,
            fadeAnimation: !calm,
            markerZoomAnimation: !calm,
            inertia: !calm,
        });
        map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
        L.tileLayer(MAP_STACK.tiles.url, {
            maxZoom: MAP_STACK.tiles.maxZoom,
            attribution: MAP_STACK.tiles.attribution,
            keepBuffer: 1,
            updateWhenZooming: false,   // no tiles for the in-between frames of a zoom or flight
        }).addTo(map);
        L.control.zoom({ position: expanded ? 'topright' : 'bottomright' }).addTo(map);
        if (expanded) L.control.scale({ maxWidth: 120, position: 'bottomleft' }).addTo(map);
        L.marker([this.lat, this.lon], {
            icon: L.divIcon({ className: '', html: '<div class="vlm-map-pin"></div>', iconSize: [28, 28], iconAnchor: [14, 14] }),
            interactive: false,
            keyboard: false,
        }).addTo(map);
        if (this.thumbUrl) {
            // The photo itself, pinned where it was taken (smaller inside the chat).
            const size = expanded ? 84 : 48;
            const img = this.doc.createElement('img');
            img.src = this.thumbUrl;
            img.alt = this.photoName ? `Photo: ${this.photoName}` : 'Photo taken here';
            img.decoding = 'async';
            img.onerror = () => pin.remove();
            const pin = el(this.doc, 'div', `vlm-map-photo-pin${expanded ? '' : ' vlm-map-photo-pin-sm'}`);
            pin.appendChild(img);
            L.marker([this.lat, this.lon], {
                icon: L.divIcon({ className: '', html: pin, iconSize: [size, size + 14], iconAnchor: [size / 2, size + 20] }),
                interactive: false,
                keyboard: false,
                zIndexOffset: 500,
            }).addTo(map);
        }
        // Inline, the place caption covers the top of the map: sit the pin a little lower.
        if (!expanded) map.panBy([0, -48], { animate: false });
        container.setAttribute('role', 'application');
        if (!container.hasAttribute('aria-label')) container.setAttribute('aria-label', `Interactive map centred on ${this.coordsText}`);
        // Keep the tiles aligned when the panel is resized, docked or expanded.
        const win = this.doc.defaultView ?? window;
        if (win.ResizeObserver) {
            let frame = 0;
            const observer = new win.ResizeObserver(() => {
                if (frame) return;
                frame = win.requestAnimationFrame(() => { frame = 0; map.invalidateSize({ animate: false }); });
            });
            observer.observe(container);
            map.on('unload', () => { observer.disconnect(); if (frame) win.cancelAnimationFrame(frame); });
        }
        return map;
    }

    _wireInlineGestures() {
        const map = this._map;
        const { signal } = this._abort;
        // A mouse can drag straight away: that never competes with scrolling the chat.
        const allowMouseDrag = (event) => { if (event.pointerType === 'mouse' && this._map) this._map.dragging.enable(); };
        this._canvas.addEventListener('pointerenter', allowMouseDrag, { signal, passive: true });
        this._canvas.addEventListener('pointerdown', allowMouseDrag, { signal, passive: true, capture: true });
        this._canvas.addEventListener('pointerleave', (event) => {
            if (event.pointerType === 'mouse' && !this._engaged && this._map) this._map.dragging.disable();
        }, { signal, passive: true });
        this._canvas.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this._engaged) { event.stopPropagation(); this.disengage(); }
        }, { signal });
        map.on('click', () => { if (!this._engaged) this.engage(); });
    }

    /** Give the map one-finger dragging and wheel zoom until the visitor taps elsewhere. */
    engage() {
        if (!this._map || this._engaged) return;
        this._engaged = true;
        this._map.dragging.enable();
        this._map.scrollWheelZoom.enable();
        this._stage.classList.add('vlm-map-engaged');
        this._engageBtn.textContent = 'Done';
        this._engageBtn.title = 'Done: Return To Scrolling The Chat';
        this._engageBtn.setAttribute('aria-pressed', 'true');
        this._outside = new AbortController();
        this.doc.addEventListener('pointerdown', (event) => {
            if (!this._stage.contains(event.target)) this.disengage();
        }, { signal: this._outside.signal, passive: true, capture: true });
    }

    disengage() {
        if (!this._engaged) return;
        this._engaged = false;
        this._outside?.abort();
        this._outside = null;
        if (this._map) {
            this._map.dragging.disable();
            this._map.scrollWheelZoom.disable();
        }
        this._stage.classList.remove('vlm-map-engaged');
        this._engageBtn.textContent = 'Explore Map';
        this._engageBtn.title = 'Explore Map: Drag And Scroll To Move Around';
        this._engageBtn.setAttribute('aria-pressed', 'false');
    }

    /** Open the large view. `view` is 'map' or 'light' (the light-pollution map). */
    async expand(view = 'map') {
        if (this._destroyed) return;
        if (this._overlay) { this._showOverlayView(view); return; }
        this.disengage();
        const doc = this.doc;
        const overlay = el(doc, 'div', 'vlm-map-overlay');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Photo location map');

        const bar = el(doc, 'div', 'vlm-map-overlay-bar');
        const title = el(doc, 'div', 'vlm-map-overlay-title');
        const placeEl = el(doc, 'span', 'vlm-map-place', this._placeEl.textContent);
        const regionEl = el(doc, 'span', 'vlm-map-coords', [this.place?.region, this.coordsText].filter(Boolean).join(' — '));
        title.append(placeEl, regionEl);
        const actions = el(doc, 'div', 'vlm-map-overlay-actions');
        let mapTab = null, lightTab = null;
        if (this.showLightPollution) {
            mapTab = button(doc, 'Map');
            lightTab = button(doc, 'Light Pollution');
            mapTab.setAttribute('aria-pressed', 'true');
            lightTab.setAttribute('aria-pressed', 'false');
            actions.append(mapTab, lightTab);
        }
        const recenter = button(doc, 'Recenter');
        actions.append(recenter);
        const closeBtn = button(doc, '', 'vlm-btn-primary vlm-map-close');
        closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg><span>Close Map</span>';
        closeBtn.title = 'Close Map';
        closeBtn.setAttribute('aria-label', 'Close Map');
        bar.append(title, actions, closeBtn);

        const stage = el(doc, 'div', 'vlm-map-overlay-stage');
        const canvas = el(doc, 'div', 'vlm-map-canvas');
        const status = el(doc, 'div', 'vlm-map-status', 'Loading map…');
        stage.append(canvas, status);

        const foot = el(doc, 'div', 'vlm-map-overlay-foot');
        const footLink = (label, href) => {
            const a = el(doc, 'a', '', label);
            a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
            return a;
        };
        foot.append(
            el(doc, 'span', 'vlm-map-foot-label', 'Open In'),
            footLink('OpenStreetMap', this.links.openStreetMap),
            footLink('Google Maps', this.links.googleMaps),
            footLink('Report A Map Issue', 'https://www.openstreetmap.org/fixthemap'),
        );
        overlay.append(bar, stage, foot);
        doc.body.appendChild(overlay);

        const scope = new AbortController();
        const returnFocus = doc.activeElement;
        this._overlay = { root: overlay, stage, canvas, status, placeEl, regionEl, mapTab, lightTab, recenter, scope, returnFocus, map: null, frame: null };

        // Map controls on the right start below the floating title bar, whatever its height.
        const win = doc.defaultView ?? window;
        const placeControls = () => overlay.style.setProperty('--vlm-map-bar', `${Math.ceil(bar.getBoundingClientRect().bottom) + 8}px`);
        placeControls();
        if (win.ResizeObserver) {
            const barObserver = new win.ResizeObserver(placeControls);
            barObserver.observe(bar);
            scope.signal.addEventListener('abort', () => barObserver.disconnect());
        }
        closeBtn.addEventListener('click', () => this.closeExpanded(), { signal: scope.signal });
        recenter.addEventListener('click', () => {
            this._overlay?.map?.setView([this.lat, this.lon], EXPANDED_ZOOM, { animate: !this._reduceMotion });
        }, { signal: scope.signal });
        mapTab?.addEventListener('click', () => this._showOverlayView('map'), { signal: scope.signal });
        lightTab?.addEventListener('click', () => this._showOverlayView('light'), { signal: scope.signal });
        overlay.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.closeExpanded(); return; }
            // Keys pressed in the map must not reach the gallery behind it.
            event.stopPropagation();
            if (event.key !== 'Tab') return;
            const focusable = [...overlay.querySelectorAll('button:not([hidden]), a[href], [tabindex="0"]')].filter(node => node.offsetParent !== null);
            if (!focusable.length) return;
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
        }, { signal: scope.signal });
        closeBtn.focus();

        this._showOverlayView(view);
        try {
            this._L = this._L ?? await loadLeaflet(doc);
        } catch (_) {
            if (this._overlay) status.textContent = 'The map could not load. The links below still open this location.';
            return;
        }
        if (!this._overlay || this._overlay.root !== overlay) return;
        status.hidden = true;
        const target = this._map ? Math.max(EXPANDED_ZOOM, this._map.getZoom() + 1) : EXPANDED_ZOOM;
        const calm = this._reduceMotion;
        // Arrive from higher up, then settle on the spot (skipped with reduced motion).
        const map = this._createMap(canvas, { zoom: calm ? target : Math.max(3, target - 2), expanded: true });
        this._overlay.map = map;
        if (!calm) map.whenReady(() => { if (this._overlay?.map === map) map.flyTo([this.lat, this.lon], target, { duration: 1.3 }); });
    }

    _showOverlayView(view) {
        const overlay = this._overlay;
        if (!overlay) return;
        const light = view === 'light' && this.showLightPollution;
        overlay.mapTab?.setAttribute('aria-pressed', String(!light));
        overlay.lightTab?.setAttribute('aria-pressed', String(light));
        overlay.recenter.hidden = light;
        overlay.canvas.style.visibility = light ? 'hidden' : '';
        if (light && !overlay.frame) {
            // The existing light-pollution map, loaded only when asked for.
            const frame = this.doc.createElement('iframe');
            frame.src = this.links.lightPollution;
            frame.title = 'Light Pollution Map';
            frame.loading = 'lazy';
            frame.referrerPolicy = 'no-referrer';
            overlay.stage.appendChild(frame);
            overlay.frame = frame;
        }
        if (overlay.frame) overlay.frame.hidden = !light;
        if (!light) overlay.map?.invalidateSize({ animate: false });
    }

    closeExpanded() {
        const overlay = this._overlay;
        if (!overlay) return;
        this._overlay = null;
        overlay.scope.abort();
        try { overlay.map?.remove(); } catch (_) {}
        overlay.root.remove();
        if (overlay.returnFocus?.isConnected) overlay.returnFocus.focus({ preventScroll: true });
        else if (this._expandBtn.isConnected) this._expandBtn.focus({ preventScroll: true });
    }

    /** Free the live map but keep the card: used when a newer location card takes over. */
    collapse() {
        if (this._collapsed || this._destroyed) return;
        this._collapsed = true;
        this.disengage();
        this.closeExpanded();
        try { this._map?.remove(); } catch (_) {}
        this._map = null;
        this._stage.hidden = true;
        const row = el(this.doc, 'div', 'vlm-map-collapsed');
        const show = button(this.doc, 'Show Map');
        show.addEventListener('click', () => {
            row.remove();
            this._stage.hidden = false;
            this._collapsed = false;
            this._started = false;
            this._status.hidden = false;
            this.start();
        }, { signal: this._abort.signal });
        row.appendChild(show);
        this._stage.after(row);
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.disengage();
        this.closeExpanded();
        this._abort.abort();
        try { this._map?.remove(); } catch (_) {}
        this._map = null;
        this.el.remove();
    }
}
