// Plays the web package in Chrome on the machine's GPU (~/games/tools/
// gpu-chrome.mjs; GPU_ADAPTER=software for headless SwiftShader), the loader
// index.html that `npm run package` writes, at a desktop viewport, a phone
// (DPR 3) and a phone held sideways (DPR 3). Desktop: Journey stage 1 from
// the title, a drag on the felt (not a tap), a hint, the pause sheet, the board
// cleared by clicking the 3D tiles (found by their accessibility names) to
// the results. Phone: Lesson 1 by touch through its banner to the results.
// Landscape: the Sprint challenge cleared by touch against its timer.
// Screenshots of each step go to --shots. Fails on console errors or
// warnings, the runtime's error screen, or a round that does not finish.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
// Serves GAME_DIR on loopback (never tests/, tools/ or dot-names), the engine
// itself from wiki.starhermit.com as the loader pins it.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import * as E from '../js/rules/engine.js';
import { JOURNEY, prepareContent, challengeContent, lessonContent } from '../js/rules/content.js';
import { findSolutionPath } from '../js/rules/validate.js';

const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    for (const name of ['playwright-core', 'playwright']) {
      const p = join(r, 'node_modules', name);
      if (existsSync(p)) return createRequire(join(r, 'package.json'))(name);
    }
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  // The platform's clock (platform.serverTime / serverNow), as the game host answers it.
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

/** screens.ts tileLabel (English) of an exposed tile. */
function label(st, id) {
  const t = st.tiles[id], cell = st.layout.cells[t.stack];
  return [`tile ${t.value}, row ${cell.y + 1} column ${cell.x + 1}`, 'top of stack', st.ruleset.sideLock ? 'free' : ''].filter(Boolean).join(', ');
}
/** The solution's tile names, two a pair (tools/gen-plays.mjs). */
function solution(content, skip = 0) {
  const { content: c, board } = prepareContent(content);
  let st = E.createGame(c, board);
  const out = [];
  for (const [a, b] of findSolutionPath(st)) {
    out.push(label(st, a), label(st, b));
    st = E.applyCommand(st, { type: 'pair', tileA: a, tileB: b, atMs: 0 }).state;
  }
  return out.slice(skip);
}
// Lesson 1 asks for the 4 first, then its 6.
const lessonTiles = (() => {
  const { content: c, board } = prepareContent(lessonContent('lesson-sum'));
  let st = E.createGame(c, board);
  const id = (v) => E.exposedTiles(st).find((t) => st.tiles[t].value === v);
  const four = id(4), six = id(6);
  const first = [label(st, four), label(st, six)];
  st = E.applyCommand(st, { type: 'pair', tileA: four, tileB: six, atMs: 0 }).state;
  const rest = [];
  for (const [a, b] of findSolutionPath(st)) { rest.push(label(st, a), label(st, b)); st = E.applyCommand(st, { type: 'pair', tileA: a, tileB: b, atMs: 0 }).state; }
  return [...first, ...rest];
})();

const desktop = [
  ['shot', 'title'], ['role', 'Play'], ['wait', 1000], ['shot', 'setup'], ['role', 'Start round'], ['wait', 3500],
  ['drag'], ['wait', 300], ['key', 'KeyH'], ['wait', 800], ['shot', 'play'], ['key', 'Escape'], ['wait', 800], ['expect', 'Restart round'], ['shot', 'paused'],
  ['role', 'Resume'], ['wait', 800], ['tiles', solution(JOURNEY[0])], ['wait', 2500], ['expect', 'Board Cleared'], ['shot', 'results'],
];
const phone = [
  ['shot', 'title'], ['role', 'Learn'], ['wait', 1000], ['shot', 'learn'], ['role', 'Start'], ['wait', 3500], ['shot', 'lesson'],
  ['role', 'Got it'], ['wait', 600], ['tiles', lessonTiles], ['wait', 2500], ['expect', 'Board Cleared'], ['shot', 'results'],
];
const landscape = [
  ['shot', 'title'], ['wheel', 300], ['wait', 600], ['role', 'Challenges'], ['wait', 1000], ['shot', 'challenges'], ['role', 'Attempt'], ['wait', 1000], ['shot', 'setup'], ['role', 'Start round'], ['wait', 3500],
  ['shot', 'play'], ['tiles', solution(challengeContent('chal-sprint'))], ['wait', 2500], ['expect', 'Board Cleared'], ['expect', 'Time bonus'], ['shot', 'results'],
];
const views = [
  { name: 'desktop', viewport: { width: 1280, height: 800 }, steps: desktop },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, steps: phone },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, steps: landscape },
];

const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
let failed = false;
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const cdp = v.hasTouch ? await ctx.newCDPSession(page) : null;
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    const platformRoute = /\/api\//.test(m.location()?.url ?? '');
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text()) && !platformRoute) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
  await page.waitForTimeout(4000); // the first press can be lost while the runtime starts up
  const press = async (loc) => (v.hasTouch ? loc.tap({ timeout: 10000 }) : loc.click({ timeout: 10000 }));
  const seen = async (text) => (await page.getByText(text).count().catch(() => 0)) > 0 || (await page.getByLabel(text).count().catch(() => 0)) > 0;
  /** Taps or clicks a 3D tile's accessibility target (ui.target: a button in the a11y mirror) at its centre. */
  async function tile(name) {
    const box = await page.getByRole('button', { name, exact: true }).first().boundingBox({ timeout: 10000 });
    if (!box) throw new Error(`tile not found: ${name}`);
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await page.waitForTimeout(60);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
  }
  for (const [op, a] of v.steps) {
    try {
      if (op === 'key') { await page.keyboard.down(a); await page.waitForTimeout(80); await page.keyboard.up(a); await page.waitForTimeout(80); }
      if (op === 'wait') await page.waitForTimeout(a);
      if (op === 'wheel') { const vp = page.viewportSize(); await page.mouse.move(vp.width / 2, vp.height / 2); await page.mouse.wheel(0, a); }
      if (op === 'role') await press(page.getByRole('button', { name: a, exact: true }).first());
      if (op === 'tiles') for (const name of a) { await tile(name); await page.waitForTimeout(450); }
      if (op === 'drag') {
        // a drag past 14 px on the felt is not a tap: nothing is chosen
        const vp = page.viewportSize();
        await page.mouse.move(vp.width * 0.2, vp.height * 0.85); await page.mouse.down();
        for (let i = 1; i <= 6; i++) { await page.waitForTimeout(16); await page.mouse.move(vp.width * 0.2 + i * 12, vp.height * 0.85); }
        await page.mouse.up();
      }
      if (op === 'expect' && !(await seen(a))) problems.push(`expected "${a}" on screen`);
      if (op === 'shot' && shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${a}.png`) }); }
    } catch (e) { problems.push(`${op} ${typeof a === 'string' ? a : JSON.stringify(a).slice(0, 80)}: ${e.message.split('\n')[0]}`); }
  }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state === 'running' && problems.length === 0;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);
