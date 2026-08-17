// Versioned content: generator, authored journey stages, daily rotation,
// challenges, practice presets, lessons, and visual themes.
// Boards are solvable by construction: values are assigned by simulating a
// legal removal order over full stacks, then validated independently.

import { makeStream, hashString } from './rng.js';
import { makePairValues, planRemovalOrder, currentTarget, legalPairs, exposedTiles, applyCommand } from './engine.js';

export const CONTENT_VERSION = 1;

// ---------------------------------------------------------------------------
// layouts — named footprints on a discrete grid
// ---------------------------------------------------------------------------

function rectCells(w, h, ox = 0, oy = 0) {
  const cells = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells.push({ x: x + ox, y: y + oy });
  return cells;
}

export const LAYOUTS = {
  // flat rows
  row6: () => rectCells(6, 1),
  terrace8: () => rectCells(4, 2),
  terrace10: () => rectCells(5, 2),
  terrace12: () => rectCells(6, 2),
  // gentle arc / dome shapes
  arc9: () => [...rectCells(5, 1, 0, 1), ...rectCells(3, 1, 1, 0), ...[{ x: 2, y: 2 }]],
  dome12: () => [...rectCells(6, 1, 0, 2), ...rectCells(4, 1, 1, 1), ...rectCells(2, 1, 2, 0)],
  ring8: () => [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 2, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 }],
  spire7: () => [...rectCells(3, 2, 0, 1), { x: 1, y: 0 }],
  grid16: () => rectCells(4, 4),
  wide18: () => rectCells(6, 3),
  vault20: () => [...rectCells(6, 3), { x: 2, y: 3 }, { x: 3, y: 3 }],
  cross12: () => [...rectCells(4, 1, 1, 0), ...rectCells(4, 1, 1, 3), ...rectCells(6, 1, 0, 1), ...rectCells(6, 1, 0, 2).slice(1, 5)],
};

// ---------------------------------------------------------------------------
// board generation — guaranteed solvable by simulated removal order
// ---------------------------------------------------------------------------

export function generateBoard(content) {
  // authored boards (lessons) bypass generation but are still validated
  if (content.fixedValues) {
    const cells = LAYOUTS[content.layout]();
    if (content.fixedValues.length > cells.length) throw new Error('fixed board exceeds layout cells');
    const heights = content.fixedValues.map(col => col.length);
    const total = heights.reduce((a, b) => a + b, 0);
    if (total % 2 !== 0) throw new Error('fixed board has odd tile count');
    return {
      cells: cells.slice(0, content.fixedValues.length),
      heights,
      values: content.fixedValues.map(col => col.slice()),
      targetSequence: content.fixedTargets ? content.fixedTargets.slice() : null,
    };
  }
  const seed = typeof content.seed === 'string' ? hashString(content.seed) : content.seed >>> 0;
  const rng = makeStream(seed ^ 0xb0a3d);
  const cells = LAYOUTS[content.layout]();
  const { pairs, layers } = content;
  const totalTiles = pairs * 2;
  const capacity = cells.length * (content.layers?.max ?? 1);
  if (capacity < totalTiles) throw new Error(`layout ${content.layout} holds ${capacity} tiles but ${totalTiles} are needed`);

  for (let attempt = 0; attempt < 64; attempt++) {
    const aRng = rng.fork('attempt-' + attempt);
    const heights = assignHeights(aRng, cells.length, totalTiles, layers);
    if (!heights) continue;
    // tile ids are assigned bottom→top per stack, matching engine.createGame
    const tiles = {};
    const stacks = [];
    let id = 0;
    for (let s = 0; s < cells.length; s++) {
      const col = [];
      for (let level = 0; level < heights[s]; level++) {
        tiles[id] = { id, stack: s, level, value: 0 };
        col.push(id++);
      }
      stacks.push(col);
    }
    const simState = {
      stacks, layout: { cells }, tiles,
      ruleset: content.ruleset,
    };
    const order = planRemovalOrder(simState, aRng);
    if (!order || order.length !== pairs) continue;
    // Assign values: pair removed at step i gets values satisfying the rule.
    // For dynamic targets, generate the sequence first and use it here.
    const vRng = aRng.fork('values');
    let targetSeq = null;
    if (content.ruleset.dynamic) {
      const r = content.ruleset;
      targetSeq = [];
      for (let i = 0; i < pairs; i++) targetSeq.push(vRng.range(r.targetMin, r.targetMax));
    }
    for (let i = 0; i < order.length; i++) {
      const target = targetSeq ? targetSeq[i] : content.ruleset.target;
      const [va, vb] = makePairValues(content.ruleset, target, vRng);
      tiles[order[i][0]].value = va;
      tiles[order[i][1]].value = vb;
    }
    const values = stacks.map(col => col.map(tid => tiles[tid].value));
    return { cells, heights, values, targetSequence: targetSeq };
  }
  throw new Error(`could not generate solvable board for ${content.id}`);
}

