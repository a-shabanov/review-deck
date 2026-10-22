// Capture the live interface against a prepared, disposable demo library.
// Usage: REVIEW_DECK_TEST_PASSWORD=... node tests/capture-docs.mjs URL OUTPUT_DIRECTORY
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const [url, out] = process.argv.slice(2);
await fs.mkdir(out, {recursive:true});
const browser = await puppeteer.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, defaultViewport:{width:1920,height:1080,deviceScaleFactor:1}});
try {
  const page = await browser.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('response',r=>{if(r.status()>=400)errors.push(`${r.status()} ${new URL(r.url()).pathname}`);});
  await page.authenticate({username:'review',password:process.env.REVIEW_DECK_TEST_PASSWORD});
  await page.setViewport({width:1920,height:760,deviceScaleFactor:1});
  await page.goto(url,{waitUntil:'networkidle2'});
  await page.waitForSelector('.card');
  await page.waitForFunction(()=>[...document.querySelectorAll('.card .th')].every(e=>e.style.backgroundImage));
  // Wait for real thumbnail pixels, not just their URL to be assigned.
  await page.evaluate(async()=>{await Promise.all([...document.querySelectorAll('.card .th')].map(e=>new Promise((resolve,reject)=>{const im=new Image();im.onload=resolve;im.onerror=reject;im.src=e.style.backgroundImage.slice(5,-2);})));});
  await page.mouse.move(1900,1060);
  await page.screenshot({path:path.join(out,'library.png')});
  await page.setViewport({width:1920,height:1080,deviceScaleFactor:1});
  await (await page.$$('.card'))[0].click();
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.querySelector('#video').readyState>=2);
  await page.evaluate(()=>{pause();P.tlWin=75;seekTo(38);});
  await page.waitForFunction(()=>Math.abs(document.querySelector('#video').currentTime-38)<.1 && !document.querySelector('#video').seeking);
  await new Promise(r=>setTimeout(r,350));
  await page.screenshot({path:path.join(out,'timeline.png')});
  assert.equal(await page.$eval('#tlBtn',e=>e.textContent),'Таймлайн: Разметка');
  await page.click('#tlBtn');
  await page.waitForFunction(()=>document.querySelector('#tlBtn').textContent==='Таймлайн: Правки');
  await page.evaluate(()=>{P.tlWin=75;seekTo(97.5);});
  await page.waitForFunction(()=>Math.abs(document.querySelector('#video').currentTime-97.5)<.1 && !document.querySelector('#video').seeking);
  await new Promise(r=>setTimeout(r,1900));
  await page.mouse.move(1900,1060);
  await page.screenshot({path:path.join(out,'review.png')});
  // Confirm the catalog and help show the new participant terminology too.
  await page.click('#pTagBtn');
  await page.waitForSelector('#tagger:not(.hidden)');
  assert.equal(await page.$eval('#tagger [data-k="people"]',e=>e.textContent),'Участники');
  await page.keyboard.press('Escape');
  const info=await page.evaluate(()=>({title:document.querySelector('#tlBtn').textContent,overflow:document.documentElement.scrollWidth>innerWidth}));
  assert.equal(info.overflow,false);
  const header=await page.evaluate(()=>[...document.querySelectorAll('#player .bar > *')].map(e=>({text:e.textContent.slice(0,25),right:Math.round(e.getBoundingClientRect().right)})));
  assert.ok(header.every(e=>e.right<=1920),'Player header must fit the viewport');
  assert.deepEqual(errors,[]);
  console.log('PASS: library, annotation timeline, review timeline, participant panel; no JS/network errors');
} finally {await browser.close();}
