/**
 * Number Mahjong — end-to-end QA playthrough (dev only, not shipped).
 *
 * Drives the REAL visible UI in headless Chrome via playwright-core:
 *   title → settings open/close → journey map → stage 1 setup → countdown →
 *   active round → pause/resume → plays the board to a win by tapping tiles
 *   on the 3D canvas at their on-screen positions → results screen.
 *
 * The only state reads are for synchronization/timing (phase, legal pairs,
 * tile screen positions); every action is a real click/keypress on a visible
 * element. Runs two passes: desktop 1280x800 and mobile 390x844 (touch).
 *
 * The repo's server.js is a StarHermit authoritative game script, so this
 * test embeds its own minimal static server on an ephemeral port.
 *
 *   node tests/e2e.mjs     (npm run test:e2e)
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/number-mahjong-e2e-${stage}-${vp}.png`;

// benign GPU/swiftshader noise (from tools/production_game_audit.mjs) + favicon/autoplay
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions|favicon|Autoplay/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.ts': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    // platform time endpoint the game expects from the StarHermit host
    if (url.pathname === '/api/v1/time') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ utcMs: Date.now() }));
      return;
    }
    let file = path.normalize(decodeURIComponent(url.pathname));
    if (file === '/' || file === '\\') file = '/index.html';
    const abs = path.join(ROOT, file);
    if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(abs);
    res.writeHead(200, { 'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const step = async (name, fn) => {
  await fn();
  console.log(`ok - ${name}`);
};

// Read the rules engine + exposed app state to decide the next move; all
// actions afterwards go through the visible UI.
async function nextMove(page) {
  return page.evaluate(async () => {
    const app = window.__nm;
    if (!app || app.phase !== 'active' || !app.state || app.state.status !== 'active') {
      return { done: true, status: app?.state?.status, phase: app?.phase };
    }
    const E = await import('./js/rules/engine.js');
    const pairs = E.legalPairs(app.state);
    if (!pairs.length) {
      return { stuck: true, reshuffles: app.state.tools?.reshuffles ?? 0 };
    }
    const [a, b] = pairs[0];
    if (app.renderer) {
      return { pa: app.renderer.tileScreenPos(a), pb: app.renderer.tileScreenPos(b), a, b };
    }
    return { a, b }; // 2D fallback board
  });
}

async function tapTile(page, pos, id) {
  if (pos) {
    await page.mouse.click(pos.x, pos.y);
  } else {
    await page.locator(`#board2d [data-tile="${id}"]`).click();
  }
}

async function runPass(browser, vpName, contextOpts) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  try {
    await step(`${vpName}: load reaches title`, async () => {
      await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForFunction(() => window.__nm && window.__nm.phase === 'title', null, { timeout: 15000 });
      await page.screenshot({ path: SHOT('title', vpName) });
    });

    await step(`${vpName}: settings opens and closes`, async () => {
      await page.click('[data-act="settings"]');
      await page.waitForSelector('#app[data-screen="settings"]');
      await page.screenshot({ path: SHOT('settings', vpName) });
      await page.click('[data-act="back"]');
      await page.waitForSelector('#app[data-screen="title"]');
    });

    await step(`${vpName}: journey map shows stages`, async () => {
      await page.click('[data-act="journey"]');
      await page.waitForSelector('.stage-cell');
      const cells = await page.locator('.stage-cell').count();
      if (cells !== 44) throw new Error(`expected 44 stage cells, got ${cells}`);
      await page.screenshot({ path: SHOT('journey', vpName) });
    });

    await step(`${vpName}: stage 1 setup screen`, async () => {
      await page.click('[data-stage="journey-01"]');
      await page.waitForSelector('[data-act="begin"]');
      await page.screenshot({ path: SHOT('setup', vpName) });
    });

    await step(`${vpName}: begin round → active`, async () => {
      await page.click('[data-act="begin"]');
      await page.waitForFunction(() => window.__nm.phase === 'active', null, { timeout: 15000 });
      await page.waitForTimeout(800); // tiles settle
      await page.screenshot({ path: SHOT('play', vpName) });
    });

    await step(`${vpName}: pause and resume via HUD`, async () => {
      await page.click('#btn-pause');
      await page.waitForSelector('#overlay-pause:not([hidden])', { state: 'attached' });
      await page.screenshot({ path: SHOT('pause', vpName) });
      await page.click('#btn-resume');
      await page.waitForSelector('#overlay-pause[hidden]', { state: 'attached' });
      const phase = await page.evaluate(() => window.__nm.phase);
      if (phase !== 'active') throw new Error(`expected active after resume, got ${phase}`);
    });

    await step(`${vpName}: hint button reveals a pair`, async () => {
      await page.click('#btn-hint');
      await page.waitForFunction(() => window.__nm.state.hintedPair != null, null, { timeout: 5000 });
    });

    await step(`${vpName}: play board to a win via canvas taps`, async () => {
      for (let i = 0; i < 80; i++) {
        const move = await nextMove(page);
        if (move.done) break;
        if (move.stuck) {
          if (!move.reshuffles) throw new Error('board stuck with no reshuffles left');
          await page.click('#btn-reshuffle');
          await page.waitForTimeout(400);
          continue;
        }
        if (!move.pa && !move.a) throw new Error(`no actionable move: ${JSON.stringify(move)}`);
        await tapTile(page, move.pa, move.a);
        await page.waitForTimeout(160);
        await tapTile(page, move.pb, move.b);
        await page.waitForTimeout(320);
        if (i === 0) await page.screenshot({ path: SHOT('first-pair', vpName) });
      }
      await page.waitForFunction(() => window.__nm.phase === 'results', null, { timeout: 10000 });
    });

    await step(`${vpName}: results screen shows the win`, async () => {
      const text = await page.locator('.screen').innerText();
      if (!text.includes('Board Cleared')) throw new Error('results headline missing "Board Cleared"');
      if (!text.includes('Pairs removed')) throw new Error('score breakdown missing');
      const stars = await page.evaluate(() => window.__nm.progress.journey['journey-01']?.stars);
      if (!(stars >= 1)) throw new Error(`journey progress not recorded: ${stars}`);
      await page.screenshot({ path: SHOT('results', vpName) });
    });

    await step(`${vpName}: back to title`, async () => {
      await page.click('[data-act="back"]');
      await page.waitForFunction(() => window.__nm.phase === 'title');
    });
  } finally {
    const real = errors.filter((e) => !browserNoise.test(e));
    await context.close();
    if (real.length) {
      throw new Error(`${vpName}: ${real.length} console/page errors:\n${real.slice(0, 8).join('\n')}`);
    }
  }
}

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});

try {
  await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } });
  await runPass(browser, 'mobile', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  console.log('\nE2E PASSED (desktop + mobile)');
} finally {
  await browser.close();
  server.close();
}
