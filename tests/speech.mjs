// speech layer: auto_speech / auto_expr rows and their captions follow the «Речь» button, independent of «Служебные»
import puppeteer from 'puppeteer-core';
const [url, out] = process.argv.slice(2); const sleep = ms => new Promise(r => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1600, height: 1000 } });
const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e)));
await p.goto(url, { waitUntil: 'networkidle2' }); await p.waitForSelector('.card');
await (await p.$$('.card'))[0].click(); await p.keyboard.press('Enter');
await p.waitForFunction(() => document.querySelector('#video').readyState >= 1, { timeout: 20000 });
await p.evaluate(() => { P.tlWin = 30; seekTo(184); }); await sleep(800);
const st = () => p.evaluate(() => ({ rows: rows().filter(K => K.startsWith('auto')), held: document.querySelector('#held').innerText.replace(/\n/g, ' | ') }));
console.log('on ', JSON.stringify(await st())); await p.screenshot({ path: out });
await p.click('#speechBtn'); await sleep(300); console.log('off', JSON.stringify(await st()));
await p.click('#speechBtn'); await sleep(300); console.log('on again', (await st()).rows);
console.log('errors', errs); await b.close();
