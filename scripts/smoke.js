// Boots the BUILT site in a real browser and fails on what CI could not see:
// a boot-time JS error, a broken index fetch path, a page that deploys blank.
// The corpus suites prove the data; this proves the thing that actually ships.
//
// puppeteer-core drives the system Chrome (channel: 'chrome') — no browser
// download at install time. GitHub's runners ship Chrome; locally, any
// desktop Chrome works. Run after `npm run build`: node scripts/smoke.js
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import puppeteer from 'puppeteer-core';

const PORT = 4199;
const URL = `http://localhost:${PORT}/`;

const fail = msg => { console.error(`smoke: ${msg}`); process.exitCode = 1; };

// vite's own binary via node, not npx: npx resolves differently on Windows
// and this script has to behave the same on a laptop as on the runner.
const server = spawn(process.execPath,
  ['node_modules/vite/bin/vite.js', 'preview', 'web', '--port', String(PORT), '--strictPort'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });

try {
  // What the served page SHOULD show, read from the same dist being served —
  // asserting against source data would pass while dist ships something else.
  const expected = JSON.parse(
    gunzipSync(readFileSync('web/dist/index.json.gz')).toString('utf8'),
  ).records.length;

  const up = async () => {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(URL)).ok) return;
      } catch { /* not yet */ }
      await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`preview server never answered on :${PORT}\n${serverLog}`);
  };
  await up();

  const browser = await puppeteer.launch({
    channel: 'chrome',
    // The runner's environment is happier without the sandbox; locally the
    // default sandbox stays on.
    args: process.env.CI ? ['--no-sandbox'] : [],
  });
  try {
    const page = await browser.newPage();
    // Uncaught exceptions are the failure this script exists for. Console
    // errors are only reported: the Ko-fi and GoatCounter scripts are external
    // and their availability is not this build's correctness.
    const errors = [];
    page.on('pageerror', err => errors.push(String(err)));
    page.on('console', m => { if (m.type() === 'error') console.warn(`smoke: console: ${m.text()}`); });

    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    // body.ready is the app's own "boot finished" signal; cards are the proof
    // the index actually parsed and rendered.
    await page.waitForFunction(() => document.body.classList.contains('ready'), { timeout: 30000 });
    await page.waitForSelector('.card', { timeout: 30000 });

    const seen = await page.evaluate(() => ({
      title: document.title,
      resultbar: document.querySelector('#resultbar')?.textContent ?? '',
      cards: document.querySelectorAll('.card').length,
      introShown: !document.querySelector('#intro').hidden,
    }));

    if (errors.length) fail(`page threw: ${errors.join(' | ')}`);
    if (!seen.title.includes('Siralim')) fail(`wrong page title "${seen.title}"`);
    if (!seen.cards) fail('no result cards rendered');
    const shown = expected.toLocaleString('en-US');
    if (!seen.resultbar.includes(shown)) {
      fail(`result bar "${seen.resultbar.trim()}" does not mention the ${shown} records dist carries`);
    }
    if (!seen.introShown) fail('start-view intro is not visible on a cold load');
    if (!process.exitCode) console.log(`smoke: ok — ${seen.cards} cards on screen, ${shown} records, no page errors`);
  } finally {
    await browser.close();
  }
} catch (err) {
  fail(err.message ?? String(err));
} finally {
  server.kill();
}
