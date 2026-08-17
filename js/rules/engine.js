// Number Mahjong rules engine — pure, deterministic, serializable.
// No rendering, no DOM, no Date.now(): every command carries its own
// authoritative elapsed time so replays reproduce exactly.

import { makeStream, hashString } from './rng.js';

export const RULES_VERSION = 1;

export const TERMINAL = {
  CLEARED: 'cleared',       // every tile removed — victory
  NO_MOVES: 'no-moves',     // no legal pair and no reshuffles left
  OUT_OF_MOVES: 'out-of-moves',
  TIME_UP: 'time-up',
  ABANDONED: 'abandoned',
};

export const REJECT = {
  NOT_ACTIVE: 'round is not active',
  UNKNOWN_TILE: 'unknown tile',
  NOT_EXPOSED: 'tile is covered or blocked',
  SAME_TILE: 'cannot pair a tile with itself',
  RULE_MISMATCH: 'values do not satisfy the round rule',
  NO_SELECTION: 'no tile selected',
  NO_HINTS: 'no hints remaining',
  NO_RESHUFFLES: 'no reshuffles remaining',
  NO_UNDO: 'nothing to undo',
  UNDO_DISABLED: 'undo is not permitted in this mode',
  HINT_DISABLED: 'hints are not permitted in this mode',
  RESHUFFLE_DISABLED: 'reshuffle is not permitted in this mode',
  NO_LEGAL_PAIR: 'no legal pair exists to reshuffle into', // internal guard
  BAD_COMMAND: 'malformed command',
};

// ---------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------

// boardSpec: { cells: [{x,y}], heights: [h,...], values: [v per cell per level] }
// values[stackIndex] is an array bottom→top.
export function createGame(content, boardSpec) {
  const stacks = [];
  const tiles = {};
  let id = 0;
  for (let s = 0; s < boardSpec.cells.length; s++) {
    const col = [];
    for (let level = 0; level < boardSpec.heights[s]; level++) {
      const tile = { id: id++, value: boardSpec.values[s][level], stack: s, level };
      tiles[tile.id] = tile;
      col.push(tile.id);
    }
    stacks.push(col);
  }
  const rng = makeStream((typeof content.seed === 'string' ? hashString(content.seed) : content.seed >>> 0) ^ 0x51ed);
  // For dynamic targets, prefer the sequence the board was generated with so
  // the shown target always matches the values on the remaining tiles.
  const targetSequence = content.__fixedTargetSequence
    ? content.__fixedTargetSequence.slice()
    : buildTargetSequence(content, rng);
  const state = {
    version: RULES_VERSION,
    contentId: content.id,
    contentVersion: content.contentVersion || 1,
    seed: content.seed,
    ruleset: { ...content.ruleset },
    layout: { cells: boardSpec.cells.map(c => ({ x: c.x, y: c.y })) },
    stacks,
    tiles,
    selected: null,
    hintedPair: null,
    tick: 0,
    elapsedMs: 0,
    lastPairAtMs: 0,
    movesUsed: 0,
    hintsUsed: 0,
    invalidCount: 0,
    undoCount: 0,
    reshufflesUsed: 0,
    chain: 0,
    bestChain: 0,
    scoreParts: { pairs: 0, speed: 0, chain: 0, clear: 0, time: 0 },
    totalPairs: id / 2,
    pairsCleared: 0,
    tools: {
      hints: content.tools?.hints ?? 0,
      reshuffles: content.tools?.reshuffles ?? 0,
      undo: content.tools?.undo ?? false,
    },
    limits: { moves: content.limits?.moves ?? null, timeMs: content.limits?.timeMs ?? null },
    targetSequence,         // null unless dynamic targets
    targetIndex: 0,
    status: 'active',
    reason: null,
    rngState: rng.state,    // rules stream state (reshuffles / dynamic targets)
    history: [],
  };
  return state;
}

function buildTargetSequence(content, rng) {
  if (!content.ruleset.dynamic) return null;
  const pairs = content.__pairCount || 32; // filled by content generator
  const seq = [];
  const { valueMin, valueMax, targetMin, targetMax } = content.ruleset;
  for (let i = 0; i < pairs; i++) {
    seq.push(rng.range(targetMin ?? valueMin * 2, targetMax ?? valueMax * 2));
  }
  return seq;
}

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------

export function currentTarget(state) {
  if (state.targetSequence) return state.targetSequence[Math.min(state.targetIndex, state.targetSequence.length - 1)];
  return state.ruleset.target ?? null;
}

