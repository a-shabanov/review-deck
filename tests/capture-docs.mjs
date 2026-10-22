// Capture the live interface against a prepared, disposable demo library.
// Usage: REVIEW_DECK_TEST_PASSWORD=... node tests/capture-docs.mjs URL OUTPUT_DIRECTORY
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const [url, out] = process.argv.slice(2);
await fs.mkdir(out, {recursive:true});
const browser = await puppeteer.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true, defaultViewport:{width:1920,height:900,deviceScaleFactor:1}});
try {
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${new URL(r.url()).pathname}`);});
  await page.authenticate({username:'review',password:process.env.REVIEW_DECK_TEST_PASSWORD});
  await page.goto(url,{waitUntil:'networkidle2'});
  await page.waitForSelector('.card');
  await page.waitForFunction(()=>[...document.querySelectorAll('.card .th')].every(e=>e.style.backgroundImage));
  await page.evaluate(async()=>{await Promise.all([...document.querySelectorAll('.card .th')].map(e=>new Promise((resolve,reject)=>{const im=new Image();im.onload=resolve;im.onerror=reject;im.src=e.style.backgroundImage.slice(5,-2);})));});
  await page.mouse.move(1900,880);
  await page.screenshot({path:path.join(out,'library.png')});
  await page.setViewport({width:1920,height:1080,deviceScaleFactor:1});
  async function openSource(name){
    const index=await page.evaluate(name=>FLAT.findIndex(x=>x.v.rel.includes(name)&&x.v.name.startsWith('01')),name);
    assert.ok(index>=0,`Missing demo source: ${name}`);
    await page.click(`.card[data-idx="${index}"]`);await page.keyboard.press('Enter');
    await page.waitForFunction(name=>P.rel.includes(name)&&document.querySelector('#video').readyState>=2&&new URL(document.querySelector('#video').currentSrc).searchParams.get('rel')===P.rel,{},name);
  }
  async function captureAt(name,time){
    await page.evaluate(time=>{pause();P.tlWin=75;seekTo(time);},time);
    await page.waitForFunction(time=>Math.abs(document.querySelector('#video').currentTime-time)<.1&&!document.querySelector('#video').seeking,{},time);
    await new Promise(r=>setTimeout(r,1850));
    await page.mouse.move(1900,1060);
    const header=await page.evaluate(()=>[...document.querySelectorAll('#player .bar > *')].every(e=>e.getBoundingClientRect().right<=1920));
    assert.ok(header,'Player header must fit the viewport');
    const text=await page.evaluate(()=>document.body.innerText+JSON.stringify(P.marks)+JSON.stringify(trackDefs()));
    assert.ok(!/[А-Яа-яЁё]/.test(text),'All visible demo labels must be English');
    await page.screenshot({path:path.join(out,name+'.png')});
  }
  await openSource('LISA');
  assert.equal(await page.$eval('#tlBtn',e=>e.textContent),'Timeline: Annotations');
  await captureAt('timeline',38);
  await page.click('#tlBtn');
  await page.waitForFunction(()=>document.querySelector('#tlBtn').textContent==='Timeline: Review');
  await captureAt('review',97.5);
  await page.click('#tlBtn');
  await page.waitForFunction(()=>document.querySelector('#tlBtn').textContent==='Timeline: Annotations');
  await page.click('#backBtn');
  await openSource('ILLIT');
  await captureAt('annotations-illit',102);
  await page.click('#pTagBtn');
  await page.waitForSelector('#tagger:not(.hidden)');
  assert.equal(await page.$eval('#tagger [data-k="people"]',e=>e.textContent),'Participants');
  await page.keyboard.press('Escape');
  await page.click('#helpBtn2');
  assert.ok((await page.$eval('#help',e=>e.textContent)).includes('Keyboard controls'));
  await page.keyboard.press('Escape');
  assert.deepEqual(errors,[]);
  console.log('PASS: both demo videos, four screenshots, English UI/annotations/help, no clipped controls or JS/network errors');
} finally {await browser.close();}
