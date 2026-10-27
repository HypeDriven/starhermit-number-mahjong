// The browser build's DOM shell (index.html + css/main.css + js/app/ui.js) as
// starhermit:ui, built every frame around the 3D desk: the screens (title
// over the key art, journey map, mode setup, practice, challenges, learn,
// results with the tile-stack banner, settings, help, score chase), the
// account chip, the play view (the HUD with the rule and target dial, pairs
// and moves left, score and chain, the timer bar and the pause button; the
// action rail with Hint, Shuffle and Undo; the 2D tile board when chosen;
// accessibility targets over the 3D tiles and the keyboard focus chip; the
// countdown; the lesson banner), the pause sheet, toasts and sound captions.
// The browser's media queries are layouts picked by the window's logical
// size: wide (the action rail at the right, or left with left-handed
// controls), narrow portrait (≤ 720 px: a bottom tray, icons and counts
// only) and short landscape (≤ 500 px tall: a narrow rail).
import { frame, openMenu } from "starhermit:engine";
import { pointer, requestRebind } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { C, E, R, Store, type State } from "./game.ts";
import { N, S, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import { token } from "./style.ts";
import {
  DIFFICULTY, app, back, begin, cachedResume, chooseTile, contentName, copyInvite, effectiveTimeLimit, eraseAll, fmtMs,
  goNext, hint, hudRects, keyText, later, leaderboardLine, leaveRound, lessonAdvance, msUntilNextDaily, nextStage, open, openChallenge, openDaily,
  openHelp, openPractice, openSettings, openStage, pauseRound, play, resetTutorials, restartRound, resumeRound, resumeSavedRound, reshuffle, sfx,
  signIn, startLesson, timerRemaining, toTitle, todayDailyInfo, undo,
} from "./main.ts";

// ------------------------------------------------------------------ layout and helpers
interface Layout { lw: number; lh: number; sc: number; ox: number; oy: number; narrow: boolean; short: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, ox: sa.left, oy: sa.top, narrow: lw <= 720, short: lh <= 500 && lw > lh };
}
const prefs = (): ui.UiPreferences => ui.preferences();
const fresh = (n = 0): boolean => frame().frame - app.openedFrame <= n;
function tw(text: string, style: string | (string | ui.Style)[], kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style }).width / prefs().scale;
}
let firstId: string | null = null;

// hover and scroll ticks (main.js: throttled 120 ms / 150 ms)
let hoverId: string | null = null, lastHover = 0;
function hoverTick(id: string, r: ui.Rect): void {
  const p = pointer();
  if (!p || p.x < r.x || p.y < r.y || p.x > r.x + r.width || p.y > r.y + r.height) { if (hoverId === id) hoverId = null; return; }
  if (hoverId === id) return;
  hoverId = id;
  const t = frame().time;
  if (t - lastHover >= 0.12) { lastHover = t; sfx("hover"); }
}
const scrollTops = new Map<string, number>();
let lastScroll = 0;
function scrollTick(key: string, top: number): void {
  const prev = scrollTops.get(key);
  scrollTops.set(key, top);
  if (prev === undefined || Math.abs(prev - top) < 1) return;
  const t = frame().time;
  if (t - lastScroll >= 0.15) { lastScroll = t; sfx("scroll-tick"); }
}

interface Btn { id: string; text: string; cls?: string; note?: string; disabled?: boolean; act: () => void }
const PAD_X: Record<string, number> = { btn: 34, primary: 34, danger: 34, "menu-btn": 42, "menu-primary": 42, "menu-resume": 42, "menu-danger": 42, "icon-btn": 26, "action-btn": 34 };
const btnW = (b: Btn): number => {
  const cls = b.cls ?? "btn";
  const menu = cls.startsWith("menu");
  return tw(b.text, menu ? "btn-face" : cls, menu ? undefined : "button") + (b.note ? tw(b.note, "btn-face-small") + 12 : 0) + (PAD_X[cls] ?? 34);
};
/** A button `width` wide (null: its text's); a long label wraps; `note` is the small second text at the end (menu-stack small). */
function button(b: Btn, width: number | null = null): boolean {
  const cls = b.cls ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  const inner = width != null ? Math.max(20, width - (PAD_X[cls] ?? 34)) : null;
  const menu = cls.startsWith("menu");
  const wraps = inner != null && btnW(b) > width!;
  if (b.note || wraps || menu) {
    opts.content = () => {
      const center = cls === "menu-primary" || cls === "menu-danger" || !menu;
      const face: (string | ui.Style)[] = menu ? ["btn-face", { text: { align: center ? "center" : "start", weight: cls === "menu-primary" ? "600" : "400", ...(cls === "menu-primary" ? { color: "$on-accent" } : cls === "menu-danger" ? { color: "$danger" } : {}) } }] : [{ text: { align: "center" } }];
      if (!b.note) {
        if (inner != null && tw(b.text, face) > inner) ui.style(...face).paragraph(b.text, inner);
        else ui.style(...face).label(b.text);
        return;
      }
      const nw = tw(b.note, "btn-face-small");
      const room = (inner ?? 400) - nw - 12;
      if (tw(b.text, face) > room) {
        // too narrow for one line (a phone): the note goes under the label
        ui.column(`${b.id}-face`, () => {
          ui.style(...face).label(b.text);
          ui.style("btn-face-small").label(b.note!);
        }, { spacing: 2, ...(inner != null ? { width: inner } : {}) });
        return;
      }
      ui.row(`${b.id}-face`, () => {
        ui.style(...face).label(b.text);
        ui.spacer();
        ui.style("btn-face-small").label(b.note!);
      }, { spacing: 12, align: "center", ...(inner != null ? { width: inner } : {}) });
    };
  }
  if (!firstId && !b.disabled) firstId = b.id;
  let hit = false;
  const r = ui.row(`${b.id}-wrap`, () => {
    hit = ui.style(cls, width != null ? { width } : {}).id(b.id).button(b.text, opts);
  });
  hoverTick(b.id, r);
  if (hit && !fresh(0)) later(b.act);
  return hit;
}
/** A column of full-width buttons (.menu-stack: a grid, gap 12, at most 420 wide, centred). */
function menuStack(id: string, list: Btn[], w: number): void {
  const mw = Math.min(420, w);
  ui.row(`${id}-row`, () => {
    ui.id(id).column(id, () => { for (const b of list) button(b, mw); }, { width: mw, spacing: 12 });
  }, { width: w, justify: "center" });
}
/** Buttons at their own widths in rows that wrap at `width` (CSS flex-wrap). */
function flow(label: string, list: Btn[], width: number, gap = 10): void {
  const rows: number[] = [];
  let used = 0, n = 0;
  for (const b of list) {
    const bw = Math.min(width, btnW(b));
    if (n && used + gap + bw > width) { rows.push(n); used = 0; n = 0; }
    used += (n ? gap : 0) + bw;
    n++;
  }
  if (n) rows.push(n);
  let k = 0;
  ui.column(label, () => {
    rows.forEach((cnt, ri) => ui.row(`${label}-r${ri}`, () => {
      for (let i = 0; i < cnt; i++, k++) { const b = list[k]!; button(b, btnW(b) > width ? width : null); }
    }, { spacing: gap, align: "center" }));
  }, { spacing: gap, width });
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "p", id?: string): void {
  if (!text) return;
  let u = ui.style(cls);
  if (id) u = u.id(id);
  if (tw(text, cls) <= width) u.label(text);
  else u.paragraph(text, width);
}
function heading(cls: string, text: string, width: number): void {
  if (tw(text, cls, "heading") <= width) ui.style(cls).heading(text);
  else ui.style(cls).paragraph(text, width);
}
const stripTags = (s: string): string => s.replace(/<\/?[a-z]+>/g, "");
/** Cards in a grid of `min`-wide columns (CSS repeat(auto-fill, minmax(min, 1fr))). */
function cardGrid(id: string, w: number, min: number, n: number, cell: (i: number, cw: number) => void, gap = 14): void {
  const cols = Math.max(1, Math.floor((w + gap) / (min + gap)));
  const cw = (w - gap * (cols - 1)) / cols;
  ui.grid(id, () => { for (let i = 0; i < n; i++) cell(i, cw); }, { columns: cols, gap, width: w, align: "stretch" });
}
function badge(text: string, kind: "" | "ranked" | "done" = ""): void {
  ui.style(kind ? `badge-${kind}` : "badge").row(`badge-${text}`, () => { ui.style(kind ? `badge-text-${kind}` : "badge-text").label(text.toUpperCase()); });
}
function backStack(w: number): void { menuStack("back-stack", [{ id: "btn-back", text: T("Back"), act: back }], w); }

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  firstId = null;
  const s = app.screen;
  if (s === null && app.state) playView(L);
  else page(s ?? "title", L);
  toasts(L, s === null);
  caption(L);
  if (s !== null && s !== "title") accountChip(L, false);
  else if (s === "title") accountChip(L, true);
  if (app.focusNext) {
    const f = frame();
    const age = f.frame - app.openedFrame;
    const target = app.focusNext === "first" ? firstId : app.focusNext;
    if (age >= 1 && target) ui.setFocus(target);
    if (age >= 3) app.focusNext = null;
  }
}

