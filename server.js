// StarHermit authoritative game script for Number Mahjong.
// Dependency-free Node server: serves the static distribution, provides
// platform time, and validates ranked score submissions by re-running the
// replay envelope through the real rules engine (deterministic seeds).
//
//   node server.js [port]     (default 8080)

import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyReplay } from './js/rules/replay.js';
import { dailyContent, challengeContent, JOURNEY, prepareContent, CONTENT_VERSION } from './js/rules/content.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const DATA_DIR = path.join(ROOT, '.server-data');

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
};

// ---------------------------------------------------------------------------
// score board persistence (server-side, per board key)
// ---------------------------------------------------------------------------

async function loadBoard(key) {
  const file = path.join(DATA_DIR, 'board-' + encodeURIComponent(key) + '.json');
  if (!existsSync(file)) return [];
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return []; }
}

async function saveBoard(key, entries) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path.join(DATA_DIR, 'board-' + encodeURIComponent(key) + '.json'), JSON.stringify(entries, null, 1));
}

// Rebuild content for a replay envelope and verify it end to end.
function verifySubmission(body) {
  const { entry, replay } = body || {};
  if (!entry || !replay) return { ok: false, error: 'missing entry or replay' };
  if (replay.contentVersion !== CONTENT_VERSION) return { ok: false, error: 'stale content version' };
  let content = null;
  if (replay.contentId.startsWith('daily-')) {
    const iso = replay.contentId.slice(6);
    const d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d.getTime())) return { ok: false, error: 'bad daily id' };
    content = dailyContent(iso, Math.floor(d.getTime() / 86400000));
  } else if (replay.contentId.startsWith('chal-')) {
    content = challengeContent(replay.contentId);
  } else if (replay.contentId.startsWith('journey-')) {
    content = JOURNEY.find(j => j.id === replay.contentId);
  }
  if (!content) return { ok: false, error: 'unknown content' };
  // timing assist widens the timer; reflected in assists and allowed
  const { content: prepared, board } = prepareContent(content);
  const result = verifyReplay(replay, prepared, board);
  if (!result.ok) return { ok: false, error: 'replay failed verification: ' + result.errors[0] };
  if (result.finalState.status !== 'won') {
    return { ok: false, error: 'only completed rounds are posted to boards' };
  }
  // plausibility: score reported must match replayed score
  if (entry.score !== result.finalState.scoreParts.pairs + result.finalState.scoreParts.speed + result.finalState.scoreParts.chain + result.finalState.scoreParts.clear + result.finalState.scoreParts.time) {
    return { ok: false, error: 'score mismatch' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  // ---- API ----
  if (url.pathname === '/api/v1/time') {
    return send(200, { utcMs: Date.now() });
  }
  if (url.pathname === '/api/v1/scores' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 256 * 1024) return send(413, { error: 'payload too large' });
    }
    let body;
    try { body = JSON.parse(raw); } catch { return send(400, { error: 'bad json' }); }
    if (typeof body.board !== 'string' || body.board.length > 128) return send(400, { error: 'bad board key' });
    const verdict = verifySubmission(body);
    if (!verdict.ok) return send(422, { error: verdict.error });
    const entries = await loadBoard(body.board);
    const entry = { ...body.entry, verified: true, receivedAt: Date.now() };
    entries.push(entry);
    entries.sort((a, b) => b.score - a.score || a.invalidCount - b.invalidCount || a.elapsedMs - b.elapsedMs || String(a.sessionId).localeCompare(String(b.sessionId)));
    await saveBoard(body.board, entries.slice(0, 100));
    return send(200, { ok: true, rank: entries.indexOf(entry) });
  }
  if (url.pathname === '/api/v1/scores' && req.method === 'GET') {
    const key = url.searchParams.get('board') || '';
    return send(200, { board: key, entries: await loadBoard(key) });
  }
  if (url.pathname.startsWith('/api/')) {
    return send(404, { error: 'unknown endpoint' });
  }

  // ---- static ----
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) return send(403, 'forbidden', 'text/plain');
  // keep source maps, secrets, and server data out of the distribution
  if (file.includes('.server-data') || file.endsWith('.map')) return send(404, 'not found', 'text/plain');
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    send(404, 'not found', 'text/plain');
  }
});

server.listen(PORT, () => {
  console.log(`Number Mahjong listening on http://localhost:${PORT}`);
});
