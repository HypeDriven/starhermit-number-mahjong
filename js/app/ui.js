// DOM shell: screens, HUD, settings, overlays, the semantic 2D board mirror,
// live-region announcements, and focus management. UI state is fully separate
// from simulation state.

import { describeRule, describeRuleShort, JOURNEY, LESSONS, CHALLENGES, THEMES, getTheme } from '../rules/content.js';
import { exposedTiles, legalPairs, currentTarget, remainingTiles, score } from '../rules/engine.js';
import { BUILD_VERSION } from '../rules/replay.js';
import { CATEGORIES, PRESETS, resolve, presetTier, describe, detectPreset } from './gfx.js';
import { gfxStrings, fill, shStrings } from './gfx-strings.js';
import { T, N } from '../lang.js';

const $ = (sel) => document.querySelector(sel);

export const ACHIEVEMENTS = [
  { key: 'first-clear', name: N('First Light'), desc: N('Complete your first round.') },
  { key: 'mechanic-master', name: N('Every Instrument'), desc: N('Win a round of each rule type: sum, match, difference.') },
  { key: 'streak-3', name: N('Steady Hand'), desc: N('Win three rounds in a row without a loss.') },
  { key: 'half-journey', name: N('Surveyor'), desc: N('Complete 22 journey stages.') },
  { key: 'full-journey', name: N('Cartographer of Skies'), desc: N('Complete all 44 journey stages.') },
  { key: 'zenith', name: N('Zenith'), desc: N('Complete the final mastery stage.') },
  { key: 'daily-7', name: N('Weekly Watcher'), desc: N('Complete dailies on 7 different days.') },
  { key: 'marathon', name: N('Long Exposure'), desc: N('Remove 1,000 tiles in total across all rounds.') },
];

const DIFFICULTY = { easy: N('Easy'), medium: N('Medium'), hard: N('Hard'), expert: N('Expert') };
/** Display name of a content item (content.js names are English keys). */
export function contentName(c) {
  if (!c) return '';
  if (c.kind === 'daily') return T('Daily — {date}', { date: String(c.id || '').replace(/^daily-/, '') });
  if (c.kind === 'practice') {
    const d = (String(c.id || '').match(/^practice-(\w+)/) || [])[1];
    return T('Practice — {level}', { level: T(DIFFICULTY[d] || c.name) });
  }
  return T(c.name);
}

export class UI {
  constructor(app) {
    this.app = app;
    this.root = $('#screen-root');
    this.focusMemory = null;
    this.board2dFocus = null; // tileId currently focused in 2D board
  }

  // ------------------------------------------------------------- utility --

  announce(msg, assertive = false) {
    const el = assertive ? $('#live-assertive') : $('#live-polite');
    el.textContent = '';
    requestAnimationFrame(() => { el.textContent = msg; });
  }

