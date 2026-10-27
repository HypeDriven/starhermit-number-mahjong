// The game's data, pure (no runtime modules), so node tests run the shipped
// code: the progress record and its two-device merge, the game's own options,
// the browser build's cloud save read for migration, and the device store
// (checksummed, versioned key/value records over an injected backend: the
// local boards, the interrupted-round snapshots and the last replay per
// content, with an in-memory fallback when the device refuses a write).

const PREFIX = 'number-mahjong.';
const STORE_VERSION = 1;
const MAX_REPLAYS = 60;
export const SAVE_SCHEMA = 1;

// ---------------------------------------------------------------------------
// progress

export const DEFAULT_PROGRESS = {
  version: 1,
  journey: {},                // stageId: { stars, bestScore, bestMs, completions }
  lessons: {},                // lessonId: { completed }
  achievements: {},           // key: unlockedAtMs
  masteryXp: 0,
  sessionsPlayed: 0,
  bestStreakDays: 0,
  lastDailyDate: null,
  dailyHistory: {},           // dateISO: { score, completed }
  challenges: {},             // challengeId: { score, elapsedMs }
  totals: { pairs: 0, wins: 0, plays: 0 },
};

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (x) => (Number.isFinite(x) ? x : 0);
const clone = (x) => JSON.parse(JSON.stringify(x));

/** A well-formed progress record from anything (absent or damaged parts take the defaults). */
export function normalizeProgress(p) {
  const src = isObj(p) ? p : {};
  const out = clone(DEFAULT_PROGRESS);
  for (const k of ['journey', 'lessons', 'achievements', 'dailyHistory', 'challenges']) if (isObj(src[k])) out[k] = clone(src[k]);
  for (const k of ['masteryXp', 'sessionsPlayed', 'bestStreakDays']) out[k] = num(src[k]);
  out.lastDailyDate = typeof src.lastDailyDate === 'string' ? src.lastDailyDate : null;
  const t = isObj(src.totals) ? src.totals : {};
  out.totals = { pairs: num(t.pairs), wins: num(t.wins), plays: num(t.plays) };
  return out;
}

/**
 * Merge two progress records (this device's and another device's or the
 * browser build's cloud save) so neither side's progress is lost: per journey
 * stage the better stars and score, the faster time and more completions;
 * union of lessons, achievements (earliest unlock) and daily history (best
 * score, completed if either); per challenge the better score; the larger
 * counters. Pure.
 */
export function mergeProgress(local, remote) {
  const a = normalizeProgress(local);
  const b = normalizeProgress(remote);
  const journey = { ...b.journey };
  for (const [id, x] of Object.entries(a.journey)) {
    const y = journey[id];
    journey[id] = !y ? x : {
      stars: Math.max(num(x.stars), num(y.stars)),
      bestScore: Math.max(num(x.bestScore), num(y.bestScore)),
      bestMs: x.bestMs && y.bestMs ? Math.min(x.bestMs, y.bestMs) : (x.bestMs || y.bestMs),
      completions: Math.max(num(x.completions), num(y.completions)),
    };
  }
  const lessons = { ...b.lessons };
  for (const [id, x] of Object.entries(a.lessons)) lessons[id] = { completed: !!(x?.completed || lessons[id]?.completed) };
  const achievements = { ...b.achievements };
  for (const [k, t] of Object.entries(a.achievements)) achievements[k] = achievements[k] == null ? t : Math.min(num(t), num(achievements[k]));
  const dailyHistory = { ...b.dailyHistory };
  for (const [d, x] of Object.entries(a.dailyHistory)) {
    const y = dailyHistory[d];
    dailyHistory[d] = !y ? x : { score: Math.max(num(x.score), num(y.score)), completed: !!(x.completed || y.completed) };
  }
  const challenges = { ...b.challenges };
  for (const [id, x] of Object.entries(a.challenges)) {
    const y = challenges[id];
    challenges[id] = !y || num(x.score) > num(y.score) ? x : y;
  }
  return {
    version: 1,
    journey, lessons, achievements, dailyHistory, challenges,
    masteryXp: Math.max(a.masteryXp, b.masteryXp),
    sessionsPlayed: Math.max(a.sessionsPlayed, b.sessionsPlayed),
    bestStreakDays: Math.max(a.bestStreakDays, b.bestStreakDays),
    lastDailyDate: [a.lastDailyDate, b.lastDailyDate].filter(Boolean).sort().pop() || null,
    totals: { pairs: Math.max(a.totals.pairs, b.totals.pairs), wins: Math.max(a.totals.wins, b.totals.wins), plays: Math.max(a.totals.plays, b.totals.plays) },
  };
}

