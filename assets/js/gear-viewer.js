const section = document.getElementById('my-gear');
const viewer = document.getElementById('gear-viewer');
const stage = document.getElementById('gear-preview');
const select = document.getElementById('gear-product');
const link = document.getElementById('gear-product-link');
const list = section.querySelector('.gear-bag-body');
const products = [...list.querySelectorAll('[data-gear]')];

// Lens dimensions are in centimeters. Ring positions and trim distinguish the
// barrel profiles while keeping all lens assemblies on the same scale.
const lenses = {
    'sony-28': [7.25, 8.3, [0.30, 0.72], 0.89],
    'sony-50': [6.86, 5.95, [0.56], 0.83],
    tamron: [7.7, 14.8, [0.27, 0.72], 1],
    samyang: [7.0, 5.92, [0.55], 1.04],
    'canon-70': [8.0, 14.55, [0.30, 0.73], 0.96],
    'canon-18': [6.85, 7.0, [0.35, 0.83], 0.86],
};

function loadThree() {
    if (window.THREE) return Promise.resolve(window.THREE);
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
        script.onload = () => resolve(window.THREE);
        script.onerror = reject;
        document.head.append(script);
    });
}

function gearModels(THREE) {
    const material = (color, roughness = .43, metalness = .15) =>
        new THREE.MeshStandardMaterial({ color, roughness, metalness });
    const black = material(0x242a33);
    const grip = material(0x10151c, .83, 0);
    const edge = material(0x636e80, .29, .62);
    const glass = material(0x152e47, .12, .64);
    const red = material(0x9f312b);
    const screen = material(0x142536, .18, .36);

    function mesh(group, geometry, surface, x = 0, y = 0, z = 0) {
        const part = new THREE.Mesh(geometry, surface);
        part.position.set(x, y, z);
        group.add(part);
        return part;
    }

    function box(group, width, height, depth, radius, surface, x = 0, y = 0, z = 0) {
        const a = width / 2 - radius, b = height / 2 - radius;
        const shape = new THREE.Shape();
        shape.moveTo(-a, -height / 2);
        shape.lineTo(a, -height / 2);
        shape.quadraticCurveTo(width / 2, -height / 2, width / 2, -b);
        shape.lineTo(width / 2, b);
        shape.quadraticCurveTo(width / 2, height / 2, a, height / 2);
        shape.lineTo(-a, height / 2);
        shape.quadraticCurveTo(-width / 2, height / 2, -width / 2, b);
        shape.lineTo(-width / 2, -b);
        shape.quadraticCurveTo(-width / 2, -height / 2, -a, -height / 2);
        const bevel = Math.min(radius / 3, depth / 8);
        const geometry = new THREE.ExtrudeGeometry(shape, { depth: depth - 2 * bevel, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 8 });
        geometry.translate(0, 0, -depth / 2 + bevel);
        return mesh(group, geometry, surface, x, y, z);
    }

    function cylinder(group, front, back, depth, surface, x, y, z) {
        const part = mesh(group, new THREE.CylinderGeometry(front, back, depth, 48), surface, x, y, z);
        part.rotation.x = Math.PI / 2;
        return part;
    }

    function lens(group, [diameter, length, rings, front], z = 0) {
        const radius = diameter / 2;
        cylinder(group, radius * front, radius * .78, length, black, 0, 0, z + length / 2);
        cylinder(group, radius * .8, radius * .79, .24, edge, 0, 0, z + .12);
        for (const position of rings) {
            const ringRadius = radius * (.78 + (front - .78) * position) + .09;
            const depth = length * .19;
            const ringZ = z + position * length;
            cylinder(group, ringRadius, ringRadius, depth, grip, 0, 0, ringZ);
            for (let i = 0; i < 48; i++) {
                const angle = 2 * Math.PI * i / 48;
                const rib = mesh(group, new THREE.BoxGeometry(.065, .06, depth * .91), black,
                    Math.cos(angle) * ringRadius, Math.sin(angle) * ringRadius, ringZ);
                rib.rotation.z = angle;
            }
        }
        cylinder(group, radius * front, radius * front, .22, grip, 0, 0, z + length + .11);
        cylinder(group, radius * front * .73, radius * front * .73, .05, glass, 0, 0, z + length + .23);
        const rim = new THREE.TorusGeometry(radius * front * .8, .06, 8, 48);
        mesh(group, rim, edge, 0, 0, z + length + .24);
    }

    function cameraBody(group, sony) {
        box(group, sony ? 12.9 : 13.0, sony ? 7.7 : 8.2, sony ? 4.1 : 4.8, .62, black);
        box(group, 3.2, 6.9, 3.0, .9, grip, -4.65, -.1, 2.35);
        const housing = box(group, sony ? 3.55 : 4.4, sony ? 1.8 : 2.35, 3.35, sony ? .28 : .65, black, .1, 4.1, -.1);
        if (!sony) housing.rotation.x = -.12;
        box(group, 1.75, .15, 1.65, .12, edge, .1, sony ? 5.04 : 5.32, -.25);
        box(group, 6.6, 4.45, .25, .3, screen, .25, -.25, sony ? -2.21 : -2.53);
        box(group, 1.45, .72, .2, .15, glass, .1, 4.02, -1.88);
        for (const x of [-4.1, 3.3]) {
            const dial = cylinder(group, .82, .82, .29, edge, x, 3.95, -.7);
            dial.rotation.set(0, 0, 0);
        }
        if (!sony) box(group, .18, 2.9, .23, .09, red, -5.8, .55, 3.9);
        cylinder(group, 3.04, 3.04, .24, sony ? red : edge, .55, 0, sony ? 2.25 : 2.57);
        const mounted = new THREE.Group();
        mounted.position.x = .55;
        group.add(mounted);
        lens(mounted, lenses[sony ? 'sony-28' : 'canon-18'], sony ? 2.4 : 2.7);
    }

    function phone(group, samsung) {
        const width = samsung ? 7.9 : 7.2, height = samsung ? 16.23 : 15.28;
        const radius = samsung ? .24 : .77;
        const finish = material(samsung ? 0x858483 : 0x9e9b92, .36, .38);
        box(group, width, height, .86, radius, edge);
        box(group, width - .13, height - .13, .11, radius, finish, 0, 0, .46);
        box(group, width - .17, height - .17, .08, radius, screen, 0, 0, -.451);
        if (samsung) {
            for (const [x, y, r] of [[-2.44, 5.65, .86], [-2.44, 3.45, .86], [-2.44, 1.27, .86], [-.46, 5.12, .5], [-.46, 3.33, .5]]) {
                cylinder(group, r, r, .25, edge, x, y, .67);
                cylinder(group, r * .78, r * .78, .08, glass, x, y, .82);
            }
        } else {
            box(group, 6.32, 2.12, .47, 1.0, finish, 0, 5.1, .68);
            box(group, 4.55, 1.55, .14, .73, grip, -.42, 5.1, .96);
            for (const x of [-1.8, -.43, .92]) cylinder(group, .49, .49, .10, glass, x, 5.1, 1.055);
            cylinder(group, .23, .23, .08, edge, 2.21, 5.1, .92);
        }
        box(group, .11, 1.20, .29, .05, edge, width / 2, 2.06, 0);
    }

    return (id) => {
        const group = new THREE.Group();
        if (lenses[id]) lens(group, lenses[id]);
        else if (id === 'sony-a7' || id === 'canon-t5') cameraBody(group, id === 'sony-a7');
        else phone(group, id === 'samsung');
        return group;
    };
}

