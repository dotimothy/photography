/** In-scene camera interaction regressions. Run against the source homepage. */
import assert from 'node:assert/strict';
import { chromium } from '../.cache/browser/node_modules/playwright/index.mjs';
const base = process.env.SITE_URL || 'http://127.0.0.1:8765';
const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
async function pose(page, front=false) {
    await page.evaluate(front=>{
        TWEEN.removeAll(); controls.enableDamping=false;
        controls.target.set(0,0,0);
        camera.position.set(...(front?[-22,22,32]:[0,0,innerWidth<768?-44:-25]));
        controls.update();renderer.render(scene,camera);
    },front);
}
async function pointFor(page,id,first=false) {
    return page.evaluate(({id,first})=>{
        const meshes=cameraControls.get(id).meshes;
        const p=(first?meshes[0]:meshes.at(-1)).getWorldPosition(new THREE.Vector3()).project(camera);
        return {x:(p.x+1)*innerWidth/2,y:(1-p.y)*innerHeight/2};
    },{id,first});
}
async function tap(page,mobile,point) {
    if(mobile) await page.touchscreen.tap(point.x,point.y); else await page.mouse.click(point.x,point.y);
}
async function activate(page,mobile,id,first=false) { await tap(page,mobile,await pointFor(page,id,first)); }
async function settle(page) { await page.waitForFunction(()=>!cameraTravel&&!cameraPhotoBusy); }
async function checkWheelZoom(page, point) {
    const before=await page.evaluate(()=>({focal:cameraZoom,position:camera.position.toArray(),target:controls.target.toArray()}));
    await page.mouse.move(point.x,point.y);
    await page.mouse.wheel(0,-120);
    await page.waitForFunction(f=>cameraZoom>f&&cameraLensTween===null,before.focal);
    assert.deepEqual(await page.evaluate(()=>camera.position.toArray()),before.position,'Wheel adjusts lens without moving the viewer');
    assert.deepEqual(await page.evaluate(()=>controls.target.toArray()),before.target);
    await page.mouse.wheel(0,120);
    await page.waitForFunction(f=>Math.abs(cameraZoom-f)<0.001&&cameraLensTween===null,before.focal);
    await page.evaluate(()=>setCameraLensZoom(18));
    await page.waitForFunction(()=>cameraLensTween===null);
}
async function watchFlash(page) {
    await page.evaluate(()=>{
        window.flashCheck=new Promise(resolve=>{
            const start=performance.now(), samples=[];
            function sample() {
                samples.push({amount:cameraFlashAmount,light:cameraFlashLight.intensity});
                if(performance.now()-start<650) requestAnimationFrame(sample);
                else resolve(samples);
            }
            sample();
        });
    });
}
async function stepBack(page) {
    await page.locator('#mode-3d canvas').focus();
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>!cameraInspection&&!cameraTravel);
}
async function screenPoint(page,label,finder=false) {
    return page.evaluate(({label,finder})=>{
        const surface=finder?finderMesh:screenMesh;
        const zone=(finder?finderClickZones:uiClickZones).find(z=>z.label===label);
        const u=(zone.x+zone.w/2)/1500,v=1-(zone.y+zone.h/2)/1500;
        const p=new THREE.Vector3((u-.5)*surface.geometry.parameters.width,(v-.5)*surface.geometry.parameters.height,0);
        surface.localToWorld(p);p.project(camera);
        return {x:(p.x+1)*innerWidth/2,y:(1-p.y)*innerHeight/2};
    },{label,finder});
}
async function photoPoint(page,kind,u,v,finder) {
    return page.evaluate(({kind,u,v,finder})=>{
        const surface=finder?finderMesh:screenMesh;
        const rect=(finder?finderCtx:uiCtx).cameraPhotoLayout[kind];
        const p=new THREE.Vector3(((rect.x+rect.w*u)/1500-.5)*surface.geometry.parameters.width,
            (.5-(rect.y+rect.h*v)/1500)*surface.geometry.parameters.height,0);
        surface.localToWorld(p);p.project(camera);
        return {x:(p.x+1)*innerWidth/2,y:(1-p.y)*innerHeight/2};
    },{kind,u,v,finder});
}
async function checkPhotoPan(page,mobile,context,finder) {
    await page.evaluate(()=>setCameraLensZoom(85));
    await page.waitForFunction(()=>cameraLensTween===null);
    const before=await page.evaluate(()=>({src:lastCameraPhoto.src,history:cameraHistory.length}));
    const point=await photoPoint(page,'photoRect',.5,.4,finder);
    if(mobile) {
        const cdp=await context.newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:point.x-35,y:point.y-12}]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        await cdp.detach();
    } else {
        await page.mouse.move(point.x,point.y);await page.mouse.down();
        await page.mouse.move(point.x-35,point.y-12,{steps:5});await page.mouse.up();
    }
    assert.ok(await page.evaluate(()=>cameraPan.x>.5&&cameraPan.y>.5),'Dragging pans in both axes');
    assert.deepEqual(await page.evaluate(()=>({src:lastCameraPhoto.src,history:cameraHistory.length})),before,'Panning never changes photographs');
    await tap(page,mobile,await photoPoint(page,'map',.02,.98,finder));
    assert.ok(await page.evaluate(()=>Math.abs(cameraPan.x-9/cameraLens.focalLength)<.001&&Math.abs(cameraPan.y-(1-9/cameraLens.focalLength))<.001),'Overview map reaches image edges without exposing empty space');
    await page.keyboard.press('Home');
    assert.deepEqual(await page.evaluate(()=>({...cameraPan})),{x:.5,y:.5});
    await page.keyboard.press('Shift+ArrowRight');
    assert.ok(await page.evaluate(()=>cameraPan.x>.5),'Keyboard panning works');
    await page.evaluate(()=>setCameraLensZoom(18));
    await page.waitForFunction(()=>cameraLensTween===null);
    assert.deepEqual(await page.evaluate(()=>({...cameraPan})),{x:.5,y:.5},'Zooming out keeps the image within bounds');
}
try {
    for(const mobile of [false,true]) {
        const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
        await context.addInitScript(()=>localStorage.setItem('sitePerformanceProfile','quality'));
        const page=await context.newPage(),errors=[],requests=[];
        page.on('pageerror',e=>errors.push(e.message));
        let failedPhoto=false;
        const fixtureNames=['Dotted.photo name','Second_photo','Third_photo'];
        const fixtureMetadata={image_order:fixtureNames,...Object.fromEntries(fixtureNames.map((name,i)=>[name,{
            'Image Make':'SONY','Image Model':'ILCE-7M4','EXIF LensModel':'FE 18-300mm',
            'EXIF FNumber':'28/10','EXIF ExposureTime':'1/250','EXIF ISOSpeedRatings':String(100*(i+1)),
            'EXIF FocalLength':'85','EXIF DateTimeOriginal':'2025:04:03 12:34:56'
        }]))};
        await page.route('**/metadata/metadata.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify(fixtureMetadata)}));
        await page.route('**/fulls/*.jpg',r=>{
            requests.push(r.request().url());
            return failedPhoto?r.fulfill({status:404,body:''}):r.fulfill({path:'assets/photographer.jpg',contentType:'image/jpeg'});
        });
        await page.goto(base+'/?mode=3d',{waitUntil:'networkidle'});
        await page.evaluate(()=>{
            document.getElementById('space-intro').style.display='none';els.welcome.style.display='none';state.hasExplored=true;
            state.rendering.cameraMotion=false;applySceneRenderingSettings();
        });
        assert.ok(await page.evaluate(()=>{
            for(const aspect of [1.52/.64,10.55/7.1]) {
                const canvas=document.createElement('canvas');canvas.width=600;canvas.height=300;
                const ctx=canvas.getContext('2d');ctx.cameraAspect=aspect;
                cameraBoxText(ctx,'Very long lens metadata / Ágj 18–300mm '.repeat(12),{x:100,y:100,w:280,h:105},{size:58,padding:14,align:'center'});
                const pixels=ctx.getImageData(0,0,600,300).data;
                let visible=false;
                for(let y=0;y<300;y++) for(let x=0;x<600;x++) if(pixels[(y*600+x)*4+3]) {
                    visible=true;
                    if(x<114||x>=366||y<114||y>=191) return false;
                }
                if(!visible) return false;
            }
            return true;
        }),'Long text renders inside padded bounds on both physical display shapes');
        assert.equal(await page.locator('#camera-photo, #camera-actions, #camera-control-toast, #camera-hover').count(),0);
        await pose(page);
        const initialDrift=await page.evaluate(()=>{
            state.rendering.cameraMotion=true;cameraPointerOverBody=false;cameraInteractionUntil=0;applySceneRenderingSettings();
            return state.rendering.starMotion;
        });
        const scale=await page.evaluate(()=>camGroup.scale.x);
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(()=>camGroup.scale.x),scale,'Camera controls no longer pulse in size');
        const driftPoint=await pointFor(page,'custom');
        let cdp;
        if(mobile) {
            cdp=await context.newCDPSession(page);
            await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[driftPoint]});
        } else {
            await page.mouse.move(driftPoint.x,driftPoint.y);await page.mouse.down();
        }
        const heldPose=await page.evaluate(()=>({position:camGroup.position.toArray(),rotation:camGroup.rotation.toArray()}));
        await page.waitForTimeout(200);
        assert.deepEqual(await page.evaluate(()=>({position:camGroup.position.toArray(),rotation:camGroup.rotation.toArray()})),heldPose,'Camera stays still while targeting a physical control');
        if(mobile) {await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();}
        else await page.mouse.up();
        assert.equal(await page.evaluate(()=>state.rendering.starMotion),!initialDrift,'Large rear Star Drift button responds to a held tap');
        await page.evaluate(drift=>{state.rendering.cameraMotion=false;state.rendering.starMotion=drift;applySceneRenderingSettings();},initialDrift);
        await pose(page);
        const original=await page.evaluate(()=>camera.position.toArray());
        const eye=await pointFor(page,'viewfinder');
        if(!mobile) {
            await page.mouse.move(eye.x,eye.y);
            assert.ok(await page.evaluate(()=>cameraControls.get('viewfinder').meshes.some(m=>m.material.emissive.getHex()>0)));
        }
        requests.length=0;
        await activate(page,mobile,'viewfinder');
        await settle(page);
        assert.equal(await page.evaluate(()=>cameraInspection),'viewfinder');
        assert.equal(requests.length,1,'Only one capture for each tap');
        assert.ok(await page.evaluate(()=>lastCameraPhoto.image.naturalWidth>0));
        assert.equal(await page.evaluate(()=>state.isPaused),false);
        assert.equal(await page.evaluate(()=>state.isAnimating),true);
        assert.ok(await page.evaluate(()=>finderMesh.material.map===finderTexture&&screenMesh.material.map===uiTexture));
        assert.ok(await page.evaluate(()=>{
            const original=lastCameraPhoto.image;
            try {
                for(const [width,height] of [[1600,400],[400,1600],[1200,900]]) {
                    const image=document.createElement('canvas');image.width=width;image.height=height;
                    image.naturalWidth=width;image.naturalHeight=height;
                    lastCameraPhoto.image=image;
                    drawCameraDisplay(uiCtx,10.55/7.1,[],false);updateFinderScreen();
                    for(const ctx of [uiCtx,finderCtx]) {
                        const {photoRect:p,map:m}=ctx.cameraPhotoLayout;
                        if(p.x+p.w>m.x-10||m.x+m.w+10>1500) return false;
                        if(matchMedia('(pointer: coarse)').matches&&Math.max(p.y+p.h,m.y+m.h+10)>=900) return false;
                    }
                }
                return true;
            } finally {lastCameraPhoto.image=original;updateUI();}
        }),'Overview map and its border stay outside portrait, landscape, and panoramic photos on both displays');
        if(!mobile) await checkWheelZoom(page,await screenPoint(page,'+',true));
        assert.ok(await page.evaluate(()=>{
            const points=finderMesh.geometry.attributes.position;
            for(let i=0;i<points.count;i++) {
                if(Math.abs(points.getX(i))>0.75&&Math.abs(points.getY(i))>0.31) return false;
            }
            const area={x:55,y:145,w:1390,h:matchMedia('(pointer: coarse)').matches?940:1080};
            const frame=cameraFocusFrame(area,1.52/0.64);
            return Math.abs(frame.w*1.52/0.64-frame.h)<0.001&&Math.abs(frame.y+frame.h/2-area.y-area.h/2)<0.001;
        }),'Eyepiece corners are inset and focus square stays centered at the display aspect ratio');
        const wideImage=await page.evaluate(()=>finderCtx.getImageData(350,350,800,500).data.toString());
        await tap(page,mobile,await screenPoint(page,'+',true));
        await page.waitForFunction(()=>cameraLens.focalLength===23);
        assert.equal(await page.evaluate(()=>cameraInspection),'viewfinder','Lens zoom keeps the visitor in the viewfinder');
        assert.notEqual(await page.evaluate(()=>finderCtx.getImageData(350,350,800,500).data.toString()),wideImage,'Zoom changes the photograph framing');
        await tap(page,mobile,await screenPoint(page,'−',true));
        await page.waitForFunction(()=>cameraLens.focalLength===18);
        await tap(page,mobile,await screenPoint(page,'METADATA',true));
        assert.equal(await page.evaluate(()=>cameraMetadataVisible),true);
        assert.equal(await page.evaluate(()=>cameraInspection),'viewfinder');
        const metadataRows=await page.evaluate(()=>Object.fromEntries(cameraMetadataRows(lastCameraPhoto)));
        assert.equal(metadataRows.CAMERA,'SONY ILCE-7M4');
        assert.match(metadataRows.EXPOSURE,/f\/2.8.*1\/250 s.*ISO/);
        assert.equal(metadataRows['FOCAL LENGTH'],'85 mm','Metadata preserves recorded focal length independently of virtual zoom');
        assert.equal(metadataRows.TAKEN,'2025-04-03 12:34:56');
        await tap(page,mobile,await screenPoint(page,'HIDE INFO',true));
        assert.equal(await page.evaluate(()=>cameraMetadataVisible),false);
        await checkPhotoPan(page,mobile,context,true);
        const stars=await page.evaluate(()=>asteroidSystem.rotation.y);
        await page.waitForTimeout(150);
        assert.notEqual(await page.evaluate(()=>asteroidSystem.rotation.y),stars);
        assert.equal(await page.locator('.controls-container').isVisible(),false);
        const first=await page.evaluate(()=>lastCameraPhoto.src);
        await page.keyboard.press('Enter'); await settle(page);
        assert.equal(await page.evaluate(()=>cameraLiveView),true,'First shutter press opens live space view');
        await watchFlash(page);
        await page.keyboard.press('Enter');
        await settle(page);
        const flash=await page.evaluate(()=>window.flashCheck);
        assert.ok(flash.some(s=>s.amount>0.2&&s.light>0),'Shutter illuminates the scene and camera displays');
        assert.deepEqual(flash.at(-1),{amount:0,light:0},'Flash fades completely');
        assert.equal(await page.evaluate(()=>cameraCaptureCount),1);
        assert.notEqual(await page.evaluate(()=>lastCameraPhoto.src),first);
        await page.keyboard.press('ArrowLeft');
        await settle(page);
        assert.equal(await page.evaluate(()=>lastCameraPhoto.src),first);
        assert.equal(await page.evaluate(()=>Object.fromEntries(cameraMetadataRows(lastCameraPhoto)).EXPOSURE),metadataRows.EXPOSURE,'History retains each photo metadata');
        await tap(page,mobile,await screenPoint(page,'STEP BACK',true));
        await page.waitForFunction(()=>!cameraInspection&&!cameraTravel);
        assert.ok(await page.evaluate(p=>camera.position.distanceTo(new THREE.Vector3(...p))<0.001,original));
        assert.equal(await page.evaluate(()=>controls.enabled),true);

        await pose(page,true);
        await activate(page,mobile,'menu');
        assert.equal(await page.evaluate(()=>cameraInspection),null,'Rear buttons cannot be activated through the body');
        const lensPose=await page.evaluate(()=>camera.position.toArray());
        if(!mobile) {
            await checkWheelZoom(page,await pointFor(page,'zoom'));
            await page.mouse.move(30,500);
            await page.mouse.wheel(0,120);
            await page.waitForTimeout(150);
            assert.notDeepEqual(await page.evaluate(()=>camera.position.toArray()),lensPose,'Background wheel keeps scene distance controls');
            assert.equal(await page.evaluate(()=>cameraZoom),18);
            await pose(page,true);
        }
        await activate(page,mobile,'zoom');
        await page.waitForFunction(()=>cameraLens.focalLength===24);
        for (let i=0;i<7;i++) await page.keyboard.press('z');
        await page.waitForFunction(()=>cameraLens.focalLength===300);
        assert.ok(await page.evaluate(()=>{
            return cameraControls.get('zoom').parts.filter(p=>p.extends).every(p=>Math.abs(p.pivot.position.z-p.rest.z-p.extends)<0.001);
        }),'Telephoto extends the lens barrel');
        assert.deepEqual(await page.evaluate(()=>camera.position.toArray()),lensPose,'Lens adjustment preserves the viewing position');
        await page.keyboard.press('z');
        await page.waitForFunction(()=>cameraLens.focalLength===18);
        assert.ok(await page.evaluate(()=>{
            const part=cameraControls.get('zoom').parts.find(p=>p.extends);
            return Math.abs(part.pivot.position.z-part.rest.z)<0.001;
        }),'Wide angle retracts the lens');
        await activate(page,mobile,'shutter');
        await settle(page);
        assert.equal(await page.evaluate(()=>cameraLiveView),true);
        await page.keyboard.press('Enter'); await settle(page);
        assert.equal(await page.evaluate(()=>cameraInspection),'screen');
        assert.equal(await page.evaluate(()=>cameraCaptureCount),2);
        assert.ok(await page.evaluate(()=>camera.position.z<0));
        await stepBack(page);
        await pose(page);
        await activate(page,mobile,'collection');
        assert.equal(await page.evaluate(()=>cameraCollection),0);
        await page.waitForTimeout(300);
        assert.ok(await page.evaluate(()=>Math.abs(cameraControls.get('collection').parts[0].pivot.rotation.y)>0.1));
        await activate(page,mobile,'settings');
        await settle(page);
        assert.equal(await page.evaluate(()=>cameraDisplay),'settings');
        assert.equal(await page.locator('#settings-overlay').evaluate(el=>el.classList.contains('visible')),false);
        const drift=await page.evaluate(()=>state.rendering.starMotion);
        await tap(page,mobile,await screenPoint(page,`STAR DRIFT / ${drift?'ON':'OFF'}`));
        assert.equal(await page.evaluate(()=>state.rendering.starMotion),!drift);
        await stepBack(page);
        await page.evaluate(()=>{ cameraSource='portfolio'; showCameraPhoto(); }); await settle(page);
        await activate(page,mobile,'playback');
        await settle(page);
        const lcdPhoto=await page.evaluate(()=>lastCameraPhoto.src);
        await tap(page,mobile,await screenPoint(page,'METADATA'));
        assert.equal(await page.evaluate(()=>cameraMetadataVisible),true);
        assert.equal(await page.evaluate(()=>cameraInspection),'screen');
        assert.equal(await page.evaluate(()=>uiCtx.cameraPhotoLayout),null,'LCD metadata hides the pan map');
        assert.equal(await page.evaluate(()=>Object.fromEntries(cameraMetadataRows(lastCameraPhoto)).CAMERA),'SONY ILCE-7M4');
        await tap(page,mobile,await screenPoint(page,'HIDE INFO'));
        assert.equal(await page.evaluate(()=>lastCameraPhoto.src),lcdPhoto,'Closing LCD metadata preserves the photograph');
        await checkPhotoPan(page,mobile,context,false);
        const history=await page.evaluate(()=>cameraHistory.length);
        const center=await page.evaluate(()=>{
            const p=screenMesh.getWorldPosition(new THREE.Vector3()).project(camera);
            return {x:(p.x+1)*innerWidth/2,y:(1-p.y)*innerHeight/2};
        });
        if(mobile) {
            const cdp=await context.newCDPSession(page);
            await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:center.x,y:center.y}]});
            await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:center.x-75,y:center.y}]});
            await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        } else {
            await page.mouse.move(center.x,center.y);await page.mouse.down();
            await page.mouse.move(center.x-75,center.y,{steps:6});await page.mouse.up();
        }
        await settle(page);
        assert.ok(await page.evaluate(n=>cameraHistory.length>n,history));
        assert.equal(await page.evaluate(()=>cameraInspection),'screen');

        // Loading failures and retries stay on the camera's display.
        failedPhoto=true;
        await page.evaluate(()=>cameraPhotoCatalogs.set(cameraCollections[cameraCollection],['Missing_photo_fixture']));
        await tap(page,mobile,await screenPoint(page,'NEXT SHOT'));
        await settle(page);
        assert.match(await page.evaluate(()=>cameraMessage),/UNAVAILABLE/);
        assert.equal(await page.evaluate(()=>cameraInspection),'screen');
        failedPhoto=false;
        await tap(page,mobile,await screenPoint(page,'NEXT SHOT'));await settle(page);
        assert.match(await page.evaluate(()=>cameraMessage),/FRAME/);
        // Leaving during an asynchronous load must not pull the visitor back in.
        await page.evaluate(()=>cameraPhotoCatalogs.clear());
        await page.route('**/metadata/metadata.json',async r=>{
            await new Promise(resolve=>setTimeout(resolve,200));
            await r.fulfill({contentType:'application/json',body:'{"image_order":["Late_photo"]}'});
        });
        await tap(page,mobile,await screenPoint(page,'NEXT SHOT'));await page.keyboard.press('Escape');
        await page.waitForFunction(()=>!cameraInspection&&!cameraTravel);
        assert.equal(await page.evaluate(()=>cameraPhotoBusy),false);
        assert.ok(await page.evaluate(()=>lastCameraPhoto.name!=='Late_photo'));
        await pose(page);
        await activate(page,mobile,'settings');
        await settle(page);
        assert.equal(await page.evaluate(()=>cameraDisplay),'settings','Dedicated physical settings button opens the camera menu');
        assert.equal(await page.evaluate(()=>cameraInspection),'screen');
        assert.equal(await page.locator('#settings-overlay').evaluate(el=>el.classList.contains('visible')),false);
        await stepBack(page);
        // Reduced motion uses the same in-scene views with no travel animation.
        await page.emulateMedia({reducedMotion:'reduce'});
        await page.keyboard.press('s');
        assert.equal(await page.evaluate(()=>cameraDisplay),'settings');
        assert.equal(await page.evaluate(()=>cameraTravel),false);
        await page.keyboard.press('Escape');
        await page.keyboard.press('z');
        assert.equal(await page.evaluate(()=>cameraLens.focalLength),24,'Reduced motion adjusts the lens immediately');
        await page.keyboard.press('v');
        assert.equal(await page.evaluate(()=>cameraInspection),'viewfinder');
        assert.equal(await page.evaluate(()=>cameraTravel),false);
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(()=>cameraInspection),null);
        await watchFlash(page);
        await page.keyboard.press('Enter');
        await settle(page);
        assert.ok((await page.evaluate(()=>window.flashCheck)).every(s=>s.amount===0&&s.light===0),'Reduced motion suppresses flash');
        assert.equal(await page.locator('#camera-photo').count(),0);
        assert.deepEqual(errors,[]);
        console.log(`${mobile?'Mobile':'Desktop'} in-scene displays, physical controls, gestures, history, loading recovery, and reduced motion passed.`);
        await context.close();
    }
} finally {await browser.close();}
