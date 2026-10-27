// Number Mahjong on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (js/rules/engine.js), the content
// (js/rules/content.js) and the replay envelopes (js/rules/replay.js) are the
// browser build's, unchanged in what they decide; this module is what
// js/app/main.js did around them — the phase machine (title → mode screens →
// setup → 3-2-1 countdown with the "Observe" beat → active ⇄ paused →
// resolving → results), command dispatch with the pausable session clock,
// the round timer and its warnings, the tap-then-partner choice, keyboard and
// gamepad focus over the exposed tiles, lessons and their banner, progression,
// achievements, the local boards and posting Daily rounds and won Challenges
// to the high-score board, interrupted-round snapshots offered back on the
// title, announcements, toasts and sound captions, and the lifecycle (a hidden
// window pauses the round, as visibilitychange did). Screens are drawn by
// screens.ts (starhermit:ui), the desk by render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps at 60 Hz: the session clock advances one
// step's 1000/60 ms per fixed step while the round is active, so pauses, a
// hidden window and slow frames never cost time and play scripts replay
// exactly; the countdown (650 ms a number, 450 ms "Observe") and the 750 ms
// resolve settle count the same steps.
import "./i18n.ts";
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { bindingLabel, onAction, onPointerButton, onPointerMove, onTouch, pointer, setCursor } from "starhermit:input";
import * as ui from "starhermit:ui";
import type { ImageBitmap } from "starhermit:canvas";
import { avatar, onSessionEnded, player, requestSignIn } from "starhermit:platform";
import { C, E, R, type BoardEntry, type Board, type Command, type Content, type Replay, type RulesEvent, type Score, type State, type Theme } from "./game.ts";
import * as audio from "./audio.ts";
import { N, S, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

export type Screen = "title" | "journey" | "modesetup" | "practice" | "challenge" | "learn" | "results" | "settings" | "help" | "scores";
export type Phase = "title" | "mode-select" | "countdown" | "active" | "paused" | "resolving" | "results";
export interface Results {
  state: State; content: Content; breakdown: Score; stars: number | null; newAchievements: Achievement[]; placement: number; postLb: boolean;
}
export interface Achievement { key: string; name: string; desc: string }
export interface Toast { text: string; error: boolean; until: number }

export const ACHIEVEMENTS: Achievement[] = [
  { key: "first-clear", name: N("First Light"), desc: N("Complete your first round.") },
  { key: "mechanic-master", name: N("Every Instrument"), desc: N("Win a round of each rule type: sum, match, difference.") },
  { key: "streak-3", name: N("Steady Hand"), desc: N("Win three rounds in a row without a loss.") },
  { key: "half-journey", name: N("Surveyor"), desc: N("Complete 22 journey stages.") },
  { key: "full-journey", name: N("Cartographer of Skies"), desc: N("Complete all 44 journey stages.") },
  { key: "zenith", name: N("Zenith"), desc: N("Complete the final mastery stage.") },
  { key: "daily-7", name: N("Weekly Watcher"), desc: N("Complete dailies on 7 different days.") },
  { key: "marathon", name: N("Long Exposure"), desc: N("Remove 1,000 tiles in total across all rounds.") },
];
const DIFFICULTY: Record<string, string> = { easy: N("Easy"), medium: N("Medium"), hard: N("Hard"), expert: N("Expert") };
export { DIFFICULTY };

export const app = {
  /** The menu screen shown (null: the round's play view). */
  screen: "title" as Screen | null,
  phase: "title" as Phase,
  /** The pause sheet over the round. */
  overlay: null as "pause" | null,
  /** Settings or Help opened from the pause sheet go back to it. */
  returnTo: null as "pause" | null,
  /** Frame the screen or overlay opened on (the press that opened it must not also act on it). */
  openedFrame: 0,
  focusNext: null as string | null,
  state: null as State | null,
  content: null as Content | null,
  board: null as Board | null,
  replay: null as Replay | null,
  sessionId: "",
  cmdSeq: 0,
  /** Keyboard / gamepad focus over the exposed tiles. */
  focusTileId: null as number | null,
  lessonStep: 0,
  lesson: null as { text: string; isLast: boolean } | null,
  countdown: null as string | null,
  pending: null as Content | null,
  setupBlurb: null as string | null,
  results: null as Results | null,
  lb: null as platform.Posted | "posting" | null,
  toasts: [] as Toast[],
  caption: null as { text: string; until: number } | null,
  winStreak: 0,
  confirmErase: false,
  online: null as platform.OnlineRow[] | null | "loading",
  avatar: null as ImageBitmap | null,
  /** The 2D board is shown (the option, or a round the 3D view could not start). */
  board2d: false,
};
const clock = { ms: 0, running: false };
const STEP_MS = 1000 / 60;
const now = (): number => frame().time;
const reduced = (): boolean => preferences().reducedMotion;

// ------------------------------------------------------------------ helpers
let lastAnnouncement = "";
/** ui.js announce(): the live region (repeated text skipped so screen readers stay usable). */
export function announce(text: string, assertive = false): void {
  if (!text) return;
  if (text === lastAnnouncement) text += " ";
  lastAnnouncement = text;
  ui.announce(text.slice(0, 600), { politeness: assertive ? "assertive" : "polite" });
}
/** ui.js toast(): 2.6 s, at most three. */
export function toast(text: string, error = false): void {
  app.toasts.push({ text, error, until: now() + 2.6 });
  while (app.toasts.length > 3) app.toasts.shift();
  if (!error) sfx("toast");
}
/** A sound with its caption (Sound captions: "♪ …" for 1.4 s). */
export function sfx(event: string, chain = 0): void {
  const cap = audio.play(event, chain);
  if (cap && platform.options.soundCaptions) app.caption = { text: "♪ " + T(cap, { n: chain || 1 }), until: now() + 1.4 };
}
export function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
/** The keys bound to an action, as the help card and Settings show them. */
export function keyText(action: string): string {
  try { return bindingLabel(action, "keyboard") || "—"; } catch { return "—"; }
}
/** ui.js contentName: a content item's display name. */
export function contentName(c: Content | null): string {
  if (!c) return "";
  if (c.kind === "daily") return T("Daily — {date}", { date: String(c.id || "").replace(/^daily-/, "") });
  if (c.kind === "practice") {
    const d = (String(c.id || "").match(/^practice-(\w+)/) || [])[1] ?? "";
    return T("Practice — {level}", { level: T(DIFFICULTY[d] ?? c.name) });
  }
  return T(c.name);
}
/** The theme shown: the option's, else the round's (ivory dusk on the menus before any round). */
export function themeNow(): Theme { return C.getTheme(platform.options.themeOverride || app.content?.theme || lastTheme); }
let lastTheme = "ivory-dusk";

function nowUtcMs(): number { return platform.nowMs(); }
export function todayDailyInfo(): { iso: string; dayIndex: number } {
  const d = new Date(nowUtcMs());
  const iso = d.toISOString().slice(0, 10);
  return { iso, dayIndex: Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000) };
}
export function msUntilNextDaily(): number {
  const n = nowUtcMs();
  return (Math.floor(n / 86400000) + 1) * 86400000 - n;
}
export function effectiveTimeLimit(content: Content): number | null {
  if (content.limits?.timeMs == null) return null;
  return Math.round(content.limits.timeMs * (platform.options.timingAssist ? 1.5 : 1));
}
export function timerRemaining(): number | null {
  if (!app.state || app.state.limits.timeMs == null) return null;
  return app.state.limits.timeMs - clock.ms;
}
const newSessionId = (): string => Math.random().toString(36).slice(2, 10);