export function remainingTiles(state) {
  let n = 0;
  for (const s of state.stacks) n += s.length;
  return n;
}

function cellIndexAt(state, x, y) {
  const cells = state.layout.cells;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].x === x && cells[i].y === y) return i;
  }
  return -1;
}

export function isExposed(state, tileId) {
  const tile = state.tiles[tileId];
  if (!tile) return false;
  const col = state.stacks[tile.stack];
  if (!col.length || col[col.length - 1] !== tileId) return false; // top of stack only
  if (state.ruleset.sideLock) {
    // classic exposure: blocked only when BOTH horizontal neighbours reach
    // this tile's level; a single open side is enough
    const cell = state.layout.cells[tile.stack];
    let leftCovered = false, rightCovered = false;
    for (const dx of [-1, 1]) {
      const ni = cellIndexAt(state, cell.x + dx, cell.y);
      const covered = ni >= 0 && state.stacks[ni].length > tile.level;
      if (dx < 0) leftCovered = covered; else rightCovered = covered;
    }
    if (leftCovered && rightCovered) return false;
  }
  return true;
}

export function exposedTiles(state) {
  const out = [];
  for (let s = 0; s < state.stacks.length; s++) {
    const col = state.stacks[s];
    if (col.length && isExposed(state, col[col.length - 1])) out.push(col[col.length - 1]);
  }
  return out;
}

export function pairSatisfies(state, valueA, valueB) {
  const r = state.ruleset;
  switch (r.rule) {
    case 'sum': return valueA + valueB === currentTarget(state);
    case 'match': return valueA === valueB;
    case 'diff': return Math.abs(valueA - valueB) === r.diff;
    default: return false;
  }
}

// The single legal-action API used by play, hints, and tutorials alike.
export function legalPairs(state) {
  if (state.status !== 'active') return [];
  const exposed = exposedTiles(state);
  const out = [];
  for (let i = 0; i < exposed.length; i++) {
    for (let j = i + 1; j < exposed.length; j++) {
      const a = state.tiles[exposed[i]], b = state.tiles[exposed[j]];
      if (pairSatisfies(state, a.value, b.value)) out.push([a.id, b.id]);
    }
  }
  return out;
}

export function isTerminal(state) { return state.status === 'won' || state.status === 'lost'; }
export function terminalReason(state) { return state.reason; }

export function score(state) {
  const p = state.scoreParts;
  const total = p.pairs + p.speed + p.chain + p.clear + p.time;
  return { ...p, total };
}

// ---------------------------------------------------------------------------
// command validation + application
// ---------------------------------------------------------------------------

function cloneState(state) {
  const copy = JSON.parse(JSON.stringify({ ...state, history: [] }));
  copy.history = state.history;
  return copy;
}

function snapshotForUndo(state) {
  return JSON.stringify({ ...state, history: [] });
}

export function validateCommand(state, cmd) {
  if (!cmd || typeof cmd.type !== 'string') return { ok: false, reason: REJECT.BAD_COMMAND };
  const tools = state.tools;
  switch (cmd.type) {
    case 'select': {
      if (state.status !== 'active') return { ok: false, reason: REJECT.NOT_ACTIVE };
      const tile = state.tiles[cmd.tileId];
      if (!tile) return { ok: false, reason: REJECT.UNKNOWN_TILE };
      if (!isExposed(state, tile.id)) return { ok: false, reason: REJECT.NOT_EXPOSED };
      return { ok: true };
    }
    case 'pair': {
      if (state.status !== 'active') return { ok: false, reason: REJECT.NOT_ACTIVE };
      const a = state.tiles[cmd.tileA], b = state.tiles[cmd.tileB];
      if (!a || !b) return { ok: false, reason: REJECT.UNKNOWN_TILE };
      if (a.id === b.id) return { ok: false, reason: REJECT.SAME_TILE };
      if (!isExposed(state, a.id) || !isExposed(state, b.id)) return { ok: false, reason: REJECT.NOT_EXPOSED };
      if (!pairSatisfies(state, a.value, b.value)) return { ok: false, reason: REJECT.RULE_MISMATCH };
      return { ok: true };
    }
    case 'hint': {
      if (state.status !== 'active') return { ok: false, reason: REJECT.NOT_ACTIVE };
      if (!(tools.hints > 0)) return { ok: false, reason: REJECT.NO_HINTS }; // Infinity passes
      if (!legalPairs(state).length) return { ok: false, reason: REJECT.NO_LEGAL_PAIR };
      return { ok: true };
    }
    case 'reshuffle': {
      if (state.status !== 'active') return { ok: false, reason: REJECT.NOT_ACTIVE };
      if (tools.reshuffles <= 0) return { ok: false, reason: REJECT.NO_RESHUFFLES };
      return { ok: true };
    }
    case 'undo': {
      if (!tools.undo) return { ok: false, reason: REJECT.UNDO_DISABLED };
      if (!state.history.length) return { ok: false, reason: REJECT.NO_UNDO };
      return { ok: true };
    }
    case 'quit':
    case 'timeout':
      return { ok: true };
    default:
      return { ok: false, reason: REJECT.BAD_COMMAND };
  }
}

