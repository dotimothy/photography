/**
 * Print Orbit: the portfolio's photographs as prints in orbit around the 3D camera.
 *
 * The camera model sits at the centre of a slowly turning belt of prints, one arc per
 * collection. Choosing a collection turns the belt to bring that arc to a stage beside
 * the camera, where its prints arrange themselves around one large photograph. Opening
 * a gallery flies the visitor through a print; photographs shown on the camera's
 * display lift off the screen and join the belt.
 *
 * Loaded as a classic script before the homepage's inline script. Scene globals
 * (scene, camera, controls, renderer, state, camGroup, ...) are read lazily at call time.
 */
window.PrintOrbit = (function () {
    'use strict';

    const TAU = Math.PI * 2;
    const GALLERIES = ['astronomy', 'food', 'landscape', 'planes', 'wildlife'];
    const TITLES = { astronomy: 'Astronomy', food: 'Food', landscape: 'Landscape', planes: 'Planes', wildlife: 'Wildlife' };
    const MAX_PER = 8;
    // Slots fill in this order so two, four or six prints still spread across the whole arc.
    const SLOT_ORDER = [0, 4, 2, 6, 1, 5, 3, 7];
    const THICK = 0.14, BORDER = 0.13;
    const DRIFT = 0.014;                 // belt rotation, radians per second
    const DIM = 0.05;                    // linear brightness of prints outside the chosen collection
    const STAGE_EYE = [20, 2, -4];       // where the visitor stands to view a collection
    const STAGE_FORWARD = [1, 0, -0.04]; // and the direction they face (screen-left of the camera home view)
    const MAX_CAPTURES = 3;

    const o = {
        built: false, active: false, mode: 'home', spin: 0.35, spinTween: null,
        slots: [], labels: [], captures: [], counts: [0, 0, 0, 0, 0],
        flight: null, hold: false, activeGi: -1, hero: null, hovered: null, highlight: -1,
        returnPose: null, galleryReturn: null, heldTravel: false,
        pointer: { x: 0, y: 0, inside: false, dirty: false, touch: false }, parallax: { x: 0, y: 0 },
        fillGen: 0, trimTimer: 0, budgetKey: '', last: 0, lineOpacity: 0.1, labelOpacity: 1,
        ejecting: 0, born: 0
    };
    const queue = [];
    let running = 0;
    let v1, v2, v3, v4, q1, q2, m1, raycaster, ndc, rail;

    const ease = {
        inOut: (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
        out: (t) => 1 - Math.pow(1 - t, 3),
        outQuint: (t) => 1 - Math.pow(1 - t, 5),
        inOutQuint: (t) => t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2,
        inQuad: (t) => t * t
    };
    const clamp01 = (t) => Math.min(1, Math.max(0, t));
    const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
    const linear = (hex) => new THREE.Color(hex).convertSRGBToLinear();
    const motionOff = () => sceneMotionPreference.matches || window.SitePerformance?.current?.animations === false;
    const compact = () => innerWidth <= 768;
    const seeded = (seed) => () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // ── Budget ────────────────────────────────────────────────────────────────
    // How many prints stay alive and how large their textures are. Thumbs are 1200 px;
    // a print in the belt is rarely more than a few hundred pixels wide on screen.
    function budget() {
        const profile = window.SitePerformance?.current?.resolvedProfile || 'quality';
        const small = compact() || (matchMedia('(pointer: coarse)').matches && Math.min(innerWidth, innerHeight) <= 768);
        let per = profile === 'quality' ? 8 : profile === 'balanced' ? 6 : 4;
        let long = profile === 'performance' ? 384 : 512;
        if (small) { per = Math.min(per, 4); long = 320; }
        const saver = state.dataSaver || navigator.connection?.saveData === true;
        if (saver) { per = 2; long = 256; }
        return { per, long, hi: !small && !saver && profile !== 'performance' ? 1024 : 0, small };
    }

    function metrics() {
        const size = viewportSize();
        const portrait = size.width / size.height < 0.9;
        // Phones orbit the camera from further away, so their belt is wider and stands
        // nearly upright: prints pass above and below the camera instead of beside it.
        return portrait
            ? { R0: 60, dR: 8, size: 1.5, ySpread: 1.5, tiltZ: 1.16, tiltX: 0.04, portrait }
            : { R0: 34, dR: 7, size: 1, ySpread: 1, tiltZ: 0.27, tiltX: -0.07, portrait };
    }

    // ── Geometry ──────────────────────────────────────────────────────────────
    // Two quads back to back: the photograph reads correctly from both sides of a print.
    function doubleQuad() {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
            -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
            0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5
        ]), 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([
            0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1
        ]), 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
            0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1
        ]), 2));
        geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
        geometry.computeBoundingSphere();
        return geometry;
    }

    function slotHome(gi, si, m) {
        const random = seeded(gi * 977 + si * 131 + 17);
        const position = SLOT_ORDER[si];
        const centre = gi * TAU / 5, span = TAU / 5 * 0.8;
        const angle = centre + ((position + 0.5) / MAX_PER - 0.5) * span + (random() - 0.5) * 0.03;
        const lane = (position * 2 + gi) % 3;
        const radius = m.R0 + lane * m.dR + (random() - 0.5) * 2.4;
        const side = position % 2 ? 1 : -1;
        const y = (side * (3.2 + random() * 4.2) + (lane - 1) * 1.2) * m.ySpread;
        const long = (7.4 + random() * 2.2) * m.size;
        const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(
            (random() - 0.5) * 0.16, angle + Math.PI + (random() - 0.5) * 0.2, (random() - 0.5) * 0.1, 'YXZ'));
        return { pos: new THREE.Vector3(Math.sin(angle) * radius, y, Math.cos(angle) * radius), quat, long, angle };
    }

    function captureHome(index, m) {
        // The visitor's own space captures ride a higher, wider lane of their own.
        const angle = [0.9, -1.0, 2.2][index % MAX_CAPTURES] - o.spin;
        const radius = m.R0 + m.dR * 2 + 7;
        const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, angle + Math.PI, index % 2 ? 0.06 : -0.06, 'YXZ'));
        return { pos: new THREE.Vector3(Math.sin(angle) * radius, (11 + index * 2.5) * m.ySpread, Math.cos(angle) * radius), quat, long: 7.2 * m.size, angle };
    }

    // ── Textures ──────────────────────────────────────────────────────────────
    async function decode(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error('Photo unavailable');
        const blob = await response.blob();
        if (window.createImageBitmap) return createImageBitmap(blob);
        return new Promise((resolve, reject) => {
            const image = new Image(), objectUrl = URL.createObjectURL(blob);
            image.onload = () => { URL.revokeObjectURL(objectUrl); resolve(image); };
            image.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Photo unavailable')); };
            image.src = objectUrl;
        });
    }

    function textureFrom(source, long) {
        const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
        if (!sw || !sh) throw new Error('Photo unavailable');
        const k = Math.min(1, long / Math.max(sw, sh));
        const w = Math.max(2, Math.round(sw * k)), h = Math.max(2, Math.round(sh * k));
        const draw = (from, cw, ch) => {
            const canvas = document.createElement('canvas');
            canvas.width = cw; canvas.height = ch;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(from, 0, 0, cw, ch);
            return canvas;
        };
        // Halve in steps so the last resample is never steeper than 2:1; fine detail
        // such as stars and feathers then stays clean in every browser.
        let stage = source, cw = sw, ch = sh;
        while (cw / w > 2) { cw = Math.ceil(cw / 2); ch = Math.ceil(ch / 2); stage = draw(stage, cw, ch); }
        const texture = new THREE.CanvasTexture(draw(stage, w, h));
        const webgl2 = renderer.capabilities.isWebGL2;
        texture.encoding = THREE.sRGBEncoding;
        texture.generateMipmaps = webgl2;
        texture.minFilter = webgl2 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        // Upload now, during idle time, rather than on the frame the print first appears.
        renderer.initTexture(texture);
        return { texture, aspect: sw / sh };
    }

    async function loadTexture(url, long) {
        const source = await decode(url);
        try { return textureFrom(source, long); }
        finally { source.close?.(); }
    }

    function pump() {
        const limit = o.budget?.small ? 2 : 3;
        while (o.active && running < limit && queue.length) {
            const job = queue.shift();
            running++;
            job().catch(() => { /* A missing photo leaves its slot empty. */ }).finally(() => { running--; pump(); });
        }
    }

    async function catalog(gallery) {
        await portfolioBaseReady;
        if (!cameraPhotoCatalogs.has(gallery)) {
            const response = await fetch(`${portfolioBase}${gallery}/metadata/metadata.json`);
            if (!response.ok) throw new Error('Collection unavailable');
            const metadata = await response.json();
            const names = (metadata.image_order || Object.keys(metadata)).filter((name) => typeof name === 'string' && name !== 'image_order');
            if (!names.length) throw new Error('Collection is empty');
            cameraPhotoCatalogs.set(gallery, names);
            cameraPhotoMetadata.set(gallery, metadata);
        }
        return cameraPhotoCatalogs.get(gallery);
    }

    const thumbUrl = (gallery, name) => `${portfolioBase}${gallery}/thumbs/${encodeURIComponent(name)}.jpg`;

    // ── Prints ────────────────────────────────────────────────────────────────
    function createPrint(slot, name, loaded, long) {
        const group = new THREE.Group();
        const material = new THREE.MeshBasicMaterial({ map: loaded.texture, toneMapped: false, fog: false, transparent: true });
        material.color.setScalar(0);
        const photo = new THREE.Mesh(o.quadGeo, material);
        const slab = new THREE.Mesh(o.slabGeo, o.slabMat);
        const aspect = loaded.aspect;
        const w = aspect >= 1 ? long : long * aspect, h = w / aspect;
        photo.scale.set(w, h, THICK + 0.02);
        slab.scale.set(w + BORDER * 2, h + BORDER * 2, THICK);
        slab.raycast = () => { };
        // Always drawn, so GPU resources are created once and stay countable.
        photo.frustumCulled = slab.frustumCulled = false;
        group.add(slab, photo);
        const print = {
            slot, gi: slot.gi, name, group, photo, slab, material, std: loaded.texture, hi: null, wantsHi: false,
            w, h, home: slot.home, base: { pos: slot.home.pos.clone(), quat: slot.home.quat.clone(), scale: 1 },
            tween: null, bright: 0, brightTarget: 1, hover: 0, hoverTarget: 0, appear: motionOff() ? 1 : 0,
            phase: Math.random() * TAU, born: ++o.born, surplus: false, place: 'belt', noFade: false, pulse: 0, world: new THREE.Vector3()
        };
        photo.userData.print = print;
        group.position.copy(print.base.pos); group.quaternion.copy(print.base.quat);
        o.belt.add(group);
        slot.print = print;
        return print;
    }

    function disposePrint(print) {
        if (!print) return;
        if (o.halo.parent === print.group) { print.group.remove(o.halo); o.halo.visible = false; }
        o.belt.remove(print.group);
        print.material.dispose();
        print.std?.dispose(); print.hi?.dispose();
        print.std = print.hi = null;
        if (print.slot?.print === print) print.slot.print = null;
        if (o.hovered === print) o.hovered = null;
        if (o.hero === print) o.hero = null;
        print.dead = true;
    }

    function prints(gi = -1) {
        const list = [];
        for (const group of o.slots) for (const slot of group)
            if (slot.print && !slot.print.dead && !slot.print.surplus && (gi < 0 || slot.gi === gi)) list.push(slot.print);
        return list;
    }

    function tweenPrint(print, to, duration, delay = 0, easing = ease.inOut, path = null) {
        if (motionOff() || duration <= 0) {
            print.base.pos.copy(to.pos); print.base.quat.copy(to.quat); print.base.scale = to.scale ?? 1;
            print.tween = null; to.done?.();
            return;
        }
        print.tween = {
            t0: performance.now() + delay, duration, easing, path, done: to.done,
            fromPos: print.base.pos.clone(), fromQuat: print.base.quat.clone(), fromScale: print.base.scale,
            toPos: to.pos.clone(), toQuat: to.quat.clone(), toScale: to.scale ?? 1
        };
    }

    function setHiRes(print, wanted) {
        const long = o.budget?.hi;
        print.wantsHi = wanted && !!long;
        if (!print.wantsHi) {
            if (print.hi) { print.material.map = print.std; print.hi.dispose(); print.hi = null; }
            return;
        }
        if (print.hi || print.loadingHi || print.gi < 0) return;
        print.loadingHi = true;
        queue.unshift(async () => {
            try {
                const loaded = await loadTexture(thumbUrl(GALLERIES[print.gi], print.name), long);
                if (print.dead || !print.wantsHi) { loaded.texture.dispose(); return; }
                print.hi = loaded.texture; print.material.map = print.hi;
            } finally { print.loadingHi = false; }
        });
        pump();
    }

    // ── Filling the belt ──────────────────────────────────────────────────────
    function pickName(names, gi, si) {
        if (!names.length) return null;
        const used = new Set(o.slots[gi].map((slot) => slot.print?.name || slot.pendingName).filter(Boolean));
        const start = names.length >= MAX_PER ? Math.floor(si * names.length / MAX_PER) : si;
        for (let i = 0; i < names.length; i++) {
            const name = names[(start + i) % names.length];
            if (!used.has(name)) return name;
        }
        return null;
    }

    async function fill() {
        if (!o.built) return;
        const generation = ++o.fillGen;
        const current = o.budget = budget();
        o.budgetKey = `${current.per}/${current.long}`;
        const lists = await Promise.all(GALLERIES.map((gallery) => catalog(gallery).catch(() => [])));
        if (generation !== o.fillGen || !o.active) return;
        lists.forEach((names, gi) => { o.counts[gi] = names.length; });
        drawLabels(); syncRail();
        for (let si = 0; si < MAX_PER; si++) for (let gi = 0; gi < GALLERIES.length; gi++) {
            const slot = o.slots[gi][si];
            if (si >= current.per) { if (slot.print) slot.print.surplus = true; continue; }
            if (slot.print) { slot.print.surplus = false; continue; }
            if (slot.pending) continue;
            const name = pickName(lists[gi], gi, si);
            if (!name) continue;
            slot.pending = true; slot.pendingName = name;
            queue.push(async () => {
                try {
                    const loaded = await loadTexture(thumbUrl(GALLERIES[gi], name), current.long);
                    if (slot.print || !o.built) { loaded.texture.dispose(); return; }
                    const print = createPrint(slot, name, loaded, slot.home.long);
                    print.surplus = si >= (o.budget?.per ?? MAX_PER);
                    if (o.mode === 'collection') {
                        if (gi === o.activeGi) layoutFormation(700); else print.brightTarget = DIM;
                    }
                } finally { slot.pending = false; slot.pendingName = null; }
            });
        }
        pump();
        scheduleTrim();
    }

    // Lowering the budget hides surplus prints at once but frees them only after a
    // pause, so flipping through quality presets never thrashes the network or the GPU.
    function scheduleTrim() {
        clearTimeout(o.trimTimer);
        o.trimTimer = setTimeout(() => {
            for (const group of o.slots) for (const slot of group)
                if (slot.print?.surplus && slot.print !== o.hero && slot.print.place === 'belt') disposePrint(slot.print);
        }, 8000);
    }

    // ── Labels and orbit lines ────────────────────────────────────────────────
    function drawLabels() {
        o.labels.forEach((label, gi) => {
            const ctx = label.canvas.getContext('2d');
            ctx.clearRect(0, 0, 1024, 256);
            ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = '#f2f8fc';
            ctx.font = '500 118px Roboto, "Helvetica Neue", Arial, sans-serif';
            ctx.fillText(TITLES[GALLERIES[gi]], 512, 138);
            if (o.counts[gi]) {
                ctx.fillStyle = '#7fe9f7';
                ctx.font = '400 50px Roboto, "Helvetica Neue", Arial, sans-serif';
                ctx.fillText(`${o.counts[gi]} ${o.counts[gi] === 1 ? 'Picture' : 'Pictures'}`, 512, 214);
            }
            label.texture.needsUpdate = true;
        });
    }

    function buildDecor() {
        const m = o.metrics;
        // Two hairline orbits trace the inner and outer edge of the belt.
        o.lineMat = new THREE.LineBasicMaterial({ color: linear(0x00e5ff), transparent: true, opacity: 0.1, depthWrite: false, fog: false, toneMapped: false });
        const points = [];
        for (let i = 0; i < 160; i++) points.push(new THREE.Vector3(Math.sin(i / 160 * TAU), 0, Math.cos(i / 160 * TAU)));
        o.lineGeo = new THREE.BufferGeometry().setFromPoints(points);
        o.lines = [m.R0 - 3.5, m.R0 + m.dR * 2 + 3.5].map((radius) => {
            const line = new THREE.LineLoop(o.lineGeo, o.lineMat);
            line.scale.setScalar(radius); line.frustumCulled = false; line.raycast = () => { };
            o.belt.add(line);
            return line;
        });
        GALLERIES.forEach((gallery, gi) => {
            const canvas = document.createElement('canvas');
            canvas.width = 1024; canvas.height = 256;
            const texture = new THREE.CanvasTexture(canvas);
            texture.encoding = THREE.sRGBEncoding;
            texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter;
            texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
            const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, fog: false });
            const mesh = new THREE.Mesh(o.quadGeo, material);
            mesh.frustumCulled = false;
            mesh.userData.label = gi;
            o.belt.add(mesh);
            o.labels.push({ mesh, canvas, texture, material, gi, glow: 0 });
        });
        drawLabels();
        document.fonts?.ready.then(drawLabels).catch(() => { });
    }

    function placeDecor() {
        const m = o.metrics;
        o.lines[0].scale.setScalar(m.R0 - 3.5);
        o.lines[1].scale.setScalar(m.R0 + m.dR * 2 + 3.5);
        o.labels.forEach((label, gi) => {
            const angle = gi * TAU / 5, radius = m.R0 + m.dR;
            label.mesh.position.set(Math.sin(angle) * radius, -12.5 * m.ySpread, Math.cos(angle) * radius);
            label.mesh.rotation.set(0, angle + Math.PI, 0);
            label.mesh.scale.set(13 * m.size, 3.25 * m.size, 0.02);
        });
    }

    // Recompute the belt for the current viewport shape; prints glide to their new homes.
    function applyLayout(immediate) {
        const m = o.metrics = metrics();
        o.tilt = { x: m.tiltX, z: m.tiltZ };
        if (immediate) o.root.rotation.set(m.tiltX, 0, m.tiltZ);
        for (let gi = 0; gi < GALLERIES.length; gi++) for (let si = 0; si < MAX_PER; si++) {
            const slot = o.slots[gi][si], home = slotHome(gi, si, m);
            slot.home = home;
            const print = slot.print;
            if (!print) continue;
            const k = home.long / Math.max(print.w, print.h);
            print.home = home;
            if (Math.abs(k - 1) > 0.01) {
                print.w *= k; print.h *= k;
                print.photo.scale.set(print.w, print.h, THICK + 0.02);
                print.slab.scale.set(print.w + BORDER * 2, print.h + BORDER * 2, THICK);
            }
            if (print.place === 'belt') tweenPrint(print, { pos: home.pos, quat: home.quat, scale: 1 }, immediate ? 0 : 900);
        }
        if (o.lines) placeDecor();
    }

    // ── Build / lifecycle ─────────────────────────────────────────────────────
    function init() {
        if (o.built || typeof scene === 'undefined' || !scene || !renderer) return;
        v1 = new THREE.Vector3(); v2 = new THREE.Vector3(); v3 = new THREE.Vector3(); v4 = new THREE.Vector3();
        q1 = new THREE.Quaternion(); q2 = new THREE.Quaternion(); m1 = new THREE.Matrix4();
        raycaster = new THREE.Raycaster(); ndc = new THREE.Vector2();
        o.root = new THREE.Group(); o.root.name = 'print-orbit';
        o.belt = new THREE.Group(); o.belt.name = 'print-belt';
        o.root.add(o.belt); scene.add(o.root);
        o.quadGeo = doubleQuad();
        o.slabGeo = new THREE.BoxGeometry(1, 1, 1);
        o.slabMat = new THREE.MeshStandardMaterial({ color: linear(0x1a222b), emissive: linear(0x0f161d), roughness: 0.58, metalness: 0.6 });
        o.haloMat = new THREE.MeshBasicMaterial({ color: linear(0x00e5ff), transparent: true, opacity: 0, depthWrite: false, toneMapped: false, fog: false });
        o.halo = new THREE.Mesh(o.slabGeo, o.haloMat);
        o.halo.visible = false; o.halo.frustumCulled = false; o.halo.raycast = () => { };
        o.slots = GALLERIES.map((gallery, gi) => Array.from({ length: MAX_PER }, (unused, si) => ({ gi, si, print: null, pending: false, home: null })));
        o.metrics = metrics();
        buildDecor();
        applyLayout(true);
        o.belt.rotation.y = o.spin;
        o.built = true;
        buildRail();
        attach();
        if (state.is3D) activate();
    }

    function activate() {
        if (!o.built || o.active) return;
        o.active = true;
        // Two frames after first paint, then the photographs start arriving.
        requestAnimationFrame(() => requestAnimationFrame(() => { fill().catch(() => { }); }));
    }

    function deactivate() {
        o.active = false;
        reset();
        o.live = false;
        document.body.classList.remove('orbit-live');
    }

    // Snap back to the plain camera scene (mode switches, errors, reloads of state).
    function reset() {
        if (!o.built) return;
        const wasAway = o.mode !== 'home' || o.flight;
        const unfinished = o.flight;
        o.flight = null; o.spinTween = null; o.hold = false;
        if (o.mode === 'collection' || o.mode === 'gallery') {
            for (const print of prints()) {
                if (print.place === 'formation') { print.place = 'belt'; tweenPrint(print, { pos: print.home.pos, quat: print.home.quat, scale: 1 }, 0); }
                print.brightTarget = 1; print.noFade = false; setHiRes(print, false);
            }
        }
        // Land wherever the interrupted journey began, or finish a journey that was heading home.
        const pose = o.returnPose || (o.galleryReturn && !o.galleryReturn.inspection ? o.galleryReturn
            : unfinished ? (unfinished.resetPose || { pos: unfinished.toPos, target: unfinished.toTarget }) : null);
        if (wasAway && pose && camera && controls) {
            camera.position.copy(pose.pos); controls.target.copy(pose.target); camera.lookAt(pose.target);
        }
        if (wasAway && controls && !cameraInspection) controls.enabled = true;
        if (o.heldTravel) { cameraTravel = false; o.heldTravel = false; }
        o.mode = 'home'; o.activeGi = -1; o.hero = null; o.returnPose = null; o.galleryReturn = null;
        setHover(null);
        document.body.classList.remove('orbit-collection');
        syncRail();
    }

    function holdTravel(held) {
        cameraTravel = held; o.heldTravel = held;
    }

    // ── Visitor camera flights ────────────────────────────────────────────────
    function arcPoint(a, b, t, out, turns = 0) {
        const ra = Math.hypot(a.x, a.z), rb = Math.hypot(b.x, b.z);
        const aa = Math.atan2(a.x, a.z);
        let sweep = Math.atan2(b.x, b.z) - aa;
        sweep = Math.atan2(Math.sin(sweep), Math.cos(sweep));
        sweep += turns * 2 * Math.PI;
        const angle = aa + sweep * t;
        let radius = ra + (rb - ra) * t;
        // Swing wide of the camera body on long sweeps instead of cutting through it.
        radius += Math.sin(Math.PI * t) * Math.max(0, 23 - radius) * Math.min(1, Math.abs(sweep) / 1.2);
        return out.set(Math.sin(angle) * radius, a.y + (b.y - a.y) * t, Math.cos(angle) * radius);
    }

    function crossesBody(a, b) {
        const dx = b.x - a.x, dz = b.z - a.z, length = dx * dx + dz * dz;
        const t = length ? clamp01(-(a.x * dx + a.z * dz) / length) : 0;
        return Math.hypot(a.x + dx * t, a.z + dz * t) < 17 && Math.abs(a.y + (b.y - a.y) * t) < 16;
    }

    function fly(options) {
        const fromPos = camera.position.clone(), fromTarget = controls.target.clone();
        const flight = Object.assign({ t0: performance.now(), fromPos, fromTarget, easing: ease.inOut, marks: [], arc: false }, options);
        if (flight.arc === 'auto') flight.arc = crossesBody(fromPos, flight.toPos);
        if (motionOff() || !(flight.duration > 0)) {
            camera.position.copy(flight.toPos); controls.target.copy(flight.toTarget); camera.lookAt(flight.toTarget);
            o.flight = null;
            flight.marks.forEach((mark) => mark.run());
            flight.done?.();
            return;
        }
        o.flight = flight;
    }

    function updateFlight(now) {
        const flight = o.flight;
        if (!flight) return;
        const raw = clamp01((now - flight.t0) / flight.duration), t = flight.easing(raw);
        if (flight.arc) arcPoint(flight.fromPos, flight.toPos, t, camera.position, flight.turns);
        else camera.position.lerpVectors(flight.fromPos, flight.toPos, t);
        controls.target.lerpVectors(flight.fromTarget, flight.toTarget, flight.targetEasing ? flight.targetEasing(raw) : t);
        camera.lookAt(controls.target);
        for (const mark of flight.marks) if (!mark.ran && raw >= mark.at) { mark.ran = true; mark.run(); }
        if (raw >= 1 && o.flight === flight) { o.flight = null; flight.done?.(); }
    }

    function homePose() {
        const mobile = innerWidth <= 768;
        const distance = mobile ? Math.max(30, 44 * (innerHeight / innerWidth) / (844 / 390)) : 25;
        return { pos: new THREE.Vector3(0, 0, -distance), target: new THREE.Vector3(0, mobile ? 0 : -0.5, mobile ? 0 : -2) };
    }

    // Finish the orbit close to the rear screen, then pull back to show the camera body.
    function arrive() {
        if (!camera || !controls) return;
        const pose = homePose();
        if (!o.built || motionOff()) {
            camera.position.copy(pose.pos);
            controls.target.copy(pose.target);
            controls.update();
            return;
        }

        const close = pose.pos.clone().multiplyScalar(0.7);
        // Smootherstep keeps both velocity and acceleration at zero at the endpoints.
        const easing = (t) => t ** 3 * (10 + t * (6 * t - 15));
        controls.enabled = false;
        holdTravel(true);
        fly({
            toPos: close, toTarget: pose.target, duration: 2050, arc: true, turns: -1, easing, resetPose: pose,
            done: () => fly({
                toPos: pose.pos, toTarget: pose.target, duration: 650, easing,
                done: () => {
                    controls.enabled = true;
                    holdTravel(false);
                    controls.update();
                }
            })
        });
    }

    // ── Collection stage ──────────────────────────────────────────────────────
    function stage() {
        if (o.stage) return o.stage;
        const eye = new THREE.Vector3().fromArray(STAGE_EYE);
        const forward = new THREE.Vector3().fromArray(STAGE_FORWARD).normalize();
        const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
        const up = new THREE.Vector3().crossVectors(right, forward).normalize();
        return (o.stage = { eye, forward, right, up, focus: eye.clone().addScaledVector(forward, 24) });
    }

    function finalBeltQuaternion(spin) {
        return new THREE.Quaternion().setFromEuler(new THREE.Euler(o.tilt.x, 0, o.tilt.z))
            .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spin));
    }

    // Arrange the chosen collection around one large photograph. Targets are designed in
    // world space, then expressed in the belt's frame as it will be once it stops turning.
    function layoutFormation(duration = 1100) {
        const list = prints(o.activeGi).filter((print) => print.place !== 'eject');
        if (!list.length) { syncRail(); return; }
        if (!o.hero || o.hero.dead || o.hero.gi !== o.activeGi) o.hero = list[0];
        const s = stage(), size = viewportSize(), aspect = size.width / size.height;
        const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
        const spin = o.spinTween ? o.spinTween.to : o.spin;
        const beltQuat = finalBeltQuaternion(spin), inverse = beltQuat.clone().invert();
        const toLocal = (world) => world.clone().applyQuaternion(inverse);
        const facing = (world) => {
            m1.lookAt(s.eye, world, s.up);
            return inverse.clone().multiply(q1.setFromRotationMatrix(m1));
        };
        const narrow = aspect < 1.25;
        // sx, sy are screen positions (-1..1); frac is the share of the view width the print covers.
        const place = (print, sx, sy, depth, frac, index) => {
            const ray = s.forward.clone().addScaledVector(s.right, sx * tan * aspect).addScaledVector(s.up, sy * tan);
            const world = s.eye.clone().addScaledVector(ray, depth);
            print.place = 'formation'; print.noFade = true; print.brightTarget = 1;
            setHiRes(print, true);
            tweenPrint(print, { pos: toLocal(world), quat: facing(world), scale: frac * 2 * depth * tan * aspect / print.w },
                duration, index * 45, ease.inOutQuint);
        };
        // Hero: large, near, clear of the collection panel on the left.
        const heroAspect = o.hero.w / o.hero.h;
        place(o.hero, narrow ? 0 : 0.2, 0.02, 15, Math.min(narrow ? 0.66 : 0.42, 0.5 * heroAspect / aspect), 0);
        // The rest: two rows on a shallow concave wall behind it, nearer at the edges.
        const others = list.filter((print) => print !== o.hero).sort((a, b) => a.slot.home.angle - b.slot.home.angle);
        const perRow = narrow ? 3 : 4;
        const rows = [[], []];
        others.forEach((print, index) => rows[Math.floor(index / perRow) % 2].push(print));
        rows.forEach((row, rowIndex) => {
            const cell = 1.66 / Math.max(row.length, perRow - 1);
            row.forEach((print, column) => {
                const sx = (column - (row.length - 1) / 2) * cell + (rowIndex ? 0.05 : 0.02);
                const frac = Math.min(cell * 0.44, 0.19 * (print.w / print.h) / aspect);
                place(print, sx, rowIndex ? -0.7 : 0.71, 31 - 3.2 * sx * sx, frac, 1 + rowIndex * row.length + column);
            });
        });
        syncRail();
    }

    function enterCollection(gi, lead = null) {
        if (!o.built || gi < 0 || gi >= GALLERIES.length || compact() || !state.is3D || !state.hasExplored) return false;
        if (cameraInspection || o.mode === 'gallery' || (o.flight && o.mode === 'home') || els.iframeOverlay.classList.contains('active')) return false;
        if (o.mode === 'home' && cameraTravel) return false;
        const s = stage();
        if (o.mode === 'home') {
            o.returnPose = { pos: camera.position.clone(), target: controls.target.clone() };
            controls.enabled = false; holdTravel(true);
            fly({ toPos: s.eye, toTarget: s.focus, duration: 1500, arc: true, easing: ease.inOutQuint });
        } else if (o.activeGi === gi) {
            if (lead) setHero(lead);
            return true;
        } else {
            // Switching collections: the old prints fall back into the belt as it turns.
            for (const print of prints(o.activeGi)) sendHome(print, 900, 0);
        }
        o.mode = 'collection'; o.activeGi = gi;
        o.hero = lead && lead.gi === gi ? lead : (prints(gi)[0] || null);
        setHover(null); o.highlight = -1;
        // Turn the belt the short way round so this arc arrives at the stage.
        const stageAngle = Math.atan2(STAGE_FORWARD[0], STAGE_FORWARD[2]);
        let delta = stageAngle - gi * TAU / 5 - o.spin;
        delta = Math.atan2(Math.sin(delta), Math.cos(delta));
        o.spinTween = motionOff() ? null : { from: o.spin, to: o.spin + delta, t0: performance.now(), duration: 1400 };
        if (!o.spinTween) o.spin += delta;
        for (const print of prints()) if (print.gi !== gi) print.brightTarget = DIM;
        layoutFormation(1250);
        document.body.classList.add('orbit-collection');
        announce(`${TITLES[GALLERIES[gi]]}: ${o.counts[gi] || 'several'} Pictures. Left and right arrows choose a picture, Enter opens it, Escape returns to the camera.`);
        sfx.click();
        syncRail();
        return true;
    }

    function sendHome(print, duration, delay) {
        print.place = 'belt'; print.noFade = false;
        setHiRes(print, false);
        tweenPrint(print, { pos: print.home.pos, quat: print.home.quat, scale: 1 }, duration, delay, ease.inOut);
    }

    function leaveCollection() {
        if (o.mode !== 'collection') return;
        prints(o.activeGi).forEach((print, index) => sendHome(print, 1000, index * 35));
        for (const print of prints()) print.brightTarget = 1;
        o.mode = 'home'; o.activeGi = -1; o.hero = null; o.spinTween = null;
        setHover(null);
        document.body.classList.remove('orbit-collection');
        const pose = o.returnPose || homePose();
        o.returnPose = null;
        fly({
            toPos: pose.pos, toTarget: pose.target, duration: 1300, arc: true, easing: ease.inOutQuint,
            done: () => { controls.enabled = true; holdTravel(false); controls.update(); }
        });
        announce('Back at the camera.');
        sfx.click();
        syncRail();
    }

    function setHero(print, quiet = false) {
        if (!print || print === o.hero || o.mode !== 'collection') return;
        o.hero = print;
        layoutFormation(760);
        if (!quiet) sfx.click();
        const list = formationOrder();
        announce(`Picture ${list.indexOf(print) + 1} of ${list.length}. ${caption(print)}`);
    }

    function formationOrder() {
        return prints(o.activeGi).sort((a, b) => a.slot.home.angle - b.slot.home.angle);
    }

    function stepHero(direction) {
        const list = formationOrder();
        if (!list.length) return;
        setHero(list[(list.indexOf(o.hero) + direction + list.length) % list.length]);
    }

    function openPrint(print) {
        if (!print || print.gi < 0) return;
        handleNav(`./portfolios/${GALLERIES[print.gi]}/index.html`, true, false, { img: print.name, print });
    }

    // ── Gallery fly-through ───────────────────────────────────────────────────
    // Returns { reveal, done } promises when a dive is under way, or null for a plain open.
    function diveInto(gallery, options = {}) {
        if (!o.built || !state.is3D || motionOff() || !camera || !controls || o.mode === 'gallery') return null;
        if (o.flight && o.mode === 'home') return null;
        const gi = GALLERIES.indexOf(gallery);
        const size = viewportSize(), aspect = size.width / size.height;
        const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
        let toPos, toTarget, duration, arc = false, print = null;
        if (cameraInspection && typeof screenMesh !== 'undefined' && screenMesh) {
            // Already at the camera's display: push on through the screen.
            camGroup.updateMatrixWorld(true);
            toTarget = screenMesh.getWorldPosition(new THREE.Vector3());
            const normal = new THREE.Vector3(0, 0, 1).transformDirection(screenMesh.matrixWorld);
            const scale = screenMesh.getWorldScale(v2);
            const w = screenMesh.geometry.parameters.width * scale.x * 0.8, h = screenMesh.geometry.parameters.height * scale.y * 0.8;
            toPos = toTarget.clone().addScaledVector(normal, Math.min(h / (2 * tan), w / (2 * tan * aspect)) * 0.8);
            duration = 620;
        } else {
            if (gi < 0) return null;
            print = options.print && !options.print.dead ? options.print : (o.mode === 'collection' && o.hero?.gi === gi ? o.hero : nearestPrint(gi));
            if (!print) return null;
            o.root.updateMatrixWorld(true);
            toTarget = print.group.getWorldPosition(new THREE.Vector3());
            const normal = new THREE.Vector3(0, 0, 1).transformDirection(print.group.matrixWorld);
            if (normal.dot(v2.copy(camera.position).sub(toTarget)) < 0) normal.negate();
            const scale = print.group.scale.x, w = print.w * scale, h = print.h * scale;
            toPos = toTarget.clone().addScaledVector(normal, Math.min(h / (2 * tan), w / (2 * tan * aspect)) * 0.86);
            const distance = camera.position.distanceTo(toPos);
            duration = THREE.MathUtils.clamp(620 + distance * 11, 820, 1500);
            arc = 'auto';
            print.noFade = true; print.brightTarget = 1; print.hoverTarget = 0;
            setHiRes(print, true);
        }
        o.galleryReturn = {
            pos: camera.position.clone(), target: controls.target.clone(), mode: o.mode,
            inspection: !!cameraInspection, enabled: controls.enabled, print, heldBefore: o.heldTravel
        };
        if (o.mode === 'collection') { o.parallax.x = o.parallax.y = 0; }
        o.mode = 'gallery'; o.hold = true;
        setHover(null);
        controls.enabled = false; holdTravel(true);
        let reveal, done;
        const revealed = new Promise((resolve) => { reveal = resolve; }), finished = new Promise((resolve) => { done = resolve; });
        fly({
            toPos, toTarget, duration, arc, easing: ease.inOut,
            targetEasing: ease.out,
            marks: [{ at: 0.58, run: reveal }],
            done
        });
        return { reveal: revealed, done: finished };
    }

    function nearestPrint(gi) {
        const forward = camera.getWorldDirection(v3);
        let best = null, bestScore = -Infinity;
        o.root.updateMatrixWorld(true);
        for (const print of prints(gi)) {
            if (print.place === 'eject' || print.appear < 0.9) continue;
            const to = print.group.getWorldPosition(v4).sub(camera.position), distance = to.length();
            const score = forward.dot(to.normalize()) * 60 - distance;
            if (score > bestScore) { best = print; bestScore = score; }
        }
        return best;
    }

    // Called as the gallery overlay closes. True when a pull-back flight has started.
    function returnFromGallery() {
        if (!o.built || o.mode !== 'gallery' || !o.galleryReturn) return false;
        const back = o.galleryReturn;
        o.galleryReturn = null; o.hold = false;
        o.mode = back.mode === 'collection' ? 'collection' : 'home';
        const settle = () => {
            if (back.print && !back.print.dead && back.print.place !== 'formation') { back.print.noFade = false; setHiRes(back.print, false); }
            if (o.mode === 'collection') return;       // still on the stage: travel stays held
            controls.enabled = back.enabled;
            holdTravel(false);
            if (!back.inspection) controls.update();
        };
        fly({ toPos: back.pos, toTarget: back.target, duration: back.inspection ? 520 : 950, arc: back.inspection ? false : 'auto', easing: ease.outQuint, done: settle });
        return true;
    }

    // ── Shutter choreography ──────────────────────────────────────────────────
    // A photograph that appears on the camera's display lifts off the screen and
    // travels out to its collection's arc; live space captures take a lane of their own.
    function photoShown(photo, kind) {
        if (!o.built || !o.active || !photo?.image || kind === 'preview') return;
        const gi = GALLERIES.indexOf(photo.gallery), capture = photo.gallery === 'space';
        if (gi < 0 && !capture) return;
        const existing = gi >= 0 && prints(gi).find((print) => print.name === photo.name);
        if (existing) { existing.pulse = performance.now(); return; }
        if (kind === 'history' || o.mode !== 'home' || o.ejecting >= 3 || state.dataSaver) return;
        o.ejecting++;
        // One beat later the display has redrawn, so the print can start exactly on the photo.
        setTimeout(() => {
            try { eject(photo, gi); } catch (_) { /* The photograph simply stays on the display. */ }
            finally { setTimeout(() => { o.ejecting = Math.max(0, o.ejecting - 1); }, 1900); }
        }, 90);
    }

    function eject(photo, gi) {
        if (!o.built || !o.active || !state.is3D || photo.image !== lastCameraPhoto?.image || typeof screenMesh === 'undefined' || !screenMesh) return;
        const m = o.metrics;
        let slot, replaced = null;
        if (gi >= 0) {
            const per = o.budget?.per ?? 4;
            const candidates = o.slots[gi].slice(0, per).filter((s) => !s.pending);
            slot = candidates.find((s) => !s.print) || candidates.filter((s) => s.print.place === 'belt').sort((a, b) => a.print.born - b.print.born)[0];
            if (!slot) return;
            replaced = slot.print;
        } else {
            const index = (o.captureCount = (o.captureCount || 0) + 1) % MAX_CAPTURES;
            slot = o.captures[index] || (o.captures[index] = { gi: -1, si: index, print: null, pending: false });
            slot.home = captureHome(index, m);
            replaced = slot.print;
        }
        const loaded = textureFrom(photo.image, o.budget?.long || 512);
        if (replaced) { slot.print = null; }
        const print = createPrint(slot, photo.name, loaded, slot.home.long);
        print.appear = 1; print.bright = 1; print.place = 'eject'; print.noFade = true;
        // Start pose: the photo's own rectangle on the display.
        camGroup.updateMatrixWorld(true); o.root.updateMatrixWorld(true);
        const layout = uiCtx?.cameraPhotoLayout, params = screenMesh.geometry.parameters;
        const imageAspect = photo.image.naturalWidth / photo.image.naturalHeight;
        const rect = layout?.photoRect || { x: 250, y: 375, w: 1000, h: 1000 / imageAspect * (params.width / params.height) };
        const local = new THREE.Vector3(((rect.x + rect.w / 2) / 1500 - 0.5) * params.width, (0.5 - (rect.y + rect.h / 2) / 1500) * params.height, 0.06);
        const startWorld = screenMesh.localToWorld(local);
        const worldScale = screenMesh.getWorldScale(v2).x;
        const startWidth = Math.min(rect.w / 1500 * params.width, rect.h / 1500 * params.height * imageAspect) * worldScale;
        const beltInverse = o.belt.getWorldQuaternion(new THREE.Quaternion()).invert();
        const startPos = o.belt.worldToLocal(startWorld.clone());
        const startQuat = beltInverse.clone().multiply(screenMesh.getWorldQuaternion(q2));
        const outward = new THREE.Vector3(0, 0, 1).transformDirection(screenMesh.matrixWorld);
        // Lift toward the visitor, rise over the camera, then fall away to the belt.
        const lift = o.belt.worldToLocal(startWorld.clone().addScaledVector(outward, 2.4).add(v3.set(0, 1.2, 0)));
        const crest = o.belt.worldToLocal(startWorld.clone().addScaledVector(outward, 5).add(v3.set(0, 15 * (m.portrait ? 1.3 : 1), 0)));
        const end = slot.home.pos;
        print.base.pos.copy(startPos); print.base.quat.copy(startQuat); print.base.scale = startWidth / print.w;
        print.group.position.copy(startPos); print.group.quaternion.copy(startQuat); print.group.scale.setScalar(print.base.scale);
        const path = (t, out) => {
            // Cubic Bézier through the lift and the crest.
            const u = 1 - t;
            return out.set(0, 0, 0).addScaledVector(startPos, u * u * u).addScaledVector(lift, 3 * u * u * t)
                .addScaledVector(crest, 3 * u * t * t).addScaledVector(end, t * t * t);
        };
        const arrived = () => { print.place = 'belt'; print.noFade = false; };
        tweenPrint(print, { pos: end, quat: slot.home.quat, scale: 1, done: arrived }, 1850, 0, ease.inOut, path);
        if (!print.tween) arrived();
        if (replaced) {
            // The print it replaces shrinks away as the new one comes in to land.
            replaced.slot = null; replaced.leaving = performance.now() + (motionOff() ? 0 : 1100);
            o.leaving = (o.leaving || []).concat(replaced);
        }
    }

    // ── Pointer and keyboard ──────────────────────────────────────────────────
    function interactive() {
        return o.built && state.is3D && state.hasExplored && !els.settingsOverlay.classList.contains('visible') &&
            !els.iframeOverlay.classList.contains('active') && o.mode !== 'gallery';
    }

    function setPointer(event) {
        const rect = renderer.domElement.getBoundingClientRect();
        ndc.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2);
        o.pointer.x = ndc.x; o.pointer.y = ndc.y;
    }

    function pick(checkBody) {
        raycaster.setFromCamera(ndc, camera);
        const targets = [];
        for (const print of prints()) if (print.appear > 0.6 && print.place !== 'eject') targets.push(print.photo);
        if (o.mode === 'home') for (const label of o.labels) targets.push(label.mesh);
        const hit = raycaster.intersectObjects(targets, false)[0];
        if (!hit) return null;
        if (checkBody && camGroup) {
            const body = raycaster.intersectObjects(camGroup.children, true)[0];
            if (body && body.distance < hit.distance) return null;
        }
        const print = hit.object.userData.print || null;
        return { print, gi: print ? print.gi : hit.object.userData.label };
    }

    function setHover(print, label = -1) {
        if (o.hovered !== print) {
            if (o.hovered) o.hovered.hoverTarget = 0;
            o.hovered = print;
            if (print) {
                print.hoverTarget = 1;
                o.halo.scale.set(print.w + BORDER * 2 + 0.34, print.h + BORDER * 2 + 0.34, THICK * 0.6);
                print.group.add(o.halo); o.halo.visible = true;
            }
        }
        o.hoverLabel = label;
    }

    function updateHover() {
        const pointer = o.pointer;
        if (!pointer.dirty) return;
        pointer.dirty = false;
        const canvas = renderer.domElement;
        if (!pointer.inside || pointer.touch || pointer.down || !interactive() || o.flight || cameraInspection ||
            (o.mode === 'home' && (cameraTravel || cameraPointerOverBody))) {
            if (o.hovered || o.hoverLabel >= 0) { setHover(null); if (!cameraPointerOverBody) canvas.style.cursor = ''; }
            return;
        }
        ndc.set(pointer.x, pointer.y);
        const hit = pick(false);
        setHover(hit?.print || null, hit && !hit.print ? hit.gi : -1);
        canvas.style.cursor = hit ? 'pointer' : '';
    }

    function onTap(event) {
        if (!interactive() || o.flight) return;
        setPointer(event);
        if (o.mode === 'collection') {
            const hit = pick(false);
            if (!hit?.print) leaveCollection();
            else if (hit.print.gi !== o.activeGi) enterCollection(hit.print.gi, hit.print);
            else if (hit.print === o.hero) openPrint(o.hero);
            else setHero(hit.print);
            return;
        }
        if (o.mode !== 'home' || cameraInspection || cameraTravel) return;
        const hit = pick(true);
        if (!hit) return;
        if (compact()) openPrint(hit.print || nearestPrint(hit.gi));
        else enterCollection(hit.gi, hit.print);
    }

    function attach() {
        const canvas = renderer.domElement;
        let press = null;
        canvas.addEventListener('pointerdown', (event) => {
            press = event.isPrimary && event.button === 0 ? { x: event.clientX, y: event.clientY, time: performance.now(), id: event.pointerId } : null;
            o.pointer.down = true;
        });
        canvas.addEventListener('pointermove', (event) => {
            o.pointer.touch = event.pointerType === 'touch';
            o.pointer.inside = true;
            setPointer(event);
            o.pointer.dirty = true;
        });
        canvas.addEventListener('pointerleave', () => { o.pointer.inside = false; o.pointer.dirty = true; });
        window.addEventListener('pointerup', (event) => {
            o.pointer.down = false; o.pointer.dirty = true;
            const tap = press;
            press = null;
            if (!tap || tap.id !== event.pointerId || event.target !== canvas) return;
            if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 8 || performance.now() - tap.time > 700) return;
            onTap(event);
        });
        window.addEventListener('pointercancel', () => { press = null; o.pointer.down = false; });
        // Capture phase: on the stage, arrows and Enter belong to the photographs, not the camera.
        window.addEventListener('keydown', (event) => {
            if (!interactive() || event.ctrlKey || event.metaKey || event.altKey) return;
            const target = event.target, tag = target?.tagName;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
            const onControl = tag === 'BUTTON' || tag === 'A';
            const digit = /^[1-5]$/.test(event.key) ? Number(event.key) - 1 : -1;
            let handled = true;
            if (o.mode === 'collection') {
                if (event.key === 'Escape') leaveCollection();
                else if (event.key === 'ArrowLeft') stepHero(-1);
                else if (event.key === 'ArrowRight') stepHero(1);
                else if ((event.key === 'Enter' || event.key === ' ') && !onControl) { if (!event.repeat && o.hero && !o.flight) openPrint(o.hero); }
                else if (digit >= 0 && !onControl) enterCollection(digit);
                else handled = false;
            } else if (digit >= 0 && !onControl && !cameraInspection && (target === canvas || target === document.body)) {
                handled = enterCollection(digit);
            } else handled = false;
            if (handled) { event.preventDefault(); event.stopPropagation(); }
        }, true);
        let resizeTimer = 0;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (!o.built) return;
                const before = o.metrics.portrait;
                const next = metrics();
                if (next.portrait !== before) applyLayout(false);
                if (compact() && o.mode === 'collection') { leaveCollection(); }
                else if (o.mode === 'collection') layoutFormation(500);
                syncBudget();
            }, 180);
        });
        window.addEventListener('siteperformancechange', syncBudget);
    }

    function syncBudget() {
        if (!o.built || !o.active) return;
        const next = budget(), key = `${next.per}/${next.long}`;
        if (key === o.budgetKey) return;
        o.budgetKey = key;
        fill().catch(() => { });
    }

    // ── Collections rail (DOM): the keyboard and screen-reader route to everything above ──
    function buildRail() {
        rail = document.createElement('nav');
        rail.id = 'orbit-rail';
        rail.className = 'orbit-rail';
        rail.setAttribute('aria-label', 'Pictures In Orbit');
        rail.innerHTML = `
            <ul class="orbit-rail-list">${GALLERIES.map((gallery, gi) => `
                <li><button type="button" class="orbit-rail-item" data-gallery="${gi}" aria-pressed="false">
                    <span class="orbit-rail-name">${TITLES[gallery]}</span><span class="orbit-rail-count" aria-hidden="true"></span>
                </button></li>`).join('')}
            </ul>
            <section class="orbit-detail" aria-label="Chosen collection" hidden>
                <h2 class="orbit-detail-title"></h2>
                <p class="orbit-detail-frame"></p>
                <p class="orbit-detail-exif"></p>
                <button type="button" class="orbit-button orbit-button-primary" data-act="open">Open Gallery</button>
                <div class="orbit-detail-actions">
                    <button type="button" class="orbit-button orbit-button-step" data-act="prev" aria-label="Previous Photo"><i class="fas fa-chevron-left" aria-hidden="true"></i></button>
                    <button type="button" class="orbit-button orbit-button-step" data-act="next" aria-label="Next Photo"><i class="fas fa-chevron-right" aria-hidden="true"></i></button>
                    <button type="button" class="orbit-button orbit-button-quiet" data-act="back">Back To Camera</button>
                </div>
            </section>
            <p class="orbit-status" role="status"></p>`;
        document.body.appendChild(rail);
        rail.addEventListener('click', (event) => {
            const item = event.target.closest('.orbit-rail-item');
            if (item) { enterCollection(Number(item.dataset.gallery)); return; }
            const act = event.target.closest('[data-act]')?.dataset.act;
            if (act === 'open') { if (o.hero) openPrint(o.hero); else if (o.activeGi >= 0) handleNav(`./portfolios/${GALLERIES[o.activeGi]}/index.html`, true); }
            else if (act === 'prev') stepHero(-1);
            else if (act === 'next') stepHero(1);
            else if (act === 'back') leaveCollection();
        });
        const lift = (event) => {
            const item = event.target.closest?.('.orbit-rail-item');
            o.highlight = item && o.mode === 'home' && event.type !== 'pointerout' && event.type !== 'focusout' ? Number(item.dataset.gallery) : -1;
        };
        for (const type of ['pointerover', 'pointerout', 'focusin', 'focusout']) rail.addEventListener(type, lift);
        // The rail floats over the scene: scrolling on it still zooms the scene underneath.
        rail.addEventListener('wheel', (event) => {
            if (o.mode === 'home') renderer.domElement.dispatchEvent(new WheelEvent('wheel', event));
        }, { passive: true });
        syncRail();
    }

    function caption(print) {
        const data = cameraPhotoMetadata.get(GALLERIES[print.gi])?.[print.name] || {};
        const number = (value) => {
            const parts = String(value ?? '').split('/').map(Number);
            const result = parts.length === 2 ? parts[0] / parts[1] : parts[0];
            return Number.isFinite(result) && result > 0 ? Math.round(result * 100) / 100 : null;
        };
        const rawExposure = String(data['EXIF ExposureTime'] ?? ''), fraction = rawExposure.split('/').map(Number);
        const seconds = fraction.length === 2 ? fraction[0] / fraction[1] : fraction[0];
        // Fast shutter speeds stay as the fraction photographers read (1/250 s).
        const exposure = Number.isFinite(seconds) && seconds > 0 ? `${seconds >= 1 ? Math.round(seconds * 10) / 10 : rawExposure} s` : '';
        const aperture = number(data['EXIF FNumber']), focal = number(data['EXIF FocalLength']);
        return [exposure && aperture ? `${exposure} at f/${aperture}` : exposure || (aperture && `f/${aperture}`),
            data['EXIF ISOSpeedRatings'] && `ISO ${data['EXIF ISOSpeedRatings']}`, focal && `${focal} mm`].filter(Boolean).join(', ');
    }

    function syncRail() {
        if (!rail) return;
        rail.querySelectorAll('.orbit-rail-item').forEach((item) => {
            const gi = Number(item.dataset.gallery);
            item.setAttribute('aria-pressed', String(o.mode !== 'home' && gi === o.activeGi));
            item.querySelector('.orbit-rail-count').textContent = o.counts[gi] || '';
            item.setAttribute('aria-label', `${TITLES[GALLERIES[gi]]}${o.counts[gi] ? `, ${o.counts[gi]} ${o.counts[gi] === 1 ? 'Picture' : 'Pictures'}` : ''}`);
        });
        const detail = rail.querySelector('.orbit-detail');
        const open = o.activeGi >= 0 && (o.mode === 'collection' || o.mode === 'gallery');
        detail.hidden = !open;
        if (!open) return;
        const list = formationOrder();
        detail.querySelector('.orbit-detail-title').textContent = TITLES[GALLERIES[o.activeGi]];
        detail.querySelector('.orbit-detail-frame').textContent = o.hero && list.length
            ? `Picture ${list.indexOf(o.hero) + 1} of ${list.length} in orbit, ${o.counts[o.activeGi] || list.length} in the gallery`
            : 'Pictures are on their way';
        detail.querySelector('.orbit-detail-exif').textContent = o.hero ? caption(o.hero) : '';
        detail.querySelectorAll('.orbit-button-step').forEach((button) => { button.disabled = list.length < 2; });
    }

    function announce(message) {
        const status = rail?.querySelector('.orbit-status');
        if (status) status.textContent = message;
    }

    // ── Per-frame update ──────────────────────────────────────────────────────
    function updatePrint(print, now, dt, decorative, camPos, beltInverse) {
        const tween = print.tween;
        if (tween && now >= tween.t0) {
            const raw = clamp01((now - tween.t0) / tween.duration), t = tween.easing(raw);
            if (tween.path) tween.path(t, print.base.pos); else print.base.pos.lerpVectors(tween.fromPos, tween.toPos, t);
            // Prints hold the display's orientation while they lift, then turn in flight.
            const turn = tween.path ? smooth(0.18, 0.95, raw) : t;
            print.base.quat.copy(tween.fromQuat).slerp(tween.toQuat, turn);
            print.base.scale = tween.fromScale + (tween.toScale - tween.fromScale) * (tween.path ? smooth(0.05, 1, raw) : t);
            if (raw >= 1) { print.tween = null; tween.done?.(); }
        }
        const rate = 1 - Math.exp(-dt * 9);
        print.hover += (print.hoverTarget - print.hover) * (motionOff() ? 1 : rate);
        if (print.appear < 1) print.appear = Math.min(1, print.appear + dt / 0.9);
        const group = print.group;
        group.position.copy(print.base.pos);
        group.quaternion.copy(print.base.quat);
        const resting = print.place === 'belt' && !print.tween;
        if (decorative && state.rendering.starMotion && resting) {
            // A slow individual float keeps the belt from reading as one rigid ring.
            const t = now * 0.001;
            group.position.y += Math.sin(t * 0.42 + print.phase) * 0.32;
            q1.setFromAxisAngle(v3.set(0, 1, 0), Math.sin(t * 0.3 + print.phase * 1.7) * 0.035);
            group.quaternion.multiply(q1);
        }
        print.world.copy(group.position).applyMatrix4(o.belt.matrixWorld);
        let scale = print.base.scale * (0.86 + 0.14 * ease.out(print.appear));
        if (print.hover > 0.002) {
            if (print.place === 'belt') {
                // Turn to face the visitor while they look at it.
                m1.lookAt(camPos, print.world, camera.up);
                q1.setFromRotationMatrix(m1); q2.copy(beltInverse).multiply(q1);
                group.quaternion.slerp(q2, 0.8 * print.hover);
                scale *= 1 + 0.12 * print.hover;
            } else if (print.place === 'formation') {
                scale *= 1 + 0.04 * print.hover;
            }
        }
        if (print.pulse) {
            const age = (now - print.pulse) / 700;
            if (age >= 1) print.pulse = 0; else scale *= 1 + Math.sin(age * Math.PI) * 0.1;
        }
        if (print.leaving) scale *= 1 - ease.inQuad(clamp01((now - print.leaving) / 450));
        group.scale.setScalar(Math.max(scale, 0.0001));
        // Brightness: developing in, dimmed behind a chosen collection, lifted by rail focus.
        let target = print.brightTarget;
        if (o.mode === 'home' && o.highlight >= 0) target = print.gi === o.highlight ? 1 : 0.22;
        print.bright += (target - print.bright) * (motionOff() ? 1 : 1 - Math.exp(-dt * 6));
        let brightness = print.bright * print.appear * print.appear;
        if (print.pulse) brightness += 0.3 * Math.sin(clamp01((now - print.pulse) / 700) * Math.PI);
        print.material.color.setScalar(brightness);
        // Fade out rather than clip when the visitor's flight passes through a print.
        print.material.opacity = print.noFade ? 1 : smooth(3.5, 10, print.world.distanceTo(camPos));
        group.visible = !print.surplus && print.material.opacity > 0.01;
    }

    function watch() {
        // The camera's own controls took over (for example V for the viewfinder) while a
        // collection was on stage: stand down and let that view return to the camera home.
        if (o.mode === 'collection' && cameraInspection) {
            prints(o.activeGi).forEach((print) => sendHome(print, 600, 0));
            for (const print of prints()) print.brightTarget = 1;
            if (cameraReturnPose && o.returnPose) { cameraReturnPose.position.copy(o.returnPose.pos); cameraReturnPose.target.copy(o.returnPose.target); }
            o.mode = 'home'; o.activeGi = -1; o.hero = null; o.returnPose = null; o.flight = null; o.spinTween = null; o.heldTravel = false;
            document.body.classList.remove('orbit-collection');
            syncRail();
        }
        const live = state.is3D && state.hasExplored;
        if (live !== o.live) { o.live = live; document.body.classList.toggle('orbit-live', live); }
    }

    /** Advance the print system one frame. Returns true while it is steering the visitor's camera. */
    function update(now, decorative) {
        if (!o.built) return false;
        const dt = Math.min((now - (o.last || now)) / 1000, 0.05);
        o.last = now;
        watch();
        o.frame = (o.frame || 0) + 1;
        if (o.frame % 90 === 0) syncBudget();
        // Prints move under a resting pointer, so refresh the hover now and then.
        if (o.frame % 12 === 0 && o.pointer.inside) o.pointer.dirty = true;
        // Belt rotation: a deliberate turn to the stage, otherwise a slow drift.
        if (o.spinTween) {
            const raw = clamp01((now - o.spinTween.t0) / o.spinTween.duration);
            o.spin = o.spinTween.from + (o.spinTween.to - o.spinTween.from) * ease.inOutQuint(raw);
            if (raw >= 1) o.spinTween = null;
        } else if (decorative && state.rendering.starMotion && o.mode === 'home' && !o.hold && !o.flight) {
            o.spin += dt * DRIFT;
        }
        o.belt.rotation.y = o.spin;
        o.root.rotation.x += (o.tilt.x - o.root.rotation.x) * Math.min(1, dt * 3);
        o.root.rotation.z += (o.tilt.z - o.root.rotation.z) * Math.min(1, dt * 3);
        o.root.updateMatrixWorld(true);

        updateFlight(now);
        let owns = !!o.flight || o.mode === 'gallery';
        if (o.mode === 'collection' && !o.flight) {
            // On the stage the view leans gently with the pointer, so the prints part in depth.
            const s = stage(), k = motionOff() ? 0 : 1 - Math.exp(-dt * 4);
            o.parallax.x += ((o.pointer.inside ? o.pointer.x : 0) - o.parallax.x) * k;
            o.parallax.y += ((o.pointer.inside ? o.pointer.y : 0) - o.parallax.y) * k;
            camera.position.copy(s.eye).addScaledVector(s.right, o.parallax.x * 1.5).addScaledVector(s.up, o.parallax.y * 0.9);
            controls.target.copy(s.focus);
            camera.lookAt(s.focus);
            owns = true;
        }

        updateHover();
        const camPos = camera.position;
        const beltInverse = o.belt.getWorldQuaternion(q2).invert().clone();
        for (const group of o.slots) for (const slot of group) if (slot.print) updatePrint(slot.print, now, dt, decorative, camPos, beltInverse);
        for (const slot of o.captures) if (slot?.print) updatePrint(slot.print, now, dt, decorative, camPos, beltInverse);
        if (o.leaving?.length) {
            o.leaving = o.leaving.filter((print) => {
                updatePrint(print, now, dt, decorative, camPos, beltInverse);
                if (now - print.leaving < 460) return true;
                disposePrint(print);
                return false;
            });
        }

        // Halo, labels and orbit lines follow the current state.
        const haloTarget = o.hovered ? 0.85 * o.hovered.hover : 0;
        o.haloMat.opacity = haloTarget;
        if (!o.hovered && o.halo.visible) { o.halo.visible = false; o.halo.parent?.remove(o.halo); }
        const calm = o.mode === 'home' ? 1 : 0;
        const k = motionOff() ? 1 : 1 - Math.exp(-dt * 5);
        o.labelOpacity += (calm - o.labelOpacity) * k;
        o.lineOpacity += ((o.mode === 'home' ? 0.1 : 0.035) - o.lineOpacity) * k;
        o.lineMat.opacity = o.lineOpacity;
        for (const label of o.labels) {
            const lit = o.hoverLabel === label.gi || o.highlight === label.gi || o.hovered?.gi === label.gi;
            label.glow += ((lit ? 1 : 0) - label.glow) * k;
            const dimmed = o.highlight >= 0 && o.highlight !== label.gi ? 0.35 : 1;
            label.material.opacity = o.labelOpacity * (0.62 + 0.38 * label.glow) * dimmed *
                smooth(4, 12, v3.copy(label.mesh.position).applyMatrix4(o.belt.matrixWorld).distanceTo(camPos));
            label.mesh.visible = label.material.opacity > 0.01;
        }
        return owns;
    }

    return {
        init, activate, deactivate, reset, update, arrive,
        enterCollection, leaveCollection, diveInto, returnFromGallery,
        photoShown,
        get mode() { return o.mode; },
        get state() { return o; }
    };
}());
