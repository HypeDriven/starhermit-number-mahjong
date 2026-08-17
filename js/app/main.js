// Bootstrap + session orchestration. Owns the game-state machine:
// boot → title → mode-select → preparing → countdown → active ↔ paused
// → resolving → results → progression.
// No module here mutates rules state except through validated engine commands.

import * as E from '../rules/engine.js';
import { JOURNEY, LESSONS, dailyContent, practiceContent, challengeContent, lessonContent, prepareContent, getTheme, DAILY_EXCLUDED, describeRuleShort } from '../rules/content.js';
import { openReplay, recordCommand, closeReplay, BUILD_VERSION } from '../rules/replay.js';
import { store } from './storage.js';
import { AudioEngine } from './audio.js';
import { UI, ACHIEVEMENTS } from './ui.js';
import { Renderer3D, detectTier, webglAvailable } from './render3d.js';
import { hashString } from '../rules/rng.js';

const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------------------
// host integration (StarHermit): scope from launch token, same-origin /api
// ---------------------------------------------------------------------------

const host = {
  scope: 'standalone',
  apiBase: '/api/v1',
  launchToken: null,
  serverOffsetMs: 0,
  online: false,
};

function readLaunchToken() {
  const params = new URLSearchParams(location.search);
  const token = params.get('launch') || (window.__STARHERMIT__ && window.__STARHERMIT__.launchToken) || null;
  if (!token) return;
  host.launchToken = token; // memory only — never persisted
  try {
    const payload = JSON.parse(atob(token.split('.')[1] || ''));
    if (payload.scope) host.scope = payload.scope;
    if (payload.slug) host.scope = payload.slug;
  } catch { /* opaque token: fine, scope stays default */ }
}

async function syncServerTime() {
  const t0 = Date.now();
  try {
    const res = await fetch(`${host.apiBase}/time`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    const t1 = Date.now();
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    const serverMs = data.utcMs ?? data.now ?? data.ms;
    host.serverOffsetMs = serverMs - (t0 + (t1 - t0) / 2);
    host.online = true;
  } catch {
    host.serverOffsetMs = 0; // offline: local clock is the platform clock
    host.online = false;
  }
}

function nowUtcMs() { return Date.now() + host.serverOffsetMs; }
function todayDailyInfo() {
  const d = new Date(nowUtcMs());
  const iso = d.toISOString().slice(0, 10);
  return { iso, dayIndex: Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000) };
}
function msUntilNextDaily() {
  const now = nowUtcMs();
  const next = (Math.floor(now / 86400000) + 1) * 86400000;
  return next - now;
}

// ---------------------------------------------------------------------------
// authoritative session clock (pausable; drives command timestamps)
// ---------------------------------------------------------------------------

class SessionClock {
  constructor() { this.acc = 0; this.t0 = null; }
  start() { this.t0 = performance.now(); }
  now() { return this.acc + (this.t0 != null ? performance.now() - this.t0 : 0); }
  pause() { if (this.t0 != null) { this.acc += performance.now() - this.t0; this.t0 = null; } }
  resume() { if (this.t0 == null) this.t0 = performance.now(); }
  set(ms) { this.acc = ms; this.t0 = performance.now(); }
}

// ---------------------------------------------------------------------------

class App {
  constructor() {
    this.root = $('#app');
    this.settings = store.loadSettings();
    this.progress = store.loadProgress();
    this.ui = new UI(this);
    this.audio = new AudioEngine(this.settings);
    this.renderer = null;
    this.phase = 'boot';
    this.state = null;         // current rules snapshot (immutable)
    this.content = null;
    this.board = null;
    this.replay = null;
    this.clock = new SessionClock();
    this.sessionId = Math.random().toString(36).slice(2, 10);
    this.cmdSeq = 0;
    this.focusTileId = null;   // keyboard/gamepad focus
    this.lessonStep = 0;
    this.paused = false;
    this.timerHandle = null;
    this.gamepadPrev = {};
    this.telemetry = [];
    this.winStreak = 0;
    this.dailyTimer = null;
  }

  // ------------------------------------------------------------- boot -----

  async boot() {
    readLaunchToken();
    syncServerTime(); // fire and forget; daily uses best-known offset
    this.ui.applyA11ySettings(this.settings);
    this.ui.applyTheme('ivory-dusk', this.settings.themeOverride);

    // renderer (3D hero) with graceful 2D fallback
    const tier = this.settings.graphicsTier === 'auto' ? detectTier() : this.settings.graphicsTier;
    if (webglAvailable() && !this.settings.board2d) {
      try {
        this.renderer = new Renderer3D($('#gl'), { tier, reducedMotion: this.settings.reducedMotion });
        this.renderer.setTheme(getTheme(this.settings.themeOverride || 'ivory-dusk'));
        this.renderer.setCameraMode(this.settings.camera);
      } catch (e) {
        console.warn('3D init failed, using 2D board', e);
        this.renderer = null;
        this.ui.compat3DUnavailable();
      }
    } else {
      this.ui.compat3DUnavailable();
      $('#compat-message').querySelector('p').textContent =
        'The 2D board is active. You can re-enable the 3D observatory in Settings → Graphics.';
    }

    this.audio.onCaption = (t) => { if (this.settings.soundCaptions && t) this.caption(t); };
    this._wireInput();
    this._wireGlobalKeys();
    this._wireVisibility();
    this._loopGamepad();
    this.toTitle('boot');
    this._track('start', { tier, online: host.online });
  }

