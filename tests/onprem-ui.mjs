// Usage: REVIEW_DECK_TEST_PASSWORD=... node tests/onprem-ui.mjs URL SCREENSHOT.png
// Run only against a synthetic/throwaway library: this check saves a test mark.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const [url, screenshot] = process.argv.slice(2);
const browser = await puppeteer.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, defaultViewport: {width: 1440, height: 1000}});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.authenticate({username: 'review', password: process.env.REVIEW_DECK_TEST_PASSWORD});
  await page.goto(url, {waitUntil: 'networkidle2'});
  await page.waitForSelector('.card');
  assert.equal(await page.$eval('#rootInput', e => e.disabled), true);
  assert.equal(await page.$eval('#rootBtn', e => e.disabled), true);
  await (await page.$$('.card'))[0].click();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#video').readyState >= 2);
  await page.evaluate(() => { trackOf('F').spans = [[.2, 1.5, 'On-prem test']]; seekTo(1); save(); });
  await page.waitForFunction(() => Math.abs(document.querySelector('#video').currentTime - 1) < .1);
  await new Promise(r => setTimeout(r, 700));
  const stored = await page.evaluate(async () => (await fetch('/api/marks?rel=' + encodeURIComponent(P.rel))).json());
  assert.deepEqual(stored.tracks.F.spans, [[.2, 1.5, 'On-prem test']]);
  if (screenshot) await page.screenshot({path: screenshot});
  assert.deepEqual(errors, []);
  console.log('PASS: authenticated UI, locked library, video playback/seek, captioned mark saved, no JS errors');
} finally { await browser.close(); }