const lastSize = new Map<string, number>();
const BUILDERS: Record<string, (w: number, L: Layout) => void> = {
  title: titleScreen, journey: journeyScreen, modesetup: setupScreen, practice: practiceScreen, challenge: challengeScreen, learn: learnScreen,
  results: resultsScreen, settings: settingsScreen, help: helpScreen, scores: scoresScreen,
};
/** #screen-root .screen: a centred column at most 980 wide, 20 px in, scrolling when taller. */
function page(key: string, L: Layout): void {
  const f = frame();
  draw.box(0, 0, f.width, f.height, key === "title" ? (prefs().highContrast ? "page-plain" : "title-art") : "page");
  const pad = L.narrow ? 16 : 20;
  const outer = Math.min(980, L.lw - 2 * pad);
  const avail = L.lh - 2 * pad;
  const h = lastSize.get(key) ?? 0;
  const scroll = h > avail;
  const inner = outer - (scroll ? 14 : 0);
  const build = BUILDERS[key] ?? titleScreen;
  // title / setup / journey centre vertically when they fit, as the old scaled screens did
  const top = !scroll && h > 0 && key === "title" ? Math.max(pad, (L.lh - h) / 2) : pad;
  ui.place(`page-${key}`, { anchor: "top", y: top }, () => {
    const body = (): void => {
      const r = ui.column(`${key}-col`, () => build(inner, L), { width: inner, spacing: 14 });
      lastSize.set(key, r.height / L.sc);
    };
    if (scroll) {
      const r = ui.scrollArea(`${key}-scroll`, { width: outer, height: avail }, body, fresh(6) ? { scrollTo: { top: 0 } } : undefined);
      scrollTick(key, r.scrollTop);
    } else body();
  });
}

// ------------------------------------------------------------------ title
function titleScreen(w: number, L: Layout): void {
  const p = platform.progress();
  const next = C.JOURNEY.find((s) => !p.journey[s.id]);
  const { iso } = todayDailyInfo();
  const dailyDone = !!p.dailyHistory[iso]?.completed;
  ui.column("title-hero", () => {
    const mark = "Number Mahjong";
    const size = Math.min(67, Math.max(41.6, L.lw * 0.07));
    if (tw(mark, ["mark", { text: { size } }]) <= w) ui.style("mark", { text: { size } }).label(mark);
    else ui.style("mark", { text: { size } }).paragraph(mark, w);
    para(T("An observatory of quiet numbers"), w, "tag");
  }, { width: w, align: "center", spacing: 6, padding: { top: L.short ? 0 : 20, bottom: 10 } });
  const resume = cachedResume();
  if (resume) {
    menuStack("resume-stack", [{
      id: "btn-resume-round", cls: "menu-resume", text: "↻ " + T("Resume interrupted round"),
      note: T("{n} tiles left · {time} in", { n: resume.remaining, time: fmtMs(resume.elapsedMs) }), act: () => resumeSavedRound(resume.contentId),
    }], w);
  }
  if (next) ui.row("title-next-row", () => para(T("Continue Journey — {name}", { name: T(next.name) }), Math.min(420, w), "meta-center", "title-next"), { width: w, justify: "center" });
  const list: Btn[] = [
    { id: "btn-play", cls: "menu-primary", text: T("Play"), act: play },
    { id: "btn-daily", cls: "menu-btn", text: T("Daily Challenge"), note: dailyDone ? T("completed today ✓") : iso, act: openDaily },
    { id: "btn-journey", cls: "menu-btn", text: T("Journey"), note: T("{done} / {total} stages", { done: Object.keys(p.journey).length, total: C.JOURNEY.length }), act: () => open("journey") },
    { id: "btn-practice", cls: "menu-btn", text: T("Practice"), note: T("unranked, undo allowed"), act: () => open("practice") },
    { id: "btn-challenge", cls: "menu-btn", text: T("Challenges"), note: T("{n} trials", { n: C.CHALLENGES.length }), act: () => open("challenge") },
    { id: "btn-learn", cls: "menu-btn", text: T("Learn"), note: T("interactive lessons"), act: () => open("learn") },
    { id: "btn-scores", cls: "menu-btn", text: T("Score Chase"), note: T("leaderboards"), act: () => open("scores") },
    { id: "btn-settings", cls: "menu-btn", text: T("Settings"), act: () => openSettings(false) },
    { id: "btn-help", cls: "menu-btn", text: T("Help & Rules"), act: () => openHelp(false) },
  ];
  if (!platform.signedIn()) list.push({ id: "btn-signin", cls: "menu-btn", text: S("signIn"), note: S("signInSub"), act: signIn });
  if (platform.inviteLink()) list.push({ id: "btn-invite", cls: "menu-btn", text: S("invite"), note: S("inviteSub"), act: copyInvite });
  menuStack("menu", list, w);
  const name = platform.signedIn() ? platform.displayName() : "";
  const status = (name ? T("Playing as {name}", { name }) + " · " : "") + (app.winStreak > 1 ? T("Win streak: {n}.", { n: app.winStreak }) + " " : "")
    + `v${R.BUILD_VERSION} · ` + T("deterministic seeds · offline capable");
  ui.row("title-status-row", () => para(status, Math.min(w, 600), "meta-center", "title-status"), { width: w, justify: "center" });
}

