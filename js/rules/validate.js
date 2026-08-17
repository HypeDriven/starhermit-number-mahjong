// Offline content validators: prove basic legality, reachable goals, bounded
// duration, and absence of soft locks for every generated board.

import { createGame, legalPairs, applyCommand, exposedTiles } from './engine.js';
import { prepareContent } from './content.js';

// Prove a reachable goal by backtracking search over legal pairs, with
// memoization on the remaining-value multiset. A reshuffle tool covers
// recovery from player-caused dead ends; generation must guarantee at least
// one full solution path exists.
export function proveSolvable(content, board) {
  const state0 = createGame(content, board);
  const memo = new Set();
  let nodes = 0;
  const keyOf = (state) =>
    state.stacks.map(col => col.map(id => state.tiles[id].value).join('.')).join('|') + '#' + state.targetIndex;
  function dfs(state, depth) {
    if (state.status === 'won') return depth;
    if (state.status === 'lost') return -1;
    const k = keyOf(state);
    if (memo.has(k)) return -1;
    if (++nodes > 300000) return -1; // budget guard: no unbounded search
    for (const [a, b] of legalPairs(state)) {
      const next = applyCommand(state, { type: 'pair', tileA: a, tileB: b, atMs: (depth + 1) * 2500 }).state;
      if (next.status === 'won') return depth + 1;
      if (next.status === 'active' && dfs(next, depth + 1) >= 0) return depth + 1;
    }
    memo.add(k);
    return -1;
  }
  const moves = dfs(state0, 0);
  if (moves < 0) return { solvable: false, reason: 'no solution path within search budget' };
  return { solvable: true, moves, elapsedEstimateMs: moves * 2500, reason: E_cleared };
}
const E_cleared = 'cleared';

// Full solution path (list of [tileA, tileB]) from any active state, or null.
// Used by golden tests and by the hint-free "rescue" tooling in development.
export function findSolutionPath(state) {
  const memo = new Set();
  let nodes = 0;
  const keyOf = (s) =>
    s.stacks.map(col => col.map(id => s.tiles[id].value).join('.')).join('|') + '#' + s.targetIndex;
  function dfs(s, out) {
    if (s.status === 'won') return out;
    if (s.status === 'lost') return null;
    const k = keyOf(s);
    if (memo.has(k) || ++nodes > 300000) return null;
    for (const [a, b] of legalPairs(s)) {
      const n = applyCommand(s, { type: 'pair', tileA: a, tileB: b, atMs: s.elapsedMs }).state;
      if (n.status === 'won') return [...out, [a, b]];
      if (n.status === 'active') {
        const r = dfs(n, [...out, [a, b]]);
        if (r) return r;
      }
    }
    memo.add(k);
    return null;
  }
  return dfs(state, []);
}

export function validateContent(rawContent) {
  const errors = [];
  const c = rawContent;
  if (!c.id || typeof c.id !== 'string') errors.push('missing id');
  if (!c.seed) errors.push('missing seed');
  if (!c.ruleset || !['sum', 'match', 'diff'].includes(c.ruleset.rule)) errors.push('bad rule');
  if (c.ruleset?.rule === 'sum' && !c.ruleset.dynamic && typeof c.ruleset.target !== 'number') errors.push('sum rule needs target');
  if (c.ruleset?.rule === 'diff' && typeof c.ruleset.diff !== 'number') errors.push('diff rule needs diff');
  if (!Number.isInteger(c.pairs) || c.pairs < 1 || c.pairs > 40) errors.push('pairs out of bounds');
  if (c.limits?.moves != null && c.limits.moves < c.pairs) errors.push('move limit below pair count: unreachable goal');
  if (errors.length) return { ok: false, errors };

  let prepared;
  try {
    prepared = prepareContent(c);
  } catch (e) {
    return { ok: false, errors: [`generation failed: ${e.message}`] };
  }
  const { content, board } = prepared;

  // basic legality: even tile count, values in range
  const values = board.values.flat();
  if (values.length !== c.pairs * 2) errors.push(`tile count ${values.length} != ${c.pairs * 2}`);
  for (const v of values) {
    if (v < c.ruleset.valueMin || v > c.ruleset.valueMax) errors.push(`value ${v} out of range`);
  }

  // reachable goal / no soft lock
  const proof = proveSolvable(content, board);
  if (!proof.solvable) errors.push(`not solvable: ${proof.reason}`);

  // bounded duration: generous bound is 20s per pair
  if (proof.solvable && proof.elapsedEstimateMs > c.pairs * 20000) errors.push('duration estimate out of bounds');

  // move-limit feasibility
  if (c.limits?.moves != null && proof.moves > c.limits.moves) errors.push('solution exceeds move limit');

  // initial exposure sanity
  const state = createGame(content, board);
  if (exposedTiles(state).length < 2) errors.push('fewer than two exposed tiles at start');
  if (!legalPairs(state).length && state.tools.reshuffles <= 0) errors.push('no opening legal pair');

  return { ok: errors.length === 0, errors, proof };
}
