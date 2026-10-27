// The browser build's pure modules, imported unchanged (allowJs) and typed
// here with the shapes this client reads: the deterministic rules engine
// (js/rules/engine.js: boards, exposure, legal pairs, commands, scoring,
// terminal states, serialization), the versioned content (js/rules/content.js:
// layouts, the solvable board generator, 44 journey stages, the Daily, four
// Practice presets, six challenges, five lessons, five themes), the replay
// envelopes (js/rules/replay.js), the seeded streams (js/rules/rng.js) and the
// game's data (js/store.js: progress and its merge, the game's options, the
// browser build's cloud save, the device store).
import * as EngineJs from "../js/rules/engine.js";
import * as ContentJs from "../js/rules/content.js";
import * as ReplayJs from "../js/rules/replay.js";
import * as RngJs from "../js/rules/rng.js";
import * as StoreJs from "../js/store.js";

export type Rule = "sum" | "match" | "diff";
export interface Ruleset {
  rule: Rule; target?: number; diff?: number; dynamic?: boolean; sideLock?: boolean;
  valueMin?: number; valueMax?: number; targetMin?: number; targetMax?: number;
}
export interface Tile { id: number; value: number; stack: number; level: number }
export interface Cell { x: number; y: number }
export interface Tools { hints: number; reshuffles: number; undo: boolean }
export interface Limits { moves: number | null; timeMs: number | null }
export interface ScoreParts { pairs: number; speed: number; chain: number; clear: number; time: number }
export interface State {
  contentId: string; seed: string | number; ruleset: Ruleset; layout: { cells: Cell[] };
  stacks: number[][]; tiles: Record<number, Tile>; selected: number | null; hintedPair: [number, number] | null;
  tick: number; elapsedMs: number; movesUsed: number; hintsUsed: number; invalidCount: number; undoCount: number;
  reshufflesUsed: number; chain: number; bestChain: number; scoreParts: ScoreParts; totalPairs: number; pairsCleared: number;
  tools: Tools; limits: Limits; targetSequence: number[] | null; targetIndex: number;
  status: "active" | "won" | "lost"; reason: string | null; history: string[];
}
export interface RulesEvent {
  type: "select" | "deselect" | "invalid" | "pair" | "hint" | "reshuffle" | "undo" | "terminal" | "rejected";
  tile?: number; tileA?: number; tileB?: number; reason?: string; values?: [number, number]; gained?: number; chain?: number;
}
export interface Command { type: string; tileId?: number; tileA?: number; tileB?: number; id?: string; atMs?: number }
export interface ScriptStep { text: string; requireSelectValue?: number; requirePairValues?: [number, number]; free?: boolean }
export interface Content {
  id: string; kind: "journey" | "daily" | "practice" | "challenge" | "lesson"; name: string; seed: string | number;
  contentVersion: number; index?: number; ruleset: Ruleset; layout: string; pairs: number; layers?: { min: number; max: number };
  tools: Tools; limits: Limits; theme?: string; ranked: boolean; mastery?: boolean; par: { score: number; timeMs: number };
  blurb?: string; script?: ScriptStep[]; date?: string; tutorial?: string;
}
export interface Board { cells: Cell[]; heights: number[]; values: number[][]; targetSequence: number[] | null }
export interface Theme {
  label: string; desk: string; deskCloth: string; tile: string; tileEdge: string; ink: string; accent: string; glow: string; sky: string; felt: string;
  css: { bg: string; panel: string; ink: string; accent: string; muted: string };
}
export interface Score extends ScoreParts { total: number }
export interface Replay { [k: string]: unknown }