/** #account-chip: the player, their avatar and the save's sync state, top-right on menus. */
function accountChip(L: Layout, title: boolean): void {
  if (!platform.signedIn()) return;
  void title;
  const sync = platform.syncState();
  const SYNC: Record<string, string> = { saving: N("saving…"), synced: N("synced ✓"), offline: "", local: "" };
  ui.place("account-chip", { anchor: "top-end", x: 10, y: 8 }, () => {
    ui.style("chip").row("account", () => {
      if (app.avatar) {
        const img = app.avatar;
        ui.widget("avatar", { role: "none", size: { width: 20, height: 20 }, draw: (r) => { draw.image(img, r.x, r.y, r.width, r.height); } });
      }
      ui.style("chip-text").label(platform.displayName());
      if (SYNC[sync]) ui.style("chip-sync").label(T(SYNC[sync]!));
    }, { spacing: 8, align: "center" });
  });
  void L;
}

// ------------------------------------------------------------------ journey
function journeyScreen(w: number): void {
  const p = platform.progress();
  heading("h1", T("Journey"), w);
  para(T("Forty-four authored stages. One new idea at a time, then combined, then mastered. Mastery stages are bordered in gold."), w);
  const gap = 10, min = 64;
  const cols = Math.max(1, Math.floor((w + gap) / (min + gap)));
  const cw = (w - gap * (cols - 1)) / cols;
  ui.grid("stage-grid", () => {
    for (const st of C.JOURNEY) {
      const rec = p.journey[st.id];
      const locked = !(st.index === 1 || p.journey[C.JOURNEY[st.index! - 2]!.id]);
      const current = !rec && !locked;
      const label = T("Stage {n}: {name}", { n: st.index!, name: T(st.name) })
        + (locked ? " " + T("(locked)") : rec ? ", " + T("{stars} stars, best {best}", { stars: rec.stars, best: rec.bestScore }) : ", " + T("not completed"));
      const cls = current ? "stage-current" : st.mastery ? "stage-mastery" : "stage-cell";
      const id = `stage-${st.index}`;
      if (!firstId && !locked) firstId = id;
      const hit = ui.style(cls, { width: cw, height: cw }).id(id).button(label, {
        disabled: locked,
        content: () => {
          ui.style("stage-num").label(String(st.index));
          if (rec) ui.style("stage-stars").label("★".repeat(rec.stars) + "☆".repeat(3 - rec.stars));
        },
      });
      if (hit && !fresh(0)) later(() => openStage(st.id));
    }
  }, { columns: cols, gap, width: w });
  backStack(w);
}

// ------------------------------------------------------------------ mode setup
function setupScreen(w: number): void {
  const c = app.pending;
  if (!c) { backStack(w); return; }
  heading("h1", contentName(c), w);
  ui.row("setup-badges", () => {
    badge(c.ranked ? T("ranked") : T("unranked"), c.ranked ? "ranked" : "");
    if (c.mastery) badge(T("mastery"));
    if (c.limits?.timeMs) badge(T("timed {time}", { time: fmtMs(effectiveTimeLimit(c)!) }));
    if (c.limits?.moves) badge(T("{n} moves max", { n: c.limits.moves }));
  }, { spacing: 8, align: "center" });
  const assists: string[] = [];
  if (c.tools.hints === Infinity) assists.push(T("unlimited hints"));
  else if (c.tools.hints > 0) assists.push(c.tools.hints > 1 ? T("{n} hints", { n: c.tools.hints }) : T("1 hint"));
  if (c.tools.reshuffles > 0) assists.push(c.tools.reshuffles > 1 ? T("{n} reshuffles", { n: c.tools.reshuffles }) : T("1 reshuffle"));
  if (c.tools.undo) assists.push(T("undo"));
  if (!assists.length) assists.push(T("no assists"));
  const cw = Math.min(520, w);
  const iw = cw - 34;
  ui.style("card", { width: cw }).id("rules-card").column(T("Rules"), () => {
    heading("h3", T("Rules"), iw);
    para(C.describeRule(c.ruleset), iw, "card-p", "rule-text");
    if (c.ruleset.sideLock) para(stripTags(T("Tiles pressed on <strong>both</strong> sides by neighbours are locked until one side opens.")), iw, "card-p");
    if ((c.layers?.max ?? 1) > 1) para(T("Tiles may be stacked; only the top tile of each stack is exposed."), iw, "card-p");
    para(T("Board: {pairs} pairs · par {score} pts · about {time}", { pairs: c.pairs, score: c.par.score, time: fmtMs(c.par.timeMs) }), iw, "card-meta");
    para(T("Assists: {list}", { list: assists.join(", ") }), iw, "card-meta");
    if (app.setupBlurb) para(T(app.setupBlurb), iw, "card-p");
    para(`${T("Seed")} ${String(c.seed)} · ${T("content v{n}", { n: c.contentVersion })}`, iw, "card-meta", "seed-line");
  }, { width: cw, spacing: 6 });
  const list: Btn[] = [{ id: "btn-begin", cls: "menu-primary", text: T("Start round"), act: begin }];
  menuStack("setup-start", list, w);
  if (c.kind === "daily") {
    const { iso } = todayDailyInfo();
    ui.row("daily-next-row", () => para(T("Next daily in {time}", { time: fmtMs(msUntilNextDaily()) }) + (C.DAILY_EXCLUDED.has(iso) ? " · " + T("today is excluded from ranking") : ""), Math.min(420, w), "meta-center"), { width: w, justify: "center" });
  }
  menuStack("setup-back", [{ id: "btn-back", cls: "menu-btn", text: T("Back"), act: back }], w);
}

