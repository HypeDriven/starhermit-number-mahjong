// End-to-end browser verification: boots the game in headless Chrome,
// plays full rounds through the real input path (DOM 2D board + pointer
// raycast on the 3D canvas), exercises pause/undo/hint, checks persistence,
// and captures screenshots for visual review.
//
//   node tests/browser-test.mjs [baseURL]

import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] || 'http://localhost:8123';
const SHOTS = '/tmp/nm-shots';
import { mkdirSync } from 'node:fs';
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function ok(cond, name) {
  console.log(`${cond ? '  ok' : 'FAIL'}: ${name}`);
  if (!cond) failures++;
}

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1440,900'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

await page.goto(BASE + '/', { waitUntil: 'networkidle0', timeout: 30000 });
await page.waitForFunction(() => window.__nm && window.__nm.phase === 'title', { timeout: 15000 });
ok(true, 'boot reaches title');
await page.screenshot({ path: SHOTS + '/01-title.png' });

// ---------------------------------------------------------------- journey --
await page.click('[data-act="journey"]');
await page.waitForFunction(() => document.querySelectorAll('.stage-cell').length === 44);
ok(true, 'journey map shows 44 stages');
const lockedCount = await page.$$eval('.stage-cell.locked', els => els.length);
ok(lockedCount === 43, `all but first stage locked initially (${lockedCount})`);
await page.screenshot({ path: SHOTS + '/02-journey.png' });

// open stage 1 setup
await page.click('[data-stage="journey-01"]');
await page.waitForSelector('[data-act="begin"]');
const setupText = await page.$eval('.screen', el => el.textContent);
ok(setupText.includes('add up to 10'), 'mode setup explains the sum rule');
ok(setupText.includes('unranked'), 'mode setup shows ranked status');
await page.screenshot({ path: SHOTS + '/03-setup.png' });

// begin round
await page.click('[data-act="begin"]');
await page.waitForFunction(() => window.__nm.phase === 'active', { timeout: 15000 });
ok(true, 'round becomes active after countdown');
await new Promise(r => setTimeout(r, 900));
await page.screenshot({ path: SHOTS + '/04-play-3d.png' });

const has3D = await page.evaluate(() => !!window.__nm.renderer && document.querySelector('#app').dataset.board2d === '0');
console.log('  3D renderer active:', has3D);

// play through the 2D DOM board (semantic mirror) using engine legality
const won1 = await page.evaluate(async () => {
  const app = window.__nm;
  const E = await import('./js/rules/engine.js');
  let guard = 0;
  while (app.state.status === 'active' && guard++ < 50) {
    const pairs = E.legalPairs(app.state);
    if (!pairs.length) return { fail: 'stuck' };
    const [a, b] = pairs[0];
    const btn = document.querySelector(`#board2d [data-tile="${a}"]`);
    btn.click();
    document.querySelector(`#board2d [data-tile="${b}"]`).click();
    await new Promise(r => setTimeout(r, 30));
  }
  return { status: app.state.status, phase: app.phase };
});
ok(won1.status === 'won', `stage 1 cleared through DOM input path (${JSON.stringify(won1)})`);

// results screen
await page.waitForFunction(() => window.__nm.phase === 'results', { timeout: 10000 });
const resultsText = await page.$eval('.screen', el => el.textContent);
ok(resultsText.includes('Board Cleared'), 'results headline');
ok(resultsText.includes('Pairs removed') && resultsText.includes('Clear bonus'), 'score breakdown shown');
ok(resultsText.includes('★'), 'stars shown');
const progress = await page.evaluate(() => window.__nm.progress.journey['journey-01']);
ok(progress && progress.stars >= 1, `journey progress persisted (${JSON.stringify(progress)})`);
await page.screenshot({ path: SHOTS + '/05-results.png' });

// ----------------------------------------------------------- persistence --
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__nm && window.__nm.phase === 'title');
const persisted = await page.evaluate(() => window.__nm.progress.journey['journey-01']?.stars);
ok(persisted >= 1, 'progress survives reload');

