// Versioned, checksummed local persistence. Never stores credentials or
// tokens — only settings, progression, sessions, and board entries.

const PREFIX = 'number-mahjong.';
const STORE_VERSION = 1;

// FNV-1a, same algorithm as the rules package (duplicated to keep this
// module dependency-free for early boot).
function checksum(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function pack(payload) {
  const body = JSON.stringify({ v: STORE_VERSION, at: Date.now(), payload });
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

function available() {
  try {
    const k = PREFIX + '__probe';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

const memoryFallback = new Map();
const hasLocal = typeof localStorage !== 'undefined' && available();

function getItem(k) {
  if (memoryFallback.has(k)) return memoryFallback.get(k);
  try { return hasLocal ? localStorage.getItem(k) : null; } catch { return null; }
}
function setItem(k, v) {
  if (hasLocal) {
    try { localStorage.setItem(k, v); memoryFallback.delete(k); return; } catch { /* quota or denied: keep the session alive on the memory fallback */ }
  }
  memoryFallback.set(k, v);
}
function removeItem(k) {
  memoryFallback.set(k, null);
  try { if (hasLocal) localStorage.removeItem(k); } catch { /* retain the deletion in memory */ }
}

// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  version: 1,
  music: 0.5,
  effects: 0.8,
  ambience: 0.4,
  muted: false,
  gfx: null,                  // graphics panel: { preset, render_scale, adaptive, show_fps, <category>: tier } (see gfx.js)
  reducedMotion: false,
  highContrast: false,
  largeText: false,
  leftHanded: false,
  palette: 'standard',        // standard | deuteranopia | protanopia | tritanopia
  soundCaptions: false,
  holdToConfirm: false,       // hold-versus-toggle preference
  timingAssist: false,        // +50% on round timers
  board2d: false,             // force the semantic DOM board
  camera: 'default',          // default | top | low
  bindings: null,             // gamepad remaps { action: code }
  themeOverride: null,        // cosmetic theme pick (null = follow content)
  tutorialSeen: {},
};

const DEFAULT_PROGRESS = {
  version: 1,
  journey: {},                // stageId: { stars, bestScore, bestMs, completions }
  lessons: {},                // lessonId: { completed }
  achievements: {},           // key: unlockedAtMs
  masteryXp: 0,
  sessionsPlayed: 0,
  bestStreakDays: 0,
  lastDailyDate: null,
  dailyHistory: {},           // dateISO: { score, completed }
  totals: { pairs: 0, wins: 0, plays: 0 },
};

export const store = {
  loadSettings() {
    return { ...DEFAULT_SETTINGS, ...(unpack(getItem(PREFIX + 'settings')) || {}) };
  },
  saveSettings(s) { setItem(PREFIX + 'settings', pack(s)); },

  loadProgress() {
    return { ...DEFAULT_PROGRESS, ...(unpack(getItem(PREFIX + 'progress')) || {}) };
  },
  saveProgress(p) { setItem(PREFIX + 'progress', pack(p)); },

  // last safe snapshot per content id, for resume after interruption
  saveSessionSnapshot(contentId, snapshot) {
    setItem(PREFIX + 'session.' + contentId, pack(snapshot));
  },
  loadSessionSnapshot(contentId) {
    return unpack(getItem(PREFIX + 'session.' + contentId));
  },
  clearSessionSnapshot(contentId) { removeItem(PREFIX + 'session.' + contentId); },

  listSessionSnapshots() {
    const out = [];
    let localKeys = [];
    try { if (hasLocal) localKeys = Object.keys(localStorage); } catch { /* storage denied */ }
    const keys = [...new Set([...localKeys, ...memoryFallback.keys()])];
    for (const k of keys) {
      if (k.startsWith(PREFIX + 'session.')) {
        const v = unpack(getItem(k));
        if (v) out.push({ contentId: k.slice((PREFIX + 'session.').length), ...v });
      }
    }
    return out;
  },

  saveReplay(contentId, envelope) {
    setItem(PREFIX + 'replay.' + contentId, pack(envelope));
  },
  loadReplay(contentId) {
    return unpack(getItem(PREFIX + 'replay.' + contentId));
  },

  // last timestamp the cloud mirror accepted (guards the remote-preferred
  // load against overwriting local changes that never synced)
  loadCloudMeta() { return unpack(getItem(PREFIX + 'cloudmeta')) || null; },
  saveCloudMeta(meta) { setItem(PREFIX + 'cloudmeta', pack(meta)); },

  // local leaderboard: board key → entries (validated locally, ranked boards
  // additionally verified server-side when hosted)
  loadBoard(boardKey) { return unpack(getItem(PREFIX + 'board.' + boardKey)) || []; },
  submitBoardEntry(boardKey, entry, maxEntries = 25) {
    const entries = store.loadBoard(boardKey);
    entries.push(entry);
    entries.sort((a, b) => b.score - a.score || a.invalidCount - b.invalidCount || a.elapsedMs - b.elapsedMs || String(a.sessionId).localeCompare(String(b.sessionId)));
    const trimmed = entries.slice(0, maxEntries);
    setItem(PREFIX + 'board.' + boardKey, pack(trimmed));
    return trimmed.indexOf(entry);
  },

  resetAll() {
    const keys = [];
    if (hasLocal) {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(PREFIX)) keys.push(k);
      }
      keys.forEach(k => localStorage.removeItem(k));
    }
    memoryFallback.clear();
  },

  persistent: hasLocal,
};