// Apply a validated command. Invalid commands are rejected (state unchanged,
// returned with `rejected` reason) — no exceptions, no partial mutation.
export function applyCommand(state, cmd) {
  const v = validateCommand(state, cmd);
  if (!v.ok) {
    if (cmd && (cmd.type === 'pair') && v.reason === REJECT.RULE_MISMATCH) {
      // Wrong-rule attempts are feedback, not errors: counted as a statistic
      // used only for tie-breaks. Score is never reduced.
      const next = cloneState(state);
      next.history = [...state.history];
      next.invalidCount++;
      next.chain = 0;
      next.selected = cmd.tileB;
      next.hintedPair = null;
      next.tick++;
      next.elapsedMs = Math.max(next.elapsedMs, cmd.atMs ?? next.elapsedMs);
      next.lastInvalid = { tileA: cmd.tileA, tileB: cmd.tileB, reason: v.reason };
      return { state: next, events: [{ type: 'invalid', reason: v.reason, tileA: cmd.tileA, tileB: cmd.tileB }] };
    }
    if (cmd && cmd.type === 'select' && v.reason === REJECT.NOT_EXPOSED) {
      const next = cloneState(state);
      next.history = [...state.history];
      next.invalidCount++;
      next.tick++;
      next.elapsedMs = Math.max(next.elapsedMs, cmd.atMs ?? next.elapsedMs);
      next.lastInvalid = { tileA: cmd.tileId, reason: v.reason };
      return { state: next, events: [{ type: 'invalid', reason: v.reason, tileA: cmd.tileId }] };
    }
    return { state, events: [{ type: 'rejected', reason: v.reason }] };
  }

  // Check timer before mutating: a command arriving after the limit ends the round.
  if (state.limits.timeMs != null && (cmd.atMs ?? 0) > state.limits.timeMs && cmd.type !== 'quit') {
    const next = cloneState(state);
    next.history = [...state.history];
    next.status = 'lost';
    next.reason = TERMINAL.TIME_UP;
    next.tick++;
    next.elapsedMs = cmd.atMs ?? next.elapsedMs;
    finalizeClearBonus(next);
    return { state: next, events: [{ type: 'terminal', reason: next.reason }] };
  }

  const prev = snapshotForUndo(state);
  const next = cloneState(state);
  next.history = [...state.history, prev];
  next.tick++;
  next.elapsedMs = Math.max(next.elapsedMs, cmd.atMs ?? next.elapsedMs);
  next.lastInvalid = null;
  const events = [];

  switch (cmd.type) {
    case 'select': {
      next.hintedPair = null;
      if (next.selected === cmd.tileId) {
        next.selected = null;
        events.push({ type: 'deselect', tile: cmd.tileId });
      } else {
        next.selected = cmd.tileId;
        events.push({ type: 'select', tile: cmd.tileId });
      }
      break;
    }
    case 'pair': {
      const a = next.tiles[cmd.tileA], b = next.tiles[cmd.tileB];
      removeTile(next, a.id);
      removeTile(next, b.id);
      next.movesUsed++;
      next.pairsCleared++;
      next.chain++;
      next.bestChain = Math.max(next.bestChain, next.chain);
      // scoring: base + speed + chain (all integers)
      const base = 100;
      const dt = next.pairsCleared === 1 ? 0 : next.elapsedMs - next.lastPairAtMs;
      const speed = dt > 0 && dt <= 4000 ? Math.round(50 * (1 - dt / 4000)) : 0;
      const chainBonus = Math.min(25 * (next.chain - 1), 150);
      next.scoreParts.pairs += base;
      next.scoreParts.speed += speed;
      next.scoreParts.chain += chainBonus;
      next.lastPairAtMs = next.elapsedMs;
      next.selected = null;
      next.hintedPair = null;
      events.push({ type: 'pair', tileA: a.id, tileB: b.id, values: [a.value, b.value], chain: next.chain, gained: base + speed + chainBonus });
      if (next.targetSequence) next.targetIndex++;
      checkTerminal(next, events);
      break;
    }
    case 'hint': {
      const pairs = legalPairs(next);
      const pair = pairs[0];
      next.hintedPair = pair;
      if (Number.isFinite(next.tools.hints)) next.tools.hints--;
      next.hintsUsed++;
      next.chain = 0;
      next.selected = null;
      events.push({ type: 'hint', tileA: pair[0], tileB: pair[1] });
      break;
    }
    case 'reshuffle': {
      next.tools.reshuffles--;
      next.reshufflesUsed++;
      next.chain = 0;
      next.selected = null;
      next.hintedPair = null;
      const rng = makeStream(next.rngState);
      reshuffleRemaining(next, rng);
      next.rngState = rng.state;
      events.push({ type: 'reshuffle' });
      // A reshuffle must always restore at least one legal pair.
      checkTerminal(next, events);
      break;
    }
    case 'undo': {
      const restored = JSON.parse(state.history[state.history.length - 1]);
      restored.history = state.history.slice(0, -1);
      restored.undoCount = state.undoCount + 1;
      restored.chain = 0;
      restored.tick = state.tick; // tick is monotonic: undo does not rewind it
      restored.elapsedMs = state.elapsedMs; // authoritative clock never rewinds
      events.push({ type: 'undo' });
      return { state: restored, events };
    }
    case 'timeout': {
      next.status = 'lost';
      next.reason = TERMINAL.TIME_UP;
      finalizeClearBonus(next);
      events.push({ type: 'terminal', reason: next.reason });
      break;
    }
    case 'quit': {
      next.status = 'lost';
      next.reason = TERMINAL.ABANDONED;
      finalizeClearBonus(next);
      events.push({ type: 'terminal', reason: next.reason });
      break;
    }
  }
  return { state: next, events };
}