// --------------------------------------------------------------- practice --
await page.click('[data-act="practice"]');
await page.waitForSelector('[data-practice="medium"]');
await page.click('[data-practice="medium"]');
await page.click('[data-act="begin"]');
await page.waitForFunction(() => window.__nm.phase === 'active', { timeout: 15000 });

// hint flow
const hintWorks = await page.evaluate(async () => {
  const app = window.__nm;
  app.dispatch({ type: 'hint' });
  return !!app.state.hintedPair && app.state.hintsUsed === 1;
});
ok(hintWorks, 'hint command reveals a legal pair');

// undo flow
const undoWorks = await page.evaluate(async () => {
  const app = window.__nm;
  const E = await import('./js/rules/engine.js');
  const pairs = E.legalPairs(app.state);
  const before = app.state.pairsCleared;
  app.dispatch({ type: 'pair', tileA: pairs[0][0], tileB: pairs[0][1] });
  const after = app.state.pairsCleared;
  app.dispatch({ type: 'undo' });
  return after === before + 1 && app.state.pairsCleared === before;
});
ok(undoWorks, 'pair + undo restores');

// invalid pair gives feedback, no score penalty
const invalidOk = await page.evaluate(async () => {
  const app = window.__nm;
  const E = await import('./js/rules/engine.js');
  const exposed = E.exposedTiles(app.state);
  // find two exposed tiles that do NOT satisfy the rule
  for (let i = 0; i < exposed.length; i++) for (let j = i + 1; j < exposed.length; j++) {
    const a = app.state.tiles[exposed[i]], b = app.state.tiles[exposed[j]];
    if (!E.pairSatisfies(app.state, a.value, b.value)) {
      const scoreBefore = E.score(app.state).total;
      app.dispatch({ type: 'pair', tileA: a.id, tileB: b.id });
      return app.state.invalidCount === 1 && E.score(app.state).total === scoreBefore;
    }
  }
  return null;
});
ok(invalidOk, 'invalid pair: feedback without score penalty');

// pause / resume (first Esc cancels any selection, second opens pause)
await page.keyboard.press('Escape');
await new Promise(r => setTimeout(r, 150));
if (await page.$('#overlay-pause[hidden]')) await page.keyboard.press('Escape');
await page.waitForSelector('#overlay-pause:not([hidden])');
ok(true, 'Esc pauses and shows overlay');
const pausedClock = await page.evaluate(() => window.__nm.clock.now());
await new Promise(r => setTimeout(r, 400));
const pausedClock2 = await page.evaluate(() => window.__nm.clock.now());
ok(pausedClock === pausedClock2, 'authoritative clock stops while paused');
await page.screenshot({ path: SHOTS + '/06-pause.png' });
await page.click('#btn-resume');
await page.waitForSelector('#overlay-pause[hidden]');
ok(true, 'resume hides overlay');

// leave round
await page.keyboard.press('Escape');
await page.click('#btn-leave-round');
await page.waitForFunction(() => ['results', 'title'].includes(window.__nm.phase));
ok(true, 'leave round resolves cleanly');
if (await page.$('[data-act="back"]')) await page.click('[data-act="back"]');

// ----------------------------------------------------------------- daily ---
await page.waitForFunction(() => window.__nm.phase === 'title');
await page.click('[data-act="daily"]');
await page.waitForSelector('[data-act="begin"]');
const dailyText = await page.$eval('.screen', el => el.textContent);
ok(dailyText.includes('ranked') || dailyText.includes('excluded'), 'daily shows ranked status');
ok(/Seed/.test(dailyText), 'daily shows its seed');
await page.click('[data-act="begin"]');
await page.waitForFunction(() => window.__nm.phase === 'active', { timeout: 20000 });
await new Promise(r => setTimeout(r, 1200));
await page.screenshot({ path: SHOTS + '/07-daily.png' });
// undo must be rejected in ranked daily
const dailyUndoRejected = await page.evaluate(() => {
  const app = window.__nm;
  app.dispatch({ type: 'undo' });
  return app.state.undoCount === 0;
});
ok(dailyUndoRejected, 'undo rejected in ranked daily');