// ------------------------------------------------------------------ navigation
export function show(screen: Screen | null, focus: string | null = "first"): void {
  app.screen = screen;
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  app.confirmErase = false;
  ui.setFocus(null);
}
const pendingActs: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built (state changes mid-build would break later widgets). */
export function later(fn: () => void): void { pendingActs.push(fn); }

/** Interrupted rounds on this device: the most recent non-terminal snapshot (the title's Resume button). */
export function resumeInfo(): { contentId: string; elapsedMs: number; remaining: number } | null {
  let best: { contentId: string; elapsedMs: number; remaining: number } | null = null;
  for (const snap of platform.device.listSessionSnapshots()) {
    try {
      const st = E.deserialize(snap.state);
      if (st.status === "active" && (!best || st.elapsedMs > best.elapsedMs)) best = { contentId: snap.contentId, elapsedMs: st.elapsedMs, remaining: E.remainingTiles(st) };
    } catch { /* corrupt snapshot ignored */ }
  }
  return best;
}
let resumeCache: ReturnType<typeof resumeInfo> | undefined;
export function cachedResume(): ReturnType<typeof resumeInfo> {
  if (resumeCache === undefined) resumeCache = resumeInfo();
  return resumeCache;
}

export function toTitle(): void {
  teardownRound();
  app.phase = "title";
  resumeCache = undefined;
  render.setActive(false);
  show("title");
}
/** A mode screen from the title (sound per old _onScreenAction). */
export function open(screen: Screen): void {
  sfx(["journey", "practice", "challenge", "learn", "scores"].includes(screen) ? "tab-switch" : "ui");
  if (screen === "scores") loadOnline();
  show(screen);
}
/** data-act="back": Settings / Help over a paused round go back to it, everything else to the title. */
export function back(): void {
  if (app.returnTo === "pause") {
    sfx("modal-close");
    app.returnTo = null;
    show(null, null);
    openPause();
    return;
  }
  sfx(app.screen === "settings" ? "settings-saved" : "back");
  toTitle();
}
export function openSettings(fromPause: boolean): void {
  if (fromPause) { sfx("modal-open"); app.returnTo = "pause"; app.overlay = null; }
  else { sfx("ui"); app.returnTo = null; }
  show("settings");
}
export function openHelp(fromPause: boolean): void {
  if (fromPause) { sfx("modal-open"); app.returnTo = "pause"; app.overlay = null; }
  else { sfx("ui"); app.returnTo = null; }
  show("help");
}
function loadOnline(): void {
  if (!platform.signedIn()) { app.online = null; return; }
  app.online = "loading";
  void platform.onlineBoard().then((rows) => { app.online = rows; });
}