function removeTile(state, tileId) {
  const col = state.stacks[state.tiles[tileId].stack];
  const i = col.indexOf(tileId);
  if (i >= 0) col.splice(i, 1);
}

function checkTerminal(state, events) {
  if (remainingTiles(state) === 0) {
    state.status = 'won';
    state.reason = TERMINAL.CLEARED;
    finalizeClearBonus(state);
    events.push({ type: 'terminal', reason: state.reason });
    return;
  }
  if (state.limits.moves != null && state.movesUsed >= state.limits.moves) {
    state.status = 'lost';
    state.reason = TERMINAL.OUT_OF_MOVES;
    finalizeClearBonus(state);
    events.push({ type: 'terminal', reason: state.reason });
    return;
  }
  if (!legalPairs(state).length && state.tools.reshuffles <= 0) {
    state.status = 'lost';
    state.reason = TERMINAL.NO_MOVES;
    finalizeClearBonus(state);
    events.push({ type: 'terminal', reason: state.reason });
  }
}

function finalizeClearBonus(state) {
  if (state.status === 'won') {
    state.scoreParts.clear = 500;
    if (state.limits.timeMs != null) {
      const remaining = Math.max(0, state.limits.timeMs - state.elapsedMs);
      state.scoreParts.time = Math.round(300 * remaining / state.limits.timeMs);
    }
  }
}

// Redistribute the values of all remaining tiles so the round is solvable
// again. Deterministic: driven entirely by the rules rng stream.
function reshuffleRemaining(state, rng) {
  // Collect remaining values, then re-lay them using the same guaranteed-
  // solvable assignment used at generation time (simulated removals).
  const remaining = [];
  for (const col of state.stacks) for (const id of col) remaining.push(id);
  if (remaining.length < 2) return;
  const order = planRemovalOrder(state, rng);
  if (!order) return; // extremely defensive: leave board untouched
  const target = currentTarget(state);
  const r = state.ruleset;
  for (const [idA, idB] of order) {
    const [va, vb] = makePairValues(r, target, rng);
    state.tiles[idA].value = va;
    state.tiles[idB].value = vb;
  }
}

