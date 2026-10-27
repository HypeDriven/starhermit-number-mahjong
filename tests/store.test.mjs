// The game's data (js/store.js): the progress merge used on save conflicts and
// for the browser build's cloud save, the browser build's save and settings
// as migrated, the options' validation, local boards and the replay cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeProgress, normalizeProgress, normalizeSave, readForeign, pickOptions, createStore, BROWSER_KEYS, OPTION_KEYS, sameProgress } from '../js/store.js';

test('progress merges per stage, union of lessons, earliest achievements, best dailies and challenges, larger totals', () => {
  const a = { journey: { 'journey-01': { stars: 2, bestScore: 500, bestMs: 9000, completions: 1 } }, lessons: { 'lesson-sum': { completed: true } },
    achievements: { 'first-clear': 200 }, dailyHistory: { '2026-10-01': { score: 100, completed: false } }, challenges: { 'chal-sprint': { score: 900, elapsedMs: 1 } },
    totals: { pairs: 10, wins: 1, plays: 3 }, masteryXp: 20 };
  const b = { journey: { 'journey-01': { stars: 3, bestScore: 400, bestMs: 8000, completions: 2 }, 'journey-02': { stars: 1, bestScore: 10, bestMs: 1, completions: 1 } },
    achievements: { 'first-clear': 100, zenith: 5 }, dailyHistory: { '2026-10-01': { score: 50, completed: true } }, challenges: { 'chal-sprint': { score: 800, elapsedMs: 2 } },
    totals: { pairs: 5, wins: 4, plays: 2 }, masteryXp: 5, lastDailyDate: '2026-10-01' };
  const m = mergeProgress(a, b);
  assert.deepEqual(m.journey['journey-01'], { stars: 3, bestScore: 500, bestMs: 8000, completions: 2 });
  assert.ok(m.journey['journey-02']);
  assert.equal(m.lessons['lesson-sum'].completed, true);
  assert.deepEqual(m.achievements, { 'first-clear': 100, zenith: 5 });
  assert.deepEqual(m.dailyHistory['2026-10-01'], { score: 100, completed: true });
  assert.equal(m.challenges['chal-sprint'].score, 900);
  assert.deepEqual(m.totals, { pairs: 10, wins: 4, plays: 3 });
  assert.equal(m.masteryXp, 20);
  assert.equal(m.lastDailyDate, '2026-10-01');
  assert.ok(sameProgress(mergeProgress(m, m), m), 'merging is idempotent');
});

test('damaged documents normalize to defaults', () => {
  const p = normalizeProgress({ journey: 'x', totals: { pairs: 'a' } });
  assert.deepEqual(p.journey, {});
  assert.equal(p.totals.pairs, 0);
  assert.deepEqual(normalizeSave(null).progress, normalizeProgress(null));
});

test("the browser build's cloud save gives its progress and its game options", () => {
  const old = { version: 1, savedAt: 123, progress: { journey: { 'journey-03': { stars: 2, bestScore: 1, bestMs: 2, completions: 1 } }, totals: { pairs: 4, wins: 1, plays: 1 } },
    settings: { music: 0.3, gfx: { preset: 'high' }, camera: 'top', board2d: true, palette: 'protanopia', themeOverride: 'frost-zenith', leftHanded: true, timingAssist: 'yes' } };
  const f = readForeign(JSON.stringify(old));
  assert.equal(f.savedAt, 123);
  assert.ok(f.progress.journey['journey-03']);
  assert.deepEqual(f.options, { camera: 'top', board2d: true, palette: 'protanopia', themeOverride: 'frost-zenith', leftHanded: true });
  assert.equal(readForeign('not json'), null);
  assert.equal(readForeign('[1]'), null);
});

test('options are validated; every option is one the browser build stored', () => {
  assert.deepEqual(pickOptions({ camera: 'side', palette: 'standard', board2d: 1, themeOverride: null }), { palette: 'standard', themeOverride: null });
  for (const k of OPTION_KEYS) assert.ok(BROWSER_KEYS.includes(k), k);
});

test('local boards keep the best entries in tie-break order; replays are capped', () => {
  const values = new Map();
  let t = 0;
  const s = createStore({ get: (k) => values.get(k) ?? null, set: (k, v) => values.set(k, v), remove: (k) => values.delete(k), keys: () => [...values.keys()] }, () => ++t);
  const e = (score, invalidCount, elapsedMs, sessionId) => ({ score, invalidCount, elapsedMs, sessionId });
  assert.equal(s.submitBoardEntry('b', e(100, 0, 10, 'a')), 0);
  assert.equal(s.submitBoardEntry('b', e(100, 1, 5, 'b')), 1);
  assert.equal(s.submitBoardEntry('b', e(200, 3, 50, 'c')), 0);
  assert.equal(s.submitBoardEntry('b', e(1, 0, 1, 'd'), 3), -1);
  assert.deepEqual(s.loadBoard('b').map((x) => x.sessionId), ['c', 'a', 'b']);
  for (let i = 0; i < 70; i++) s.saveReplay('c' + i, { i });
  const replays = [...values.keys()].filter((k) => k.includes('.replay.'));
  assert.equal(replays.length, 60);
  assert.equal(s.loadReplay('c0'), null);
  assert.deepEqual(s.loadReplay('c69'), { i: 69 });
  s.resetAll();
  assert.equal(values.size, 0);
});