export function openModeSetup(content: Content, blurb: string | null = null): void {
  app.pending = content;
  app.setupBlurb = blurb;
  app.phase = "mode-select";
  show("modesetup", "btn-begin");
}
export function play(): void {
  sfx("ui");
  const p = platform.progress();
  const next = C.JOURNEY.find((s) => !p.journey[s.id]) ?? C.JOURNEY[C.JOURNEY.length - 1]!;
  openModeSetup({ ...next });
}
export function openStage(id: string): void {
  sfx("ui");
  const st = C.JOURNEY.find((j) => j.id === id);
  if (st) openModeSetup({ ...st });
}
export function openDaily(): void {
  sfx("ui");
  try {
    const { iso, dayIndex } = todayDailyInfo();
    openModeSetup(C.dailyContent(iso, dayIndex));
  } catch (err) {
    // A bad clock must never leave the menu silently unresponsive.
    toast(T("Could not set up today’s daily (clock problem). Using this device’s clock — try again."));
    console.warn(`daily setup failed: ${String(err)}`);
  }
}
export function openPractice(level: string): void {
  sfx("ui");
  openModeSetup(C.practiceContent(level, Math.random().toString(36).slice(2, 8)));
}
export function openChallenge(id: string): void {
  sfx("ui");
  const c = C.challengeContent(id);
  openModeSetup(c, c.blurb ?? null);
}
export function startLesson(id: string): void {
  sfx("ui");
  beginRound(C.lessonContent(id));
}
export function begin(): void {
  if (!app.pending) return;
  sfx("confirm");
  beginRound(app.pending);
}

// ------------------------------------------------------------------ the round
function prepared(content: Content): { content: Content; board: Board } {
  const p = C.prepareContent(content);
  const limit = effectiveTimeLimit(p.content);
  if (limit != null) p.content.limits = { ...p.content.limits, timeMs: limit };
  return p;
}
let countdown: { n: number; steps: number } | null = null;
let resolveSteps = -1;
let lastTickSec = -1;

function enterRound(content: Content, board: Board, state: State): void {
  app.content = content;
  app.board = board;
  app.state = state;
  app.sessionId = newSessionId();
  app.focusTileId = null;
  app.results = null;
  app.lb = null;
  app.overlay = null;
  app.returnTo = null;
  app.lesson = null;
  lastTheme = content.theme ?? lastTheme;
  app.board2d = platform.options.board2d;
  render.setTheme(themeNow());
  render.setReducedMotion(reduced());
  render.setCameraMode(platform.options.camera);
  render.setActive(!app.board2d);
  render.buildBoard(state);
  show(null, null);
  lastTickSec = -1;
}

export function beginRound(content: Content): void {
  const p = prepared(content);
  const state = E.createGame(p.content, p.board);
  enterRound(p.content, p.board, state);
  app.replay = R.openReplay(p.content, p.board);
  app.cmdSeq = 0;
  app.lessonStep = 0;
  announce(boardSummary(state));
  if (p.content.kind === "lesson") startLesson0();
  app.phase = "countdown";
  clock.ms = 0;
  clock.running = false;
  if (reduced()) { activate(); return; }
  countdown = { n: 3, steps: 0 };
  app.countdown = "3";
  sfx("countdown");
}

/** main.js countdown on the fixed steps: a number every 39 steps (650 ms), then "Observe" for 27 (450 ms). */
function countdownStep(): void {
  const c = countdown;
  if (!c || app.phase !== "countdown") return;
  c.steps++;
  if (c.n > 0 && c.steps >= 39) {
    c.steps = 0;
    c.n--;
    if (c.n > 0) { app.countdown = String(c.n); sfx("countdown"); }
    else { app.countdown = T("Observe"); sfx("round-start"); }
  } else if (c.n === 0 && c.steps >= 27) {
    countdown = null;
    app.countdown = null;
    activate();
  }
}

function activate(): void {
  if (app.phase !== "countdown" || !app.state) return;
  app.phase = "active";
  clock.ms = 0;
  clock.running = true;
  const target = E.currentTarget(app.state);
  announce(T("Round started. {rule}. {summary}", { rule: C.describeRuleShort(app.state.ruleset, target), summary: boardSummary(app.state) }));
  if (hidden) pauseRound();
}

