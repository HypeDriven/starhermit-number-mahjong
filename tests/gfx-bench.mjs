// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts the Expert practice board and keeps clearing pairs by tapping the tiles on the 3D board (the
// rules engine's first legal pair, located through the renderer's own tile projection, like a player),
// reshuffling when stuck and replaying from the results — tile lifts, removals, sparks, dust and the
// lamp shimmer run all the time.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForFunction(() => window.__nm && window.__nm.phase === 'title', null, { timeout: 20000 });
  await page.click('[data-act="settings"]');
  await page.waitForSelector('#gfx-preset');
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.click('[data-act="back"]');
  await page.waitForFunction(() => window.__nm.phase === 'title');
}

const nextMove = (page) => page.evaluate(async () => {
  const app = window.__nm;
  if (!app || app.phase !== 'active' || !app.state || app.state.status !== 'active') return { phase: app?.phase };
  const E = await import('./js/rules/engine.js');
  const pairs = E.legalPairs(app.state);
  if (!pairs.length) return { stuck: true, reshuffles: app.state.tools?.reshuffles ?? 0 };
  const [a, b] = pairs[0];
  return { pa: app.renderer?.tileScreenPos(a), pb: app.renderer?.tileScreenPos(b), a, b };
});

async function tap(page, pos, id) {
  if (pos) await page.mouse.click(pos.x, pos.y);
  else await page.locator(`#board2d [data-tile="${id}"]`).click({ timeout: 3000 });
}

async function begin(page) {
  const btn = page.locator('[data-act="begin"]');
  if (await btn.count()) await btn.click({ timeout: 3000 });
  await page.waitForFunction(() => window.__nm.phase === 'active', null, { timeout: 15000 });
}

async function step(page) {
  const m = await nextMove(page);
  if (m.phase === 'results') {
    await page.click('[data-act="retry"]', { timeout: 3000 });
    return begin(page);
  }
  if (m.phase) return;
  if (m.stuck) {
    if (m.reshuffles) return page.click('#btn-reshuffle', { timeout: 3000 });
    return page.click('#btn-pause').then(() => page.click('#btn-pause-restart', { timeout: 3000 })).catch(() => {});
  }
  await tap(page, m.pa, m.a);
  await page.waitForTimeout(200);
  await tap(page, m.pb, m.b);
}

export async function start(page) {
  await page.click('[data-act="practice"]');
  await page.click('[data-practice="expert"]');
  await begin(page);
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(450).catch(() => {});
    }
  })();
  await page.waitForTimeout(1500);
}
