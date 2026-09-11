import assert from 'node:assert/strict';
import { chromium } from '../.cache/browser/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
 for (const width of [320,390,667]) {
  const context = await browser.newContext({viewport:{width,height:width===667?375:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
  await context.addInitScript(()=>{localStorage.setItem('vlmType','api');localStorage.setItem('vlmApiEndpoint','http://127.0.0.1:8765/test-api');localStorage.setItem('vlmApiKey','test');});
  const page=await context.newPage();
  for(const prefix of ['', '/build']) {
   await page.goto(`http://127.0.0.1:8765${prefix}/portfolios/astronomy/index.html?mode=2d`,{waitUntil:'domcontentloaded'});
   // Check both normal and photo-viewer controls, including controls that auto-hide.
   const collisions=await page.evaluate(()=>{
    const back=document.querySelector('#portfolio-return').getBoundingClientRect();
    const overlaps=r=>r.width&&r.height&&r.left<back.right&&r.right>back.left&&r.top<back.bottom&&r.bottom>back.top;
    document.querySelector('#imageViewer').hidden=false;
    return [...document.querySelectorAll('#top-controls button,#viewer-controls button,#controls-toggle,#viewer-controls-toggle,#portfolio-inspector')].filter(el=>overlaps(el.getBoundingClientRect())).map(el=>el.id);
   });
   assert.deepEqual(collisions,[],`${prefix} ${width}: controls must clear Back`);
   const inspector=await page.locator('#portfolio-inspector').boundingBox();
   assert.ok(inspector.x>=0&&inspector.x+inspector.width<=width);
  }
  console.log(`${width}px: return link clears gallery and photo controls in both layouts`);
  if(width===390){
   await page.goto('http://127.0.0.1:8765/build/index.html?mode=3d',{waitUntil:'domcontentloaded'});
   await page.locator('#btn-controls-toggle').click();
   await page.locator('#btn-about').click();
   await page.frameLocator('#exhibit-iframe').locator('.profile-img').waitFor();
   await page.locator('.vlm-panel.vlm-open').waitFor({state:'visible',timeout:30000});
   assert.ok(page.url().includes('index.html'));
   assert.equal(await page.locator('#controls-container').evaluate(el=>el.classList.contains('expanded')),false);
   await page.evaluate(() => {
    const overlay = window[Symbol.for('thedoshoots.galleryVLMOverlays')][0];
    overlay._imageSrc = 'test-image';
    overlay._sendMessage = () => { window.submittedSuggestion = overlay._q('-input').value; };
    overlay._panel.querySelectorAll('.vlm-suggestion').forEach(button => button.disabled = false);
   });
   await page.locator('.vlm-input').focus();
   await page.locator('.vlm-suggestion').first().click();
   assert.equal(await page.evaluate(() => window.submittedSuggestion), 'Describe the image');
   assert.equal(await page.locator('.vlm-input').evaluate(el=>el===document.activeElement),false);
   await page.locator('.vlm-input').click();
   assert.equal(await page.locator('.vlm-input').evaluate(el=>el===document.activeElement),true);
   console.log('Suggested prompt submits without input focus; tapping the input still focuses it');
   await page.locator('#close-iframe').click();
   await page.waitForFunction(()=>!document.querySelector('#iframe-container').classList.contains('active'));
   console.log('About opens embedded with AI Inspector; close returns to main');
  }
  await context.close();
 }
} finally {await browser.close();}