export function resumeSavedRound(contentId: string): void {
  sfx("ui");
  const snap = platform.device.loadSessionSnapshot(contentId);
  if (!snap?.state) { toast(T("No saved round found"), true); return; }
  let state: State;
  try { state = E.deserialize(snap.state); } catch { toast(T("Saved round was corrupt"), true); return; }
  // rebuild content deterministically from the stored content id
  let content: Content | null = null;
  if (contentId.startsWith("daily-")) {
    const iso = contentId.slice(6);
    content = C.dailyContent(iso, Math.floor(new Date(iso + "T00:00:00Z").getTime() / 86400000));
  } else if (contentId.startsWith("journey-")) content = C.JOURNEY.find((j) => j.id === contentId) ?? null;
  else if (contentId.startsWith("practice-")) {
    const m = contentId.match(/^practice-(\w+)-(.+)$/);
    if (m) content = C.practiceContent(m[1]!, m[2]!);
  } else if (contentId.startsWith("chal-")) content = C.challengeContent(contentId);
  if (!content) { toast(T("Cannot resume this round"), true); return; }
  const p = prepared(content);
  enterRound(p.content, p.board, state);
  app.replay = R.openReplay(p.content, p.board); // continuation log; the snapshot's state carries the hash
  app.phase = "active";
  clock.ms = state.elapsedMs;
  clock.running = true;
  const away = T("Welcome back. {n} tiles remain, score {score}, {time} elapsed.", { n: E.remainingTiles(state), score: E.score(state).total, time: fmtMs(state.elapsedMs) });
  toast(away);
  announce(away + " " + boardSummary(state));
}

export function boardSummary(state: State): string {
  const exposed = E.exposedTiles(state);
  const vals = exposed.map((id) => state.tiles[id]!.value).join(", ");
  const rule = C.describeRuleShort(state.ruleset, E.currentTarget(state));
  return T("{rule}. {n} tiles exposed with values: {values}. {left} tiles remain.", { rule, n: exposed.length, values: vals, left: E.remainingTiles(state) });
}

// ------------------------------------------------------------------ commands
export function dispatch(cmd: Command): void {
  if (!app.state || app.phase !== "active") return;
  cmd.id = `${app.sessionId}-${++app.cmdSeq}`;
  cmd.atMs = Math.round(clock.ms);
  const before = app.state;
  const { state: next, events } = E.applyCommand(before, cmd);
  if (next === before && events[0]?.type === "rejected") {
    if (cmd.type === "hint" || cmd.type === "reshuffle" || cmd.type === "undo") {
      toast(T(events[0].reason ?? "Not allowed"), true);
      sfx("invalid");
    }
    return;
  }
  app.state = next;
  R.recordCommand(app.replay!, cmd, next);
  afterCommand(events, before);
}

function afterCommand(events: RulesEvent[], before: State): void {
  const st = app.state!;
  render.syncState(st, events);
  platform.device.saveSessionSnapshot(app.content!.id, { state: E.serialize(st), replay: { ...app.replay!, state: undefined } as Replay });
  for (const ev of events) {
    switch (ev.type) {
      case "select":
        sfx("select");
        announce(T("Tile {v} selected. {hint}", { v: st.tiles[ev.tile!]!.value, hint: partnerHint(ev.tile!) }));
        break;
      case "deselect": sfx("deselect"); break;
      case "invalid":
        sfx("invalid");
        toast(invalidText(ev), true);
        announce(T("Invalid: {reason}", { reason: invalidText(ev) }));
        break;
      case "pair": {
        sfx(ev.chain! > 1 ? "chain" : "pair", ev.chain ?? 0);
        // a deeper tile sliding free under the removed pair
        if (E.exposedTiles(st).some((id) => st.tiles[id] && !E.isExposed(before, id))) sfx("expose");
        if (st.ruleset.dynamic && st.status === "active") sfx("target-shift");
        announce(T("{a} and {b} removed, +{gained}. {left} pairs left.", { a: ev.values![0], b: ev.values![1], gained: ev.gained!, left: E.remainingTiles(st) / 2 })
          + (st.ruleset.dynamic ? " " + T("New target: {n}.", { n: E.currentTarget(st)! }) : ""));
        break;
      }
      case "hint": {
        sfx("hint");
        const a = st.tiles[ev.tileA!]!, b = st.tiles[ev.tileB!]!;
        announce(T("Hint: try {a} and {b}.", { a: a.value, b: b.value }));
        toast(T("Hint: {pair}", { pair: `${a.value} ${hintJoiner(st)} ${b.value}` }));
        break;
      }
      case "reshuffle":
        sfx("reshuffle");
        announce(T("Remaining tiles reshuffled.") + " " + boardSummary(st));
        break;
      case "undo":
        sfx("undo");
        announce(T("Move undone.") + " " + boardSummary(st));
        break;
      case "terminal":
        onTerminal();
        break;
    }
  }
  if (app.focusTileId != null && !E.isExposed(st, app.focusTileId)) app.focusTileId = null;
  if (app.content!.kind === "lesson") lessonTick();
}

export function partnerHint(tileId: number): string {
  const st = app.state!;
  const v = st.tiles[tileId]!.value;
  const r = st.ruleset;
  switch (r.rule) {
    case "sum": return T("Partner must be {n}.", { n: E.currentTarget(st)! - v });
    case "match": return T("Partner must also be {n}.", { n: v });
    case "diff": return T("Partner must be {a} or {b}.", { a: v - r.diff!, b: v + r.diff! });
    default: return "";
  }
}
function invalidText(ev: RulesEvent): string {
  const st = app.state!;
  if (ev.reason === E.REJECT.RULE_MISMATCH) {
    const a = st.tiles[ev.tileA!]?.value ?? "", b = st.tiles[ev.tileB!]?.value ?? "";
    return T("{a} and {b} don’t satisfy the rule ({rule})", { a, b, rule: C.describeRuleShort(st.ruleset, E.currentTarget(st)) });
  }
  if (ev.reason === E.REJECT.NOT_EXPOSED) return T("That tile is covered or locked on both sides");
  return ev.reason ? T(ev.reason) : T("Not allowed");
}
function hintJoiner(st: State): string { return st.ruleset.rule === "match" ? "=" : st.ruleset.rule === "diff" ? "↔" : "+"; }

