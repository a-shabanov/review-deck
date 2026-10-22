// UI check: marks get captions with N, captions show on the timeline and over the video.
// usage: node caption.mjs http://127.0.0.1:8766/ out.png   (server on a throwaway library)
import puppeteer from 'puppeteer-core';
const [url, out] = process.argv.slice(2); const sleep = ms => new Promise(r => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1600, height: 1000 } });
const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e)));
p.on('dialog', d => d.accept('Уточнить монтажный переход'));
await p.goto(url, { waitUntil: 'networkidle2' }); await p.waitForSelector('.card');
await (await p.$$('.card'))[0].click(); await p.keyboard.press('Enter');
await p.waitForFunction(() => document.querySelector('#video').readyState >= 1, { timeout: 20000 }); await sleep(600);
await p.evaluate(() => { trackOf('Z').spans = [[40, 46]]; seekTo(43); P.tlWin = 60; P.sel = { K: 'Z', i: 0 }; });
await p.keyboard.press('KeyN'); await sleep(500);
const sp = await p.evaluate(() => JSON.stringify(P.marks.tracks.Z.spans)); console.log('Z spans', sp);
const held = await p.evaluate(() => document.querySelector('#held').textContent); console.log('overlay:', held);
await p.screenshot({ path: out });
await p.evaluate(() => { P.marks.tracks.Z.spans = []; save(); }); await sleep(600);
console.log('errors', JSON.stringify(errs)); await b.close();