/** Whether two progress records are the same. */
export function sameProgress(a, b) {
  return JSON.stringify(normalizeProgress(a)) === JSON.stringify(normalizeProgress(b));
}

/** The engine save document: { v, progress }. */
export function normalizeSave(doc) {
  return { v: SAVE_SCHEMA, progress: normalizeProgress(isObj(doc) ? doc.progress : null) };
}

// ---------------------------------------------------------------------------
// the game's own options (engine settings, kept with the player's account)

export const DEFAULT_OPTIONS = {
  camera: 'default',          // default | top | low
  board2d: false,             // the flat tile board instead of the 3D desk
  themeOverride: null,        // cosmetic theme (null = follow the round)
  palette: 'standard',        // standard | deuteranopia | protanopia | tritanopia
  leftHanded: false,          // the action buttons on the left
  soundCaptions: false,       // text cues for meaningful sounds
  timingAssist: false,        // +50 % on round timers
};
export const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);
export const CAMERAS = ['default', 'top', 'low'];
export const PALETTES = ['standard', 'deuteranopia', 'protanopia', 'tritanopia'];
export const THEME_IDS = ['ivory-dusk', 'emerald-archive', 'crimson-meridian', 'frost-zenith', 'gilded-eclipse'];
/** Every per-player settings key the browser build wrote (the JS SDK's settings KV): removed after migration. */
export const BROWSER_KEYS = ['music', 'effects', 'ambience', 'muted', 'gfx', 'reducedMotion', 'highContrast', 'largeText', 'leftHanded', 'palette',
  'soundCaptions', 'holdToConfirm', 'timingAssist', 'board2d', 'camera', 'bindings', 'themeOverride', 'ui.language'];

/** The valid options among `obj`'s keys (others left out). */
export function pickOptions(obj) {
  const src = isObj(obj) ? obj : {};
  const out = {};
  if (CAMERAS.includes(src.camera)) out.camera = src.camera;
  if (PALETTES.includes(src.palette)) out.palette = src.palette;
  if (src.themeOverride === null || THEME_IDS.includes(src.themeOverride)) out.themeOverride = src.themeOverride;
  for (const k of ['board2d', 'leftHanded', 'soundCaptions', 'timingAssist']) if (typeof src[k] === 'boolean') out[k] = src[k];
  return out;
}

/** The browser build's cloud save (the JS SDK's writeSave of { version, savedAt, progress, settings }): its progress and options, or null. */
export function readForeign(text) {
  let doc;
  try { doc = JSON.parse(String(text)); } catch { return null; }
  if (!isObj(doc)) return null;
  return {
    progress: isObj(doc.progress) ? normalizeProgress(doc.progress) : null,
    options: pickOptions(doc.settings),
    savedAt: Number.isFinite(doc.savedAt) ? doc.savedAt : 0,
  };
}

// ---------------------------------------------------------------------------
// the device store