/** Tap / confirm semantics: the first tile selects, a second tile attempts the pair. */
export function chooseTile(tileId: number): void {
  const st = app.state;
  if (!st || app.phase !== "active") return;
  if (st.selected == null || st.selected === tileId) dispatch({ type: "select", tileId });
  else dispatch({ type: "pair", tileA: st.selected, tileB: tileId });
}
export const hint = (): void => dispatch({ type: "hint" });
export const reshuffle = (): void => dispatch({ type: "reshuffle" });
export const undo = (): void => dispatch({ type: "undo" });

// ------------------------------------------------------------------ the timer (on fixed steps)
function timerStep(): void {
  if (app.phase !== "active" || !app.state) return;
  const rem = timerRemaining();
  if (rem == null) return;
  if (rem <= 0) dispatch({ type: "timeout" });
  else if (rem < 10500 && Math.floor(rem / 1000) !== lastTickSec) {
    lastTickSec = Math.floor(rem / 1000);
    sfx("timer-warning");
  }
}

// ------------------------------------------------------------------ terminal and results
function onTerminal(): void {
  app.phase = "resolving";
  clock.running = false;
  const won = app.state!.status === "won";
  sfx(won ? "board-clear" : "lose");
  app.lesson = null;
  // settle cosmetics into the exact deterministic end state, then results (750 ms; 60 ms with reduced motion)
  resolveSteps = reduced() ? 4 : 45;
}
function resolveStep(): void {
  if (app.phase !== "resolving" || resolveSteps < 0) return;
  if (--resolveSteps > 0) return;
  resolveSteps = -1;
  render.settleImmediately();
  showResults();
}