function assignHeights(rng, cellCount, totalTiles, layers) {
  const min = layers?.min ?? 1, max = layers?.max ?? 1;
  // choose how many stacks to use, then give each a base height and
  // distribute the remainder randomly — guarantees per-stack min when feasible
  const loK = Math.ceil(totalTiles / max);
  let hiK = Math.min(cellCount, Math.floor(totalTiles / Math.max(min, 1)));
  if (hiK < loK) hiK = Math.min(cellCount, totalTiles); // relax min if infeasible
  if (hiK < loK) return null;
  const k = rng.range(loK, hiK);
  const chosen = rng.shuffle([...Array(cellCount).keys()]).slice(0, k);
  const heights = new Array(cellCount).fill(0);
  const base = Math.max(1, Math.min(min, max, Math.floor(totalTiles / k)));
  for (const s of chosen) heights[s] = base;
  let remaining = totalTiles - base * k;
  let guard = 0;
  while (remaining > 0 && guard++ < 100000) {
    const s = chosen[rng.int(k)];
    if (heights[s] < max) { heights[s]++; remaining--; }
  }
  return remaining === 0 ? heights : null;
}

// ---------------------------------------------------------------------------
// rule helpers
// ---------------------------------------------------------------------------

export function describeRule(ruleset) {
  switch (ruleset.rule) {
    case 'sum':
      return ruleset.dynamic
        ? `Remove pairs that add up to the shown target. The target changes after every pair.`
        : `Remove pairs of exposed tiles that add up to ${ruleset.target}.`;
    case 'match':
      return `Remove pairs of exposed tiles showing the same number.`;
    case 'diff':
      return `Remove pairs of exposed tiles whose numbers differ by exactly ${ruleset.diff}.`;
    default: return '';
  }
}

export function describeRuleShort(ruleset, target) {
  switch (ruleset.rule) {
    case 'sum': return `Make ${target}`;
    case 'match': return `Match equals`;
    case 'diff': return `Differ by ${ruleset.diff}`;
    default: return '';
  }
}

// ---------------------------------------------------------------------------
// journey — 44 authored stages with isolated → combined → mastery pacing
// ---------------------------------------------------------------------------

const T = Infinity;

function stage(n, name, opts) {
  return {
    contentVersion: CONTENT_VERSION,
    id: `journey-${String(n).padStart(2, '0')}`,
    kind: 'journey',
    index: n,
    name,
    seed: `journey-${n}-v${CONTENT_VERSION}`,
    ranked: false,
    mastery: false,
    tools: { hints: 3, reshuffles: 1, undo: true },
    limits: { moves: null, timeMs: null },
    layers: { min: 1, max: 1 },
    ...opts,
  };
}