// ------------------------------------------------------------------ practice, challenges, learn
function practiceScreen(w: number): void {
  heading("h1", T("Practice"), w);
  para(T("Unranked. Hints and undo are unlimited; two reshuffles per round. Nothing here affects your rating."), w);
  const levels = ["easy", "medium", "hard", "expert"];
  const DESC: Record<string, string> = {
    easy: N("Five pairs, flat board, sum to 10. No pressure."), medium: N("Eight pairs with light stacking, sum to 12."),
    hard: N("Eleven pairs, side-locked matches."), expert: N("Fourteen pairs: shifting targets, stacks, side locks."),
  };
  cardGrid("practice-cards", w, 230, levels.length, (i, cw) => {
    const d = levels[i]!;
    ui.style("card", { width: cw }).column(`practice-${d}`, () => {
      heading("h3", T(DIFFICULTY[d]!), cw - 34);
      para(T(DESC[d]!), cw - 34, "card-p");
      button({ id: `btn-practice-${d}`, text: T("Start {level}", { level: T(DIFFICULTY[d]!) }), act: () => openPractice(d) }, cw - 34);
    }, { width: cw, spacing: 6 });
  });
  backStack(w);
}
function challengeScreen(w: number): void {
  const p = platform.progress();
  heading("h1", T("Challenges"), w);
  para(T("Constrained goals with fixed seeds. Everyone faces the same board."), w);
  cardGrid("challenge-cards", w, 230, C.CHALLENGES.length, (i, cw) => {
    const c = C.CHALLENGES[i]!;
    const best = p.challenges[c.id];
    const meta = [T("{n} pairs", { n: c.pairs }), c.limits.timeMs ? fmtMs(c.limits.timeMs) : "", c.limits.moves ? T("{n} moves", { n: c.limits.moves }) : "", T("ranked")].filter(Boolean).join(" · ");
    ui.style("card", { width: cw }).column(`challenge-${c.id}`, () => {
      heading("h3", T(c.name), cw - 34);
      para(T(c.blurb ?? ""), cw - 34, "card-p");
      para(meta, cw - 34, "card-meta");
      if (best) para(T("Best: {score} pts in {time}", { score: best.score, time: fmtMs(best.elapsedMs) }), cw - 34, "card-meta");
      button({ id: `btn-${c.id}`, text: T("Attempt"), act: () => openChallenge(c.id) }, cw - 34);
    }, { width: cw, spacing: 6 });
  });
  backStack(w);
}
function learnScreen(w: number): void {
  const p = platform.progress();
  heading("h1", T("Learn"), w);
  para(T("Short interactive lessons. Each introduces one rule and asks you to perform it. Replay any time."), w);
  cardGrid("learn-cards", w, 230, C.LESSONS.length, (i, cw) => {
    const l = C.LESSONS[i]!;
    const done = !!p.lessons[l.id]?.completed;
    const prevDone = i === 0 || !!p.lessons[C.LESSONS[i - 1]!.id]?.completed;
    ui.style(prevDone ? "card" : "card-locked", { width: cw }).column(`lesson-${l.id}`, () => {
      ui.row(`lesson-${l.id}-h`, () => { heading("h3", T(l.name), cw - 34 - (done ? 70 : 0)); if (done) badge(T("done"), "done"); }, { spacing: 8, align: "center" });
      para(T("{n} steps", { n: l.script!.length }), cw - 34, "card-meta");
      button({ id: `btn-${l.id}`, text: done ? T("Replay") : prevDone ? T("Start") : T("Locked"), disabled: !prevDone, act: () => startLesson(l.id) }, cw - 34);
    }, { width: cw, spacing: 6 });
  });
  backStack(w);
}

// ------------------------------------------------------------------ results
function resultsScreen(w: number, L: Layout): void {
  const r = app.results;
  if (!r) { backStack(w); return; }
  const st = r.state, won = st.status === "won";
  if (!prefs().highContrast && !prefs().reducedMotion) {
    const h = Math.min(200, Math.max(110, L.lw * 0.22));
    ui.style("results-art", { width: w, height: h }).column("results-art", () => undefined, { width: w, height: h });
  }
  const REASONS: Record<string, string> = { "no-moves": N("No Moves Remain"), "out-of-moves": N("Out of Moves"), "time-up": N("Time Is Up"), abandoned: N("Round Left") };
  const WORDS: Record<string, string> = { "no-moves": N("no moves"), "out-of-moves": N("out of moves"), "time-up": N("time up"), abandoned: N("abandoned") };
  heading("h1", won ? T("Board Cleared") : T(REASONS[st.reason ?? ""] ?? N("Round Over")), w);
  para([contentName(r.content), won ? T("completed in {time}", { time: fmtMs(st.elapsedMs) }) : T("reason: {reason}", { reason: WORDS[st.reason ?? ""] ? T(WORDS[st.reason ?? ""]!) : String(st.reason) }),
    st.invalidCount === 1 ? T("1 invalid attempt") : T("{n} invalid attempts", { n: st.invalidCount })].join(" · "), w, "p", "results-summary");
  if (r.stars != null && won) ui.style("stars").id("results-stars").label("★".repeat(r.stars) + "☆".repeat(3 - r.stars), { description: T("{n} of 3 stars", { n: r.stars }) } as ui.TextOptions);
  const b = r.breakdown;
  const rows: [string, number][] = [[T("Pairs removed"), b.pairs], [T("Speed bonus"), b.speed], [T("Chain bonus"), b.chain], [T("Clear bonus"), b.clear], [T("Time bonus"), b.time]];
  const tableW = Math.min(w, Math.max(280, ...rows.map(([k]) => tw(k, "cell") + 110)));
  ui.id("score-table").column(T("Score breakdown"), () => {
    for (const [k, v] of rows) scoreRow(k, String(v), tableW, "row-line", "cell");
    scoreRow(T("Total"), String(b.total), tableW, "row-total", "cell-total");
  }, { width: tableW, spacing: 0 });
  para(T("Par: {score} pts in {time}", { score: r.content.par.score, time: fmtMs(r.content.par.timeMs) })
    + (r.placement >= 0 ? " · " + T("placed #{n} on the local board", { n: r.placement + 1 }) : ""), w, "meta", "results-par");
  const lb = leaderboardLine();
  if (lb) para(lb, w, "meta", "results-lb");
  if (r.newAchievements.length) {
    heading("h2", T("Achievements"), w);
    cardGrid("ach-cards", w, 230, r.newAchievements.length, (i, cw) => {
      const a = r.newAchievements[i]!;
      ui.style("card", { width: cw }).column(`ach-${a.key}`, () => {
        heading("h3", "🏅 " + T(a.name), cw - 34);
        para(T(a.desc), cw - 34, "card-p");
      }, { width: cw, spacing: 4 });
    });
  }
  const next = won ? nextStage() : null;
  const list: Btn[] = [];
  if (next) list.push({ id: "btn-next", cls: "menu-primary", text: T("Next: {name}", { name: T(next.name) }), act: goNext });
  list.push({ id: "btn-retry", cls: next ? "menu-btn" : "menu-primary", text: won ? T("Replay this board") : T("Try again"), act: restartRound });
  list.push({ id: "btn-results-scores", cls: "menu-btn", text: T("Leaderboards"), act: () => open("scores") });
  list.push({ id: "btn-results-title", cls: "menu-btn", text: T("Back to title"), act: () => { sfx("back"); toTitle(); } });
  menuStack("results-actions", list, w);
}
function scoreRow(k: string, v: string, width: number, cls: string, cell: string): void {
  ui.style(cls, { width }).row(`row-${k}`, () => {
    ui.style(cell).label(k);
    ui.spacer();
    ui.style(cell, { text: { numerals: "tabular" } } as ui.Style).label(v);
  }, { width, align: "center" });
}