function showResults(): void {
  app.phase = "results";
  const st = app.state!, content = app.content!;
  const breakdown = E.score(st);
  const won = st.status === "won";
  const envelope = R.closeReplay(app.replay!, st, breakdown, app.sessionId);
  platform.device.saveReplay(content.id, envelope);
  platform.device.clearSessionSnapshot(content.id);
  const p = platform.progress();
  p.totals.plays++;
  p.totals.pairs += st.pairsCleared;
  if (won) { p.totals.wins++; app.winStreak++; } else app.winStreak = 0;
  let stars: number | null = null;
  if (content.kind === "journey" && won) {
    const prev = p.journey[content.id];
    stars = 1 + (breakdown.total >= content.par.score ? 1 : 0) + (st.elapsedMs <= content.par.timeMs ? 1 : 0);
    p.journey[content.id] = {
      stars: Math.max(stars, prev?.stars || 0),
      bestScore: Math.max(breakdown.total, prev?.bestScore || 0),
      bestMs: prev?.bestMs ? Math.min(prev.bestMs, st.elapsedMs) : st.elapsedMs,
      completions: (prev?.completions || 0) + 1,
    };
    p.masteryXp += 10 + (content.mastery ? 15 : 0) + stars * 2;
  }
  if (content.kind === "lesson" && won) p.lessons[content.id] = { completed: true };
  if (content.kind === "daily") {
    // the round's own day, not "today": a round crossing UTC midnight lands on the seed that was played
    const iso = content.id.slice("daily-".length);
    const prev = p.dailyHistory[iso];
    p.dailyHistory[iso] = { score: Math.max(breakdown.total, prev?.score || 0), completed: (prev?.completed || false) || won };
    p.lastDailyDate = iso;
  }
  if (content.kind === "challenge" && won) {
    const prev = p.challenges[content.id];
    if (!prev || breakdown.total > prev.score) p.challenges[content.id] = { score: breakdown.total, elapsedMs: st.elapsedMs };
  }
  // local boards — wins only
  let placement = -1;
  if (won) {
    const entry: BoardEntry = {
      score: breakdown.total, elapsedMs: st.elapsedMs, invalidCount: st.invalidCount, sessionId: app.sessionId, at: nowUtcMs(),
      ruleset: content.ruleset.rule, contentVersion: content.contentVersion, seed: String(content.seed), assists: assistsUsed(), verified: false,
    };
    placement = platform.device.submitBoardEntry(boardKey(), entry);
    if (content.kind === "journey") platform.device.submitBoardEntry("journey.all", entry, 50);
  }
  const newAchievements = checkAchievements();
  platform.saveNow();
  // signed in: every finished Daily round and every won Challenge posts its total to the high-score board
  const postLb = platform.signedIn() && (content.kind === "daily" || (content.kind === "challenge" && won));
  app.results = { state: st, content, breakdown, stars, newAchievements, placement, postLb };
  app.lb = postLb ? "posting" : null;
  show("results", won && nextStage() ? "btn-next" : "btn-retry");
  if (postLb) {
    void platform.postScore(breakdown.total).then((r) => { if (app.results?.state === st && app.phase === "results") app.lb = r; });
  }
  announce(T("{headline}. Total score {total}.", { headline: won ? T("Round complete") : T("Round over"), total: breakdown.total }), true);
  if (won) sfx("win-stinger");
  if (stars != null && won) sfx("star-rating");
  if (placement === 0) sfx("new-record");
  if (newAchievements.length) sfx("achievement");
}
function assistsUsed(): string {
  const st = app.state!, out: string[] = [];
  if (st.hintsUsed) out.push(`hints:${st.hintsUsed}`);
  if (st.reshufflesUsed) out.push(`reshuffles:${st.reshufflesUsed}`);
  if (st.undoCount) out.push(`undo:${st.undoCount}`);
  if (platform.options.timingAssist) out.push("timing-assist");
  return out.join(",") || "none";
}
function boardKey(): string {
  const c = app.content!;
  if (c.kind === "daily") return "daily." + c.id.slice("daily-".length);
  if (c.kind === "challenge") return "challenge." + c.id;
  if (c.kind === "journey") return "journey." + c.id;
  return "casual." + c.kind;
}
function checkAchievements(): Achievement[] {
  const st = app.state!, content = app.content!, p = platform.progress();
  const won = st.status === "won";
  const unlocked: Achievement[] = [];
  const grant = (key: string): void => {
    if (p.achievements[key]) return;
    p.achievements[key] = nowUtcMs();
    const meta = ACHIEVEMENTS.find((a) => a.key === key);
    if (meta) { unlocked.push(meta); toast(T("Achievement: {name}", { name: T(meta.name) })); }
  };
  if (won) {
    grant("first-clear");
    if (app.winStreak >= 3) grant("streak-3");
    const rulesWon = new Set<string>();
    for (const [id, rec] of Object.entries(p.journey)) {
      if (rec.completions > 0) { const s = C.JOURNEY.find((j) => j.id === id); if (s) rulesWon.add(s.ruleset.rule); }
    }
    if (content.kind === "journey") rulesWon.add(content.ruleset.rule);
    if (["sum", "match", "diff"].every((r) => rulesWon.has(r))) grant("mechanic-master");
    const doneCount = Object.keys(p.journey).length;
    if (doneCount >= 22) grant("half-journey");
    if (doneCount >= C.JOURNEY.length) grant("full-journey");
    if (content.id === "journey-44") grant("zenith");
    if (Object.keys(p.dailyHistory).filter((d) => p.dailyHistory[d]!.completed).length >= 7) grant("daily-7");
  }
  if (p.totals.pairs >= 1000) grant("marathon");
  return unlocked;
}
/** The journey stage after the results' one (won), or null. */
export function nextStage(): Content | null {
  const r = app.results;
  if (!r || r.state.status !== "won" || r.content.kind !== "journey") return null;
  return C.JOURNEY[r.content.index!] ?? null;
}
export function goNext(): void { const n = nextStage(); if (n) { sfx("ui"); openModeSetup({ ...n }); } }
export function leaderboardLine(): string | null {
  const r = app.lb;
  if (!r) return null;
  if (r === "posting") return S("lbPosting");
  return !r.posted ? S("lbNotPosted") : r.rank ? S("lbRank", { rank: r.rank }) : S("lbPosted");
}

// ------------------------------------------------------------------ lessons
function startLesson0(): void {
  const script = app.content!.script ?? [];
  if (!script.length) return;
  app.lesson = { text: script[0]!.text, isLast: script.length === 1 };
}
function lessonTick(): void {
  const st = app.state!;
  const script = app.content!.script ?? [];
  if (!script.length || app.lessonStep >= script.length) return;
  const step = script[app.lessonStep]!;
  if (step.requireSelectValue != null && st.selected != null) {
    if (st.tiles[st.selected]!.value === step.requireSelectValue) lessonAdvance();
  } else if (step.requirePairValues && st.pairsCleared > 0) lessonAdvance();
}
export function lessonAdvance(): void {
  app.lessonStep++;
  const script = app.content?.script ?? [];
  if (app.lessonStep < script.length) app.lesson = { text: script[app.lessonStep]!.text, isLast: app.lessonStep === script.length - 1 };
  else app.lesson = null;
}

