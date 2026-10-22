// screenshot of the player with the library's real track config (rows, group separators)
import puppeteer from 'puppeteer-core';
const [url, out, t] = process.argv.slice(2); const sleep = ms => new Promise(r => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1600, height: 1000 } });
const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e)));
await p.goto(url, { waitUntil: 'networkidle2' }); await p.waitForSelector('.card');
await (await p.$$('.card'))[0].click(); await p.keyboard.press('Enter');
await p.waitForFunction(() => document.querySelector('#video').readyState >= 1, { timeout: 20000 });
await p.evaluate(t => { seekTo(+t); P.tlWin = 40; }, t || 515); await sleep(1500);
console.log('timeline height', await p.evaluate(() => document.querySelector('#timeline').offsetHeight), 'stage', await p.evaluate(() => document.querySelector('#stage').offsetHeight));
await p.screenshot({ path: out }); console.log('errors', JSON.stringify(errs)); await b.close();