  _track(name, data = {}) {
    // anonymous funnel events only; short retention, never leaves the device
    // unless a hosted platform with consent is attached
    this.telemetry.push({ name, ...data, at: Date.now() });
    if (this.telemetry.length > 200) this.telemetry.shift();
  }

  caption(text) {
    const el = $('#sound-caption');
    el.classList.remove('visually-hidden');
    el.textContent = '♪ ' + text;
    clearTimeout(this._captionT);
    this._captionT = setTimeout(() => el.classList.add('visually-hidden'), 1400);
  }

  // ---------------------------------------------------------- screens -----

  toTitle(reason) {
    this.phase = 'title';
    this._teardownRound();
    const { iso, dayIndex } = todayDailyInfo();
    // resume offer: the most recent non-terminal saved session
    let resumeInfo = null;
    for (const snap of store.listSessionSnapshots()) {
      try {
        const st = E.deserialize(snap.state);
        if (st.status === 'active' && (!resumeInfo || st.elapsedMs > resumeInfo.elapsedMs)) {
          resumeInfo = { contentId: snap.contentId, elapsedMs: st.elapsedMs, remaining: E.remainingTiles(st) };
        }
      } catch { /* corrupt snapshot ignored */ }
    }
    this.ui.showTitle({
      journeyDone: this.progress.journey,
      dailyDone: !!this.progress.dailyHistory[iso]?.completed,
      dailyDate: iso,
      streak: this.winStreak,
      resumeInfo,
    });
  }

  resumeSavedRound(contentId) {
    const snap = store.loadSessionSnapshot(contentId);
    if (!snap?.state) { this.ui.toast('No saved round found', true); return; }
    let state;
    try { state = E.deserialize(snap.state); } catch { this.ui.toast('Saved round was corrupt', true); return; }
    // rebuild content deterministically from the stored content id
    let content = null;
    if (contentId.startsWith('daily-')) {
      const iso = contentId.slice(6);
      const d = new Date(iso + 'T00:00:00Z');
      content = dailyContent(iso, Math.floor(d.getTime() / 86400000));
    } else if (contentId.startsWith('journey-')) {
      content = JOURNEY.find(j => j.id === contentId);
    } else if (contentId.startsWith('practice-')) {
      const m = contentId.match(/^practice-(\w+)-(.+)$/);
      if (m) content = practiceContent(m[1], m[2]);
    } else if (contentId.startsWith('chal-')) {
      content = challengeContent(contentId);
    }
    if (!content) { this.ui.toast('Cannot resume this round', true); return; }

    this.phase = 'preparing';
    const { content: prepared, board } = prepareContent(content);
    if (this.effectiveTimeLimit(prepared) != null) {
      prepared.limits = { ...prepared.limits, timeMs: this.effectiveTimeLimit(prepared) };
    }
    this.content = prepared;
    this.board = board;
    this.state = state;
    this.replay = openReplay(prepared, board); // continuation log; snapshot hash verified via engine state
    this.sessionId = Math.random().toString(36).slice(2, 10);
    const theme = this.ui.applyTheme(prepared.theme, this.settings.themeOverride);
    if (this.renderer) {
      this.renderer.setTheme(theme);
      this.renderer.buildBoard(this.state);
      this.renderer.noteState(this.state);
    }
    this.ui.renderBoard2D(this.state);
    this.ui.updateHUD(this.state, prepared, prepared.limits.timeMs);
    this.ui.setScreen('play');
    this.phase = 'active';
    this.clock = new SessionClock();
    this.clock.set(state.elapsedMs);
    this._startTimerLoop();
    // “while you were away” summary
    const away = `Welcome back. ${E.remainingTiles(state)} tiles remain, score ${E.score(state).total}, ${this.ui.fmtMs(state.elapsedMs)} elapsed.`;
    this.ui.toast(away);
    this.ui.announce(away + ' ' + this.ui.boardSummary(state));
  }

  // --------------------------------------------------------- round flow ---

  effectiveTimeLimit(content) {
    if (content.limits?.timeMs == null) return null;
    return Math.round(content.limits.timeMs * (this.settings.timingAssist ? 1.5 : 1));
  }

  openModeSetup(content, opts = {}) {
    this.pendingContent = content;
    this.phase = 'mode-select';
    this.ui.showModeSetup(content, opts);
  }

