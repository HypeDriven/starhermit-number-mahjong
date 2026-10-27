// The game's data and the StarHermit platform, on the runtime's modules:
// - the progress (js/store.js: journey stars and bests, lessons, achievements,
//   daily history, challenge bests, totals) is the game's save
//   (starhermit:storage `saves`), on the device and in the player's cloud
//   slot; two devices' copies merge on a conflict as the browser build's
//   saveconflict merge did (mergeProgress). The slot the browser build wrote
//   (the JS SDK's writeSave of { version, savedAt, progress, settings } under
//   game:<slug>) shows as foreign: its progress is merged in, its game options
//   adopted, and it is replaced once;
// - the game's own options (board view, 2D board, cosmetic theme, colour-vision
//   palette, left-handed controls, sound captions, timing assistance) are
//   engine `settings` (same keys, kept with the account); the browser build's
//   values in the account's settings KV are adopted (unless set here since),
//   then all its KV keys are removed (volumes, mute, graphics, reduced motion,
//   high contrast, larger text and language are the runtime's Options; key and
//   pad bindings are the runtime's controls);
// - the device store (local boards, interrupted-round snapshots, replays) is
//   starhermit:storage `storage` under the browser build's key names;
// - the player, the invite link, the platform's clock for the Daily, the
//   online high-score board, and posting a finished round's total through
//   score-script.js (a practice session whose socket carries { type:
//   'result', scores }, as the JS SDK's submitScores did) with the rank.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions, type Leaderboard,
} from "starhermit:platform";
import { saves, settings as kv, storage } from "starhermit:storage";
import { Store, type DeviceStore, type Options, type Progress, type SaveDoc } from "./game.ts";

type Key = keyof Options;

// --- the game's options --------------------------------------------------------------------
export const options: Options = { ...Store.DEFAULT_OPTIONS };
const optionListeners = new Set<() => void>();
export function onOptionsChange(fn: () => void): void { optionListeners.add(fn); }
function optionsChanged(): void { for (const fn of optionListeners) fn(); }
function readOption(key: Key): void {
  let v: JsonValue | undefined;
  try { v = kv.get(key); } catch { return; }
  const ok = Store.pickOptions({ [key]: v })[key];
  if (ok !== undefined) (options as unknown as Record<string, unknown>)[key] = ok;
}
/** Changes one of the game's options (device and account). */
export function setOption<K extends Key>(key: K, value: Options[K]): void {
  if (options[key] === value) return;
  options[key] = value;
  try { kv.set(key, value as unknown as JsonValue); } catch (e) { console.warn(`option ${key}: ${String(e)}`); }
  optionsChanged();
}
/** A migrated value, kept unless this game set the key since. */
function adoptOption(key: Key, value: unknown): void {
  const v = Store.pickOptions({ [key]: value })[key];
  if (v === undefined) return;
  try {
    if (kv.get(key) !== undefined) return;
    kv.set(key, v as unknown as JsonValue);
    (options as unknown as Record<string, unknown>)[key] = v;
    optionsChanged();
  } catch { /* keep the device's */ }
}
function importLegacy(): void {
  const keys = kv.legacyKeys();
  if (!keys) return;
  for (const k of keys) if ((Store.OPTION_KEYS as string[]).includes(k)) adoptOption(k as Key, kv.legacy(k));
  for (const k of keys) if (Store.BROWSER_KEYS.includes(k)) kv.removeLegacy(k);
}
/** Settings › Erase: the options back to their defaults. */
export function resetOptions(): void {
  for (const k of Store.OPTION_KEYS) {
    (options as unknown as Record<string, unknown>)[k] = Store.DEFAULT_OPTIONS[k];
    try { kv.delete(k); } catch { /* already gone */ }
  }
  optionsChanged();
}

// --- the save ------------------------------------------------------------------------------
let doc: SaveDoc = Store.normalizeSave(null);
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

