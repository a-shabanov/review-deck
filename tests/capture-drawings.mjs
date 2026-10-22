// Capture and verify real freehand drawing on a disposable demo library.
// Usage: REVIEW_DECK_TEST_PASSWORD=... node tests/capture-drawings.mjs URL OUTPUT_DIRECTORY
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const [url,out]=process.argv.slice(2);
await fs.mkdir(out,{recursive:true});
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,defaultViewport:{width:2200,height:1240,deviceScaleFactor:1}});
try{
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${new URL(r.url()).pathname}`);});
  await page.authenticate({username:'review',password:process.env.REVIEW_DECK_TEST_PASSWORD});
  await page.goto(url,{waitUntil:'networkidle2'});
  async function openSource(){
    await page.waitForSelector('.card');
    const index=await page.evaluate(()=>FLAT.findIndex(x=>x.v.rel.includes('LISA')&&x.v.name.startsWith('01')));
    assert.ok(index>=0,'A disposable LISA demo source is required');
    await page.click(`.card[data-idx="${index}"]`);await page.keyboard.press('Enter');
    await page.waitForFunction(()=>P.rel.includes('LISA')&&video.readyState>=2&&new URL(video.currentSrc).searchParams.get('rel')===P.rel);
    if(await page.$eval('#tlBtn',e=>e.textContent)!=='Timeline: Review'){
      await page.click('#tlBtn');await page.waitForFunction(()=>document.querySelector('#tlBtn').textContent==='Timeline: Review');
    }
    await page.evaluate(()=>{pause();P.tlWin=75;seekTo(97.5);});
    await page.waitForFunction(()=>Math.abs(video.currentTime-97.5)<.01&&!video.seeking);
  }
  await openSource();
  const previous=await page.evaluate(()=>P.marks.drawings.length);
  await page.keyboard.press('KeyP');
  await page.waitForFunction(()=>P.mode==='draw');
  await page.keyboard.press('BracketRight');await page.keyboard.press('BracketRight'); // 10px
  const r=await page.$eval('#draw',e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};});
  async function stroke(points){
    const p=([x,y])=>({x:r.x+x*r.w,y:r.y+y*r.h});
    const first=p(points[0]);await page.mouse.move(first.x,first.y);await page.mouse.down();
    for(const q of points.slice(1)){const v=p(q);await page.mouse.move(v.x,v.y,{steps:8});}
    await page.mouse.up();
  }
  await page.keyboard.press('Digit2');
  await stroke([[.13,.28],[.88,.28],[.88,.94],[.13,.94],[.13,.28]]);
  await page.keyboard.press('Digit1');
  await stroke([[.79,.12],[.60,.55]]);
  await stroke([[.60,.55],[.60,.43]]);
  await stroke([[.60,.55],[.70,.49]]);
  await page.keyboard.press('Digit4');
  const circle=Array.from({length:49},(_,i)=>{const a=2*Math.PI*i/48;return[.51+.075*Math.cos(a),.86+.065*Math.sin(a)];});
  await stroke(circle);
  assert.equal(await page.evaluate(()=>P.strokes.length),5);
  const fits=await page.evaluate(()=>[...document.querySelectorAll('#player .bar>*')].every(e=>e.getBoundingClientRect().right<=innerWidth));
  assert.ok(fits,'All drawing controls must be visible');
  await page.mouse.move(2180,1210);await new Promise(r=>setTimeout(r,500));
  await page.screenshot({path:path.join(out,'drawing-tools.png')});
  await page.keyboard.press('Enter');
  await page.waitForFunction(n=>P.mode===''&&P.marks.drawings.length===n+1,{},previous);
  await page.waitForFunction(async n=>{const m=await(await fetch('/api/marks?rel='+encodeURIComponent(P.rel)+'&tl=review')).json();return m.drawings.length===n+1;},{},previous);
  const saved=await page.evaluate(()=>P.marks.drawings.at(-1));
  assert.equal(saved.strokes.length,5);
  assert.ok(saved.strokes.every(s=>s.pts.every(([x,y])=>x>=0&&x<=1&&y>=0&&y<=1)));
  const png=await page.evaluate(async()=>{const d=P.marks.drawings.at(-1),file=d.png.split('/drawings/')[1];const r=await fetch('/drawing?f='+encodeURIComponent(file));return{status:r.status,head:[...new Uint8Array(await r.arrayBuffer()).slice(0,8)]};});
  assert.equal(png.status,200);assert.deepEqual(png.head,[137,80,78,71,13,10,26,10]);
  await page.reload({waitUntil:'networkidle2'});await openSource();
  await page.waitForFunction(()=>P.marks.drawings.some(d=>Math.abs(d.t-97.5)<.01));
  await new Promise(r=>setTimeout(r,1900));
  const painted=await page.evaluate(()=>{const a=dcv.getContext('2d').getImageData(0,0,dcv.width,dcv.height).data;let n=0;for(let i=3;i<a.length;i+=4)if(a[i])n++;return n;});
  assert.ok(painted>1000,'Saved strokes must render after reload');
  await page.mouse.move(2180,1210);
  await page.screenshot({path:path.join(out,'drawing-saved.png')});
  assert.deepEqual(errors,[]);
  console.log('PASS: mouse-drawn strokes, five strokes persisted, annotated PNG retrieved, strokes restored after page reload; two screenshots; no JS/network errors');
}finally{await browser.close();}