  beginRound(content) {
    this.phase = 'preparing';
    const { content: prepared, board } = prepareContent(content);
    if (this.effectiveTimeLimit(prepared) != null) {
      prepared.limits = { ...prepared.limits, timeMs: this.effectiveTimeLimit(prepared) };
    }
    this.content = prepared;
    this.board = board;
    this.state = E.createGame(prepared, board);
    this.replay = openReplay(prepared, board);
    this.sessionId = Math.random().toString(36).slice(2, 10);
    this.cmdSeq = 0;
    this.lessonStep = 0;
    this.focusTileId = null;

    const theme = this.ui.applyTheme(prepared.theme, this.settings.themeOverride);
    if (this.renderer) {
      this.renderer.setTheme(theme);
      this.renderer.setReducedMotion(this.settings.reducedMotion);
      this.renderer.buildBoard(this.state);
      this.renderer.noteState(this.state);
    }
    this.ui.renderBoard2D(this.state);
    this.ui.updateHUD(this.state, prepared, prepared.limits.timeMs);
    this.ui.setScreen('play');
    this.ui.hideLessonBanner();
    this._announceBoard();

    // countdown (tutorial screens are lesson banners instead)
    const isLesson = prepared.kind === 'lesson';
    if (isLesson) {
      this._startLesson();
    }
    this.phase = 'countdown';
    if (this.settings.reducedMotion) {
      this._activate();
    } else {
      let n = 3;
      const step = () => {
        if (this.phase !== 'countdown') return;
        if (n === 0) { this.ui.countdown('Observe'); this.audio.play('ui'); setTimeout(() => { this.ui.countdown(null); this._activate(); }, 450); return; }
        this.ui.countdown(String(n));
        this.audio.play('tick-urgent');
        n--;
        setTimeout(step, 650);
      };
      step();
    }
  }

  _activate() {
    if (this.phase !== 'countdown') return;
    this.phase = 'active';
    this.clock = new SessionClock();
    this.clock.start();
    this._startTimerLoop();
    this.announceObjective();
  }

  announceObjective() {
    const target = E.currentTarget(this.state);
    this.ui.announce(`Round started. ${describeRuleShort(this.state.ruleset, target)}. ${this.ui.boardSummary(this.state)}`);
  }

  _announceBoard() {
    this.ui.announce(this.ui.boardSummary(this.state));
  }

  // --------------------------------------------------------- commands -----

  dispatch(cmd) {
    if (!this.state) return;
    if (this.phase !== 'active') {
      if (cmd.type === 'quit') { this._endRoundCleanup(); }
      return;
    }
    cmd.id = `${this.sessionId}-${++this.cmdSeq}`;
    cmd.atMs = Math.round(this.clock.now());
    const before = this.state;
    const { state: next, events } = E.applyCommand(before, cmd);
    if (next === before && events[0]?.type === 'rejected') {
      if (cmd.type === 'hint' || cmd.type === 'reshuffle' || cmd.type === 'undo') {
        this.ui.toast(events[0].reason, true);
        this.audio.play('invalid');
      }
      return;
    }
    this.state = next;
    recordCommand(this.replay, cmd, next);
    this._afterCommand(events);
  }

  _afterCommand(events) {
    const st = this.state;
    // presentation
    if (this.renderer) { this.renderer.noteState(st); this.renderer.syncState(st, events); }
    this.ui.renderBoard2D(st);
    this.ui.updateHUD(st, this.content, this._timerRemaining());
    store.saveSessionSnapshot(this.content.id, { state: E.serialize(st), replay: { ...this.replay, state: undefined } });

    for (const ev of events) {
      switch (ev.type) {
        case 'select':
          this.audio.play('select');
          this.ui.announce(`Tile ${st.tiles[ev.tile].value} selected. ${this._partnerHint(ev.tile)}`);
          break;
        case 'deselect': this.audio.play('deselect'); break;
        case 'invalid':
          this.audio.play('invalid');
          this.ui.toast(this._invalidText(ev), true);
          this.ui.announce(`Invalid: ${this._invalidText(ev)}`);
          break;
        case 'pair': {
          this.audio.play(ev.chain > 1 ? 'chain' : 'pair', { chain: ev.chain });
          this.ui.announce(`${ev.values[0]} and ${ev.values[1]} removed, +${ev.gained}. ${E.remainingTiles(st) / 2} pairs left.${st.ruleset.dynamic ? ` New target: ${E.currentTarget(st)}.` : ''}`);
          break;
        }
        case 'hint': {
          this.audio.play('hint');
          const a = st.tiles[ev.tileA], b = st.tiles[ev.tileB];
          this.ui.announce(`Hint: try ${a.value} and ${b.value}.`);
          this.ui.toast(`Hint: ${a.value} + ${b.value}`.replace('+', hintJoiner(st)));
          break;
        }
        case 'reshuffle':
          this.audio.play('reshuffle');
          this.ui.announce('Remaining tiles reshuffled. ' + this.ui.boardSummary(st));
          break;
        case 'undo':
          this.audio.play('undo');
          this.ui.announce('Move undone. ' + this.ui.boardSummary(st));
          break;
        case 'terminal':
          this._onTerminal();
          break;
      }
    }
    if (this.content.kind === 'lesson') this._lessonTick();
  }

  _partnerHint(tileId) {
    const v = this.state.tiles[tileId].value;
    const r = this.state.ruleset;
    switch (r.rule) {
      case 'sum': return `Partner must be ${E.currentTarget(this.state) - v}.`;
      case 'match': return `Partner must also be ${v}.`;
      case 'diff': return `Partner must be ${v - r.diff} or ${v + r.diff}.`;
      default: return '';
    }
  }

  _invalidText(ev) {
    if (ev.reason === E.REJECT.RULE_MISMATCH) {
      const a = this.state.tiles[ev.tileA]?.value, b = this.state.tiles[ev.tileB]?.value;
      return `${a} and ${b} don’t satisfy the rule (${describeRuleShort(this.state.ruleset, E.currentTarget(this.state))})`;
    }
    if (ev.reason === E.REJECT.NOT_EXPOSED) return 'That tile is covered or locked on both sides';
    return ev.reason || 'Not allowed';
  }