export const JOURNEY = [
  // --- block 1: SUM fundamentals ---
  stage(1, 'First Light', { ruleset: { rule: 'sum', target: 10, valueMin: 1, valueMax: 9 }, layout: 'row6', pairs: 3, theme: 'ivory-dusk', par: { score: 300, timeMs: 60000 }, tutorial: 'sum' }),
  stage(2, 'Brass and Glass', { ruleset: { rule: 'sum', target: 10, valueMin: 1, valueMax: 9 }, layout: 'terrace8', pairs: 4, theme: 'ivory-dusk', par: { score: 420, timeMs: 75000 } }),
  stage(3, 'Quiet Meridian', { ruleset: { rule: 'sum', target: 12, valueMin: 1, valueMax: 9 }, layout: 'terrace10', pairs: 5, theme: 'ivory-dusk', par: { score: 540, timeMs: 90000 } }),
  stage(4, 'Star Charts', { ruleset: { rule: 'sum', target: 8, valueMin: 1, valueMax: 7 }, layout: 'dome12', pairs: 6, theme: 'ivory-dusk', par: { score: 660, timeMs: 100000 } }),
  stage(5, 'Mastery: Summation', { ruleset: { rule: 'sum', target: 11, valueMin: 1, valueMax: 9 }, layout: 'wide18', pairs: 7, theme: 'ivory-dusk', mastery: true, tools: { hints: 1, reshuffles: 0, undo: false }, par: { score: 800, timeMs: 100000 } }),
  // --- block 2: MATCH ---
  stage(6, 'Twin Stars', { ruleset: { rule: 'match', valueMin: 1, valueMax: 6 }, layout: 'terrace8', pairs: 4, theme: 'emerald-archive', tutorial: 'match', par: { score: 420, timeMs: 75000 } }),
  stage(7, 'Paired Lenses', { ruleset: { rule: 'match', valueMin: 1, valueMax: 8 }, layout: 'terrace10', pairs: 5, theme: 'emerald-archive', par: { score: 540, timeMs: 90000 } }),
  stage(8, 'Echoes', { ruleset: { rule: 'match', valueMin: 1, valueMax: 9 }, layout: 'terrace12', pairs: 6, theme: 'emerald-archive', par: { score: 660, timeMs: 100000 } }),
  stage(9, 'Harmonics', { ruleset: { rule: 'match', valueMin: 1, valueMax: 9 }, layout: 'wide18', pairs: 7, theme: 'emerald-archive', par: { score: 780, timeMs: 110000 } }),
  stage(10, 'Mastery: Resonance', { ruleset: { rule: 'match', valueMin: 1, valueMax: 9 }, layout: 'wide18', pairs: 8, theme: 'emerald-archive', mastery: true, tools: { hints: 1, reshuffles: 0, undo: false }, par: { score: 900, timeMs: 110000 } }),
  // --- block 3: DIFF ---
  stage(11, 'Parallax', { ruleset: { rule: 'diff', diff: 2, valueMin: 1, valueMax: 9 }, layout: 'terrace8', pairs: 4, theme: 'crimson-meridian', tutorial: 'diff', par: { score: 420, timeMs: 75000 } }),
  stage(12, 'Offset Orbits', { ruleset: { rule: 'diff', diff: 3, valueMin: 1, valueMax: 9 }, layout: 'terrace10', pairs: 5, theme: 'crimson-meridian', par: { score: 540, timeMs: 90000 } }),
  stage(13, 'Divergence', { ruleset: { rule: 'diff', diff: 1, valueMin: 1, valueMax: 9 }, layout: 'terrace12', pairs: 6, theme: 'crimson-meridian', par: { score: 660, timeMs: 100000 } }),
  stage(14, 'Wide Separation', { ruleset: { rule: 'diff', diff: 5, valueMin: 1, valueMax: 9 }, layout: 'wide18', pairs: 7, theme: 'crimson-meridian', par: { score: 780, timeMs: 110000 } }),
  stage(15, 'Mastery: Difference', { ruleset: { rule: 'diff', diff: 4, valueMin: 1, valueMax: 9 }, layout: 'wide18', pairs: 8, theme: 'crimson-meridian', mastery: true, tools: { hints: 1, reshuffles: 0, undo: false }, par: { score: 900, timeMs: 110000 } }),
  // --- block 4: layered stacks (deeper tiles) ---
  stage(16, 'Strata', { ruleset: { rule: 'sum', target: 10, valueMin: 1, valueMax: 9 }, layout: 'terrace8', pairs: 6, layers: { min: 1, max: 2 }, theme: 'ivory-dusk', tutorial: 'layers', par: { score: 700, timeMs: 120000 } }),
  stage(17, 'Buried Light', { ruleset: { rule: 'sum', target: 13, valueMin: 1, valueMax: 9 }, layout: 'arc9', pairs: 8, layers: { min: 1, max: 2 }, theme: 'ivory-dusk', par: { score: 900, timeMs: 130000 } }),
  stage(18, 'Deep Archive', { ruleset: { rule: 'match', valueMin: 1, valueMax: 9 }, layout: 'dome12', pairs: 9, layers: { min: 1, max: 2 }, theme: 'emerald-archive', par: { score: 1000, timeMs: 140000 } }),
  stage(19, 'Undercurrent', { ruleset: { rule: 'diff', diff: 2, valueMin: 1, valueMax: 9 }, layout: 'terrace10', pairs: 9, layers: { min: 1, max: 3 }, theme: 'crimson-meridian', par: { score: 1020, timeMs: 140000 } }),
  stage(20, 'Mastery: Depths', { ruleset: { rule: 'sum', target: 11, valueMin: 1, valueMax: 9 }, layout: 'dome12', pairs: 10, layers: { min: 2, max: 3 }, theme: 'frost-zenith', mastery: true, tools: { hints: 1, reshuffles: 1, undo: false }, par: { score: 1150, timeMs: 150000 } }),
  // --- block 5: side-locked tiles (classic mahjong exposure) ---
  stage(21, 'Shouldered', { ruleset: { rule: 'sum', target: 10, valueMin: 1, valueMax: 9, sideLock: true }, layout: 'terrace10', pairs: 5, theme: 'frost-zenith', tutorial: 'sidelock', par: { score: 600, timeMs: 120000 } }),
  stage(22, 'Braced Row', { ruleset: { rule: 'sum', target: 14, valueMin: 1, valueMax: 9, sideLock: true }, layout: 'wide18', pairs: 7, theme: 'frost-zenith', par: { score: 820, timeMs: 130000 } }),
  stage(23, 'Frozen Corridor', { ruleset: { rule: 'match', valueMin: 1, valueMax: 9, sideLock: true }, layout: 'wide18', pairs: 8, theme: 'frost-zenith', par: { score: 920, timeMs: 140000 } }),
  stage(24, 'Narrow Passage', { ruleset: { rule: 'diff', diff: 3, valueMin: 1, valueMax: 9, sideLock: true }, layout: 'wide18', pairs: 9, theme: 'frost-zenith', par: { score: 1020, timeMs: 150000 } }),
  stage(25, 'Mastery: Flanks', { ruleset: { rule: 'sum', target: 12, valueMin: 1, valueMax: 9, sideLock: true }, layout: 'wide18', pairs: 10, layers: { min: 1, max: 2 }, theme: 'frost-zenith', mastery: true, tools: { hints: 1, reshuffles: 1, undo: false }, par: { score: 1150, timeMs: 160000 } }),
  // --- block 6: dynamic targets ---
  stage(26, 'Shifting Sands', { ruleset: { rule: 'sum', dynamic: true, targetMin: 7, targetMax: 13, valueMin: 1, valueMax: 9 }, layout: 'terrace12', pairs: 6, theme: 'gilded-eclipse', tutorial: 'dynamic', par: { score: 720, timeMs: 130000 } }),
  stage(27, 'Wandering Star', { ruleset: { rule: 'sum', dynamic: true, targetMin: 6, targetMax: 14, valueMin: 1, valueMax: 9 }, layout: 'wide18', pairs: 8, theme: 'gilded-eclipse', par: { score: 940, timeMs: 140000 } }),
  stage(28, 'Unsteady Meridian', { ruleset: { rule: 'sum', dynamic: true, targetMin: 6, targetMax: 15, valueMin: 1, valueMax: 9 }, layout: 'terrace12', pairs: 9, layers: { min: 1, max: 2 }, theme: 'gilded-eclipse', par: { score: 1060, timeMs: 150000 } }),
  stage(29, 'Restless Sky', { ruleset: { rule: 'sum', dynamic: true, targetMin: 5, targetMax: 16, valueMin: 1, valueMax: 9, sideLock: true }, layout: 'wide18', pairs: 10, layers: { min: 1, max: 2 }, theme: 'gilded-eclipse', par: { score: 1160, timeMs: 160000 } }),
  stage(30, 'Mastery: Flux', { ruleset: { rule: 'sum', dynamic: true, targetMin: 6, targetMax: 15, valueMin: 1, valueMax: 9 }, layout: 'grid16', pairs: 11, layers: { min: 1, max: 2 }, theme: 'gilded-eclipse', mastery: true, tools: { hints: 1, reshuffles: 1, undo: false }, par: { score: 1250, timeMs: 170000 } }),
  // --- block 7: time pressure ---
  stage(31, 'Swift Transit', { ruleset: { rule: 'sum', target: 10, valueMin: 1, valueMax: 9 }, layout: 'terrace12', pairs: 6, limits: { moves: null, timeMs: 60000 }, theme: 'crimson-meridian', tutorial: 'timer', par: { score: 800, timeMs: 45000 } }),
  stage(32, 'Comet Chase', { ruleset: { rule: 'match', valueMin: 1, valueMax: 9 }, layout: 'wide18', pairs: 8, limits: { moves: null, timeMs: 75000 }, theme: 'crimson-meridian', par: { score: 1000, timeMs: 55000 } }),
  stage(33, 'Eclipse Window', { ruleset: { rule: 'diff', diff: 2, valueMin: 1, valueMax: 9 }, layout: 'terrace12', pairs: 9, layers: { min: 1, max: 2 }, limits: { moves: null, timeMs: 90000 }, theme: 'gilded-eclipse', par: { score: 1120, timeMs: 70000 } }),
  stage(34, 'Occultation', { ruleset: { rule: 'sum', dynamic: true, targetMin: 7, targetMax: 14, valueMin: 1, valueMax: 9 }, layout: 'grid16', pairs: 10, layers: { min: 1, max: 2 }, limits: { moves: null, timeMs: 100000 }, theme: 'gilded-eclipse', par: { score: 1200, timeMs: 80000 } }),
  stage(35, 'Mastery: Haste', { ruleset: { rule: 'sum', target: 12, valueMin: 1, valueMax: 9, sideLock: true }, layout: 'wide18', pairs: 11, layers: { min: 1, max: 2 }, limits: { moves: null, timeMs: 110000 }, theme: 'crimson-meridian', mastery: true, tools: { hints: 0, reshuffles: 1, undo: false }, par: { score: 1300, timeMs: 85000 } }),
  // --- block 8: combined mastery ---
  stage(36, 'Grand Terrace', { ruleset: { rule: 'sum', target: 13, valueMin: 1, valueMax: 9, sideLock: true }, layout: 'grid16', pairs: 12, layers: { min: 1, max: 3 }, theme: 'ivory-dusk', par: { score: 1350, timeMs: 200000 } }),
  stage(37, 'Silent Vault', { ruleset: { rule: 'match', valueMin: 1, valueMax: 9, sideLock: true }, layout: 'vault20', pairs: 12, layers: { min: 1, max: 3 }, theme: 'emerald-archive', limits: { moves: 16, timeMs: null }, par: { score: 1350, timeMs: 200000 } }),
  stage(38, 'Crimson Calculus', { ruleset: { rule: 'diff', diff: 4, valueMin: 1, valueMax: 9, sideLock: true }, layout: 'vault20', pairs: 13, layers: { min: 1, max: 2 }, theme: 'crimson-meridian', limits: { moves: 17, timeMs: null }, par: { score: 1450, timeMs: 210000 } }),
  stage(39, 'Golden Oscillation', { ruleset: { rule: 'sum', dynamic: true, targetMin: 5, targetMax: 16, valueMin: 1, valueMax: 9, sideLock: true }, layout: 'grid16', pairs: 13, layers: { min: 1, max: 2 }, limits: { moves: null, timeMs: 150000 }, theme: 'gilded-eclipse', par: { score: 1500, timeMs: 120000 } }),
  stage(40, 'Mastery: Convergence', { ruleset: { rule: 'sum', target: 11, valueMin: 1, valueMax: 9, sideLock: true }, layout: 'vault20', pairs: 14, layers: { min: 2, max: 3 }, theme: 'frost-zenith', mastery: true, tools: { hints: 0, reshuffles: 0, undo: false }, par: { score: 1600, timeMs: 240000 } }),
  // --- capstones ---
  stage(41, 'Observatory North', { ruleset: { rule: 'sum', dynamic: true, targetMin: 6, targetMax: 15, valueMin: 1, valueMax: 9, sideLock: true }, layout: 'vault20', pairs: 14, layers: { min: 1, max: 3 }, theme: 'ivory-dusk', tools: { hints: 1, reshuffles: 1, undo: true }, par: { score: 1600, timeMs: 240000 } }),
  stage(42, 'Observatory South', { ruleset: { rule: 'diff', diff: 1, valueMin: 1, valueMax: 9, sideLock: true }, layout: 'grid16', pairs: 14, layers: { min: 1, max: 3 }, limits: { moves: 18, timeMs: null }, theme: 'emerald-archive', tools: { hints: 1, reshuffles: 1, undo: true }, par: { score: 1600, timeMs: 240000 } }),
  stage(43, 'Observatory East', { ruleset: { rule: 'sum', target: 15, valueMin: 1, valueMax: 9, sideLock: true }, layout: 'vault20', pairs: 15, layers: { min: 2, max: 3 }, limits: { moves: null, timeMs: 180000 }, theme: 'crimson-meridian', tools: { hints: 1, reshuffles: 1, undo: true }, par: { score: 1700, timeMs: 150000 } }),
  stage(44, 'The Zenith', { ruleset: { rule: 'sum', dynamic: true, targetMin: 5, targetMax: 17, valueMin: 1, valueMax: 9, sideLock: true }, layout: 'vault20', pairs: 16, layers: { min: 2, max: 3 }, limits: { moves: 20, timeMs: 200000 }, theme: 'gilded-eclipse', mastery: true, tools: { hints: 0, reshuffles: 0, undo: false }, par: { score: 1900, timeMs: 170000 } }),
];