// ------------------------------------------------------------------ pause / resume / leave
export function openPause(): void {
  app.overlay = "pause";
  app.openedFrame = frame().frame;
  app.focusNext = "btn-resume";
  ui.setFocus(null);
}
export function pauseRound(): void {
  if (app.phase !== "active") return;
  app.phase = "paused";
  clock.running = false;
  sfx("pause");
  audio.setSuspended(true);
  openPause();
  announce(T("Paused"));
}
export function resumeRound(): void {
  if (app.phase !== "paused") return;
  app.phase = "active";
  app.overlay = null;
  app.returnTo = null;
  show(null, null);
  clock.running = true;
  audio.setSuspended(false);
  sfx("resume");
  announce(T("Round resumed.") + " " + boardSummary(app.state!));
}
export function leaveRound(): void {
  sfx("ui");
  if (app.state && app.state.status === "active") {
    // record abandonment in the log for honesty: the terminal handler shows the results
    app.overlay = null;
    app.phase = "active";
    clock.running = true;
    audio.setSuspended(false);
    show(null, null);
    dispatch({ type: "quit" });
    if (app.state.status !== "active") return;
  }
  toTitle();
}
function teardownRound(): void {
  app.overlay = null;
  app.returnTo = null;
  app.lesson = null;
  app.countdown = null;
  countdown = null;
  resolveSteps = -1;
  clock.running = false;
  audio.setSuspended(false);
  app.state = null;
  app.content = null;
  app.board = null;
  app.replay = null;
}
export function restartRound(): void {
  const c = app.content;
  if (!c) return;
  sfx("ui");
  let content: Content;
  const stage = C.JOURNEY.find((j) => j.id === c.id);
  if (stage) content = { ...stage };
  else if (c.kind === "practice") {
    const m = c.id.match(/^practice-(\w+)-(.+)$/);
    content = m ? C.practiceContent(m[1]!, m[2]!) : c;
  } else if (c.kind === "daily") {
    const { iso, dayIndex } = todayDailyInfo();
    content = C.dailyContent(iso, dayIndex);
  } else if (c.kind === "challenge") content = C.challengeContent(c.id);
  else if (c.kind === "lesson") content = C.lessonContent(c.id);
  else content = c;
  teardownRound();
  beginRound(content);
}

// ------------------------------------------------------------------ account and settings actions
export function copyInvite(): void {
  sfx("ui");
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(S("copied")); } catch { toast(S("copyFailed"), true); }
}
export function signIn(): void { sfx("ui"); void requestSignIn().catch(() => undefined); }
export function resetTutorials(): void {
  sfx("ui");
  platform.progress().lessons = {};
  platform.saveNow();
  toast(T("Lessons reset"));
}
export function eraseAll(): void {
  sfx("ui");
  platform.device.resetAll();
  platform.resetProgress();
  platform.resetOptions();
  app.confirmErase = false;
  resumeCache = undefined;
  toast(T("All local data erased"));
}

// ------------------------------------------------------------------ keyboard / gamepad focus
function exposedSorted(): { id: number; x: number; y: number }[] {
  const st = app.state;
  if (!st) return [];
  return E.exposedTiles(st).map((id) => {
    const t = st.tiles[id]!;
    const cell = st.layout.cells[t.stack]!;
    return { id, x: cell.x, y: cell.y };
  }).sort((a, b) => a.y - b.y || a.x - b.x);
}
/** main.js _moveFocus: the nearest exposed tile in a grid direction, wrapping. */
export function moveFocus(dx: number, dy: number): void {
  const exposed = exposedSorted();
  if (!exposed.length) return;
  const cur = exposed.find((t) => t.id === app.focusTileId);
  if (!cur) app.focusTileId = exposed[0]!.id;
  else {
    let best: { id: number; x: number; y: number } | null = null, bestScore = Infinity;
    for (const t of exposed) {
      if (t.id === cur.id) continue;
      const vx = t.x - cur.x, vy = t.y - cur.y;
      if (dx && Math.sign(vx) !== dx) continue;
      if (dy && Math.sign(vy) !== dy) continue;
      const lateral = dx ? Math.abs(vy) : Math.abs(vx);
      const forward = dx ? Math.abs(vx) : Math.abs(vy);
      const score = forward * 10 + lateral * 14;
      if (forward > 0 && score < bestScore) { bestScore = score; best = t; }
    }
    if (!best) best = exposed.slice().sort((a, b) => (dx ? (a.x - b.x) * dx || (a.y - b.y) : (a.y - b.y) * dy || (a.x - b.x)))[0]!;
    app.focusTileId = best.id;
  }
  const t = app.state!.tiles[app.focusTileId!]!;
  announce(T("Focused tile {v}. {hint}", { v: t.value, hint: partnerHint(t.id) }));
  if (app.board2d) { app.focusNext = `tile-${app.focusTileId}`; app.openedFrame = frame().frame; }
}

// ------------------------------------------------------------------ input
const inRound = (): boolean => app.screen === null && app.state !== null;
const MOVES: Record<string, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
onAction((e) => {
  if (!e.pressed) return;
  const fresh = frame().frame === app.openedFrame;
  if (fresh || ui.capturingKeys()) return;
  const play = inRound() && app.overlay === null;
  switch (e.action) {
    case "back":
      if (app.phase === "paused" && app.overlay === "pause") resumeRound();
      else if (play && app.phase === "active") {
        if (app.state!.selected != null) dispatch({ type: "select", tileId: app.state!.selected });
        else pauseRound();
      }
      break;
    case "pause":
      if (app.phase === "paused" && app.overlay === "pause") resumeRound();
      else if (play) pauseRound();
      break;
    case "hint": if (play) hint(); break;
    case "reshuffle": if (play) reshuffle(); break;
    case "undo": if (play) undo(); break;
    case "camera": if (play) render.resetCamera(); break;
    case "left": case "right": case "up": case "down":
      if (play && app.phase === "active") {
        // board focus, not the UI's: arrows must not also walk the HUD buttons
        if (!app.board2d) ui.setFocus(null);
        const [dx, dy] = MOVES[e.action]!;
        moveFocus(dx, dy);
      }
      break;
    case "choose":
      // a focused UI widget takes Enter / Space itself (the 2D board's tiles are widgets)
      if (play && app.phase === "active" && app.focusTileId != null && ui.focused() == null) chooseTile(app.focusTileId);
      break;
  }
});