  // tap/confirm semantics: first tile selects, second tile attempts a pair
  chooseTile(tileId) {
    if (!this.state || this.phase !== 'active') return;
    if (this.state.selected == null || this.state.selected === tileId) {
      this.dispatch({ type: 'select', tileId });
    } else {
      this.dispatch({ type: 'pair', tileA: this.state.selected, tileB: tileId });
    }
  }

  // ------------------------------------------------------------- timer ----

  _timerRemaining() {
    if (!this.state || this.state.limits.timeMs == null) return null;
    return this.state.limits.timeMs - this.clock.now();
  }

  _startTimerLoop() {
    clearInterval(this.timerHandle);
    this.timerHandle = setInterval(() => {
      if (this.phase !== 'active' || !this.state) return;
      const rem = this._timerRemaining();
      this.ui.updateHUD(this.state, this.content, rem);
      if (rem != null) {
        if (rem <= 0) {
          this.dispatch({ type: 'timeout' });
        } else if (rem < 10500 && Math.floor(rem / 1000) !== this._lastTickSec) {
          this._lastTickSec = Math.floor(rem / 1000);
          this.audio.play('tick-urgent');
        }
      }
    }, 200);
  }

  // ----------------------------------------------------------- terminal ---

  _onTerminal() {
    this.phase = 'resolving';
    clearInterval(this.timerHandle);
    this.clock.pause();
    const won = this.state.status === 'won';
    this.audio.play(won ? 'win' : 'lose');
    this._track('round-end', { kind: this.content.kind, won, reason: this.state.reason });

    // settle cosmetics into the exact deterministic end state, then results
    const delay = this.settings.reducedMotion ? 60 : 750;
    setTimeout(() => {
      if (this.renderer) this.renderer.settleImmediately();
      this._showResults();
    }, delay);
  }

  _showResults() {
    this.phase = 'results';
    const st = this.state;
    const breakdown = E.score(st);
    const won = st.status === 'won';
    const envelope = closeReplay(this.replay, st, breakdown, this.sessionId);
    store.saveReplay(this.content.id, envelope);
    store.clearSessionSnapshot(this.content.id);

    // progression
    this.progress.totals.plays++;
    this.progress.totals.pairs += st.pairsCleared;
    if (won) {
      this.progress.totals.wins++;
      this.winStreak++;
    } else {
      this.winStreak = 0;
    }
    let stars = null;
    if (this.content.kind === 'journey') {
      const prev = this.progress.journey[this.content.id];
      if (won) {
        stars = 1 + (breakdown.total >= this.content.par.score ? 1 : 0) + (st.elapsedMs <= this.content.par.timeMs ? 1 : 0);
        this.progress.journey[this.content.id] = {
          stars: Math.max(stars, prev?.stars || 0),
          bestScore: Math.max(breakdown.total, prev?.bestScore || 0),
          bestMs: prev?.bestMs ? Math.min(prev.bestMs, st.elapsedMs) : st.elapsedMs,
          completions: (prev?.completions || 0) + 1,
        };
        this.progress.masteryXp += 10 + (this.content.mastery ? 15 : 0) + stars * 2;
      }
    }
    if (this.content.kind === 'lesson' && won) {
      this.progress.lessons[this.content.id] = { completed: true };
    }
    if (this.content.kind === 'daily') {
      const { iso } = todayDailyInfo();
      const prev = this.progress.dailyHistory[iso];
      this.progress.dailyHistory[iso] = {
        score: Math.max(breakdown.total, prev?.score || 0),
        completed: (prev?.completed || false) || won,
      };
      this.progress.lastDailyDate = iso;
    }
    if (this.content.kind === 'challenge' && won) {
      this.progress.challenges = this.progress.challenges || {};
      const prev = this.progress.challenges[this.content.id];
      if (!prev || breakdown.total > prev.score) {
        this.progress.challenges[this.content.id] = { score: breakdown.total, elapsedMs: st.elapsedMs };
      }
    }

    // leaderboards (local always; server when hosted and ranked) — wins only
    let placement = -1;
    if (won) {
      const entry = {
        score: breakdown.total, elapsedMs: st.elapsedMs, invalidCount: st.invalidCount,
        sessionId: this.sessionId, at: nowUtcMs(),
        ruleset: this.content.ruleset.rule, contentVersion: this.content.contentVersion,
        seed: String(this.content.seed), assists: this._assistsUsed(), verified: false,
      };
      const boardKey = this._boardKey();
      placement = store.submitBoardEntry(boardKey, entry);
      if (this.content.kind === 'journey' && won) store.submitBoardEntry('journey.all', entry, 50);
      if (this.content.ranked && host.online && !this.settings.timingAssist) this._submitScore(envelope, entry);
    }

    const newAchievements = this._checkAchievements();
    store.saveProgress(this.progress);

    this.ui.showResults({
      state: st, content: this.content, breakdown, stars,
      newAchievements, boardPlacement: placement, par: this.content.par,
    });
    this.ui.announce(`${st.status === 'won' ? 'Round complete' : 'Round over'}. Total score ${breakdown.total}.`, true);
    if (newAchievements.length) this.audio.play('achievement');
  }

