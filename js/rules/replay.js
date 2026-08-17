// Replay envelope: schema version, build/content version, seed, initial hash,
// ordered commands, periodic state hashes, terminal result. Verification
// re-runs the commands and compares hashes at every checkpoint.

import { createGame, applyCommand, stateHash, serialize, RULES_VERSION } from './engine.js';
import { CONTENT_VERSION } from './content.js';

export const REPLAY_SCHEMA = 1;
export const BUILD_VERSION = '1.0.0';

export function openReplay(content, board) {
  const state = createGame(content, board);
  return {
    schema: REPLAY_SCHEMA,
    build: BUILD_VERSION,
    contentVersion: content.contentVersion || CONTENT_VERSION,
    rulesVersion: RULES_VERSION,
    contentId: content.id,
    seed: content.seed,
    initialHash: stateHash(state),
    startedAtOffsetMs: 0,
    commands: [],
    checkpoints: [{ at: 0, hash: stateHash(state) }],
    result: null,
    state,
  };
}

export function recordCommand(replay, cmd, resultingState) {
  replay.commands.push({
    id: cmd.id ?? replay.commands.length + 1,
    tick: resultingState.tick,
    type: cmd.type,
    tileA: cmd.tileA ?? cmd.tileId ?? null,
    tileB: cmd.tileB ?? null,
    atMs: cmd.atMs ?? resultingState.elapsedMs,
  });
  // checkpoint every 8 commands plus on terminal
  if (replay.commands.length % 8 === 0 || resultingState.status !== 'active') {
    replay.checkpoints.push({ at: replay.commands.length, hash: stateHash(resultingState) });
  }
  replay.state = resultingState;
}

export function closeReplay(replay, finalState, scoreBreakdown, sessionId) {
  replay.result = {
    status: finalState.status,
    reason: finalState.reason,
    score: scoreBreakdown.total,
    parts: scoreBreakdown,
    elapsedMs: finalState.elapsedMs,
    moves: finalState.movesUsed,
    invalidCount: finalState.invalidCount,
    finalHash: stateHash(finalState),
    sessionId,
  };
  const { state, ...envelope } = replay;
  return envelope;
}

// Deterministic re-execution. Returns { ok, errors, finalState }.
export function verifyReplay(envelope, content, board) {
  const errors = [];
  if (envelope.schema !== REPLAY_SCHEMA) errors.push(`schema ${envelope.schema}`);
  if (envelope.contentVersion !== (content.contentVersion || CONTENT_VERSION)) errors.push('content version mismatch');
  let state = createGame(content, board);
  if (stateHash(state) !== envelope.initialHash) errors.push('initial hash mismatch');
  const checkpoints = new Map(envelope.checkpoints.map(c => [c.at, c.hash]));
  const seen = new Set();
  for (let i = 0; i < envelope.commands.length; i++) {
    const cmd = envelope.commands[i];
    if (seen.has(cmd.id)) { errors.push(`duplicate command id ${cmd.id}`); continue; } // idempotent rejection
    seen.add(cmd.id);
    const r = applyCommand(state, { type: cmd.type, tileId: cmd.tileA ?? undefined, tileA: cmd.tileA ?? undefined, tileB: cmd.tileB ?? undefined, atMs: cmd.atMs });
    if (r.events.length && r.events[0].type === 'rejected') {
      errors.push(`command ${cmd.id} rejected: ${r.events[0].reason}`);
    }
    state = r.state;
    const cpHash = checkpoints.get(i + 1);
    if (cpHash && cpHash !== stateHash(state)) errors.push(`checkpoint mismatch after command ${i + 1}`);
  }
  if (envelope.result) {
    if (envelope.result.finalHash !== stateHash(state)) errors.push('final hash mismatch');
    if (envelope.result.reason !== state.reason) errors.push('terminal reason mismatch');
  }
  return { ok: errors.length === 0, errors, finalState: state };
}