// ------------------------------------------------------------------ settings
const CAMERA: Record<string, string> = { default: N("default"), top: N("top"), low: N("low") };
const PALETTE: Record<string, string> = { standard: N("standard"), deuteranopia: N("deuteranopia"), protanopia: N("protanopia"), tritanopia: N("tritanopia") };
function settingRow(id: string, label: string, w: number, control: (cw: number) => void, cw = 220): void {
  const c = Math.min(cw, w * 0.52);
  ui.row(`${id}-row`, () => {
    para(label, w - c - 16, "p", `${id}-label`);
    ui.spacer();
    control(c);
  }, { width: w, align: "center", spacing: 16 });
}
function checkRow(key: "board2d" | "leftHanded" | "soundCaptions" | "timingAssist", label: string, w: number): void {
  const cur = !!platform.options[key];
  // index.html .setting-row: the label (wrapping) at the start, the check box at the end
  settingRow(`set-${key}`, label, w, () => {
    const r = ui.id(`set-${key}`).widget(label, {
      role: "checkbox", checked: cur, size: { width: 24, height: 24 },
      draw: (rc, st) => {
        const k = st.scale;
        draw.box(rc.x, rc.y, rc.width, rc.height, { background: cur ? token("accent") : token("panel"), radius: 5, border: { width: 2, color: cur ? token("accent") : token("muted") } } as ui.Style);
        if (cur) {
          draw.line(rc.x + 5 * k, rc.y + 12 * k, rc.x + 10 * k, rc.y + 17 * k, token("on-accent"), 3);
          draw.line(rc.x + 10 * k, rc.y + 17 * k, rc.x + 19 * k, rc.y + 7 * k, token("on-accent"), 3);
        }
      },
    });
    if (r.activated && !fresh(0)) later(() => { platform.setOption(key, !cur); sfx("toggle"); });
  }, 24);
}
function settingsScreen(w: number): void {
  const fw = Math.min(560, w);
  const o = platform.options;
  heading("h1", T("Settings"), w);
  heading("h2", T("Audio"), w);
  para(T("Volumes, graphics quality, language, larger text, high contrast and reduced motion are in the StarHermit Options."), fw, "meta", "options-note");
  flow("settings-runtime", [
    { id: "btn-options", text: T("Open Options"), act: () => openMenu() },
  ], fw);
  checkRow("soundCaptions", T("Sound captions (text cues for meaningful audio)"), fw);
  heading("h2", T("Graphics"), w);
  settingRow("set-camera", T("Board view"), fw, (cw) => {
    const idx = Math.max(0, Store.CAMERAS.indexOf(o.camera));
    const pick = ui.id("set-camera").select(T("Camera view"), idx, Store.CAMERAS.map((c) => T(CAMERA[c]!)), { width: cw } as ui.WidgetOptions);
    if (pick !== idx && !fresh(0)) later(() => { platform.setOption("camera", Store.CAMERAS[pick] as "default"); render.resetCamera(); sfx("toggle"); });
  });
  checkRow("board2d", T("Use 2D board instead of 3D"), fw);
  settingRow("set-theme", T("Cosmetic theme"), fw, (cw) => {
    const ids: (string | null)[] = [null, ...Store.THEME_IDS];
    const idx = Math.max(0, ids.indexOf(o.themeOverride));
    const pick = ui.id("set-theme").select(T("Cosmetic theme"), idx, ids.map((id) => id ? T(C.THEMES[id]!.label) : T("follow the round")), { width: cw } as ui.WidgetOptions);
    if (pick !== idx && !fresh(0)) later(() => { platform.setOption("themeOverride", ids[pick] ?? null); sfx("toggle"); });
  });
  heading("h2", T("Accessibility"), w);
  settingRow("set-palette", T("Colour-vision palette"), fw, (cw) => {
    const idx = Math.max(0, Store.PALETTES.indexOf(o.palette));
    const pick = ui.id("set-palette").select(T("Colour-vision palette"), idx, Store.PALETTES.map((p) => T(PALETTE[p]!)), { width: cw } as ui.WidgetOptions);
    if (pick !== idx && !fresh(0)) later(() => { platform.setOption("palette", Store.PALETTES[pick]!); sfx("toggle"); });
  });
  checkRow("leftHanded", T("Left-handed controls"), fw);
  checkRow("timingAssist", T("Timing assistance (+50% round timers)"), fw);
  settingRow("set-tutorials", T("Replay tutorials"), fw, () => { button({ id: "btn-reset-tutorials", text: T("Reset"), act: resetTutorials }); }, 140);
  heading("h2", T("Controls"), w);
  para(T("Keyboard: {move} or Tab move focus · {choose} select · {back} pause/cancel · {pause} pause · {hint} hint · {reshuffle} reshuffle · {undo} undo · {camera} camera. Gamepad: d-pad/stick move · A select · B cancel · Start pause · Y hint · X undo.", {
    move: [keyText("left"), keyText("right"), keyText("up"), keyText("down")].join(" "), choose: keyText("choose"), back: keyText("back"), pause: keyText("pause"),
    hint: keyText("hint"), reshuffle: keyText("reshuffle"), undo: keyText("undo"), camera: keyText("camera"),
  }), fw, "meta", "controls-text");
  flow("controls-buttons", [{ id: "btn-rebind", text: T("Change controls"), act: () => requestRebind() }], fw);
  heading("h2", T("Data"), w);
  if (!app.confirmErase) {
    settingRow("set-erase", T("Erase all local progress and settings"), fw, () => {
      button({ id: "btn-erase", cls: "danger", text: T("Erase"), act: () => { app.confirmErase = true; app.focusNext = "btn-erase-cancel"; app.openedFrame = frame().frame; } });
    }, 140);
  } else {
    para(T("Erase ALL local progress, settings, and leaderboard entries? This cannot be undone."), fw, "p", "erase-confirm");
    flow("erase-confirm-row", [
      { id: "btn-erase-yes", cls: "danger", text: T("Erase"), act: eraseAll },
      { id: "btn-erase-cancel", text: T("Cancel"), act: () => { app.confirmErase = false; } },
    ], fw);
  }
  backStack(w);
}

