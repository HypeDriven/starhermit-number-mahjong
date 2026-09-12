// StarHermit host integration (hosted mode activates only when a launch token
// was read). Same-origin /api only, no hard-coded API base. The token arrives
// in the URL fragment, is read once and stripped, lives in memory only, and is
// sent as `Authorization: Bearer` on every REST call. Without a token this
// module no-ops and the game plays exactly as before.

const API = '/api/v1';

export const platform = {
  token: null,          // launch JWT, memory only — never persisted
  userId: null,         // JWT sub
  slug: null,           // JWT game_scope
  nickname: null,       // profile nickname (NEVER the username)
  serverOffsetMs: 0,
  online: false,        // hosted AND last platform call succeeded
  sync: 'offline',      // offline | saving | synced — shown in the account chip
  _refreshTimer: null,
  _saveTimer: null,
  _pendingDoc: null,
  _nickCache: new Map(),
  persistMeta: null,    // hook: (savedAt) => void, set by main.js
};

// ---------------------------------------------------------------------------
// launch token
// ---------------------------------------------------------------------------

export function readLaunchToken() {
  // primary: URL fragment `#game_token=<jwt>` (+ optional &session_id=) —
  // read once, then strip from the address bar
  let token = null;
  if (location.hash.length > 1) {
    const frag = new URLSearchParams(location.hash.slice(1));
    token = frag.get('game_token');
    if (token) {
      frag.delete('game_token');
      frag.delete('session_id');
      const rest = frag.toString();
      history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));
    }
  }
  // local-dev fallbacks only (a dev server has no fragment machinery)
  if (!token) {
    const params = new URLSearchParams(location.search);
    token = params.get('token') || params.get('launch')
      || (window.__STARHERMIT__ && window.__STARHERMIT__.launchToken) || null;
  }
  if (!token) return false;
  platform.token = token;
  try {
    const payload = JSON.parse(atob(token.split('.')[1] || ''));
    platform.userId = payload.sub || null;
    platform.slug = payload.game_scope || payload.scope || payload.slug || null;
  } catch { /* opaque token: identity lookups just stay disabled */ }
  return true;
}

function authHeaders(extra = {}) {
  return platform.token ? { ...extra, Authorization: `Bearer ${platform.token}` } : extra;
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: authHeaders({ ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) }),
    signal: opts.signal || AbortSignal.timeout(4000),
  });
  if (res.status === 404 || res.status === 403) return null; // absent or launch-token-forbidden: graceful
  if (!res.ok) throw new Error('http ' + res.status);
  return res;
}

// ---------------------------------------------------------------------------
// clock + token refresh
// ---------------------------------------------------------------------------

export async function syncServerTime() {
  const t0 = Date.now();
  try {
    const res = await fetch(`${API}/time`, { cache: 'no-store', signal: AbortSignal.timeout(2500), headers: authHeaders() });
    const t1 = Date.now();
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    // Platform contract is { serverTime }; older/dev servers use utcMs/now/ms.
    const serverMs = Number(data.serverTime ?? data.utcMs ?? data.now ?? data.ms);
    if (!Number.isFinite(serverMs) || serverMs <= 0) throw new Error('invalid time response');
    platform.serverOffsetMs = serverMs - (t0 + (t1 - t0) / 2);
    platform.online = true;
  } catch {
    platform.serverOffsetMs = 0; // offline: local clock is the platform clock
    platform.online = false;
  }
  return platform.online;
}