interface EngineApi {
  REJECT: Record<string, string>;
  TERMINAL: Record<string, string>;
  createGame(content: Content, board: Board): State;
  applyCommand(state: State, cmd: Command): { state: State; events: RulesEvent[] };
  currentTarget(state: State): number | null;
  remainingTiles(state: State): number;
  isExposed(state: State, tileId: number): boolean;
  exposedTiles(state: State): number[];
  legalPairs(state: State): [number, number][];
  score(state: State): Score;
  serialize(state: State): string;
  deserialize(json: string): State;
}
interface ContentApi {
  JOURNEY: Content[]; LESSONS: Content[]; CHALLENGES: Content[]; PRACTICE: Record<string, unknown>;
  THEMES: Record<string, Theme>; DAILY_EXCLUDED: Set<string>;
  dailyContent(iso: string, dayIndex: number): Content;
  practiceContent(difficulty: string, salt: string): Content;
  challengeContent(id: string): Content;
  lessonContent(id: string): Content;
  prepareContent(content: Content): { content: Content; board: Board };
  getTheme(id: string | null | undefined): Theme;
  describeRule(ruleset: Ruleset): string;
  describeRuleShort(ruleset: Ruleset, target: number | null): string;
}
interface ReplayApi {
  BUILD_VERSION: string;
  openReplay(content: Content, board: Board): Replay;
  recordCommand(replay: Replay, cmd: Command, state: State): void;
  closeReplay(replay: Replay, state: State, breakdown: Score, sessionId: string): Replay;
}
interface RngApi {
  hashString(s: string): number;
  makeStream(seed: number | string): { next(): number; int(n: number): number; pick<T>(a: T[]): T; range(a: number, b: number): number; state: number };
}

export interface Progress {
  version: number;
  journey: Record<string, { stars: number; bestScore: number; bestMs: number; completions: number }>;
  lessons: Record<string, { completed: boolean }>;
  achievements: Record<string, number>;
  masteryXp: number; sessionsPlayed: number; bestStreakDays: number; lastDailyDate: string | null;
  dailyHistory: Record<string, { score: number; completed: boolean }>;
  challenges: Record<string, { score: number; elapsedMs: number }>;
  totals: { pairs: number; wins: number; plays: number };
}
export interface SaveDoc { v: number; progress: Progress }
export interface Options {
  camera: "default" | "top" | "low"; board2d: boolean; themeOverride: string | null; palette: string;
  leftHanded: boolean; soundCaptions: boolean; timingAssist: boolean;
}
export interface BoardEntry {
  score: number; elapsedMs: number; invalidCount: number; sessionId: string; at: number; ruleset: string; contentVersion: number;
  seed: string; assists: string; verified: boolean;
}
export interface Snapshot { contentId: string; state: string; replay?: Replay }
export interface DeviceStore {
  saveSessionSnapshot(contentId: string, snap: { state: string; replay?: Replay }): void;
  loadSessionSnapshot(contentId: string): Snapshot | null;
  clearSessionSnapshot(contentId: string): void;
  listSessionSnapshots(): Snapshot[];
  saveReplay(contentId: string, envelope: Replay): void;
  loadReplay(contentId: string): Replay | null;
  loadBoard(key: string): BoardEntry[];
  submitBoardEntry(key: string, entry: BoardEntry, maxEntries?: number): number;
  resetAll(): void;
}
export interface Backend { get(k: string): string | null; set(k: string, v: string): void; remove(k: string): void; keys(): string[] }
interface StoreApi {
  SAVE_SCHEMA: number;
  DEFAULT_OPTIONS: Options; OPTION_KEYS: (keyof Options)[]; BROWSER_KEYS: string[];
  CAMERAS: string[]; PALETTES: string[]; THEME_IDS: string[];
  normalizeProgress(p: unknown): Progress;
  mergeProgress(a: unknown, b: unknown): Progress;
  sameProgress(a: unknown, b: unknown): boolean;
  normalizeSave(doc: unknown): SaveDoc;
  pickOptions(obj: unknown): Partial<Options>;
  readForeign(text: string): { progress: Progress | null; options: Partial<Options>; savedAt: number } | null;
  createStore(backend: Backend, now?: () => number): DeviceStore;
}

export const E = EngineJs as unknown as EngineApi;
export const C = ContentJs as unknown as ContentApi;
export const R = ReplayJs as unknown as ReplayApi;
export const Rng = RngJs as unknown as RngApi;
export const Store = StoreJs as unknown as StoreApi;
