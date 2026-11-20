const section = document.getElementById('my-gear');
const viewer = document.getElementById('gear-viewer');
const stage = document.getElementById('gear-preview');
const select = document.getElementById('gear-product');
const link = document.getElementById('gear-product-link');
const list = section.querySelector('.gear-bag-body');
const products = [...list.querySelectorAll('[data-gear]')];

// Barrel stations run from mount to filter thread, in centimeters. Each station
// gives its end height, radius, and finish or inscription around the barrel.
const lenses = {
    'sony-28': { face: 'SONY   FE 3.5–5.6/28–70 OSS', filter: 55, stations: [
        [.6, 3.02], [1.2, 3.38], [2.1, 3.43, 'SONY'], [4.6, 3.62, 'rubber'],
        [5.35, 3.52, '28   35   50   70'], [6.95, 3.51, 'fine'], [8.3, 3.22]] },
    'sony-50': { face: 'SONY   FE 1.8/50', filter: 49, stations: [
        [.5, 2.95], [1.05, 3.30], [2.65, 3.43, 'FE 1.8/50'], [4.85, 3.41, 'fine'],
        [5.55, 3.33, 'SONY'], [5.95, 3.15]] },
    tamron: { face: 'TAMRON   70–300mm F/4.5–6.3 Di III RXD', filter: 67, stations: [
        [.32, 3.03, 'silver'], [1.5, 3.05], [3.25, 3.23, 'TAMRON'], [4.36, 3.34, 'fine'],
        [5.72, 3.55], [6.95, 3.70, '70   100   135   200   300'], [12.98, 3.85, 'rubber'],
        [14.8, 3.82]] },
    samyang: { face: 'SAMYANG   12mm 1:2.0 NCS CS', filter: 67, stations: [
        [.55, 2.97], [1.28, 3.04, '22  16  11  8  5.6  4  2.8  2'], [1.82, 3.19],
        [2.58, 3.34, '∞   2   1   0.7   0.5   0.3'], [4.49, 3.48, 'rubber'],
        [4.65, 3.51, 'red'], [5.48, 3.63, 'SAMYANG'], [5.92, 3.63]] },
    'canon-70': { face: 'CANON ZOOM LENS EF 70–300mm 1:4–5.6 IS USM', filter: 58, switches: true, stations: [
        [.88, 3.30], [2.1, 3.64, 'Canon'], [4.35, 3.79], [5.35, 3.81, '70   100   135   200   300'],
        [9.25, 3.83, 'rubber'], [10.35, 3.76, 'ULTRASONIC'], [10.49, 3.78, 'gold'],
        [12.56, 3.68, 'fine'], [14.28, 3.44]] },
    'canon-18': { face: 'CANON ZOOM LENS EF-S 18–55mm 1:3.5–5.6 IS II', filter: 58, switches: true, stations: [
        [.58, 3.08], [1.72, 3.39, 'Canon'], [2.38, 3.4, '18   24   35   55'],
        [4.74, 3.43, 'rubber'], [5.55, 3.29, 'IMAGE STABILIZER'], [6.35, 3.15],
        [7.0, 3.19, 'fine']] },
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
        new THREE.MeshStandardMaterial({ color: new THREE.Color(color).convertSRGBToLinear(), roughness, metalness });
    const black = material(0x232427);
    const grip = material(0x242323, .83, 0);
    // Fine stippling breaks up the highlights on the molded handgrips.
    const grain = new Uint8Array(128 * 128);
    let seed = 17;
    for (let i = 0; i < grain.length; i++) {
        seed = (1664525 * seed + 1013904223) >>> 0;
        grain[i] = seed >>> 24;
    }
    grip.bumpMap = new THREE.DataTexture(grain, 128, 128, THREE.LuminanceFormat);
    grip.bumpMap.wrapS = grip.bumpMap.wrapT = THREE.RepeatWrapping;
    grip.bumpMap.needsUpdate = true;
    grip.bumpScale = .0013;
    const edge = material(0x909398, .29, .62);
    const glass = material(0x152e47, .12, .64);
    const red = material(0xa92928);
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

    function artwork(width, height, paint, transparent = false) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        paint(canvas.getContext('2d'), width, height);
        const map = new THREE.CanvasTexture(canvas);
        map.encoding = THREE.sRGBEncoding;
        map.anisotropy = 4;
        return new THREE.MeshStandardMaterial({ map, transparent, roughness: .58,
            polygonOffset: true, polygonOffsetFactor: -1 });
    }

    function lettering(ctx, value, x, y, font, color = '#ecebe7') {
        ctx.fillStyle = color;
        ctx.font = font;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(value, x, y);
    }

    function badge(group, value, w, h, x, y, z, font = 'bold 66px Arial', color) {
        const ink = artwork(512, 96, (ctx) => {
            ctx.font = font;
            ctx.translate(256, 48);
            ctx.scale(480 / Math.max(ctx.measureText(value).width, 1), 1);
            lettering(ctx, value, 0, 0, font, color);
        }, true);
        return mesh(group, new THREE.PlaneGeometry(w, h), ink, x, y, z);
    }

    function barrelFinish(style) {
        if (!style) return black;
        if (style === 'red') return red;
        if (style === 'silver') return edge;
        if (style === 'gold') return material(0xac955e);
        return artwork(2048, 128, (ctx, w, h) => {
            ctx.fillStyle = '#232428';
            ctx.fillRect(0, 0, w, h);
            if (style === 'rubber' || style === 'fine') {
                const step = style === 'fine' ? 10 : 20;
                const rib = ctx.createLinearGradient(0, 0, step, 0);
                for (const [stop, color] of [[0,'#151517'], [.24,'#39393a'], [.5,'#303032'], [1,'#111113']])
                    rib.addColorStop(stop, color);
                ctx.fillStyle = rib;
                for (let x = 0; x < w; x += step) {
                    ctx.fillRect(0, 5, step, h - 10);
                    ctx.translate(step, 0);
                }
            } else {
                for (const x of [w / 4, w * .75])
                    lettering(ctx, style, x, h / 2, '48px Arial');
            }
        });
    }

    // The diaphragm, coating reflections and filter-ring engraving share one
    // circular atlas; the stepped bezel and retaining threads cast real edges.
    function opticalFace(group, radius, name, filter, y) {
        const atlas = artwork(768, 768, (ctx, w) => {
            const r = w / 2;
            ctx.translate(r, r);
            ctx.fillStyle = '#161718';
            ctx.fillRect(-r, -r, w, w);
            const aperture = r * .73;
            const coating = ctx.createRadialGradient(-r*.22, -r*.28, 1, 0, 0, aperture);
            for (const [t,c] of [[0,'#665284'],[.22,'#374c5c'],[.52,'#14252d'],[.78,'#263330'],[1,'#080e13']])
                coating.addColorStop(t,c);
            ctx.fillStyle = coating;
            ctx.beginPath(); ctx.arc(0,0,aperture,0,2*Math.PI); ctx.fill();
            ctx.fillStyle = '#080d13';
            ctx.beginPath();
            for (let i=0; i<8; i++) {
                const a=i*2*Math.PI/7;
                ctx.lineTo(.31*r*Math.cos(a), .31*r*Math.sin(a));
            }
            ctx.fill();
            for (const [x,z,rx,ry] of [[-.27,-.39,.18,.05],[.32,.34,.09,.026]]) {
                ctx.fillStyle='rgba(189,217,225,.34)';
                ctx.beginPath(); ctx.ellipse(x*r,z*r,rx*r,ry*r,-.4,0,2*Math.PI); ctx.fill();
            }
            const imprint = (value, middle) => {
                [...value].forEach((letter,i) => {
                    ctx.save(); ctx.rotate(middle + (i-(value.length-1)/2)*.062);
                    lettering(ctx,letter,0,-r*.865,'bold 26px Arial'); ctx.restore();
                });
            };
            imprint(name,0); imprint('Ø'+filter+'mm',Math.PI);
        });
        const face = mesh(group,new THREE.CircleGeometry(radius,96),atlas,0,y,0);
        face.rotation.x = -Math.PI/2;
    }

    function lens(group, spec) {
        let bottom = .18, previous = 2.92;
        const band = (start, end, low, high, surface) =>
            mesh(group, new THREE.CylinderGeometry(high, low, end-start, 96, 1, false, -Math.PI/2),
                surface, 0, (start+end)/2, 0);
        band(0,bottom,2.91,previous,edge);
        for (const [top, radius, style] of spec.stations) {
            const transition = Math.min(.22,(top-bottom)/3);
            band(bottom,bottom+transition,previous,radius,black);
            band(bottom+transition,top,radius,radius,barrelFinish(style));
            previous = radius;
            bottom = top;
        }
        opticalFace(group, previous*.97, spec.face, spec.filter, bottom+.012);
        for (const fraction of [.975,.997]) {
            const lip = mesh(group,new THREE.TorusGeometry(previous*fraction,.026,6,96),black,0,bottom+.035,0);
            lip.rotation.x = Math.PI/2;
        }
        if (spec.switches) {
            const panel = new THREE.Group();
            panel.rotation.y = -.78;
            group.add(panel);
            for (const [i, label] of ['AF  MF','STABILIZER'].entries()) {
                const h = spec === lenses['canon-18'] ? .85 : 2.8;
                const r = spec === lenses['canon-18'] ? 3.39 : 3.78;
                box(panel,.78,.26,.12,.05,grip,0,h+i*.52,r);
                badge(panel,label,1.02,.19,0,h+.22+i*.52,r+.08);
            }
        }
        band(-.16,0,2.26,2.26,grip);
        band(-.19,-.16,1.49,1.62,glass);
        const brass = material(0xbe9956,.30,.55);
        for (let i=0; i<8; i++) {
            const angle=.37+i*.115;
            const pin=box(group,.15,.045,.27,.012,brass,
                2.52*Math.sin(angle),-.016,2.52*Math.cos(angle));
            pin.rotation.y=angle;
        }
        for (let i=0; i<3; i++) {
            const flange = mesh(group,new THREE.RingGeometry(2.65,2.97,30,1,i*2*Math.PI/3,.92),
                edge,0,-.055,0);
            flange.rotation.x=Math.PI/2;
        }
    }

    function prism(group, points, depth, z) {
        const shape = new THREE.Shape(points.map(([x,y]) => new THREE.Vector2(x,y)));
        const geometry = new THREE.ExtrudeGeometry(shape,{depth,bevelSize:.13,
            bevelThickness:.14,bevelSegments:3,steps:1});
        return mesh(group,geometry,black,0,0,z);
    }

    function cameraBody(group, sony) {
        const front = sony ? 1.94 : 2.25;
        box(group,12.8,sony ? 7.2 : 7.65,front*2,sony ? .38 : .85,black);
        const outline = sony ? [[-2.1,3.26],[-1.54,4.81],[-1.16,5.22],[1.76,5.22],[2.38,3.95],[2.89,3.26]]
            : [[-2.85,3.12],[-2.28,4.21],[-1.38,5.36],[-.66,5.69],[1.34,5.62],[2.13,5.12],[3.1,3.12]];
        prism(group, outline, sony ? 3.58 : 4.45,-1.72);
        // Cross-section of the grip in plan. The DSLR sweeps farther
        // forward at the shutter and hollows out beside the lens mount.
        const contour = new THREE.Shape();
        contour.moveTo(-6.22,.18);
        contour.bezierCurveTo(-6.57,1.55,-6.52,front+1.95,-5.58,front+2.15);
        contour.bezierCurveTo(-4.54,front+2.56,-3.62,front+1.91,-3.53,front+1.12);
        contour.quadraticCurveTo(-3.55,front+.15,-2.96,front-.22);
        contour.lineTo(-3.35,.18);
        contour.closePath();
        const handgrip = new THREE.ExtrudeGeometry(contour,{depth:sony?5.95:6.27,
            bevelSize:sony?.19:.31,bevelThickness:.41,bevelSegments:6,curveSegments:16});
        handgrip.rotateX(Math.PI/2);
        mesh(group,handgrip,grip,0,sony?2.83:3.06,0);
        const shoulder=box(group,2.88,1.12,2.47,.47,black,-4.90,3.05,front+.56);
        shoulder.rotation.x=.23;
        cylinder(group,.38,.38,.12,black,3.82,-1.70,front+.22);
        cylinder(group,.18,.18,.075,glass,-2.82,2.35,front+.16);
        for (const x of [-6.40,6.40]) {
            const lug=mesh(group,new THREE.TorusGeometry(.23,.082,8,24),edge,x,2.86,.16);
            lug.rotation.y=.72;
        }
        box(group,1.68,.12,1.52,.08,grip,.16,sony?5.42:5.87,-.23);
        for (const x of [-.76,.96]) box(group,.15,.17,1.54,.04,edge,x,sony?5.52:5.97,-.23);
        if (!sony) {
            // The T5's built-in pop-up flash sits over the sloped DSLR shoulders.
            prism(group,[[-2.38,3.78],[-1.43,5.23],[-.63,5.62],[1.30,5.54],
                [2.02,5.07],[2.54,3.78]],.23,2.72);
            prism(group,[[-6.07,3.21],[-5.52,3.90],[-4.12,4.06],[-2.48,3.80],
                [-1.94,3.23]],3.17,-1.57);
        }
        const labelZ = sony ? 2.02 : 3.11;
        badge(group,sony?'SONY':'Canon',sony?2.48:2.89,.94,.24,4.31,labelZ,
            sony?'bold 80px Georgia':'italic bold 84px Georgia');
        badge(group,sony?'α':'EOS',sony?.94:1.22,.85,4.92,2.66,front+.20);
        badge(group,sony?'7 IV':'Rebel T5',1.44,.49,4.92,1.98,front+.20);
        // Open mount shows the mirror box on the DSLR and the exposed sensor on the α7.
        const mountX=.58;
        cylinder(group,3.19,3.27,.32,sony?material(0xbc6938):black,mountX,-.25,front+.28);
        cylinder(group,3.06,3.06,.23,edge,mountX,-.25,front+.53);
        cylinder(group,2.66,2.66,.06,grip,mountX,-.25,front+.68);
        box(group,sony?3.65:3.1,sony?2.48:2.22,.055,.06,
            material(sony?0x424b60:0x53606a,.17,.32),mountX,-.25,front+.745);
        const opticalSurface = artwork(384,256,(ctx,w,h) => {
            const reflection = ctx.createLinearGradient(0,h,w*.65,0);
            const stops = sony ? ['#27383c','#547363','#6b6176','#3c475a']
                : ['#282b2e','#5b6165','#41474b','#26282d'];
            stops.forEach((c,i) => reflection.addColorStop(i/3,c));
            ctx.fillStyle=reflection;
            ctx.fillRect(0,0,w,h);
        });
        mesh(group,new THREE.PlaneGeometry(sony?3.44:2.93,sony?2.28:2.05),
            opticalSurface,mountX,-.25,front+.80);
        for (const a of [.62,2.48,3.77,5.49])
            cylinder(group,.106,.106,.028,grip,mountX+2.87*Math.cos(a),-.25+2.87*Math.sin(a),front+.66);
        cylinder(group,.11,.11,.04,sony?edge:red,mountX,2.65,front+.68);
        const shutter = cylinder(group,.48,.55,.17,edge,-4.64,3.48,front+.63);
        shutter.rotation.x=.24;
        for (const x of sony?[-4.44,-2.68]:[-3.74]) {
            const dial = cylinder(group,.83,.83,.55,barrelFinish('fine'),x,sony?3.86:4.06,-.67);
            dial.rotation.x=0;
            const top=badge(group,'P  A  S  M',1.25,.42,x,sony?4.15:4.35,-.67);
            top.rotation.x=-Math.PI/2;
        }
        const rear=-front-.18;
        box(group,7.0,4.87,.23,.25,grip,1.22,-.57,rear);
        box(group,6.56,4.36,.13,.15,screen,1.22,-.57,rear-.17);
        box(group,2.55,1.56,.66,.31,grip,.24,4.06,-1.96);
        box(group,1.54,.84,.16,.15,glass,.24,4.06,-2.35);
        for (const [x,y,r] of [[-3.82,-.9,.93],[-3.82,-.9,.40],[-3.82,1.43,.34],[-5.08,2.13,.28],[-2.62,-2.69,.27]]) {
            cylinder(group,r,r,.18,black,x,y,rear-.24+(r>.9?.12:0));
        }
        if (sony) box(group,.32,3.66,.38,.11,grip,4.76,-.53,rear-.10);
        for (const [label,x,y] of [['MENU',3.77,2.72],[sony?'AF-ON':'Av',-3.83,1.98],
            [sony?'Fn':'Q',-5.13,1.57],[sony?'DISP':'SET',-3.82,-.90]]) {
            const print=badge(group,label,.76,.34,x,y,rear-.37);
            print.rotation.y=Math.PI;
        }
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
        const flash = material(0xf2dfb5, .27, .08);
        if (samsung) {
            cylinder(group,.28,.28,.06,flash,-.46,4.20,.57);
            badge(group,'SAMSUNG',2.52,.52,0,-6.45,.521,'bold 72px Arial','#646466');
            box(group,.83,.09,.40,.045,black,-2.99,-height/2-.01,0);
        } else {
            cylinder(group,.27,.27,.08,flash,2.21,5.30,.99);
            cylinder(group,.22,.22,.08,grip,2.21,4.70,.99);
            badge(group,'G',1.07,1.25,0,-.12,.525,'bold 88px Arial','#646464');
        }
        const modules = samsung ? [[-2.44,5.65],[-2.44,3.45],[-2.44,1.27],[-.46,3.33]]
            : [[-1.8,5.1],[-.43,5.1],[.92,5.1]];
        for (const [x,y] of modules) {
            const z=samsung?.875:1.116;
            cylinder(group,.27,.27,.025,grip,x,y,z);
            cylinder(group,.084,.084,.02,material(0x65778e),x-.10,y+.11,z+.019);
        }
        cylinder(group,.14,.14,.03,grip,0,height/2-.55,-.51);
        box(group,.10,1.72,.26,.05,edge,width/2,samsung?3.22:1.35,0);
        box(group,.10,.88,.26,.05,edge,width/2,samsung?1.51:3.12,0);
        box(group,.91,.08,.29,.04,grip,.04,-height/2-.035,0);
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
    // Reflected strip lights define the metal rails and barrel edges at every angle.
    const studio = new THREE.Scene();
    studio.background = new THREE.Color(0x24252a);
    for (const [x,y,z,w,h] of [[-5,3,4,2,8],[4,2,-3,1.2,7],[1,6,3,6,3]]) {
        const card = new THREE.Mesh(new THREE.PlaneGeometry(w,h),
            new THREE.MeshBasicMaterial({color:0xffffff}));
        card.position.set(x,y,z);
        card.lookAt(0,0,0);
        studio.add(card);
    }
    const generator = new THREE.PMREMGenerator(renderer);
    const reflections = generator.fromScene(studio, .035);
    scene.environment = reflections.texture;
    generator.dispose();
    studio.children.forEach(card => { card.geometry.dispose(); card.material.dispose(); });
    const camera = new THREE.PerspectiveCamera(36, 1, .1, 100);
    camera.position.z = 8;
    scene.add(new THREE.HemisphereLight(0xeef2ff, 0x737985, .93));
    for (const [color, intensity, x, y, z] of [
        [0xfff7ea, 1.45, -4, 5, 6],
        [0xbee1ff, 1.08, 4, 1, -5],
        [0xe7ebff, .45, 2, -2, 5],
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
            const materials = new Set();
            model.traverse(part => {
                part.geometry?.dispose();
                if (part.material) materials.add(part.material);
            });
            for (const surface of materials) {
                surface.map?.dispose();
                surface.dispose();
            }
        }
        model = build(product.dataset.gear);
        const bounds = new THREE.Box3().setFromObject(model);
        const sphere = bounds.getBoundingSphere(new THREE.Sphere());
        const size = 2.06 / sphere.radius;
        model.scale.setScalar(size);
        model.position.copy(sphere.center).multiplyScalar(-size);
        pivot.add(model);
        const id = product.dataset.gear;
        yaw = lenses[id] ? .05 : id === 'samsung' || id === 'pixel' ? -.30 : .38;
        pitch = lenses[id] ? .46 : .24;
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
        camera.position.z = Math.max(6.9, 6.9 / camera.aspect);
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