// ------------------------------------------------------------- challenge ---
await page.evaluate(() => window.__nm.leaveRound());
await page.waitForFunction(() => ['results', 'title'].includes(window.__nm.phase));
if (await page.$('[data-act="back"]')) await page.click('[data-act="back"]');
await page.waitForFunction(() => window.__nm.phase === 'title');
await page.click('[data-act="challenge"]');
await page.waitForSelector('[data-challenge="chal-sprint"]');
await page.click('[data-challenge="chal-sprint"]');
await page.click('[data-act="begin"]');
await page.waitForFunction(() => window.__nm.phase === 'active', { timeout: 20000 });
const timerVisible = await page.evaluate(() => !document.querySelector('#timer-block').hidden);
ok(timerVisible, 'timed challenge shows countdown');
await page.screenshot({ path: SHOTS + '/08-challenge.png' });
await page.evaluate(() => window.__nm.leaveRound());
await page.waitForFunction(() => ['results', 'title'].includes(window.__nm.phase));
if (await page.$('[data-act="back"]')) await page.click('[data-act="back"]');

// -------------------------------------------------------- 2D board toggle --
await page.waitForFunction(() => window.__nm.phase === 'title');
await page.evaluate(() => {
  const app = window.__nm;
  app.settings.board2d = true;
  app.ui.applyA11ySettings(app.settings);
});
await page.click('[data-act="practice"]');
await page.click('[data-practice="easy"]');
await page.click('[data-act="begin"]');
await page.waitForFunction(() => window.__nm.phase === 'active', { timeout: 15000 });
await new Promise(r => setTimeout(r, 500));
await page.screenshot({ path: SHOTS + '/09-board2d.png' });
await page.evaluate(() => { window.__nm.settings.board2d = false; window.__nm.ui.applyA11ySettings(window.__nm.settings); window.__nm.leaveRound(); });

// ---------------------------------------------------------------- mobile ---
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__nm && window.__nm.phase === 'title');
await page.screenshot({ path: SHOTS + '/10-mobile-title.png' });
await page.click('[data-act="play"]');
await page.click('[data-act="begin"]');
await page.waitForFunction(() => window.__nm.phase === 'active', { timeout: 15000 });
await new Promise(r => setTimeout(r, 800));
await page.screenshot({ path: SHOTS + '/11-mobile-play.png' });

// pointer raycast on the 3D canvas: tap the two tiles of a legal pair
const tapWorks = await page.evaluate(async () => {
  const app = window.__nm;
  if (!app.renderer) return 'no-renderer';
  const E = await import('./js/rules/engine.js');
  const pairs = E.legalPairs(app.state);
  if (!pairs.length) return 'no-pairs';
  const cleared = app.state.pairsCleared;
  for (const id of pairs[0]) {
    const pos = app.renderer.tileScreenPos(id);
    if (!pos) return 'no-pos';
    const el = document.elementFromPoint(pos.x, pos.y);
    // simulate pointer tap at the projected position
    for (const type of ['pointerdown', 'pointerup']) {
      const ev = new PointerEvent(type, { clientX: pos.x, clientY: pos.y, bubbles: true, pointerId: 1 });
      document.querySelector('#gl').dispatchEvent(ev);
    }
    await new Promise(r => setTimeout(r, 50));
  }
  return app.state.pairsCleared === cleared + 1 ? 'ok' : 'no-clear';
});
ok(tapWorks === 'ok', `3D canvas tap removes a pair (${tapWorks})`);
await page.screenshot({ path: SHOTS + '/12-mobile-after-tap.png' });

// ------------------------------------------------------- console errors ----
const realErrors = consoleErrors.filter(e => !e.includes('favicon') && !e.includes('Autoplay'));
ok(realErrors.length === 0, `no console errors (${realErrors.length})${realErrors.length ? '\n' + realErrors.slice(0, 5).join('\n') : ''}`);

await browser.close();
console.log(failures ? `\n${failures} FAILURES` : '\nBROWSER TESTS PASSED');
process.exit(failures ? 1 : 0);