// ---------------------------------------------------------------------------
// daily — one shared seed + ruleset per UTC day, immutable after publication
// ---------------------------------------------------------------------------

const DAILY_RULESETS = [
  { rule: 'sum', target: 10, valueMin: 1, valueMax: 9 },                                  // Sun
  { rule: 'match', valueMin: 1, valueMax: 9 },                                            // Mon
  { rule: 'diff', diff: 3, valueMin: 1, valueMax: 9 },                                    // Tue
  { rule: 'sum', target: 12, valueMin: 1, valueMax: 9, sideLock: true },                  // Wed
  { rule: 'sum', dynamic: true, targetMin: 7, targetMax: 14, valueMin: 1, valueMax: 9 },  // Thu
  { rule: 'diff', diff: 2, valueMin: 1, valueMax: 9, sideLock: true },                    // Fri
  { rule: 'sum', target: 11, valueMin: 1, valueMax: 9, sideLock: true },                  // Sat
];
const DAILY_LAYOUTS = ['dome12', 'terrace12', 'wide18', 'grid16', 'vault20'];
const DAILY_THEMES = ['ivory-dusk', 'emerald-archive', 'crimson-meridian', 'frost-zenith', 'gilded-eclipse'];

// Excluded days: defective content is marked excluded from ranking, never
// silently replaced. Keyed by UTC date (YYYY-MM-DD).
export const DAILY_EXCLUDED = new Set();