export function startRefreshLoop() {
  if (!platform.token || !platform.slug) return;
  const refresh = async () => {
    try {
      const res = await fetch(`${API}/games/${encodeURIComponent(platform.slug)}/launch-token`, {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json();
      if (data && typeof data.token === 'string' && data.token) platform.token = data.token;
      platform._refreshTimer = setTimeout(refresh, 45 * 60 * 1000);
    } catch {
      platform._refreshTimer = setTimeout(refresh, 60000); // retry ~60 s
    }
  };
  clearTimeout(platform._refreshTimer);
  platform._refreshTimer = setTimeout(refresh, 45 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// profile (nickname only — never the username, never /api/v1/me)
// ---------------------------------------------------------------------------

export async function loadProfile() {
  if (!platform.token || !platform.userId) return null;
  try {
    const res = await apiFetch(`/users/${encodeURIComponent(platform.userId)}/profile`);
    if (!res) return null;
    const data = await res.json();
    platform.nickname = (data && data.nickname) || 'Player ' + String(platform.userId).slice(0, 8);
    return platform.nickname;
  } catch {
    platform.nickname = platform.nickname || 'Player ' + String(platform.userId).slice(0, 8);
    return null;
  }
}

async function nicknameFor(userId) {
  if (!userId) return 'Player';
  if (platform._nickCache.has(userId)) return platform._nickCache.get(userId);
  let nick = 'Player ' + String(userId).slice(0, 8);
  try {
    const res = await apiFetch(`/users/${encodeURIComponent(userId)}/profile`);
    if (res) {
      const data = await res.json();
      if (data && data.nickname) nick = data.nickname;
    }
  } catch { /* fall back to the id-based name */ }
  platform._nickCache.set(userId, nick);
  return nick;
}

// ---------------------------------------------------------------------------
// cloud save (one slot, zip+base64; localStorage stays the offline cache)
// ---------------------------------------------------------------------------

function setSync(state) {
  platform.sync = state;
  const el = document.getElementById('sync-status');
  if (el) el.textContent = { offline: '', saving: 'saving…', synced: 'synced ✓' }[state] || '';
}

export function scheduleCloudSave(buildDoc) {
  if (!platform.token || !platform.slug) return;
  platform._pendingDoc = buildDoc;
  setSync('saving');
  clearTimeout(platform._saveTimer);
  platform._saveTimer = setTimeout(flushCloudSave, 2000); // ~2 s debounce
}

export async function flushCloudSave() {
  clearTimeout(platform._saveTimer);
  if (!platform.token || !platform.slug || !platform._pendingDoc) return true;
  const doc = platform._pendingDoc;
  platform._pendingDoc = null;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    const body = JSON.stringify({ dataBase64: bytesToBase64(zipStore('save.json', bytes)) });
    const res = await fetch(`${API}/me/cloud-saves/${encodeURIComponent(platform.slug)}`, {
      method: 'PUT',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body,
      signal: AbortSignal.timeout(5000),
      keepalive: true,
    });
    if (!res.ok) throw new Error('http ' + res.status);
    setSync('synced');
    if (platform.persistMeta) { try { platform.persistMeta(doc.savedAt); } catch { /* meta is advisory */ } }
    return true;
  } catch {
    platform._pendingDoc = platform._pendingDoc || doc; // retried on next change / pagehide
    setSync('offline');
    return false;
  }
}

export async function loadCloudSave() {
  if (!platform.token || !platform.slug) return null;
  try {
    const res = await apiFetch(`/me/cloud-saves/${encodeURIComponent(platform.slug)}`, {
      headers: authHeaders({ accept: 'application/zip' }),
    });
    if (!res) return null;
    const raw = await res.arrayBuffer();
    const json = unzipFirstEntry(new Uint8Array(raw));
    const doc = JSON.parse(new TextDecoder().decode(json));
    if (!doc || typeof doc !== 'object') return null;
    setSync('synced');
    return doc;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// verified score submission to the game's own server.js (replay-validated).
// Graceful: any failure leaves the local board as the only record.
// ---------------------------------------------------------------------------

export async function submitVerifiedScore(board, entry, envelope) {
  if (!platform.token) return null;
  try {
    const res = await fetch(`${API}/scores`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ board, entry, replay: envelope }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null; // route not served here / rejected: local-only
    const data = await res.json();
    return { rank: typeof data.rank === 'number' ? data.rank : null };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// read-only platform leaderboard (hosted only; absent ⇒ local records only)
// ---------------------------------------------------------------------------

export async function fetchOnlineBoard() {
  if (!platform.token || !platform.slug) return null;
  try {
    const g = await apiFetch(`/games/${encodeURIComponent(platform.slug)}`);
    if (!g) return null;
    const game = await g.json();
    const leaderboardId = game && game.leaderboardId;
    if (!leaderboardId) return null;
    const e = await apiFetch(`/leaderboards/${encodeURIComponent(leaderboardId)}/entries?pageSize=10`);
    if (!e) return null;
    const data = await e.json();
    const raw = Array.isArray(data) ? data : (data.entries || []);
    const entries = [];
    for (const row of raw.slice(0, 10)) {
      const userId = row.userId ?? row.user_id ?? row.user?.id;
      entries.push({
        score: row.score ?? 0,
        nickname: await nicknameFor(userId),
        me: userId != null && userId === platform.userId,
      });
    }
    const me = (game.me && typeof game.me === 'object') ? game.me : null;
    return { entries, me };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// minimal stored-zip writer/reader (no compression; CRC32 included)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const local = out.length;
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

// exported for the cloud-save round-trip tests (zip strictness is validated
// externally with python3 zipfile / unzip -t against the same bytes)
export const _zip = { zipStore, unzipFirstEntry, bytesToBase64, base64ToBytes };