// ------------------------------------------------------------------ help
function helpScreen(w: number): void {
  heading("h1", T("Help & Rules"), w);
  const k = keyText;
  const cards: [string, string][] = [
    ["⌖ " + T("Goal"), stripTags(T("Clear the board by removing pairs of <strong>exposed</strong> tiles. The round’s rule is always shown at the top: a sum target, matching twins, or an exact difference."))],
    ["▤ " + T("Exposure"), stripTags(T("Only the top tile of each stack can be played. In side-locked rounds, a tile is also locked while neighbours press on <em>both</em> its sides — one open side is enough."))],
    ["✦ " + T("Scoring"), T("Each pair scores 100. Removing pairs quickly adds up to 50 speed bonus. Unbroken chains of pairs (no hints, no misses) add up to 150 per pair. Clearing the board adds 500, plus a time bonus in timed rounds. Exploring never costs points.")],
    ["⚑ " + T("Stuck?"), T("If no legal pair exists and no reshuffles remain, the round ends. Hints (H) reveal one legal pair. Reshuffles (R) redeal the remaining tiles solvably. Practice and Journey allow undo (U).")],
    ["⌨ " + T("Controls"), T("Pointer or touch: tap a tile, tap its partner. Keyboard: {move} move, {choose} selects, {back} cancels or pauses. Gamepad: d-pad moves, {confirm} confirms, {cancel} cancels, Start pauses. {hint} hints, {reshuffle} reshuffles, {undo} undoes, {camera} resets the camera.", {
      move: [k("left"), k("right"), k("up"), k("down")].join(" "), choose: k("choose"), back: k("back"), confirm: "A", cancel: "B",
      hint: k("hint"), reshuffle: k("reshuffle"), undo: k("undo"), camera: k("camera"),
    })],
    ["⚖ " + T("Fair play"), T("Every board is generated from a visible seed and proven solvable offline. Ranked rounds disallow undo and are submitted with a replay log for validation.")],
  ];
  cardGrid("help-cards", w, 230, cards.length, (i, cw) => {
    const [title, text] = cards[i]!;
    ui.style("card", { width: cw }).column(`help-${i}`, () => {
      heading("h3", title, cw - 34);
      para(text, cw - 34, "card-p");
    }, { width: cw, spacing: 6 });
  });
  backStack(w);
}

// ------------------------------------------------------------------ score chase
function scoresScreen(w: number): void {
  const p = platform.progress();
  heading("h1", T("Score Chase"), w);
  para(T("Asynchronous comparison on validated seeds. Ranked submissions carry a replay log; unverifiable boards are marked casual."), w);
  const online = app.online;
  if (Array.isArray(online) && online.length) {
    heading("h2", T("Online board"), w);
    table("online", [T("#"), T("Player"), T("Score")], online.map((x, i) => [String(i + 1), x.name + (x.me ? " " + T("(you)") : ""), String(x.score)]), w);
  }
  const { iso } = todayDailyInfo();
  const section = (title: string, key: string, note?: string): void => {
    heading("h2", title, w);
    const entries = platform.device.loadBoard(key);
    if (!entries.length) { para(note ?? T("No entries yet — be the first."), w, "meta"); return; }
    table(key, [T("#"), T("Score"), T("Time"), T("Invalid"), T("When")], entries.slice(0, 10).map((x, i) => [
      String(i + 1), String(x.score), fmtMs(x.elapsedMs), String(x.invalidCount), new Date(x.at).toISOString().slice(0, 10),
    ]), w);
  };
  section(T("Today’s daily"), "daily." + iso, T("Play today’s daily to appear here."));
  section(T("Journey total"), "journey.all");
  section(T("Zenith Protocol (challenge)"), "challenge.chal-zenith");
  heading("h2", T("Profile"), w);
  const name = platform.signedIn() ? platform.displayName() + " · " : "";
  para(name + T("{plays} rounds played · {wins} wins · {pairs} pairs removed · mastery {xp} XP", { plays: p.totals.plays, wins: p.totals.wins, pairs: p.totals.pairs, xp: p.masteryXp }), w, "meta", "profile-line");
  backStack(w);
}
function table(id: string, head: string[], rows: string[][], w: number): void {
  const cols = head.map((h, c) => Math.max(tw(h, "cell-head"), ...rows.map((r) => tw(r[c]!, "cell"))) + 28);
  const total = cols.reduce((a, b) => a + b, 0);
  const width = Math.min(w, Math.max(280, total));
  ui.grid(`table-${id}`, () => {
    head.forEach((h, c) => ui.style("cell-head", { text: { align: c === 0 ? "start" : "end" } } as ui.Style).label(h));
    for (const r of rows) r.forEach((v, c) => ui.style("cell", { text: { align: c === 0 ? "start" : "end" } } as ui.Style).label(v));
  }, { columns: cols.map((cw, c) => ({ width: Math.floor((cw * width) / total), align: c === 0 ? "start" : "end" })) as ui.GridColumn[], gap: { row: 6, column: 0 }, width, rowStyle: "row-line" });
}

// ------------------------------------------------------------------ the play view
/** #hud-top: the rule and target dial, pairs / moves left, score and chain, the timer, the pause button; its height (logical). */
function hudTop(L: Layout, st: State): number {
  const f = frame();
  const target = E.currentTarget(st);
  const small = L.narrow || L.short;
  const h = L.short ? 52 : 63;
  draw.box(0, 0, f.width, L.oy + h * L.sc, "page-plain");
  const left = E.remainingTiles(st) / 2;
  const progressText = [left === 1 ? T("1 pair left") : T("{n} pairs left", { n: left }), st.limits.moves != null ? T("{n} moves", { n: st.limits.moves - st.movesUsed }) : ""].filter(Boolean).join(" · ");
  const sc = E.score(st);
  const rem = timerRemaining();
  ui.place("hud-top", { anchor: "top-start", x: 16, y: L.short ? 4 : 8 }, () => {
    ui.row("hud-row", () => {
      ui.column("objective-block", () => {
        ui.row("objective", () => {
          ui.style(small ? "objective-small" : "objective").id("rule-label").label(C.describeRuleShort(st.ruleset, target));
          if (st.ruleset.rule === "sum" && target != null) ui.style("dial").row("dial", () => { ui.style("dial-text").id("target-dial").label(String(target)); });
        }, { spacing: 10, align: "center" });
        ui.style("progress").id("progress-line").label(progressText);
      }, { spacing: 2 });
      ui.spacer();
      if (st.limits.timeMs != null && rem != null) {
        const r = Math.max(0, rem);
        ui.column("timer-block", () => {
          ui.style(r < 10000 ? "timer-urgent" : "timer-value").id("timer-value").label(fmtMs(r));
          const bw = small ? 70 : 110;
          ui.widget("timer-bar", { role: "none", size: { width: bw, height: 5 }, draw: (rc) => {
            draw.rect(rc.x, rc.y, rc.width, rc.height, token("ink") + "26");
            draw.rect(rc.x, rc.y, rc.width * (r / st.limits.timeMs!), rc.height, r < 10000 ? token("danger") : token("accent"));
          } });
        }, { spacing: 2, align: "center" });
      }
      ui.column("score-block", () => {
        ui.style(small ? "score-small" : "score-value").id("score-value").label(String(sc.total));
        ui.style("chain").id("chain-indicator").label(st.chain > 1 ? T("chain ×{n}", { n: st.chain }) : " ");
      }, { spacing: 0, align: "end" });
      const live = app.phase === "active" && app.overlay === null;
      const hit = ui.style("icon-btn").id("btn-pause").button(T("Pause (Esc)"), {
        disabled: !live,
        content: () => { ui.widget("pause-glyph", { role: "none", size: { width: 14, height: 16 }, draw: (r) => {
          const bw = r.width * 0.32, ink = token("ink");
          draw.rect(r.x, r.y, bw, r.height, ink);
          draw.rect(r.x + r.width - bw, r.y, bw, r.height, ink);
        } }); },
      });
      if (hit && !fresh(0)) later(pauseRound);
    }, { width: L.lw - 32, height: h - (L.short ? 8 : 16), align: "center", spacing: small ? 10 : 16 });
  });
  hudRects.push({ x: 0, y: 0, width: f.width, height: L.oy + h * L.sc });
  return h;
}