// FNV-1a, same algorithm as the rules package.
function checksum(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
function pack(payload, at) {
  const body = JSON.stringify({ v: STORE_VERSION, at, payload });
  return JSON.stringify({ body, sum: checksum(body) });
}
function unpack(raw) {
  if (!raw) return null;
  try {
    const { body, sum } = JSON.parse(raw);
    if (checksum(body) !== sum) return null; // corrupt: treat as absent
    const doc = JSON.parse(body);
    if (doc.v > STORE_VERSION) return null;
    return doc.payload;
  } catch {
    return null;
  }
}

/** Local boards: highest score, then fewer invalid attempts, faster, session id (engine.js compareResults order). */
export function sortBoard(entries) {
  return entries.sort((a, b) => b.score - a.score || a.invalidCount - b.invalidCount || a.elapsedMs - b.elapsedMs || String(a.sessionId).localeCompare(String(b.sessionId)));
}

/**
 * The device store over `backend` ({ get(key) → string|null, set(key, text), remove(key), keys() → string[] }; any
 * call may throw). A refused write keeps the value in memory for the session, superseding the device's copy.
 * `now()` stamps the records.
 */
export function createStore(backend, now = () => 0) {
  const memory = new Map();
  const getItem = (k) => {
    if (memory.has(k)) return memory.get(k);
    try { return backend.get(k); } catch { return null; }
  };
  const setItem = (k, v) => {
    try { backend.set(k, v); memory.delete(k); } catch { memory.set(k, v); }
  };
  const removeItem = (k) => {
    memory.set(k, null);
    try { backend.remove(k); } catch { /* the deletion stays in memory */ }
  };
  const allKeys = () => {
    let keys = [];
    try { keys = backend.keys(); } catch { /* storage denied */ }
    return [...new Set([...keys, ...memory.keys()])];
  };
  const store = {
    saveSessionSnapshot(contentId, snapshot) { setItem(PREFIX + 'session.' + contentId, pack(snapshot, now())); },
    loadSessionSnapshot(contentId) { return unpack(getItem(PREFIX + 'session.' + contentId)); },
    clearSessionSnapshot(contentId) { removeItem(PREFIX + 'session.' + contentId); },
    listSessionSnapshots() {
      const out = [];
      for (const k of allKeys()) {
        if (!k.startsWith(PREFIX + 'session.')) continue;
        const v = unpack(getItem(k));
        if (v) out.push({ contentId: k.slice((PREFIX + 'session.').length), ...v });
      }
      return out;
    },
    /** The last replay per content; the oldest are dropped past MAX_REPLAYS (the device holds at most 4,096 keys). */
    saveReplay(contentId, envelope) {
      setItem(PREFIX + 'replay.' + contentId, pack(envelope, now()));
      const keys = allKeys().filter((k) => k.startsWith(PREFIX + 'replay.') && getItem(k));
      if (keys.length <= MAX_REPLAYS) return;
      const at = (k) => { try { return JSON.parse(JSON.parse(getItem(k)).body).at || 0; } catch { return 0; } };
      keys.map((k) => [k, at(k)]).sort((a, b) => a[1] - b[1]).slice(0, keys.length - MAX_REPLAYS).forEach(([k]) => removeItem(k));
    },
    loadReplay(contentId) { return unpack(getItem(PREFIX + 'replay.' + contentId)); },
    loadBoard(boardKey) { return unpack(getItem(PREFIX + 'board.' + boardKey)) || []; },
    /** Adds an entry to a local board (best `maxEntries` kept); its place, or -1 when it did not make the board. */
    submitBoardEntry(boardKey, entry, maxEntries = 25) {
      const entries = store.loadBoard(boardKey);
      entries.push(entry);
      sortBoard(entries);
      const trimmed = entries.slice(0, maxEntries);
      setItem(PREFIX + 'board.' + boardKey, pack(trimmed, now()));
      return trimmed.indexOf(entry);
    },
    /** Settings › Erase: every record of this game on the device. */
    resetAll() {
      for (const k of allKeys()) if (k.startsWith(PREFIX)) removeItem(k);
    },
  };
  return store;
}