/** The live progress (rounds update it in place, then saveNow()). */
export function progress(): Progress { return doc.progress; }
/** Saves the document (device at once, the account debounced by the runtime). */
export function saveNow(opts: { replaceForeign?: boolean } = {}): void {
  try {
    saves.save(doc as unknown as JsonValue, { schema: Store.SAVE_SCHEMA, ...opts });
    lastSavedAt = saves.load()?.savedAt ?? lastSavedAt;
  } catch (e) { console.warn(`save: ${String(e)}`); }
}
/** Merges another copy's progress into the live document (and saves); whether anything changed. */
function adopt(other: unknown): boolean {
  const next = Store.mergeProgress(doc.progress, Store.normalizeSave(other).progress);
  if (Store.sameProgress(next, doc.progress)) return false;
  replaceWith(next);
  saveNow();
  return true;
}
/** Keeps the live object (screens hold it) and fills it from `next`. */
function replaceWith(next: Progress): void {
  const p = doc.progress as unknown as Record<string, unknown>;
  for (const k of Object.keys(p)) delete p[k];
  Object.assign(p, next);
}
/** Settings › Erase: progress back to a new player's. */
export function resetProgress(): void {
  replaceWith(Store.normalizeProgress(null));
  saveNow();
}
saves.onConflict((mine, remote) => ({
  merged: { v: Store.SAVE_SCHEMA, progress: Store.mergeProgress(Store.normalizeSave(mine?.data ?? null).progress, Store.normalizeSave(remote.data).progress) } as unknown as JsonValue,
}));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // The account's save replaced the device's (another device saved last): merge it in.
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(cur.data)) merged();
  }
});
/** The browser build's cloud mirror: progress merged with this device's, its options adopted, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const prev = Store.normalizeProgress(doc.progress);
  const foreign = old.text != null ? Store.readForeign(old.text) : null;
  if (foreign?.progress) replaceWith(Store.mergeProgress(doc.progress, foreign.progress));
  if (foreign) for (const [k, v] of Object.entries(foreign.options)) adoptOption(k as Key, v);
  saveNow({ replaceForeign: true });
  if (!Store.sameProgress(prev, doc.progress)) merged();
}

/** For the account chip (platform.js sync text): local (a guest) | saving | synced | offline. */
export function syncState(): "local" | "saving" | "synced" | "offline" {
  if (!player()) return "local";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "offline";
  if (st === "loading" || st === "foreign" || st === "uploading" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- the device store ----------------------------------------------------------------------
export const device: DeviceStore = Store.createStore({
  get: (k) => storage.getText(k),
  set: (k, v) => storage.set(k, v),
  remove: (k) => { storage.remove(k); },
  keys: () => storage.keys(),
}, () => nowMs());

/** Reads the device's save and the game's options (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  doc = Store.normalizeSave(cur?.data ?? null);
  for (const k of Store.OPTION_KEYS) readOption(k);
  kv.onChange((k) => {
    if (!(Store.OPTION_KEYS as string[]).includes(k)) return;
    readOption(k as Key);
    optionsChanged();
  });
  kv.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  optionsChanged();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

// --- the player and the clock ------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = undefined;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
const playerListeners = new Set<(signedIn: boolean) => void>();
export function onPlayer(fn: (signedIn: boolean) => void): void { playerListeners.add(fn); }
onPlayerChange(() => { refreshPlayer(); for (const fn of playerListeners) fn(!!player()); });

/** Now in ms by the platform's clock when it has answered, else the device's (the Daily's UTC day). */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}

// --- the high-score board ------------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
export interface Posted { posted: boolean; rank: number | null }
export interface OnlineRow { name: string; score: number; me: boolean }

/** The online board's first ten (the Score Chase screen); null when there is none or it cannot be read. */
export async function onlineBoard(): Promise<OnlineRow[] | null> {
  try {
    const b = await highScoreBoard();
    if (!b) return null;
    const r = await leaderboards.entries(b.id, { pageSize: 10 });
    const me = player()?.userId;
    return r.items.slice(0, 10).map((e) => ({ name: e.displayName || e.username, score: e.score, me: !!me && e.userId === me }));
  } catch { return null; }
}

/** Signed in only: post a finished round's total through score-script.js; { posted, rank }. Never rejects. */
export async function postScore(total: number): Promise<Posted> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