export function dailyContent(dateISO, utcDayIndex) {
  const day = new Date(dateISO + 'T00:00:00Z');
  const weekday = day.getUTCDay();
  const seed = `daily-${dateISO}-v${CONTENT_VERSION}`;
  const rng = makeStream(hashString(seed) ^ 0xda121);
  const layout = rng.pick(DAILY_LAYOUTS);
  let maxLayers = rng.int(2) ? 2 : 3;
  // guarantee the layout can physically hold 14 pairs
  while (LAYOUTS[layout]().length * maxLayers < 28) maxLayers++;
  return {
    contentVersion: CONTENT_VERSION,
    id: `daily-${dateISO}`,
    kind: 'daily',
    name: `Daily — ${dateISO}`,
    date: dateISO,
    seed,
    ruleset: { ...DAILY_RULESETS[weekday] },
    layout,
    pairs: 14,
    layers: { min: 1, max: maxLayers },
    tools: { hints: 1, reshuffles: 1, undo: false },
    limits: { moves: null, timeMs: null },
    theme: DAILY_THEMES[utcDayIndex % DAILY_THEMES.length],
    ranked: !DAILY_EXCLUDED.has(dateISO),
    mastery: false,
    par: { score: 1500, timeMs: 240000 },
  };
}

// ---------------------------------------------------------------------------
// practice presets
// ---------------------------------------------------------------------------

