// multi-select on the timeline: rubber band (Shift-drag), Cmd-click, track-name click, Del, undo, group move
import puppeteer from 'puppeteer-core';
const [url, out] = process.argv.slice(2); const sleep = ms => new Promise(r => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', defaultViewport: { width: 1600, height: 1000 } });
const p = await b.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e)));
await p.goto(url, { waitUntil: 'networkidle2' }); await p.waitForSelector('.card');
await (await p.$$('.card'))[0].click(); await p.keyboard.press('Enter');
await p.waitForFunction(() => document.querySelector('#video').readyState >= 1, { timeout: 20000 });
await p.evaluate(() => { seekTo(515); P.tlWin = 40; }); await sleep(800);
const g = await p.evaluate(() => { const r = tl.getBoundingClientRect(), [a, b] = win(curT()), w = r.width - 10 - TL.left;
  return { a, b, w, left: r.left + TL.left, top: r.top, rows: rows(), ry: r.top + TL.ovH + 4 + TL.rulerH, rh: TL.rowH, labX: r.left + 40 }; });
const X = t => g.left + (t - g.a) / (g.b - g.a) * g.w, Y = K => g.ry + g.rows.indexOf(K) * g.rh + g.rh / 2;
const cntF = () => p.evaluate(() => P.marks.tracks.F.spans.length);
const f0 = await cntF();
// rubber band over F and scene rows, 505..512 s
await p.keyboard.down('Shift'); await p.mouse.move(X(505), Y('F')); await p.mouse.down(); await p.mouse.move(X(508), Y("'")); await p.mouse.move(X(512), Y("'")); await p.mouse.up(); await p.keyboard.up('Shift'); await sleep(200);
const n1 = await p.evaluate(() => P.msel.size); await p.screenshot({ path: out });
console.log('band selected', n1);
await p.keyboard.press('Delete'); await sleep(200); const f1 = await cntF(); console.log('F before', f0, 'after delete', f1);
await p.keyboard.down('Meta'); await p.keyboard.press('KeyZ'); await p.keyboard.up('Meta'); await sleep(200); console.log('after undo', await cntF());
// track-name click = all F marks in view, then Cmd-click one to drop it
await p.mouse.click(g.labX, Y('F')); await sleep(100); const n2 = await p.evaluate(() => P.msel.size);
const first = await p.evaluate(() => { const [a, b] = win(curT()); return P.marks.tracks.F.spans.find(s => s[0] >= a + 2)[0]; });
await p.keyboard.down('Meta'); await p.mouse.click(X(first), Y('F')); await p.keyboard.up('Meta'); await sleep(100);
console.log('label click selected', n2, 'after cmd-click', await p.evaluate(() => P.msel.size));
// drag the group by +1 s
const before = await p.evaluate(() => [...P.msel].slice(0, 3).map(s => s[0]));
const anyT = await p.evaluate(() => [...P.msel][5][0]);
await p.mouse.move(X(anyT), Y('F')); await p.mouse.down(); for (let i = 1; i <= 6; i++) { await p.mouse.move(X(anyT + i / 6), Y('F')); await sleep(20); } await p.mouse.up(); await sleep(200);
const after = await p.evaluate(() => [...P.msel].slice(0, 3).map(s => s[0]));
console.log('group move', JSON.stringify(before), '->', JSON.stringify(after));
await p.keyboard.press('Escape'); console.log('esc clears', await p.evaluate(() => P.msel.size));
console.log('errors', JSON.stringify(errs)); await b.close();
