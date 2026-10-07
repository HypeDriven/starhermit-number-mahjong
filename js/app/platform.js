// StarHermit host integration — a thin adapter over the shared SDK
// (starhermit-sdk.js, loaded by index.html as window.StarHermit). Hosted mode
// activates only when a launch token was read (#game_token / #access_token);
// the SDK owns the token, its renewal, the `game:<slug>` cloud-save slot, the
// per-player settings KV, controls and read-only leaderboards. Without a token
// this module makes no request at all (local clock, local boards).

function sdk() {
  const w = typeof window !== 'undefined' ? window : globalThis;
  return (w && w.StarHermit) || null;
}

export const platform = {
  get token() { const s = sdk(); return s && s.signedIn ? s.token : null; },
  get userId() { const s = sdk(); return s && s.signedIn ? s.userId : null; },
  get slug() { const s = sdk(); return s ? s.slug : null; },
  nickname: null,       // profile nickname (fallback "Player " + id prefix)
  serverOffsetMs: 0,
  online: false,        // signed in AND the platform clock answered
  sync: 'offline',      // offline | saving | synced — shown in the account chip
  _saveTimer: null,
  _pendingDoc: null,
  persistMeta: null,    // hook: (savedAt) => void, set by main.js
  onAuth: null,         // hook: ({ signedIn }) => void, set by main.js
};

let inited = false;

// ---------------------------------------------------------------------------
// launch token (read once by the SDK, stripped from the address bar)
// ---------------------------------------------------------------------------

export function readLaunchToken() {
  const s = sdk();
  if (!s) return false;
  if (!inited) {
    inited = true;
    s.init();
    s.on('auth', (a) => {
      if (!a.signedIn) { platform.nickname = null; setSync('offline'); }
      if (platform.onAuth) platform.onAuth(a);
    });
  }
  return !!s.signedIn;
}

export const canSignIn = () => { const s = sdk(); return !!(s && s.canSignIn()); };
export const signIn = () => { const s = sdk(); return !!(s && s.signIn()); };
export const inviteLink = () => { const s = sdk(); return s && s.signedIn ? s.inviteLink() : null; };
export const avatarUrl = () => { const s = sdk(); return s && s.signedIn ? s.avatarUrl() : Promise.resolve(null); };

// ---------------------------------------------------------------------------
// clock: GET /api/v1/time via the SDK, signed in only; standalone uses the
// device clock and makes no request
// ---------------------------------------------------------------------------

export async function syncServerTime() {
  const s = sdk();
  platform.serverOffsetMs = 0;
  platform.online = false;
  if (!platform.token) return false;
  const t0 = Date.now();
  try {
    const data = await s.api('/api/v1/time');
    const t1 = Date.now();
    const serverMs = Number(data && data.now);
    if (Number.isFinite(serverMs) && serverMs > 0) {
      platform.serverOffsetMs = serverMs - (t0 + (t1 - t0) / 2);
      platform.online = true;
    }
  } catch { /* device clock */ }
  return platform.online;
}

// Token renewal is owned by the SDK; kept for the boot call site.
export function startRefreshLoop() {}

// ---------------------------------------------------------------------------
// profile (nickname first, "Player " + id prefix fallback; never /api/v1/me)
// ---------------------------------------------------------------------------

export async function loadProfile() {
  const s = sdk();
  if (!s || !s.signedIn) return null;
  const p = await s.profile();
  platform.nickname = p ? p.displayName : 'Player ' + String(s.userId).slice(0, 6);
  return platform.nickname;
}

async function nicknameFor(userId) {
  const s = sdk();
  if (!userId) return 'Player';
  const p = s ? await s.profile(String(userId)) : null;
  return p ? p.displayName : 'Player ' + String(userId).slice(0, 6);
}

// ---------------------------------------------------------------------------
// cloud save (game:<slug>; localStorage stays the offline cache)
// ---------------------------------------------------------------------------

function setSync(state) {
  platform.sync = state;
  const el = typeof document !== 'undefined' && document.getElementById('sync-status');
  if (el) el.textContent = { offline: '', saving: 'saving…', synced: 'synced ✓' }[state] || '';
}

export function scheduleCloudSave(buildDoc) {
  if (!platform.token) return;
  platform._pendingDoc = buildDoc;
  setSync('saving');
  clearTimeout(platform._saveTimer);
  platform._saveTimer = setTimeout(flushCloudSave, 2000); // ~2 s debounce
}

export async function flushCloudSave() {
  clearTimeout(platform._saveTimer);
  const s = sdk();
  if (!platform.token || !platform._pendingDoc) return true;
  const doc = platform._pendingDoc;
  platform._pendingDoc = null;
  const ok = await s.writeSave(JSON.stringify(doc), { keepalive: true });
  if (!ok) {
    platform._pendingDoc = platform._pendingDoc || doc; // retried on next change / pagehide
    setSync('offline');
    return false;
  }
  setSync('synced');
  if (platform.persistMeta) { try { platform.persistMeta(doc.savedAt); } catch { /* meta is advisory */ } }
  return true;
}

export async function loadCloudSave() {
  const s = sdk();
  if (!platform.token) return null;
  const doc = await s.loadJSON();
  if (!doc || typeof doc !== 'object') return null;
  setSync('synced');
  return doc;
}

// ---------------------------------------------------------------------------
// per-player settings KV and keyboard bindings
// ---------------------------------------------------------------------------

export async function getPlatformSettings() {
  const s = sdk();
  return platform.token ? s.getSettings() : null;
}
export function patchPlatformSettings(obj) {
  const s = sdk();
  if (platform.token) s.patchSettings(obj);
}
export async function loadBindings(defaults) {
  const s = sdk();
  if (!platform.token) return structuredClone(defaults);
  try { return await s.loadBindings(defaults); } catch { return structuredClone(defaults); }
}

// ---------------------------------------------------------------------------
// read-only platform leaderboard (hosted only; absent ⇒ local records only)
// ---------------------------------------------------------------------------

// Post a finished ranked round to the leaderboards (score-script.js);
// resolves { posted, rank } — rank on the high-score board, or null.
export async function submitScore(total) {
  const s = sdk();
  if (!s || !s.signedIn || typeof s.submitScores !== 'function') return { posted: false, rank: null };
  const keys = await s.submitScores({ 'high-score': total }).catch(() => []);
  if (!keys || !keys.includes('high-score')) return { posted: false, rank: null };
  try {
    const r = await s.leaderboard('high-score', { pageSize: 100 });
    const me = ((r && r.items) || []).find(i => i.userId === s.userId);
    return { posted: true, rank: me ? me.rank : null };
  } catch { return { posted: true, rank: null }; }
}

export async function fetchOnlineBoard() {
  const s = sdk();
  if (!platform.token) return null;
  try {
    const [res, game] = await Promise.all([s.leaderboard(null, { pageSize: 10 }), s.getGame()]);
    if (!res || !res.board) return null;
    const entries = [];
    for (const row of (res.items || []).slice(0, 10)) {
      const userId = row.userId ?? null;
      entries.push({
        score: row.score ?? 0,
        nickname: await nicknameFor(userId),
        me: userId != null && String(userId) === String(platform.userId),
      });
    }
    const me = (game && game.me && typeof game.me === 'object') ? game.me : null;
    return { entries, me };
  } catch {
    return null;
  }
}