export const PRACTICE = {
  easy: { ruleset: { rule: 'sum', target: 10, valueMin: 1, valueMax: 9 }, layout: 'terrace10', pairs: 5, layers: { min: 1, max: 1 } },
  medium: { ruleset: { rule: 'sum', target: 12, valueMin: 1, valueMax: 9 }, layout: 'dome12', pairs: 8, layers: { min: 1, max: 2 } },
  hard: { ruleset: { rule: 'match', valueMin: 1, valueMax: 9, sideLock: true }, layout: 'wide18', pairs: 11, layers: { min: 1, max: 2 } },
  expert: { ruleset: { rule: 'sum', dynamic: true, targetMin: 6, targetMax: 15, valueMin: 1, valueMax: 9, sideLock: true }, layout: 'vault20', pairs: 14, layers: { min: 1, max: 3 } },
};

export function practiceContent(difficulty, sessionSalt) {
  const p = PRACTICE[difficulty] || PRACTICE.easy;
  const seed = `practice-${difficulty}-${sessionSalt}`;
  return {
    contentVersion: CONTENT_VERSION,
    id: `practice-${difficulty}-${sessionSalt}`,
    kind: 'practice',
    name: `Practice — ${difficulty[0].toUpperCase()}${difficulty.slice(1)}`,
    seed,
    ruleset: { ...p.ruleset },
    layout: p.layout,
    pairs: p.pairs,
    layers: { ...p.layers },
    tools: { hints: Infinity, reshuffles: 2, undo: true },
    limits: { moves: null, timeMs: null },
    theme: 'ivory-dusk',
    ranked: false,
    mastery: false,
    par: { score: p.pairs * 110, timeMs: p.pairs * 15000 },
  };
}

// ---------------------------------------------------------------------------
// challenges — constrained goals
// ---------------------------------------------------------------------------

export const CHALLENGES = [
  { id: 'chal-sprint', name: 'Sprint: Ninety Seconds', ruleset: { rule: 'sum', target: 10, valueMin: 1, valueMax: 9 }, layout: 'vault20', pairs: 10, layers: { min: 1, max: 1 }, limits: { moves: null, timeMs: 90000 }, tools: { hints: 0, reshuffles: 1, undo: false }, theme: 'crimson-meridian', blurb: 'Clear the board before the lens closes. No hints.' },
  { id: 'chal-frugal', name: 'Frugal Astronomer', ruleset: { rule: 'sum', target: 11, valueMin: 1, valueMax: 9, sideLock: true }, layout: 'wide18', pairs: 12, layers: { min: 1, max: 2 }, limits: { moves: 13, timeMs: null }, tools: { hints: 1, reshuffles: 0, undo: false }, theme: 'frost-zenith', blurb: 'Twelve pairs, thirteen moves. One mistake is fatal.' },
  { id: 'chal-locked', name: 'The Locked Gallery', ruleset: { rule: 'match', valueMin: 1, valueMax: 9, sideLock: true }, layout: 'vault20', pairs: 12, layers: { min: 2, max: 3 }, limits: { moves: null, timeMs: null }, tools: { hints: 0, reshuffles: 0, undo: false }, theme: 'emerald-archive', blurb: 'Side-locked stacks, no tools at all.' },
  { id: 'chal-flux', name: 'Unstable Instrument', ruleset: { rule: 'sum', dynamic: true, targetMin: 5, targetMax: 16, valueMin: 1, valueMax: 9 }, layout: 'grid16', pairs: 12, layers: { min: 1, max: 2 }, limits: { moves: null, timeMs: 120000 }, tools: { hints: 1, reshuffles: 1, undo: false }, theme: 'gilded-eclipse', blurb: 'Shifting targets against the clock.' },
  { id: 'chal-monolith', name: 'Monolith', ruleset: { rule: 'diff', diff: 1, valueMin: 1, valueMax: 9, sideLock: true }, layout: 'terrace12', pairs: 12, layers: { min: 1, max: 2 }, limits: { moves: 14, timeMs: null }, tools: { hints: 0, reshuffles: 1, undo: false }, theme: 'ivory-dusk', blurb: 'Consecutive numbers only, in a tight corridor.' },
  { id: 'chal-zenith', name: 'Zenith Protocol', ruleset: { rule: 'sum', dynamic: true, targetMin: 6, targetMax: 16, valueMin: 1, valueMax: 9, sideLock: true }, layout: 'vault20', pairs: 15, layers: { min: 2, max: 3 }, limits: { moves: 18, timeMs: 180000 }, tools: { hints: 0, reshuffles: 0, undo: false }, theme: 'gilded-eclipse', blurb: 'Everything at once. The full examination.' },
];