  toast(msg, isError = false) {
    const stack = $('#toast-stack');
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' error' : '');
    el.textContent = msg;
    stack.appendChild(el);
    if (!isError) this.app.audio.play('toast');
    setTimeout(() => el.remove(), 2600);
    while (stack.children.length > 3) stack.firstChild.remove();
  }

  setScreen(name) {
    this.app.root.dataset.screen = name;
    if (name === 'play') {
      this.root.innerHTML = '';
      $('#btn-pause').focus({ preventScroll: true });
      $('#btn-pause').blur();
    }
  }

  /** Rebuild the open screen in the current language (Settings → Language). */
  relabel() {
    if (document.getElementById('settings-own-top')) { this._renderSettingsBoxes(); return; }
    if (this._last && this.app.root.dataset.screen === this._lastScreen) this._last();
  }
  // Remembers how to rebuild the screen being shown, so relabel() can redraw it.
  _remember(screen, fn) { this._last = fn; this._lastScreen = screen; return fn(); }

  show(html, screenName) {
    if (this._lastScreen !== screenName) this._last = null;
    this.root.innerHTML = `<div class="screen" role="document">${html}</div>`;
    this.setScreen(screenName);
    const first = this.root.querySelector('button, [href], input, select');
    if (first) first.focus({ preventScroll: true });
    // #screen-root is reused for every screen: a new screen opens at its top,
    // not at the previous screen's scroll offset.
    this.root.scrollTop = 0;
  }

  esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  fmtMs(ms) {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // -------------------------------------------------------------- title ---

  showTitle(args) {
    return this._remember('title', () => this._showTitle(args));
  }
  _showTitle({ journeyDone, dailyDone, dailyDate, streak, resumeInfo, profile, account = {} }) {
    const S = shStrings();
    const next = JOURNEY.find(s => !journeyDone[s.id]);
    const e = (k, v) => this.esc(T(k, v));
    this.show(`
      <div class="title-hero">
        <p class="mark">Number Mahjong</p>
        <p class="tag">${e('An observatory of quiet numbers')}</p>
      </div>
      ${resumeInfo ? `<div class="menu-stack"><button data-act="resume" data-content="${this.esc(resumeInfo.contentId)}" style="border-color:var(--accent)">↻ ${e('Resume interrupted round')} <small>${e('{n} tiles left · {time} in', { n: resumeInfo.remaining, time: this.fmtMs(resumeInfo.elapsedMs) })}</small></button></div>` : ''}
      <div class="menu-stack" role="menu">
        ${next ? `<p class="meta title-next">${e('Continue Journey — {name}', { name: T(next.name) })}</p>` : ''}
        <button class="primary" data-act="play" role="menuitem">${e('Play')}</button>
        <button data-act="daily" role="menuitem">${e('Daily Challenge')} <small>${dailyDone ? e('completed today ✓') : this.esc(dailyDate)}</small></button>
        <button data-act="journey" role="menuitem">${e('Journey')} <small>${e('{done} / {total} stages', { done: Object.keys(journeyDone).length, total: JOURNEY.length })}</small></button>
        <button data-act="practice" role="menuitem">${e('Practice')} <small>${e('unranked, undo allowed')}</small></button>
        <button data-act="challenge" role="menuitem">${e('Challenges')} <small>${e('{n} trials', { n: CHALLENGES.length })}</small></button>
        <button data-act="learn" role="menuitem">${e('Learn')} <small>${e('interactive lessons')}</small></button>
        <button data-act="scores" role="menuitem">${e('Score Chase')} <small>${e('leaderboards')}</small></button>
        <button data-act="settings" role="menuitem">${e('Settings')}</button>
        <button data-act="help" role="menuitem">${e('Help & Rules')}</button>
        ${account.signIn ? `<button data-act="sh-sign-in" role="menuitem">${this.esc(S.signIn)} <small>${this.esc(S.signInSub)}</small></button>` : ''}
        ${account.invite ? `<button data-act="sh-invite" role="menuitem">${this.esc(S.invite)} <small>${this.esc(S.inviteSub)}</small></button>` : ''}
      </div>
      <p class="title-status">${profile ? e('Playing as {name}', { name: profile }) + ' · ' : ''}${streak > 1 ? e('Win streak: {n}.', { n: streak }) + ' ' : ''}v${BUILD_VERSION} · ${e('deterministic seeds · offline capable')}</p>
    `, 'title');
  }

  // ------------------------------------------------------------ journey ---

  showJourney(progress) {
    return this._remember('journey', () => this._showJourney(progress));
  }
  _showJourney(progress) {
    const cells = JOURNEY.map(st => {
      const rec = progress.journey[st.id];
      const prevDone = st.index === 1 || progress.journey[JOURNEY[st.index - 2].id];
      const locked = !prevDone;
      const stars = rec ? '★'.repeat(rec.stars) + '☆'.repeat(3 - rec.stars) : '';
      const cls = ['stage-cell', st.mastery ? 'mastery' : '', locked ? 'locked' : '', !rec && !locked ? 'current' : ''].join(' ');
      return `<button class="${cls}" data-stage="${st.id}" ${locked ? 'disabled aria-disabled="true"' : ''}
        aria-label="${this.esc(T('Stage {n}: {name}', { n: st.index, name: T(st.name) }) + (locked ? ' ' + T('(locked)') : rec ? ', ' + T('{stars} stars, best {best}', { stars: rec.stars, best: rec.bestScore }) : ', ' + T('not completed')))}">
        <span>${st.index}</span><span class="stars" aria-hidden="true">${stars}</span>
      </button>`;
    }).join('');
    this.show(`
      <h1>${this.esc(T('Journey'))}</h1>
      <p>${this.esc(T('Forty-four authored stages. One new idea at a time, then combined, then mastered. Mastery stages are bordered in gold.'))}</p>
      <div class="stage-grid">${cells}</div>
      <div class="menu-stack"><button data-act="back">${this.esc(T('Back'))}</button></div>
    `, 'journey');
  }

  // --------------------------------------------------------- mode setup ---

  showModeSetup(content, opts = {}) {
    return this._remember('modesetup', () => this._showModeSetup(content, opts));
  }
  _showModeSetup(content, opts = {}) {
    const rule = describeRule(content.ruleset);
    const e = (k, v) => this.esc(T(k, v));
    const chips = [];
    chips.push(`<span class="badge ${content.ranked ? 'ranked' : ''}">${content.ranked ? e('ranked') : e('unranked')}</span>`);
    if (content.mastery) chips.push(`<span class="badge">${e('mastery')}</span>`);
    if (content.limits?.timeMs) chips.push(`<span class="badge">${e('timed {time}', { time: this.fmtMs(this.app.effectiveTimeLimit(content)) })}</span>`);
    if (content.limits?.moves) chips.push(`<span class="badge">${e('{n} moves max', { n: content.limits.moves })}</span>`);
    const assists = [];
    if (content.tools.hints === Infinity) assists.push(T('unlimited hints'));
    else if (content.tools.hints > 0) assists.push(content.tools.hints > 1 ? T('{n} hints', { n: content.tools.hints }) : T('1 hint'));
    if (content.tools.reshuffles > 0) assists.push(content.tools.reshuffles > 1 ? T('{n} reshuffles', { n: content.tools.reshuffles }) : T('1 reshuffle'));
    if (content.tools.undo) assists.push(T('undo'));
    if (!assists.length) assists.push(T('no assists'));
    const blurb = typeof opts.blurb === 'function' ? opts.blurb() : opts.blurb;
    const extra = typeof opts.extraButtons === 'function' ? opts.extraButtons() : opts.extraButtons;
    this.show(`
      <h1>${this.esc(contentName(content))}</h1>
      <p>${chips.join(' ')}</p>
      <div class="card" style="max-width:520px">
        <h3>${e('Rules')}</h3>
        <p>${this.esc(rule)}</p>
        ${content.ruleset.sideLock ? `<p>${T('Tiles pressed on <strong>both</strong> sides by neighbours are locked until one side opens.')}</p>` : ''}
        ${(content.layers?.max ?? 1) > 1 ? `<p>${e('Tiles may be stacked; only the top tile of each stack is exposed.')}</p>` : ''}
        <p class="meta">${e('Board: {pairs} pairs · par {score} pts · about {time}', { pairs: content.pairs, score: content.par.score, time: this.fmtMs(content.par.timeMs) })}</p>
        <p class="meta">${e('Assists: {list}', { list: assists.join(', ') })}</p>
        ${blurb ? `<p>${this.esc(blurb)}</p>` : ''}
        <p class="meta">${e('Seed')} <code>${this.esc(String(content.seed))}</code> · ${e('content v{n}', { n: content.contentVersion })}</p>
      </div>
      <div class="menu-stack">
        <button class="primary" data-act="begin">${e('Start round')}</button>
        ${extra || ''}
        <button data-act="back">${e('Back')}</button>
      </div>
    `, 'modesetup');
  }

  // ------------------------------------------------------------ practice --

  showPractice() {
    return this._remember('practice', () => this._showPractice());
  }
  _showPractice() {
    const cards = ['easy', 'medium', 'hard', 'expert'].map(d => {
      const desc = {
        easy: N('Five pairs, flat board, sum to 10. No pressure.'),
        medium: N('Eight pairs with light stacking, sum to 12.'),
        hard: N('Eleven pairs, side-locked matches.'),
        expert: N('Fourteen pairs: shifting targets, stacks, side locks.'),
      }[d];
      return `<div class="card"><h3>${this.esc(T(DIFFICULTY[d]))}</h3><p>${this.esc(T(desc))}</p>
        <button data-practice="${d}">${this.esc(T('Start {level}', { level: T(DIFFICULTY[d]) }))}</button></div>`;
    }).join('');
    this.show(`
      <h1>${this.esc(T('Practice'))}</h1>
      <p>${this.esc(T('Unranked. Hints and undo are unlimited; two reshuffles per round. Nothing here affects your rating.'))}</p>
      <div class="card-grid">${cards}</div>
      <div class="menu-stack"><button data-act="back">${this.esc(T('Back'))}</button></div>
    `, 'practice');
  }

  // ----------------------------------------------------------- challenges --

  showChallenges(progress) {
    return this._remember('challenge', () => this._showChallenges(progress));
  }
  _showChallenges(progress) {
    const cards = CHALLENGES.map(c => {
      const best = (progress.challenges || {})[c.id];
      const meta = [T('{n} pairs', { n: c.pairs }), c.limits.timeMs ? this.fmtMs(c.limits.timeMs) : '', c.limits.moves ? T('{n} moves', { n: c.limits.moves }) : '', T('ranked')].filter(Boolean).join(' · ');
      return `<div class="card">
        <h3>${this.esc(T(c.name))}</h3>
        <p>${this.esc(T(c.blurb))}</p>
        <p class="meta">${this.esc(meta)}</p>
        ${best ? `<p class="meta">${this.esc(T('Best: {score} pts in {time}', { score: best.score, time: this.fmtMs(best.elapsedMs) }))}</p>` : ''}
        <button data-challenge="${c.id}">${this.esc(T('Attempt'))}</button>
      </div>`;
    }).join('');
    this.show(`
      <h1>${this.esc(T('Challenges'))}</h1>
      <p>${this.esc(T('Constrained goals with fixed seeds. Everyone faces the same board.'))}</p>
      <div class="card-grid">${cards}</div>
      <div class="menu-stack"><button data-act="back">${this.esc(T('Back'))}</button></div>
    `, 'challenge');
  }

  // --------------------------------------------------------------- learn ---

  showLearn(progress) {
    return this._remember('learn', () => this._showLearn(progress));
  }
  _showLearn(progress) {
    const cards = LESSONS.map((l, i) => {
      const done = progress.lessons[l.id]?.completed;
      const prevDone = i === 0 || progress.lessons[LESSONS[i - 1].id]?.completed;
      return `<div class="card ${prevDone ? '' : 'locked'}">
        <h3>${this.esc(T(l.name))} ${done ? `<span class="badge done">${this.esc(T('done'))}</span>` : ''}</h3>
        <p class="meta">${this.esc(T('{n} steps', { n: l.script.length }))}</p>
        <button data-lesson="${l.id}" ${prevDone ? '' : 'disabled'}>${this.esc(done ? T('Replay') : prevDone ? T('Start') : T('Locked'))}</button>
      </div>`;
    }).join('');
    this.show(`
      <h1>${this.esc(T('Learn'))}</h1>
      <p>${this.esc(T('Short interactive lessons. Each introduces one rule and asks you to perform it. Replay any time.'))}</p>
      <div class="card-grid">${cards}</div>
      <div class="menu-stack"><button data-act="back">${this.esc(T('Back'))}</button></div>
    `, 'learn');
  }

  // ----------------------------------------------------------------- HUD ---

  updateHUD(state, content, timerRemainingMs) {
    const target = currentTarget(state);
    $('#rule-label').textContent = describeRuleShort(state.ruleset, target);
    const dial = $('#target-dial');
    if (state.ruleset.rule === 'sum') {
      dial.textContent = target;
      dial.setAttribute('aria-hidden', 'false');
    } else {
      dial.textContent = '';
    }
    const left = remainingTiles(state) / 2;
    $('#pairs-remaining').textContent = left === 1 ? T('1 pair left') : T('{n} pairs left', { n: left });
    $('#moves-left').textContent = state.limits.moves != null ? T('{n} moves', { n: state.limits.moves - state.movesUsed }) : '';
    const sc = score(state);
    $('#score-value').textContent = sc.total;
    $('#chain-indicator').textContent = state.chain > 1 ? T('chain ×{n}', { n: state.chain }) : '';

    const timerBlock = $('#timer-block');
    if (state.limits.timeMs != null && timerRemainingMs != null) {
      timerBlock.hidden = false;
      const rem = Math.max(0, timerRemainingMs);
      $('#timer-value').textContent = this.fmtMs(rem);
      $('#timer-fill').style.width = `${(rem / state.limits.timeMs) * 100}%`;
      timerBlock.classList.toggle('urgent', rem < 10000);
    } else {
      timerBlock.hidden = true;
    }

    const hintBtn = $('#btn-hint'), shufBtn = $('#btn-reshuffle'), undoBtn = $('#btn-undo');
    hintBtn.hidden = !(state.tools.hints > 0);
    $('#hint-count').textContent = state.tools.hints === Infinity ? '∞' : state.tools.hints;
    shufBtn.hidden = !(state.tools.reshuffles > 0);
    $('#reshuffle-count').textContent = state.tools.reshuffles;
    undoBtn.hidden = !state.tools.undo || state.history.length === 0;
    hintBtn.disabled = shufBtn.disabled = undoBtn.disabled = state.status !== 'active';
  }

  // ------------------------------------------------- semantic 2D board ----

  renderBoard2D(state) {
    const host = $('#board2d');
    const exposed = new Set(exposedTiles(state));
    const cells = state.layout.cells;
    const maxY = Math.max(...cells.map(c => c.y));
    const rows = [];
    for (let y = 0; y <= maxY; y++) {
      const rowCells = [];
      for (let x = 0; x <= Math.max(...cells.map(c => c.x)); x++) {
        const si = cells.findIndex(c => c.x === x && c.y === y);
        if (si < 0) continue;
        rowCells.push(si);
      }
      if (rowCells.length) rows.push(rowCells);
    }
    host.innerHTML = rows.map(rowCells => {
      const cellHtml = rowCells.map(si => {
        const col = state.stacks[si];
        if (!col.length) return `<span class="cell" role="presentation"></span>`;
        // top tile last in DOM? column-reverse: render bottom first
        const tiles = col.map(id => {
          const t = state.tiles[id];
          const isTop = col[col.length - 1] === id;
          const free = exposed.has(id);
          const sel = state.selected === id;
          const hint = state.hintedPair && state.hintedPair.includes(id);
          const locked = isTop && !free;
          const pos = { row: cells[si].y + 1, col: cells[si].x + 1 };
          const label = this.esc(free
            ? [T('tile {v}, row {row} column {col}', { v: t.value, ...pos }), isTop ? T('top of stack') : '', state.ruleset.sideLock ? T('free') : ''].filter(Boolean).join(', ')
            : T('covered tile, row {row} column {col}', pos));
          const cls = ['tile-btn', free ? '' : 'covered', locked ? 'locked' : '', sel ? 'selected' : '', hint ? 'hinted' : ''].join(' ');
          return `<button class="${cls}" data-tile="${id}" role="gridcell" aria-label="${label}" ${free ? '' : 'disabled'} tabindex="${free ? '0' : '-1'}">${isTop || free ? t.value : '·'}</button>`;
        }).join('');
        return `<span class="cell" role="presentation">${tiles}</span>`;
      }).join('');
      return `<div class="row" role="row">${cellHtml}</div>`;
    }).join('');
  }

  boardSummary(state) {
    const exposed = exposedTiles(state);
    const vals = exposed.map(id => state.tiles[id].value).join(', ');
    const target = currentTarget(state);
    const rule = describeRuleShort(state.ruleset, target);
    return T('{rule}. {n} tiles exposed with values: {values}. {left} tiles remain.', { rule, n: exposed.length, values: vals, left: remainingTiles(state) });
  }

  // -------------------------------------------------------------- results --

  showResults(args) {
    return this._remember('results', () => this._showResults(args));
  }
  // args.leaderboard may be a thunk so the line follows a language change.
  _showResults({ state, content, breakdown, stars, newAchievements, boardPlacement, par, leaderboard = null }) {
    const won = state.status === 'won';
    const e = (k, v) => this.esc(T(k, v));
    const reasons = { 'no-moves': N('No Moves Remain'), 'out-of-moves': N('Out of Moves'), 'time-up': N('Time Is Up'), 'abandoned': N('Round Left') };
    const headline = won ? T('Board Cleared') : T(reasons[state.reason] || N('Round Over'));
    const rows = [
      [T('Pairs removed'), breakdown.pairs],
      [T('Speed bonus'), breakdown.speed],
      [T('Chain bonus'), breakdown.chain],
      [T('Clear bonus'), breakdown.clear],
      [T('Time bonus'), breakdown.time],
    ].map(([k, v]) => `<tr><td>${this.esc(k)}</td><td>${v}</td></tr>`).join('');
    const achHtml = newAchievements.length
      ? `<h2>${e('Achievements')}</h2><div class="card-grid">${newAchievements.map(a => `<div class="card"><h3>🏅 ${this.esc(T(a.name))}</h3><p>${this.esc(T(a.desc))}</p></div>`).join('')}</div>` : '';
    const lb = typeof leaderboard === 'function' ? leaderboard() : leaderboard;
    const reasonWord = { 'no-moves': N('no moves'), 'out-of-moves': N('out of moves'), 'time-up': N('time up'), 'abandoned': N('abandoned') };
    this.show(`
      <div class="results-art" aria-hidden="true"></div>
      <h1>${this.esc(headline)}</h1>
      <p>${this.esc([contentName(content), won ? T('completed in {time}', { time: this.fmtMs(state.elapsedMs) }) : T('reason: {reason}', { reason: reasonWord[state.reason] ? T(reasonWord[state.reason]) : state.reason }), state.invalidCount === 1 ? T('1 invalid attempt') : T('{n} invalid attempts', { n: state.invalidCount })].join(' · '))}</p>
      ${stars != null && won ? `<p aria-label="${e('{n} of 3 stars', { n: stars })}" style="font-size:1.6rem;color:var(--accent)">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</p>` : ''}
      <table class="score-table" aria-label="${e('Score breakdown')}">
        ${rows}
        <tr class="total"><td>${e('Total')}</td><td>${breakdown.total}</td></tr>
      </table>
      <p class="meta">${e('Par: {score} pts in {time}', { score: par.score, time: this.fmtMs(par.timeMs) })}<span id="board-note">${boardPlacement != null && boardPlacement >= 0 ? ' · ' + e('placed #{n} on the local board', { n: boardPlacement + 1 }) : ''}</span></p>
      ${lb ? `<p class="meta" id="results-lb" aria-live="polite">${this.esc(lb)}</p>` : ''}
      ${achHtml}
      <div class="menu-stack">
        ${won && opts_next(content) ? `<button class="primary" data-act="next">${this.esc(nextLabel(content))}</button>` : ''}
        <button class="${won && opts_next(content) ? '' : 'primary'}" data-act="retry">${won ? e('Replay this board') : e('Try again')}</button>
        <button data-act="scores">${e('Leaderboards')}</button>
        <button data-act="back">${e('Back to title')}</button>
      </div>
    `, 'results');
  }

  // ------------------------------------------------------------ settings ---

  // The Settings screen is built once per open; its own parts live in boxes
  // (#settings-own-top, #gfx-own, #settings-own-rest) that a language change
  // redraws in place. The shared Language / Sound / Report sections
  // (game-options.js) mount after #gfx-own inside #gfx-section
  // (data-options-graphics) and are never redrawn by the game.
  showSettings(s) {
    this._settingsArgs = s;
    this._last = null; this._lastScreen = 'settings';
    this.show(`
      <div id="settings-own-top"></div>
      <div id="gfx-section" data-options-graphics><div class="settings-grid" id="gfx-own"></div></div>
      <div id="settings-own-rest"></div>
    `, 'settings');
    this._renderSettingsBoxes();
    const first = this.root.querySelector('button, [href], input, select');
    if (first) first.focus({ preventScroll: true });
  }
  _renderSettingsBoxes() {
    const s = this._settingsArgs;
    const top = $('#settings-own-top');
    if (!s || !top) return;
    const k = (a) => this.app.keyText(a);
    const e = (key, v) => this.esc(T(key, v));
    const row = (label, control) => `<div class="setting-row"><label>${this.esc(label)}</label>${control}</div>`;
    const slider = (key, val, label) => `<input type="range" min="0" max="1" step="0.05" value="${val}" data-set="${key}" aria-label="${this.esc(label)}">`;
    const check = (key, val, label) => `<input type="checkbox" ${val ? 'checked' : ''} data-set="${key}" aria-label="${this.esc(label)}">`;
    const CAMERA = { default: N('default'), top: N('top'), low: N('low') };
    const PALETTE = { standard: N('standard'), deuteranopia: N('deuteranopia'), protanopia: N('protanopia'), tritanopia: N('tritanopia') };
    const ACTIONS = { confirm: N('confirm'), cancel: N('cancel'), pause: N('pause'), hint: N('hint'), undo: N('undo') };
    top.innerHTML = `
      <h1>${e('Settings')}</h1>
      <h2>${e('Audio')}</h2>
      <div class="settings-grid">
        ${row(T('Music'), slider('music', s.music, T('Music')))}
        ${row(T('Effects'), slider('effects', s.effects, T('Effects')))}
        ${row(T('Ambience'), slider('ambience', s.ambience, T('Ambience')))}
        ${row(T('Mute all'), check('muted', s.muted, T('Mute all audio')))}
        ${row(T('Sound captions (text cues for meaningful audio)'), check('soundCaptions', s.soundCaptions, T('Sound captions')))}
      </div>
      <h2>${e('Graphics')}</h2>`;
    $('#gfx-own').innerHTML = this.gfxSectionHtml(s.gfx, this.app.graphicsInfo());
    $('#settings-own-rest').innerHTML = `
      <div class="settings-grid">
        ${row(T('Reduced motion'), check('reducedMotion', s.reducedMotion, T('Reduced motion')))}
        ${row(T('Board view'), `<select data-set="camera" aria-label="${e('Camera view')}">
          ${['default', 'top', 'low'].map(t => `<option value="${t}" ${s.camera === t ? 'selected' : ''}>${e(CAMERA[t])}</option>`).join('')}</select>`)}
        ${row(T('Use 2D board instead of 3D'), check('board2d', s.board2d, T('Use 2D board')))}
        ${row(T('Cosmetic theme'), `<select data-set="themeOverride" aria-label="${e('Cosmetic theme')}">
          <option value="" ${!s.themeOverride ? 'selected' : ''}>${e('follow the round')}</option>
          ${Object.entries(THEMES).map(([key, v]) => `<option value="${key}" ${s.themeOverride === key ? 'selected' : ''}>${this.esc(T(v.label))}</option>`).join('')}</select>`)}
      </div>
      <h2>${e('Accessibility')}</h2>
      <div class="settings-grid">
        ${row(T('Larger text'), check('largeText', s.largeText, T('Larger text')))}
        ${row(T('High contrast'), check('highContrast', s.highContrast, T('High contrast')))}
        ${row(T('Colour-vision palette'), `<select data-set="palette" aria-label="${e('Colour-vision palette')}">
          ${['standard', 'deuteranopia', 'protanopia', 'tritanopia'].map(t => `<option value="${t}" ${s.palette === t ? 'selected' : ''}>${e(PALETTE[t])}</option>`).join('')}</select>`)}
        ${row(T('Left-handed controls'), check('leftHanded', s.leftHanded, T('Left-handed controls')))}
        ${row(T('Timing assistance (+50% round timers)'), check('timingAssist', s.timingAssist, T('Timing assistance')))}
        ${row(T('Replay tutorials'), `<button data-act="reset-tutorials">${e('Reset')}</button>`)}
      </div>
      <h2>${e('Controls')}</h2>
      <p class="meta">${e('Keyboard: {move} or Tab move focus · {choose} select · {back} pause/cancel · {pause} pause · {hint} hint · {reshuffle} reshuffle · {undo} undo · {camera} camera. Gamepad: d-pad/stick move · A select · B cancel · Start pause · Y hint · X undo.', {
        move: [k('left'), k('right'), k('up'), k('down')].join(' '), choose: k('choose'), back: k('back'), pause: k('pause'), hint: k('hint'), reshuffle: k('reshuffle'), undo: k('undo'), camera: k('camera'),
      })}</p>
      <div class="settings-grid" id="gamepad-remap">
        ${['confirm', 'cancel', 'pause', 'hint', 'undo'].map(a => row(T('Gamepad: {action}', { action: T(ACTIONS[a]) }), `<button data-remap="${a}">${this.esc((s.bindings || {})[a] || T('default'))}</button>`)).join('')}
      </div>
      <h2>${e('Data')}</h2>
      <div class="settings-grid">
        ${row(T('Erase all local progress and settings'), `<button class="danger" data-act="erase-all">${e('Erase')}</button>`)}
      </div>
      <div class="menu-stack"><button data-act="back">${e('Back')}</button></div>`;
  }

  // Graphics section: quality preset, render scale, per-effect overrides,
  // adaptive resolution, frame-rate readout, and a cost summary.
  gfxSectionHtml(saved, info) {
    const T = gfxStrings();
    const g = saved || {};
    const detected = info?.detected || detectPreset('');
    const r = info?.resolved || resolve(g, detected);
    const tierName = (p) => T.presets[p] || p;
    const opt = (v, label, sel) => `<option value="${v}" ${sel ? 'selected' : ''}>${this.esc(label)}</option>`;
    const row = (id, label, control) => `<div class="setting-row"><label for="${id}">${this.esc(label)}</label>${control}</div>`;
    const presetSel = PRESETS.includes(g.preset) ? g.preset : 'auto';
    const pct = Math.round(r.renderScale * 100);
    const cats = Object.entries(CATEGORIES).map(([cat, tiers]) => {
      const own = CATEGORIES[cat].includes(g[cat]) ? g[cat] : 'preset';
      return row(`gfx-cat-${cat}`, T.cats[cat], `<select id="gfx-cat-${cat}" data-gfx="${cat}">
        ${opt('preset', fill(T.fromPreset, { tier: T.tiers[presetTier(r.preset, cat)] || presetTier(r.preset, cat) }), own === 'preset')}
        ${tiers.map(t => opt(t, T.tiers[t] || t, own === t)).join('')}</select>`);
    }).join('');
    return `
      ${row('gfx-preset', T.quality, `<select id="gfx-preset" data-gfx="preset">
        ${opt('auto', fill(T.auto, { tier: tierName(detected) }), presetSel === 'auto')}
        ${PRESETS.map(p => opt(p, tierName(p), presetSel === p)).join('')}</select>`)}
      ${row('gfx-render-scale', T.renderScale, `<span class="gfx-range"><input type="range" id="gfx-render-scale" data-gfx="render_scale" min="50" max="200" step="5" value="${pct}"><output id="gfx-render-scale-value" for="gfx-render-scale">${pct}%</output></span>`)}
      ${cats}
      ${row('gfx-adaptive', T.adaptive, `<input type="checkbox" id="gfx-adaptive" data-gfx="adaptive" ${r.adaptive ? 'checked' : ''}>`)}
      ${row('gfx-show-fps', T.showFps, `<input type="checkbox" id="gfx-show-fps" data-gfx="show_fps" ${r.showFps ? 'checked' : ''}>`)}
      <p class="meta gfx-summary" id="gfx-summary" data-preset="${r.preset}">${this.esc(this.gfxSummary(r, info))}</p>
      <p class="meta gfx-note" id="gfx-post-note" ${info?.postFailed ? '' : 'hidden'}>${this.esc(T.postUnavailable)}</p>
      <p class="meta gfx-note" id="gfx-off3d-note" ${info ? 'hidden' : ''}>${this.esc(T.off3d)}</p>`;
  }

  gfxSummary(r, info) {
    const T = gfxStrings();
    return [info?.gpu || T.unknownGpu, info?.level != null ? T.level.replace('{n}', info.level) : null,
      describe(r, info?.pixels, T.sum)].filter(Boolean).join(' · ');
  }

  // Re-render the Graphics section in place, keeping keyboard focus on the same control.
  refreshGfx(saved, info) {
    const sec = $('#gfx-own');
    if (!sec) return;
    const focusId = document.activeElement?.id;
    sec.innerHTML = this.gfxSectionHtml(saved, info);
    if (focusId && sec.querySelector('#' + focusId)) $('#' + focusId).focus({ preventScroll: true });
  }

  updateGfxSummary(saved, info) {
    const r = info?.resolved || resolve(saved, info?.detected || detectPreset(''));
    const out = $('#gfx-render-scale-value');
    if (out) out.textContent = `${Math.round(r.renderScale * 100)}%`;
    const sum = $('#gfx-summary');
    if (sum) sum.textContent = this.gfxSummary(r, info);
  }

  // ---------------------------------------------------------------- help ---

  showHelp(bindings) {
    return this._remember('help', () => this._showHelp(bindings));
  }
  _showHelp(bindings) {
    const k = (a) => this.app.keyText(a);
    const card = (title, html) => `<div class="card"><h3>${this.esc(title)}</h3><p>${html}</p></div>`;
    this.show(`
      <h1>${this.esc(T('Help & Rules'))}</h1>
      <div class="card-grid">
        ${card('⌖ ' + T('Goal'), T('Clear the board by removing pairs of <strong>exposed</strong> tiles. The round’s rule is always shown at the top: a sum target, matching twins, or an exact difference.'))}
        ${card('▤ ' + T('Exposure'), T('Only the top tile of each stack can be played. In side-locked rounds, a tile is also locked while neighbours press on <em>both</em> its sides — one open side is enough.'))}
        ${card('✦ ' + T('Scoring'), this.esc(T('Each pair scores 100. Removing pairs quickly adds up to 50 speed bonus. Unbroken chains of pairs (no hints, no misses) add up to 150 per pair. Clearing the board adds 500, plus a time bonus in timed rounds. Exploring never costs points.')))}
        ${card('⚑ ' + T('Stuck?'), this.esc(T('If no legal pair exists and no reshuffles remain, the round ends. Hints (H) reveal one legal pair. Reshuffles (R) redeal the remaining tiles solvably. Practice and Journey allow undo (U).')))}
        ${card('⌨ ' + T('Controls'), this.esc(T('Pointer or touch: tap a tile, tap its partner. Keyboard: {move} move, {choose} selects, {back} cancels or pauses. Gamepad: d-pad moves, {confirm} confirms, {cancel} cancels, Start pauses. {hint} hints, {reshuffle} reshuffles, {undo} undoes, {camera} resets the camera.', {
          move: [k('left'), k('right'), k('up'), k('down')].join(' '), choose: k('choose'), back: k('back'), confirm: bindings.confirm || 'A', cancel: bindings.cancel || 'B',
          hint: k('hint'), reshuffle: k('reshuffle'), undo: k('undo'), camera: k('camera'),
        })))}
        ${card('⚖ ' + T('Fair play'), this.esc(T('Every board is generated from a visible seed and proven solvable offline. Ranked rounds disallow undo and are submitted with a replay log for validation.')))}
      </div>
      <div class="menu-stack"><button data-act="back">${this.esc(T('Back'))}</button></div>
    `, 'help');
  }

  // --------------------------------------------------------- leaderboards --

  showScores(args) {
    return this._remember('scores', () => this._showScores(args));
  }
  _showScores({ boards, progress, online = null, profile = null }) {
    const e = (k, v) => this.esc(T(k, v));
    const prof = typeof profile === 'function' ? profile() : profile;
    const section = (title, entries, note) => `
      <h2>${this.esc(title)}</h2>
      ${entries.length ? `<table class="score-table"><tr><th>#</th><th>${e('Score')}</th><th>${e('Time')}</th><th>${e('Invalid')}</th><th>${e('When')}</th></tr>${
        entries.slice(0, 10).map((x, i) => `<tr><td>${i + 1}</td><td>${x.score}</td><td>${this.fmtMs(x.elapsedMs)}</td><td>${x.invalidCount}</td><td>${new Date(x.at).toLocaleDateString(document.documentElement.lang || undefined)}</td></tr>`).join('')
      }</table>` : `<p class="meta">${this.esc(note || T('No entries yet — be the first.'))}</p>`}`;
    const onlineSection = online && online.entries.length ? `
      <h2>${e('Online board')}</h2>
      <table class="score-table"><tr><th>#</th><th>${e('Player')}</th><th>${e('Score')}</th></tr>${
        online.entries.map((x, i) => `<tr><td>${i + 1}</td><td>${this.esc(x.nickname)}${x.me ? ' ' + e('(you)') : ''}</td><td>${x.score}</td></tr>`).join('')
      }</table>` : '';
    this.show(`
      <h1>${e('Score Chase')}</h1>
      <p>${e('Asynchronous comparison on validated seeds. Ranked submissions carry a replay log; unverifiable boards are marked casual.')}</p>
      ${onlineSection}
      ${section(T('Today’s daily'), boards.daily, T('Play today’s daily to appear here.'))}
      ${section(T('Journey total'), boards.journey)}
      ${section(T('Zenith Protocol (challenge)'), boards.zenith)}
      <h2>${e('Profile')}</h2>
      <p class="meta">${prof ? `${this.esc(prof)} · ` : ''}${e('{plays} rounds played · {wins} wins · {pairs} pairs removed · mastery {xp} XP', { plays: progress.totals.plays, wins: progress.totals.wins, pairs: progress.totals.pairs, xp: progress.masteryXp })}</p>
      <div class="menu-stack"><button data-act="back">${e('Back')}</button></div>
    `, 'scores');
  }

  // ---------------------------------------------------------------- pause ---

  setPaused(visible) {
    const ov = $('#overlay-pause');
    if (visible) {
      this.focusMemory = document.activeElement;
      ov.hidden = false;
      $('#btn-resume').focus();
    } else {
      ov.hidden = true;
      if (this.focusMemory) { this.focusMemory.focus({ preventScroll: true }); this.focusMemory = null; }
    }
  }

  showLessonBanner(text, isLast) {
    this._lesson = { text, isLast };
    $('#lesson-text').textContent = T(text);
    $('#lesson-next').textContent = isLast ? T('Finish') : T('Got it');
    $('#lesson-banner').hidden = false;
  }
  relabelLessonBanner() { if (this._lesson && !$('#lesson-banner').hidden) this.showLessonBanner(this._lesson.text, this._lesson.isLast); }
  hideLessonBanner() { $('#lesson-banner').hidden = true; }

  countdown(text) {
    const el = $('#countdown-overlay');
    if (text == null) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = text;
  }

  applyA11ySettings(s) {
    const root = this.app.root;
    root.dataset.largeText = s.largeText ? '1' : '0';
    root.dataset.contrast = s.highContrast ? '1' : '0';
    root.dataset.motion = s.reducedMotion ? 'reduced' : 'full';
    root.dataset.palette = s.palette;
    root.dataset.board2d = s.board2d ? '1' : '0';
    $('#hud-actions').classList.toggle('left-handed', s.leftHanded);
  }

  applyTheme(themeId, overrideId) {
    const theme = getTheme(overrideId || themeId);
    const root = this.app.root;
    for (const [k, v] of Object.entries(theme.css)) {
      root.style.setProperty('--' + (k === 'ink' ? 'ink' : k), v);
    }
    root.style.setProperty('--tile', theme.tile);
    root.style.setProperty('--tile-ink', theme.ink);
    return theme;
  }

  compat3DUnavailable() {
    $('#compat-message').hidden = false;
    this.app.root.dataset.board2d = '1';
  }
}

function opts_next(content) {
  return content.kind === 'journey' && content.index < JOURNEY.length;
}
function nextLabel(content) {
  return T('Next: {name}', { name: T(JOURNEY[content.index].name) });
}