/** #hud-actions: Hint, Shuffle and Undo (hidden when the round has none; labels hidden on narrow portrait). */
function actionRail(L: Layout, st: State, top: number): void {
  const f = frame();
  const live = app.phase === "active" && app.overlay === null;
  const tray = L.narrow && !L.short;
  const list: { id: string; glyph: string; label: string; count: string; act: () => void }[] = [];
  if (st.tools.hints > 0) list.push({ id: "btn-hint", glyph: "💡", label: T("Hint"), count: st.tools.hints === Infinity ? "∞" : String(st.tools.hints), act: hint });
  if (st.tools.reshuffles > 0) list.push({ id: "btn-reshuffle", glyph: "🔀", label: T("Shuffle"), count: String(st.tools.reshuffles), act: reshuffle });
  if (st.tools.undo && st.history.length > 0) list.push({ id: "btn-undo", glyph: "↩", label: T("Undo"), count: "", act: undo });
  if (!list.length) return;
  const titles: Record<string, string> = { "btn-hint": T("Hint ({key})", { key: keyText("hint") }), "btn-reshuffle": T("Reshuffle ({key})", { key: keyText("reshuffle") }), "btn-undo": T("Undo ({key})", { key: keyText("undo") }) };
  const left = platform.options.leftHanded;
  const items = left && L.narrow && !L.short ? [...list].reverse() : list;
  const buttons = (): void => {
    for (const b of items) {
      const hit = ui.style("action-btn").id(b.id).tooltip(titles[b.id]!).button(b.label, {
        disabled: !live,
        content: () => {
          ui.row(`${b.id}-face`, () => {
            ui.style("action-label").label(b.glyph);
            if (!tray) ui.style("action-label").label(b.label);
            if (b.count) ui.style("action-count").label(b.count);
          }, { spacing: 6, align: "center" });
        },
      });
      if (hit && !fresh(0)) later(b.act);
    }
  };
  if (tray) {
    const h = 64;
    draw.box(0, f.height - (h + 10) * L.sc, f.width, (h + 10) * L.sc, "tray");
    const r = ui.place("hud-actions", { anchor: "bottom", y: 10 }, () => {
      ui.row("actions", buttons, { spacing: 10, align: "center" });
    });
    hudRects.push(r);
  } else {
    const r = ui.place("hud-actions", { anchor: left ? "start" : "end", x: L.short ? 6 : 12, y: top / 2 }, () => {
      ui.column("actions", buttons, { spacing: L.short ? 6 : 10 });
    });
    hudRects.push(r);
  }
}

function playView(L: Layout): void {
  const st = app.state!;
  const f = frame();
  const top = hudTop(L, st);
  const boardTop = L.oy + top * L.sc;
  render.setPlayfield(0, boardTop, f.width, Math.max(1, f.height - boardTop));
  if (app.board2d) board2d(L, st, top);
  else boardTargets(st);
  actionRail(L, st, top);
  if (app.countdown) {
    ui.place("countdown", { anchor: "center", y: top / 2 }, () => {
      const size = Math.min(96, Math.max(48, L.lw * 0.12));
      ui.style("countdown", { text: { size } }).id("countdown").label(app.countdown!);
    });
  }
  if (app.lesson) lessonBanner(L);
  const focusId = app.focusTileId;
  if (!app.board2d && focusId != null && app.phase === "active" && app.overlay === null) {
    const pos = render.tileScreenPos(focusId);
    const t = st.tiles[focusId];
    if (pos && t) {
      const text = String(t.value);
      const w = tw(text, "focus-chip-text") + 20, h = 22;
      draw.box(pos.x - (w / 2) * L.sc, pos.y - h * 1.3 * L.sc, w * L.sc, h * L.sc, "focus-chip");
      draw.text(text, pos.x, pos.y - h * 1.3 * L.sc + 3 * L.sc, { size: 14.4 * L.sc, weight: "700", align: "center", color: token("on-accent") });
    }
  }
  pauseSheet(L);
}

/** The 3D tiles' accessibility targets (index.html #board2d's labels): screen readers and play scripts find each top tile. */
function boardTargets(st: State): void {
  if (app.phase !== "active" && app.phase !== "countdown" && app.phase !== "paused") return;
  const exposed = new Set(E.exposedTiles(st));
  st.stacks.forEach((col, si) => {
    const id = col[col.length - 1];
    if (id == null) return;
    const r = render.tileRect(id);
    if (!r) return;
    ui.target(tileLabel(st, id, si, exposed.has(id)), r);
  });
}
function tileLabel(st: State, id: number, si: number, free: boolean): string {
  const t = st.tiles[id]!;
  const pos = { row: st.layout.cells[si]!.y + 1, col: st.layout.cells[si]!.x + 1 };
  const isTop = st.stacks[si]![st.stacks[si]!.length - 1] === id;
  return free
    ? [T("tile {v}, row {row} column {col}", { v: t.value, ...pos }), isTop ? T("top of stack") : "", st.ruleset.sideLock ? T("free") : ""].filter(Boolean).join(", ")
    : T("covered tile, row {row} column {col}", pos);
}