export function challengeContent(id) {
  const c = CHALLENGES.find(x => x.id === id) || CHALLENGES[0];
  return {
    contentVersion: CONTENT_VERSION,
    kind: 'challenge',
    seed: `${c.id}-v${CONTENT_VERSION}`,
    ranked: true,
    mastery: false,
    par: { score: c.pairs * 115, timeMs: c.pairs * 14000 },
    ...c,
  };
}

// ---------------------------------------------------------------------------
// lessons (Learn mode) — tiny scripted boards, one rule at a time
// ---------------------------------------------------------------------------

export const LESSONS = [
  {
    id: 'lesson-sum', kind: 'lesson', name: 'Lesson 1 — Making Ten', contentVersion: CONTENT_VERSION,
    seed: 'lesson-sum-v1', theme: 'ivory-dusk', ranked: false,
    ruleset: { rule: 'sum', target: 10, valueMin: 1, valueMax: 9 },
    layout: 'row6', pairs: 3, layers: { min: 1, max: 1 },
    fixedValues: [[4], [7], [6], [3], [8], [2]],
    tools: { hints: Infinity, reshuffles: 0, undo: true }, limits: { moves: null, timeMs: null },
    par: { score: 300, timeMs: 120000 },
    script: [
      { text: 'Welcome to the observatory. Each round shows a rule at the top — this one asks you to make 10.' },
      { text: 'Tap a tile to select it. Try the 4 on the far left.', requireSelectValue: 4 },
      { text: 'Good. Now tap the 6 to complete the pair: 4 + 6 = 10.', requirePairValues: [4, 6] },
      { text: 'The pair is removed. Clear every tile to finish the round. Keyboard players: arrow keys move focus, Enter selects.' },
    ],
  },
  {
    id: 'lesson-match', kind: 'lesson', name: 'Lesson 2 — Twins', contentVersion: CONTENT_VERSION,
    seed: 'lesson-match-v1', theme: 'emerald-archive', ranked: false,
    ruleset: { rule: 'match', valueMin: 1, valueMax: 6 },
    layout: 'row6', pairs: 3, layers: { min: 1, max: 1 },
    fixedValues: [[3], [5], [2], [3], [5], [2]],
    tools: { hints: Infinity, reshuffles: 0, undo: true }, limits: { moves: null, timeMs: null },
    par: { score: 300, timeMs: 120000 },
    script: [
      { text: 'This round asks for twins — two tiles showing the same number.' },
      { text: 'Find two matching numbers and remove them. Use a hint any time with the H key.', free: true },
    ],
  },
  {
    id: 'lesson-layers', kind: 'lesson', name: 'Lesson 3 — Depths', contentVersion: CONTENT_VERSION,
    seed: 'lesson-layers-v1', theme: 'frost-zenith', ranked: false,
    ruleset: { rule: 'sum', target: 9, valueMin: 1, valueMax: 8 },
    layout: 'row6', pairs: 4, layers: { min: 1, max: 2 },
    fixedValues: [[1, 4], [8, 5], [2], [7], [3], [6]],
    tools: { hints: Infinity, reshuffles: 0, undo: true }, limits: { moves: null, timeMs: null },
    par: { score: 400, timeMs: 150000 },
    script: [
      { text: 'Some tiles are stacked. Only the top tile of each stack can be played.' },
      { text: 'Remove top tiles to uncover what lies beneath. Clear the board — make 9 with each pair.', free: true },
    ],
  },
  {
    id: 'lesson-sidelock', kind: 'lesson', name: 'Lesson 4 — Shoulders', contentVersion: CONTENT_VERSION,
    seed: 'lesson-sidelock-v1', theme: 'crimson-meridian', ranked: false,
    ruleset: { rule: 'sum', target: 10, valueMin: 1, valueMax: 9, sideLock: true },
    layout: 'terrace8', pairs: 4, layers: { min: 1, max: 1 },
    fixedValues: [[1], [4], [6], [9], [2], [3], [7], [8]],
    tools: { hints: Infinity, reshuffles: 1, undo: true }, limits: { moves: null, timeMs: null },
    par: { score: 400, timeMs: 150000 },
    script: [
      { text: 'In this round a tile is also locked while taller neighbours press against both its sides.' },
      { text: 'Dimmed tiles are locked. Free them by clearing their neighbours. Make 10 to remove a pair.', free: true },
    ],
  },
  {
    id: 'lesson-dynamic', kind: 'lesson', name: 'Lesson 5 — Shifting Target', contentVersion: CONTENT_VERSION,
    seed: 'lesson-dynamic-v1', theme: 'gilded-eclipse', ranked: false,
    ruleset: { rule: 'sum', dynamic: true, targetMin: 7, targetMax: 12, valueMin: 1, valueMax: 9 },
    layout: 'terrace8', pairs: 4, layers: { min: 1, max: 1 },
    fixedValues: [[4], [3], [5], [7], [2], [6], [5], [6]],
    fixedTargets: [9, 10, 8, 11],
    tools: { hints: Infinity, reshuffles: 0, undo: true }, limits: { moves: null, timeMs: null },
    par: { score: 400, timeMs: 150000 },
    script: [
      { text: 'Precision instruments drift: here the target changes after every pair you remove.' },
      { text: 'Watch the target dial and adapt. Clear the board to finish.', free: true },
    ],
  },
];