async function start() {
    const THREE = await loadThree();
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.domElement.setAttribute('aria-hidden', 'true');
    stage.append(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, .1, 100);
    camera.position.z = 8;
    scene.add(new THREE.HemisphereLight(0xcdeaff, 0x55647a, 1.6));
    for (const [color, intensity, x, y, z] of [
        [0xffffff, 2.4, -4, 5, 6],
        [0x49cfff, 2.7, 4, 1, -5],
        [0xb6abff, .9, 2, -2, 5],
    ]) {
        const light = new THREE.DirectionalLight(color, intensity);
        light.position.set(x, y, z);
        scene.add(light);
    }

    const pivot = new THREE.Group();
    scene.add(pivot);
    const build = gearModels(THREE);
    let model;
    let yaw, pitch;

    function draw() {
        if (!model || !stage.clientWidth || !stage.clientHeight) return;
        pivot.rotation.set(pitch, yaw, 0);
        renderer.render(scene, camera);
    }

    function showProduct() {
        const product = products[select.selectedIndex];
        if (model) {
            pivot.remove(model);
            model.traverse(part => part.geometry?.dispose());
        }
        model = build(product.dataset.gear);
        const bounds = new THREE.Box3().setFromObject(model);
        const sphere = bounds.getBoundingSphere(new THREE.Sphere());
        const size = 1.85 / sphere.radius;
        model.scale.setScalar(size);
        model.position.copy(sphere.center).multiplyScalar(-size);
        pivot.add(model);
        yaw = -0.56; pitch = .20;
        link.href = product.href;
        stage.setAttribute('aria-label', `${select.selectedOptions[0].textContent} 3D render. Use arrow keys to rotate.`);
        draw();
    }

    for (const [index, product] of products.entries()) {
        select.add(new Option(product.textContent.trim().replace(/\s+/g, ' '), String(index)));
    }
    select.addEventListener('change', showProduct);

    let drag;
    stage.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
        stage.setPointerCapture(event.pointerId);
    });
    stage.addEventListener('pointermove', event => {
        if (drag?.id !== event.pointerId) return;
        yaw += (event.clientX - drag.x) * .012;
        pitch = THREE.MathUtils.clamp(pitch + (event.clientY - drag.y) * .012, -1.4, 1.4);
        drag.x = event.clientX; drag.y = event.clientY;
        draw();
    });
    stage.addEventListener('lostpointercapture', () => { drag = null; });
    stage.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        yaw += event.key === 'ArrowLeft' ? -.18 : event.key === 'ArrowRight' ? .18 : 0;
        pitch = THREE.MathUtils.clamp(pitch + (event.key === 'ArrowUp' ? -.18 : event.key === 'ArrowDown' ? .18 : 0), -1.4, 1.4);
        draw();
    });

    viewer.hidden = false;
    list.hidden = true;
    new ResizeObserver(() => {
        if (!stage.clientWidth || !stage.clientHeight) return;
        camera.aspect = stage.clientWidth / stage.clientHeight;
        camera.position.z = Math.max(7, 7 / camera.aspect);
        camera.updateProjectionMatrix();
        renderer.setSize(stage.clientWidth, stage.clientHeight, false);
        draw();
    }).observe(stage);
    showProduct();
}

const observer = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    observer.disconnect();
    start().catch(() => { viewer.hidden = true; list.hidden = false; });
}, { rootMargin: '140px' });
observer.observe(section);