  _assistsUsed() {
    const out = [];
    if (this.state.hintsUsed) out.push(`hints:${this.state.hintsUsed}`);
    if (this.state.reshufflesUsed) out.push(`reshuffles:${this.state.reshufflesUsed}`);
    if (this.state.undoCount) out.push(`undo:${this.state.undoCount}`);
    if (this.settings.timingAssist) out.push('timing-assist');
    return out.join(',') || 'none';
  }

  _boardKey() {
    if (this.content.kind === 'daily') return 'daily.' + todayDailyInfo().iso;
    if (this.content.kind === 'challenge') return 'challenge.' + this.content.id;
    if (this.content.kind === 'journey') return 'journey.' + this.content.id;
    return 'casual.' + this.content.kind;
  }

  async _submitScore(envelope, entry) {
    try {
      const res = await fetch(`${host.apiBase}/scores`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ board: this._boardKey(), entry, replay: envelope }),
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.error) this.ui.toast(`Score not accepted: ${data.error}`, true);
      }
    } catch { /* offline: local board stands */ }
  }

  _checkAchievements() {
    const won = this.state.status === 'won';
    const unlocked = [];
    const grant = (key) => {
      if (!this.progress.achievements[key]) {
        this.progress.achievements[key] = nowUtcMs();
        const meta = ACHIEVEMENTS.find(a => a.key === key);
        if (meta) { unlocked.push(meta); this.ui.toast(`Achievement: ${meta.name}`); }
      }
    };
    if (won) {
      grant('first-clear');
      if (this.winStreak >= 3) grant('streak-3');
      const rulesWon = new Set();
      for (const [id, rec] of Object.entries(this.progress.journey)) {
        if (rec.completions > 0) {
          const st = JOURNEY.find(j => j.id === id);
          if (st) rulesWon.add(st.ruleset.rule);
        }
      }
      if (this.content.kind === 'journey') rulesWon.add(this.content.ruleset.rule);
      if (['sum', 'match', 'diff'].every(r => rulesWon.has(r))) grant('mechanic-master');
      const doneCount = Object.keys(this.progress.journey).length;
      if (doneCount >= 22) grant('half-journey');
      if (doneCount >= JOURNEY.length) grant('full-journey');
      if (this.content.id === 'journey-44') grant('zenith');
      if (Object.keys(this.progress.dailyHistory).filter(d => this.progress.dailyHistory[d].completed).length >= 7) grant('daily-7');
    }
    if (this.progress.totals.pairs >= 1000) grant('marathon');
    return unlocked;
  }

  // ------------------------------------------------------------ lessons ---

  _startLesson() {
    const script = this.content.script || [];
    if (!script.length) return;
    this.ui.showLessonBanner(script[0].text, script.length === 1);
    this._track('tutorial-step', { lesson: this.content.id, step: 0 });
  }

  _lessonTick() {
    const script = this.content.script || [];
    if (!script.length || this.lessonStep >= script.length) return;
    const step = script[this.lessonStep];
    // advance on satisfied requirements
    if (step.requireSelectValue != null && this.state.selected != null) {
      if (this.state.tiles[this.state.selected].value === step.requireSelectValue) this._lessonAdvance();
    } else if (step.requirePairValues && this.state.pairsCleared > 0) {
      this._lessonAdvance();
    }
  }

  _lessonAdvance() {
    this.lessonStep++;
    const script = this.content.script || [];
    if (this.lessonStep < script.length) {
      this.ui.showLessonBanner(script[this.lessonStep].text, this.lessonStep === script.length - 1);
      this._track('tutorial-step', { lesson: this.content.id, step: this.lessonStep });
    } else {
      this.ui.hideLessonBanner();
    }
  }

  // -------------------------------------------------------- pause/resume --

  pause(reason = 'user') {
    if (this.phase !== 'active' || this.paused) return;
    this.paused = true;
    this.phase = 'paused';
    this.clock.pause();
    this.audio.play('pause');
    this.audio.suspend();
    this.ui.setPaused(true);
    this._track('pause', { reason });
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.phase = 'active';
    this.clock.resume();
    this.audio.resume();
    this.ui.setPaused(false);
    this.ui.announce('Round resumed. ' + this.ui.boardSummary(this.state));
  }

  leaveRound() {
    if (this.state && this.state.status === 'active') {
      // record abandonment in the log for honesty, then leave
      this.paused = false;
      this.ui.setPaused(false);
      this.phase = 'active';
      this.clock.resume();
      this.dispatch({ type: 'quit' });
      if (this.state.status !== 'active') return; // terminal handler will show results
    }
    this._endRoundCleanup();
    this.toTitle('leave');
  }

  _endRoundCleanup() {
    clearInterval(this.timerHandle);
    this.paused = false;
    this.ui.setPaused(false);
    this.ui.hideLessonBanner();
    this.ui.countdown(null);
  }

  _teardownRound() {
    this._endRoundCleanup();
    this.state = null;
    this.content = null;
    this.board = null;
    this.replay = null;
  }

  restartRound() {
    if (!this.content) return;
    const content = JOURNEY.find(j => j.id === this.content.id)
      ? { ...JOURNEY.find(j => j.id === this.content.id) }
      : this._contentSource();
    this._track('retry', { kind: this.content.kind });
    this._endRoundCleanup();
    this.beginRound(content);
  }

  _contentSource() {
    // rebuild the same content descriptor (same seed ⇒ same board)
    const c = this.content;
    const base = { ...c };
    delete base.__pairCount;
    delete base.__fixedTargetSequence;
    if (c.kind === 'practice') {
      const m = c.id.match(/^practice-(\w+)-(.+)$/);
      if (m) return practiceContent(m[1], m[2]);
    }
    if (c.kind === 'daily') {
      const { iso, dayIndex } = todayDailyInfo();
      return dailyContent(iso, dayIndex);
    }
    if (c.kind === 'challenge') return challengeContent(c.id);
    if (c.kind === 'lesson') return lessonContent(c.id);
    return base;
  }

  // -------------------------------------------------------------- input ---

  _wireInput() {
    const canvas = $('#gl');
    let downAt = null, downPos = null, dragging = false;

    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      downAt = performance.now();
      downPos = { x: e.clientX, y: e.clientY };
      dragging = false;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (downPos && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 14) dragging = true;
      // hover preview: highlight legal partners of the hovered tile
      if (!downPos && this.renderer && this.phase === 'active') {
        const id = this.renderer.pick(e.clientX, e.clientY);
        canvas.style.cursor = id != null && E.isExposed(this.state, id) ? 'pointer' : 'default';
      }
    });
    canvas.addEventListener('pointerup', (e) => {
      const wasDrag = dragging;
      downPos = null;
      if (wasDrag || !this.renderer) return;
      if (performance.now() - downAt > 600) return; // long press ≠ tap
      const id = this.renderer.pick(e.clientX, e.clientY);
      if (id != null) this.chooseTile(id);
    });
    canvas.addEventListener('pointercancel', () => { downPos = null; dragging = false; });

    // 2D board clicks
    $('#board2d').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tile]');
      if (btn && !btn.disabled) this.chooseTile(Number(btn.dataset.tile));
    });

    // HUD buttons
    $('#btn-pause').addEventListener('click', () => this.pause());
    $('#btn-hint').addEventListener('click', () => this.dispatch({ type: 'hint' }));
    $('#btn-reshuffle').addEventListener('click', () => this.dispatch({ type: 'reshuffle' }));
    $('#btn-undo').addEventListener('click', () => this.dispatch({ type: 'undo' }));

    // pause overlay
    $('#btn-resume').addEventListener('click', () => this.resume());
    $('#btn-pause-settings').addEventListener('click', () => { this._settingsReturn = 'pause'; this.ui.setPaused(false); this.ui.showSettings(this.settings); this.setScreenForSettings(); });
    $('#btn-pause-help').addEventListener('click', () => { this._helpReturn = 'pause'; this.ui.setPaused(false); this.ui.showHelp(this.settings.bindings || {}); this.setScreenForOverlay('help'); });
    $('#btn-restart-round').addEventListener('click', () => { this.ui.setPaused(false); this.restartRound(); });
    $('#btn-leave-round').addEventListener('click', () => this.leaveRound());

    $('#lesson-next').addEventListener('click', () => this._lessonAdvance());

    // screen-root delegated actions
    this.ui.root.addEventListener('click', (e) => this._onScreenAction(e));
    this.ui.root.addEventListener('input', (e) => this._onSettingInput(e));
    this.ui.root.addEventListener('change', (e) => this._onSettingInput(e));

    // first gesture starts audio
    const startAudio = () => { this.audio.start(); window.removeEventListener('pointerdown', startAudio); window.removeEventListener('keydown', startAudio); };
    window.addEventListener('pointerdown', startAudio);
    window.addEventListener('keydown', startAudio);
  }

  setScreenForSettings() { this.root.dataset.screen = 'settings'; }
  setScreenForOverlay(name) { this.root.dataset.screen = name; }

  _onScreenAction(e) {
    const el = e.target.closest('[data-act], [data-stage], [data-practice], [data-challenge], [data-lesson], [data-remap]');
    if (!el) return;
    this.audio.start();
    this.audio.play('ui');
    const act = el.dataset.act;
    if (el.dataset.stage) {
      const st = JOURNEY.find(j => j.id === el.dataset.stage);
      if (st) this.openModeSetup({ ...st });
      return;
    }
    if (el.dataset.practice) {
      const salt = Math.random().toString(36).slice(2, 8);
      this.openModeSetup(practiceContent(el.dataset.practice, salt));
      return;
    }
    if (el.dataset.challenge) {
      const c = challengeContent(el.dataset.challenge);
      this.openModeSetup(c, { blurb: c.blurb });
      return;
    }
    if (el.dataset.lesson) {
      this.beginRound(lessonContent(el.dataset.lesson));
      return;
    }
    if (el.dataset.remap) {
      this._remapGamepad(el.dataset.remap, el);
      return;
    }
    switch (act) {
      case 'resume':
        if (el.dataset.content) this.resumeSavedRound(el.dataset.content);
        break;
      case 'play': {
        const next = JOURNEY.find(s => !this.progress.journey[s.id]) || JOURNEY[JOURNEY.length - 1];
        this.openModeSetup({ ...next });
        break;
      }
      case 'daily': {
        const { iso, dayIndex } = todayDailyInfo();
        const content = dailyContent(iso, dayIndex);
        this.openModeSetup(content, {
          extraButtons: `<p class="meta" style="text-align:center">Next daily in ${this.ui.fmtMs(msUntilNextDaily())}${DAILY_EXCLUDED.has(iso) ? ' · today is excluded from ranking' : ''}</p>`,
        });
        break;
      }
      case 'journey': this.ui.showJourney(this.progress); break;
      case 'practice': this.ui.showPractice(); break;
      case 'challenge': this.ui.showChallenges(this.progress); break;
      case 'learn': this.ui.showLearn(this.progress); break;
      case 'settings': this._settingsReturn = 'title'; this.ui.showSettings(this.settings); break;
      case 'help': this._helpReturn = 'title'; this.ui.showHelp(this.settings.bindings || {}); break;
      case 'scores': this._showScores(); break;
      case 'begin': if (this.pendingContent) this.beginRound(this.pendingContent); break;
      case 'back':
        if (this._settingsReturn === 'pause' || this._helpReturn === 'pause') {
          this._settingsReturn = this._helpReturn = null;
          this.ui.setScreen('play');
          this.ui.setPaused(true);
          this.root.dataset.screen = 'play';
        } else {
          this.toTitle('back');
        }
        break;
      case 'next': {
        const next = JOURNEY[this.content.index];
        if (next) this.openModeSetup({ ...next });
        break;
      }
      case 'retry': this.restartRound(); break;
      case 'reset-tutorials':
        this.progress.lessons = {};
        store.saveProgress(this.progress);
        this.ui.toast('Lessons reset');
        break;
      case 'erase-all':
        if (confirm('Erase ALL local progress, settings, and leaderboard entries? This cannot be undone.')) {
          store.resetAll();
          this.settings = store.loadSettings();
          this.progress = store.loadProgress();
          this.ui.applyA11ySettings(this.settings);
          this.ui.showSettings(this.settings);
          this.ui.toast('All local data erased');
        }
        break;
    }
  }

  _onSettingInput(e) {
    const key = e.target.dataset?.set;
    if (!key) return;
    let val;
    if (e.target.type === 'checkbox') val = e.target.checked;
    else if (e.target.type === 'range') val = Number(e.target.value);
    else val = e.target.value || null;
    this.settings[key] = val;
    store.saveSettings(this.settings);
    this._track('settings-change', { key });
    // apply live
    if (['music', 'effects', 'ambience'].includes(key)) this.audio.setVolume(key, val);
    if (key === 'muted') this.audio.setMuted(val);
    if (key === 'graphicsTier' && this.renderer) this.renderer.setQuality(val === 'auto' ? detectTier() : val);
    if (key === 'reducedMotion' && this.renderer) this.renderer.setReducedMotion(val);
    if (key === 'camera' && this.renderer) { this.renderer.setCameraMode(val); this.renderer.resetCamera(); }
    if (key === 'board2d') location.reload();
    if (key === 'themeOverride') {
      const theme = this.ui.applyTheme(this.content?.theme || 'ivory-dusk', val);
      if (this.renderer) this.renderer.setTheme(theme);
    }
    this.ui.applyA11ySettings(this.settings);
  }

  _showScores() {
    const { iso } = todayDailyInfo();
    this.ui.showScores({
      boards: {
        daily: store.loadBoard('daily.' + iso),
        journey: store.loadBoard('journey.all'),
        zenith: store.loadBoard('challenge.chal-zenith'),
      },
      progress: this.progress,
    });
  }

  // --------------------------------------------------- keyboard + focus ---

  _wireGlobalKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.target.matches('input, select, textarea')) return;
      const inPlay = this.root.dataset.screen === 'play';
      switch (e.key) {
        case 'Escape':
          if (this.paused) this.resume();
          else if (inPlay && this.phase === 'active') {
            if (this.state?.selected != null) { this.dispatch({ type: 'select', tileId: this.state.selected }); }
            else this.pause();
          }
          break;
        case 'p': case 'P': if (inPlay) { this.paused ? this.resume() : this.pause(); } break;
        case 'h': case 'H': if (inPlay) this.dispatch({ type: 'hint' }); break;
        case 'r': case 'R': if (inPlay) this.dispatch({ type: 'reshuffle' }); break;
        case 'u': case 'U': if (inPlay) this.dispatch({ type: 'undo' }); break;
        case 'c': case 'C': if (this.renderer) this.renderer.resetCamera(); break;
        case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown':
          if (inPlay && this.phase === 'active') {
            e.preventDefault();
            this._moveFocus({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]);
          }
          break;
        case 'Enter': case ' ':
          if (inPlay && this.phase === 'active' && this.focusTileId != null) {
            e.preventDefault();
            this.chooseTile(this.focusTileId);
          }
          break;
      }
    });
  }

  _exposedSorted() {
    if (!this.state) return [];
    return E.exposedTiles(this.state).map(id => {
      const t = this.state.tiles[id];
      const cell = this.state.layout.cells[t.stack];
      return { id, x: cell.x, y: cell.y, level: t.level };
    }).sort((a, b) => a.y - b.y || a.x - b.x);
  }

  _moveFocus([dx, dy]) {
    const exposed = this._exposedSorted();
    if (!exposed.length) return;
    if (this.focusTileId == null || !exposed.some(t => t.id === this.focusTileId)) {
      this.focusTileId = exposed[0].id;
    } else {
      const cur = exposed.find(t => t.id === this.focusTileId);
      let best = null, bestScore = Infinity;
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
      if (!best) {
        // wrap around in that direction
        const sorted = exposed.slice().sort((a, b) => dx ? (a.x - b.x) * dx || (a.y - b.y) : (a.y - b.y) * dy || (a.x - b.x));
        best = sorted[0];
      }
      this.focusTileId = best.id;
    }
    this._highlightFocus();
  }

  _highlightFocus() {
    const t = this.state?.tiles[this.focusTileId];
    if (!t) return;
    this.ui.announce(`Focused tile ${t.value}. ${this._partnerHint(this.focusTileId)}`);
    // reflect focus in the 2D board for visible focus ring
    const btn = document.querySelector(`#board2d [data-tile="${this.focusTileId}"]`);
    if (btn && this.root.dataset.board2d === '1') { btn.focus({ preventScroll: true }); return; }
    // 3D mode: floating focus chip aligned to the projected tile position
    let chip = $('#focus-chip');
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'focus-chip';
      chip.setAttribute('aria-hidden', 'true');
      $('#board-region').appendChild(chip);
    }
    if (this.renderer) {
      const pos = this.renderer.tileScreenPos(this.focusTileId);
      const rect = $('#board-region').getBoundingClientRect();
      if (pos) {
        chip.style.display = 'block';
        chip.style.left = (pos.x - rect.left) + 'px';
        chip.style.top = (pos.y - rect.top) + 'px';
        chip.textContent = t.value;
      }
    }
  }

  // -------------------------------------------------------------- gamepad --

  _remapGamepad(action, btnEl) {
    btnEl.textContent = 'press a button…';
    const poll = () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const pad of pads) {
        if (!pad) continue;
        for (let i = 0; i < pad.buttons.length; i++) {
          if (pad.buttons[i].pressed) {
            this.settings.bindings = { ...(this.settings.bindings || {}), [action]: `b${i}` };
            store.saveSettings(this.settings);
            btnEl.textContent = `b${i}`;
            return;
          }
        }
      }
      requestAnimationFrame(poll);
    };
    const stop = (e) => { window.removeEventListener('keydown', stop); };
    window.addEventListener('keydown', stop, { once: true });
    poll();
  }

  _gamepadButton(pad, action, defIdx) {
    const map = this.settings.bindings || {};
    const custom = map[action];
    const idx = custom ? Number(custom.slice(1)) : defIdx;
    const b = pad.buttons[idx];
    return b ? b.pressed : false;
  }

  _loopGamepad() {
    const step = () => {
      requestAnimationFrame(step);
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const pad = [...pads].find(p => p && p.connected);
      if (!pad || this.root.dataset.screen !== 'play' || this.phase !== 'active') { this.gamepadPrev = {}; return; }
      const pressed = (name, defIdx) => {
        const now = this._gamepadButton(pad, name, defIdx);
        const was = this.gamepadPrev[name];
        this.gamepadPrev[name] = now;
        return now && !was;
      };
      // default mapping: A=0 confirm, B=1 cancel, X=2 undo, Y=3 hint, start=9 pause
      if (pressed('confirm', 0) && this.focusTileId != null) this.chooseTile(this.focusTileId);
      if (pressed('cancel', 1)) {
        if (this.state?.selected != null) this.dispatch({ type: 'select', tileId: this.state.selected });
      }
      if (pressed('undo', 2)) this.dispatch({ type: 'undo' });
      if (pressed('hint', 3)) this.dispatch({ type: 'hint' });
      if (pressed('pause', 9)) this.pause();
      // d-pad 12-15
      const axes = pad.axes || [];
      const dz = (v) => Math.abs(v) > 0.6 ? Math.sign(v) : 0;
      const mv = { x: dz(axes[0] || 0), y: dz(axes[1] || 0) };
      const dpad = { x: (pad.buttons[15]?.pressed ? 1 : 0) - (pad.buttons[14]?.pressed ? 1 : 0), y: (pad.buttons[13]?.pressed ? 1 : 0) - (pad.buttons[12]?.pressed ? 1 : 0) };
      const dir = { x: dpad.x || mv.x, y: dpad.y || mv.y };
      const key = `${dir.x},${dir.y}`;
      if ((dir.x || dir.y) && this.gamepadPrev.dirKey !== key) {
        this._moveFocus([dir.x, dir.y]);
      }
      this.gamepadPrev.dirKey = key;
    };
    requestAnimationFrame(step);
  }

  // ----------------------------------------------------- lifecycle --------

  _wireVisibility() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        // backgrounding pauses solo simulation; rendering heartbeat stops in renderer
        if (this.phase === 'active') this.pause('background');
        this.audio.suspend();
      } else {
        this.audio.resume();
      }
    });
    window.addEventListener('beforeunload', () => {
      if (this.state && this.state.status === 'active') {
        store.saveSessionSnapshot(this.content.id, { state: E.serialize(this.state) });
      }
    });
  }
}

function hintJoiner(state) {
  switch (state.ruleset.rule) {
    case 'sum': return '+';
    case 'match': return '=';
    case 'diff': return '↔';
    default: return '+';
  }
}

// ---------------------------------------------------------------------------

const app = new App();
app.boot();
window.__nm = app; // debug/testing handle