export function lessonContent(id) {
  const l = LESSONS.find(x => x.id === id) || LESSONS[0];
  return { mastery: false, ...l };
}

// ---------------------------------------------------------------------------
// themes — five visual themes (cosmetic only: never hitboxes/timing/power)
// ---------------------------------------------------------------------------

export const THEMES = {
  'ivory-dusk': {
    label: 'Ivory Dusk',
    desk: '#3a2f28', deskCloth: '#4a3d33', tile: '#f3ead8', tileEdge: '#d8cbb2', ink: '#3b3230',
    accent: '#e8b34b', glow: '#ffd98a', sky: '#1b2233', felt: '#2e4038',
    css: { bg: '#171a24', panel: '#232838', ink: '#ece4d4', accent: '#e8b34b', muted: '#9b94a8' },
  },
  'emerald-archive': {
    label: 'Emerald Archive',
    desk: '#22332b', deskCloth: '#2c4437', tile: '#eef3e4', tileEdge: '#c8d4b8', ink: '#27331f',
    accent: '#63c98a', glow: '#a5f0c3', sky: '#12211a', felt: '#1d3328',
    css: { bg: '#101a15', panel: '#1c2b23', ink: '#e4efe2', accent: '#63c98a', muted: '#8ba796' },
  },
  'crimson-meridian': {
    label: 'Crimson Meridian',
    desk: '#38222a', deskCloth: '#492b32', tile: '#f6e8dd', tileEdge: '#dcc0ae', ink: '#402428',
    accent: '#f0705e', glow: '#ffb09f', sky: '#221420', felt: '#3d2330',
    css: { bg: '#1d1116', panel: '#2e1b22', ink: '#f2e2d8', accent: '#f0705e', muted: '#b08f93' },
  },
  'frost-zenith': {
    label: 'Frost Zenith',
    desk: '#26303e', deskCloth: '#31404f', tile: '#eef2f6', tileEdge: '#c3cedb', ink: '#24303e',
    accent: '#6cb8e8', glow: '#b5dcff', sky: '#101c2c', felt: '#22303e',
    css: { bg: '#0e1620', panel: '#1a2634', ink: '#e2ecf4', accent: '#6cb8e8', muted: '#8ba2b6' },
  },
  'gilded-eclipse': {
    label: 'Gilded Eclipse',
    desk: '#2e2820', deskCloth: '#3d352a', tile: '#f7f0dc', tileEdge: '#d9cba4', ink: '#3a3020',
    accent: '#d9a441', glow: '#ffe2a0', sky: '#191410', felt: '#33291c',
    css: { bg: '#171208', panel: '#26200f', ink: '#efe6cc', accent: '#d9a441', muted: '#a89a78' },
  },
};

export function getTheme(id) { return THEMES[id] || THEMES['ivory-dusk']; }

// ---------------------------------------------------------------------------
// content assembly: content descriptor + generated board, ready for engine
// ---------------------------------------------------------------------------

export function prepareContent(content) {
  const board = generateBoard(content);
  const prepared = { ...content, __pairCount: content.pairs };
  if (board.targetSequence) {
    prepared.ruleset = { ...content.ruleset };
    prepared.__fixedTargetSequence = board.targetSequence;
  }
  return { content: prepared, board };
}