// Simulate removals over the *current* stacks, choosing exposed positions,
// returning the removal order as pairs of tile ids. null if it dead-ends.
export function planRemovalOrder(state, rng) {
  const sim = {
    stacks: state.stacks.map(c => c.slice()),
    layout: state.layout,
    ruleset: state.ruleset,
    tiles: state.tiles,
  };
  const order = [];
  for (let guard = 0; guard < 4096; guard++) {
    const exposed = [];
    for (let s = 0; s < sim.stacks.length; s++) {
      const col = sim.stacks[s];
      if (!col.length) continue;
      const topId = col[col.length - 1];
      if (exposedInSim(sim, s, topId)) exposed.push(s);
    }
    if (exposed.length === 0) return order.length ? null : [];
    if (exposed.length === 1) {
      // dead end: one exposed stack but tiles remain elsewhere
      return null;
    }
    const iA = rng.int(exposed.length);
    let iB = rng.int(exposed.length - 1);
    if (iB >= iA) iB++;
    const sA = exposed[iA], sB = exposed[iB];
    order.push([sim.stacks[sA][sim.stacks[sA].length - 1], sim.stacks[sB][sim.stacks[sB].length - 1]]);
    sim.stacks[sA].pop();
    sim.stacks[sB].pop();
    if (sim.stacks.every(c => c.length === 0)) return order;
  }
  return null;
}

function exposedInSim(sim, stackIndex, topId) {
  const tile = sim.tiles[topId];
  if (!sim.ruleset.sideLock) return true;
  const cell = sim.layout.cells[stackIndex];
  let leftCovered = false, rightCovered = false;
  for (const dx of [-1, 1]) {
    for (let ni = 0; ni < sim.layout.cells.length; ni++) {
      const c = sim.layout.cells[ni];
      if (c.x === cell.x + dx && c.y === cell.y && sim.stacks[ni].length > tile.level) {
        if (dx < 0) leftCovered = true; else rightCovered = true;
      }
    }
  }
  return !(leftCovered && rightCovered);
}

export function makePairValues(ruleset, target, rng) {
  const lo = ruleset.valueMin, hi = ruleset.valueMax;
  switch (ruleset.rule) {
    case 'sum': {
      const aLo = Math.max(lo, target - hi), aHi = Math.min(hi, target - lo);
      const a = rng.range(aLo, aHi);
      return [a, target - a];
    }
    case 'match': {
      const v = rng.range(lo, hi);
      return [v, v];
    }
    case 'diff': {
      const aLo = lo, aHi = hi - ruleset.diff;
      const a = rng.range(aLo, aHi);
      const b = a + ruleset.diff;
      return rng.int(2) ? [a, b] : [b, a];
    }
    default:
      return [rng.range(lo, hi), rng.range(lo, hi)];
  }
}

// ---------------------------------------------------------------------------
// serialization (versioned) + stable hashing for replay checkpoints
// ---------------------------------------------------------------------------

export function serialize(state) {
  return JSON.stringify({ ...state, history: state.history });
}

export function migrate(data) {
  if (!data || typeof data !== 'object') throw new Error('corrupt state');
  if (data.version == null) data.version = 1;
  if (data.version > RULES_VERSION) throw new Error(`unsupported state version ${data.version}`);
  // v1 is current; future migrations chain here.
  return data;
}

export function deserialize(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  return migrate(data);
}

export function stateHash(state) {
  const view = {
    stacks: state.stacks,
    values: Object.keys(state.tiles).map(k => state.tiles[k].value),
    sel: state.selected,
    tick: state.tick,
    moves: state.movesUsed,
    score: state.scoreParts,
    chain: state.chain,
    status: state.status,
    reason: state.reason,
    hints: state.hintsUsed,
    inv: state.invalidCount,
    undos: state.undoCount,
    resh: state.reshufflesUsed,
    ti: state.targetIndex,
    rng: state.rngState,
  };
  return hashString(JSON.stringify(view)).toString(16).padStart(8, '0');
}

// Tie-break ordering: completion, fewer invalid actions, lower elapsed, session id.
export function compareResults(a, b) {
  if (a.completed !== b.completed) return a.completed ? -1 : 1;
  if (a.score !== b.score) return b.score - a.score;
  if (a.invalidCount !== b.invalidCount) return a.invalidCount - b.invalidCount;
  if (a.elapsedMs !== b.elapsedMs) return a.elapsedMs - b.elapsedMs;
  return String(a.sessionId).localeCompare(String(b.sessionId));
}