/** HUD rectangles (window pixels) where a press belongs to the UI, set by screens.ts each frame. */
export const hudRects: { x: number; y: number; width: number; height: number }[] = [];
const onHud = (x: number, y: number): boolean => hudRects.some((r) => x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height);
type PEvent = { kind: "down" | "move" | "up" | "cancel"; x: number; y: number; id: number; t: number };
const pevents: PEvent[] = [];
let lastTouch = -1e9;
onTouch((e) => {
  lastTouch = now();
  if (e.control) return;
  const kind = e.phase === "start" ? "down" : e.phase === "move" ? "move" : e.phase === "end" ? "up" : "cancel";
  pevents.push({ kind, x: e.x, y: e.y, id: e.id, t: now() });
});
onPointerButton((e) => {
  if (e.button !== 0 || now() - lastTouch < 0.6) return;
  pevents.push({ kind: e.pressed ? "down" : "up", x: e.x, y: e.y, id: -1, t: now() });
});
let pointerMoved = true;
onPointerMove((x, y) => {
  pointerMoved = true;
  if (now() - lastTouch >= 0.6) pevents.push({ kind: "move", x, y, id: -1, t: now() });
});
let downAt: (PEvent & { drag: boolean }) | null = null;
/** main.js canvas pointer handling, decided once the frame's UI is built: a tap picks a tile; a drag past 14 px is not a tap. */
function pointerInput(): void {
  const sc = ui.preferences().scale;
  const live = inRound() && app.phase === "active" && app.overlay === null && !app.board2d;
  for (const ev of pevents.splice(0)) {
    if (ev.kind === "down") {
      downAt = live && !onHud(ev.x, ev.y) ? { ...ev, drag: false } : null;
      if (downAt) ui.setFocus(null);
      continue;
    }
    const d = downAt;
    if (!d || d.id !== ev.id) continue;
    if (ev.kind === "move") {
      if (!d.drag && Math.hypot(ev.x - d.x, ev.y - d.y) / sc > 14) { d.drag = true; sfx("drag-start"); }
      continue;
    }
    downAt = null;
    if (ev.kind === "cancel") continue;
    if (d.drag) { sfx("drop"); continue; }
    if (!live || ev.t - d.t > 0.6) continue; // long press ≠ tap
    const id = render.pick(ev.x, ev.y);
    if (id != null) chooseTile(id);
  }
  // hover: the pointer cursor only over exposed tiles
  if (pointerMoved) {
    pointerMoved = false;
    const p = pointer();
    const id = live && p && !onHud(p.x, p.y) ? render.pick(p.x, p.y) : null;
    setCursor(id != null && app.state && E.isExposed(app.state, id) ? "pointer" : "default");
  }
}

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
function refreshAvatar(): void {
  app.avatar = null;
  const me = player();
  if (me) void avatar(me.userId).then((img) => { if (player()?.userId === me.userId) app.avatar = img; }, () => undefined);
}

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  render.setReducedMotion(reduced());
  render.setTheme(themeNow());
  applyLook();
  refreshAvatar();
  toTitle();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onOptionsChange(() => {
  render.setCameraMode(platform.options.camera);
  render.setTheme(themeNow());
  if (app.state && platform.options.board2d !== app.board2d) {
    app.board2d = platform.options.board2d;
    // the 3D desk shows only in a round's play view (render.setActive below follows the screen)
  }
});
platform.onProgressMerged(() => { resumeCache = undefined; });
platform.onPlayer((on) => { refreshAvatar(); if (!on) toast(S("signedOut")); });
onSessionEnded(() => toast(S("signedOut"))); // keep playing locally
let hidden = false;
onSuspend(() => {
  hidden = true;
  platform.flush();
  if (app.phase === "active") pauseRound();
  audio.setSuspended(true);
});
onResume(() => {
  hidden = false;
  if (app.phase !== "paused") audio.setSuspended(false);
});

onFixedUpdate(() => {
  if (hidden) return;
  countdownStep();
  if (app.phase === "active" && clock.running) clock.ms += STEP_MS;
  timerStep();
  resolveStep();
});

onUpdate(() => {
  applyLook();
  applyTokens(themeNow(), platform.options.palette, ui.preferences().highContrast);
  audio.update();
  const t = now();
  app.toasts = app.toasts.filter((x) => x.until > t);
  if (app.caption && app.caption.until <= t) app.caption = null;
});
onRender(() => {
  hudRects.length = 0;
  // the 3D desk draws only behind the round's play view (menus covered it, as the old canvas was hidden)
  render.setActive(app.state !== null && !app.board2d && app.screen === null);
  drawScreens();
  for (const fn of pendingActs.splice(0)) fn();
  pointerInput();
  render.update();
});