/** #board2d: the same state as buttons — rows of stacks, each stack's tiles from the bottom up (covered dimmed, locked dashed). */
function board2d(L: Layout, st: State, top: number): void {
  const exposed = new Set(E.exposedTiles(st));
  const cells = st.layout.cells;
  const maxX = Math.max(...cells.map((c) => c.x)), maxY = Math.max(...cells.map((c) => c.y));
  const big = prefs().textScale > 1.15;
  const tw2 = big ? 64 : 52, th = big ? 78 : 64;
  const live = app.phase === "active" && app.overlay === null;
  const tile = (id: number, si: number): void => {
    const t = st.tiles[id]!;
    const col = st.stacks[si]!;
    const isTop = col[col.length - 1] === id;
    const free = exposed.has(id);
    const sel = st.selected === id;
    const hinted = !!st.hintedPair && st.hintedPair.includes(id);
    const locked = isTop && !free;
    const res = ui.id(`tile-${id}`).widget(tileLabel(st, id, si, free), {
      role: "button", size: { width: tw2, height: th }, disabled: !free || !live,
      draw: (r, s) => {
        const k = s.scale;
        const lift = sel && !s.reducedMotion ? 6 * k : 0;
        const y = r.y - lift;
        const alpha = free ? 1 : 0.28;
        const ink = token("tile-ink");
        draw.box(r.x, y + 2 * k, r.width, r.height, { background: ink + "59", radius: 8 });
        draw.box(r.x, y, r.width, r.height, { background: token("tile"), radius: 8, border: { width: 2, color: ink + "4d", style: locked ? "dashed" : "solid" }, opacity: alpha } as ui.Style);
        if (isTop || free) draw.text(String(t.value), r.x + r.width / 2, y + r.height / 2 - (big ? 15 : 12) * k, { size: (big ? 30.4 : 24) * k, weight: "700", align: "center", color: ink, font: "serif", ...(free ? {} : { opacity: 0.28 }) } as draw.TextOptions);
        else draw.text("·", r.x + r.width / 2, y + r.height / 2 - 12 * k, { size: 24 * k, weight: "700", align: "center", color: ink + "47" });
        if (sel) draw.strokeRoundRect(r.x - 4 * k, y - 4 * k, r.width + 8 * k, r.height + 8 * k, 10, token("accent"), 4);
        else if (hinted) draw.strokeRoundRect(r.x - 4 * k, y - 4 * k, r.width + 8 * k, r.height + 8 * k, 10, token("accent"), 4);
      },
    });
    if (res.activated && !fresh(0)) later(() => { chooseTile(id); app.focusTileId = id; });
  };
  const rows: number[][] = [];
  for (let y = 0; y <= maxY; y++) {
    const row: number[] = [];
    for (let x = 0; x <= maxX; x++) { const si = cells.findIndex((c) => c.x === x && c.y === y); if (si >= 0) row.push(si); }
    if (row.length) rows.push(row);
  }
  const f = frame();
  const availH = (f.height - L.oy) / L.sc - top - (L.narrow && !L.short ? 74 : 0) - 24;
  const content = (): void => {
    ui.id("board2d").column(T("Tiles"), () => {
      rows.forEach((row, ri) => ui.row(`b2-row-${ri}`, () => {
        for (const si of row) {
          ui.column(`b2-cell-${si}`, () => {
            const col = st.stacks[si]!;
            if (!col.length) { ui.widget(`b2-empty-${si}`, { role: "none", size: { width: tw2, height: th } }); return; }
            for (let i = col.length - 1; i >= 0; i--) tile(col[i]!, si);
          }, { spacing: 4, align: "center" });
        }
      }, { spacing: 8, align: "end", justify: "center" }));
    }, { spacing: 8, align: "center" });
  };
  const h = lastSize.get("board2d") ?? 0;
  // #board2d: place-content center in the board region
  ui.place("board2d-place", { anchor: "top", y: top + 12 + Math.max(0, (availH - h) / 2) }, () => {
    const width = Math.min(L.lw - 24, 980);
    const inner = (): void => { const r = ui.column("board2d-col", content, { width, align: "center" }); lastSize.set("board2d", r.height / L.sc); };
    if (h > availH) ui.scrollArea("board2d-scroll", { width, height: availH }, inner);
    else inner();
  });
}

/** #lesson-banner: the lesson's step text and Got it / Finish, bottom centre. */
function lessonBanner(L: Layout): void {
  const l = app.lesson!;
  const w = Math.min(560, L.lw - 32);
  const tray = L.narrow && !L.short;
  const r = ui.place("lesson", { anchor: "bottom", y: (tray ? 84 : 18) }, () => {
    ui.style("lesson", { width: w }).id("lesson-banner").row(T("Lesson"), () => {
      const bw = btnW({ id: "x", text: l.isLast ? T("Finish") : T("Got it"), cls: "primary", act: () => undefined });
      para(T(l.text), w - 36 - bw - 14, "p", "lesson-text");
      ui.spacer();
      button({ id: "lesson-next", cls: "primary", text: l.isLast ? T("Finish") : T("Got it"), act: lessonAdvance });
    }, { width: w, spacing: 14, align: "center" });
  });
  hudRects.push(r);
}

/** #overlay-pause: Resume, Settings, Help, Restart round, Leave round. */
function pauseSheet(L: Layout): void {
  const open = app.overlay === "pause";
  if (!open) return;
  const w = Math.min(480, L.lw - 40) - 50;
  const still = ui.dialog(T("Paused"), "", true, () => {
    ui.column("pause-col", () => {
      heading("h2", T("Paused"), w);
      ui.column("pause-grid", () => {
        button({ id: "btn-resume", cls: "primary", text: T("Resume"), act: resumeRound }, w);
        button({ id: "btn-pause-settings", text: T("Settings"), act: () => openSettings(true) }, w);
        button({ id: "btn-pause-help", text: T("Help"), act: () => openHelp(true) }, w);
        button({ id: "btn-restart-round", text: T("Restart round"), act: restartRound }, w);
        button({ id: "btn-leave-round", cls: "danger", text: T("Leave round"), act: leaveRound }, w);
      }, { spacing: 10, width: w });
    }, { width: w, spacing: 16 });
  });
  if (!still && !fresh(0)) later(resumeRound);
}

// ------------------------------------------------------------------ toasts and captions
function toasts(L: Layout, inPlay: boolean): void {
  if (!app.toasts.length) return;
  const w = L.lw - 32;
  const tray = L.narrow && !L.short;
  ui.place("toasts", inPlay ? { anchor: "bottom", y: tray ? 150 : 90 } : { anchor: "top", y: 14 }, () => {
    ui.column("toast-stack", () => {
      app.toasts.forEach((t, i) => {
        ui.style(t.error ? "toast-error" : "toast").row(`toast-${i}`, () => {
          const cls = t.error ? "toast-text-error" : "toast-text";
          if (tw(t.text, cls) > w - 40) ui.style(cls).paragraph(t.text, w - 40); else ui.style(cls).label(t.text);
        }, { align: "center" });
      });
    }, { spacing: 8, align: "center" });
  });
}
function caption(L: Layout): void {
  const c = app.caption;
  if (!c) return;
  ui.place("caption", { anchor: "bottom-start", x: 12, y: L.narrow && !L.short ? 84 : 12 }, () => {
    ui.style("caption").row("caption-box", () => { ui.style("caption-text").id("sound-caption").label(c.text); });
  });
}

