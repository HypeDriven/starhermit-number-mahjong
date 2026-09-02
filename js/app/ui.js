// DOM shell: screens, HUD, settings, overlays, the semantic 2D board mirror,
// live-region announcements, and focus management. UI state is fully separate
// from simulation state.

import { describeRule, describeRuleShort, JOURNEY, LESSONS, CHALLENGES, THEMES, getTheme } from '../rules/content.js';
import { exposedTiles, legalPairs, currentTarget, remainingTiles, score } from '../rules/engine.js';
import { BUILD_VERSION } from '../rules/replay.js';

const $ = (sel) => document.querySelector(sel);

export const ACHIEVEMENTS = [
  { key: 'first-clear', name: 'First Light', desc: 'Complete your first round.' },
  { key: 'mechanic-master', name: 'Every Instrument', desc: 'Win a round of each rule type: sum, match, difference.' },
  { key: 'streak-3', name: 'Steady Hand', desc: 'Win three rounds in a row without a loss.' },
  { key: 'half-journey', name: 'Surveyor', desc: 'Complete 22 journey stages.' },
  { key: 'full-journey', name: 'Cartographer of Skies', desc: 'Complete all 44 journey stages.' },
  { key: 'zenith', name: 'Zenith', desc: 'Complete the final mastery stage.' },
  { key: 'daily-7', name: 'Weekly Watcher', desc: 'Complete dailies on 7 different days.' },
  { key: 'marathon', name: 'Long Exposure', desc: 'Remove 1,000 tiles in total across all rounds.' },
];

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

  show(html, screenName) {
    this.root.innerHTML = `<div class="screen" role="document">${html}</div>`;
    this.setScreen(screenName);
    const first = this.root.querySelector('button, [href], input, select');
    if (first) first.focus({ preventScroll: true });
  }

  esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  fmtMs(ms) {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // -------------------------------------------------------------- title ---

  showTitle({ journeyDone, dailyDone, dailyDate, streak, resumeInfo }) {
    const next = JOURNEY.find(s => !journeyDone[s.id]);
    this.show(`
      <div class="title-hero">
        <p class="mark">Number Mahjong</p>
        <p class="tag">An observatory of quiet numbers</p>
      </div>
      ${resumeInfo ? `<div class="menu-stack"><button data-act="resume" data-content="${this.esc(resumeInfo.contentId)}" style="border-color:var(--accent)">↻ Resume interrupted round <small>${resumeInfo.remaining} tiles left · ${this.fmtMs(resumeInfo.elapsedMs)} in</small></button></div>` : ''}
      <div class="menu-stack" role="menu">
        ${next ? `<p class="meta title-next">Continue Journey — ${this.esc(next.name)}</p>` : ''}
        <button class="primary" data-act="play" role="menuitem">Play</button>
        <button data-act="daily" role="menuitem">Daily Challenge <small>${dailyDone ? 'completed today ✓' : this.esc(dailyDate)}</small></button>
        <button data-act="journey" role="menuitem">Journey <small>${Object.keys(journeyDone).length} / ${JOURNEY.length} stages</small></button>
        <button data-act="practice" role="menuitem">Practice <small>unranked, undo allowed</small></button>
        <button data-act="challenge" role="menuitem">Challenges <small>${CHALLENGES.length} trials</small></button>
        <button data-act="learn" role="menuitem">Learn <small>interactive lessons</small></button>
        <button data-act="scores" role="menuitem">Score Chase <small>leaderboards</small></button>
        <button data-act="settings" role="menuitem">Settings</button>
        <button data-act="help" role="menuitem">Help &amp; Rules</button>
      </div>
      <p class="title-status">${streak > 1 ? `Win streak: ${streak}. ` : ''}v${BUILD_VERSION} · deterministic seeds · offline capable</p>
    `, 'title');
  }

  // ------------------------------------------------------------ journey ---

  showJourney(progress) {
    const cells = JOURNEY.map(st => {
      const rec = progress.journey[st.id];
      const prevDone = st.index === 1 || progress.journey[JOURNEY[st.index - 2].id];
      const locked = !prevDone;
      const stars = rec ? '★'.repeat(rec.stars) + '☆'.repeat(3 - rec.stars) : '';
      const cls = ['stage-cell', st.mastery ? 'mastery' : '', locked ? 'locked' : '', !rec && !locked ? 'current' : ''].join(' ');
      return `<button class="${cls}" data-stage="${st.id}" ${locked ? 'disabled aria-disabled="true"' : ''}
        aria-label="Stage ${st.index}: ${this.esc(st.name)}${locked ? ' (locked)' : rec ? `, ${rec.stars} stars, best ${rec.bestScore}` : ', not completed'}">
        <span>${st.index}</span><span class="stars" aria-hidden="true">${stars}</span>
      </button>`;
    }).join('');
    this.show(`
      <h1>Journey</h1>
      <p>Forty-four authored stages. One new idea at a time, then combined, then mastered. Mastery stages are bordered in gold.</p>
      <div class="stage-grid">${cells}</div>
      <div class="menu-stack"><button data-act="back">Back</button></div>
    `, 'journey');
  }

  // --------------------------------------------------------- mode setup ---

  showModeSetup(content, opts = {}) {
    const rule = describeRule(content.ruleset);
    const chips = [];
    chips.push(`<span class="badge ${content.ranked ? 'ranked' : ''}">${content.ranked ? 'ranked' : 'unranked'}</span>`);
    if (content.mastery) chips.push(`<span class="badge">mastery</span>`);
    if (content.limits?.timeMs) chips.push(`<span class="badge">timed ${this.fmtMs(this.app.effectiveTimeLimit(content))}</span>`);
    if (content.limits?.moves) chips.push(`<span class="badge">${content.limits.moves} moves max</span>`);
    const assists = [];
    if (content.tools.hints === Infinity) assists.push('unlimited hints');
    else if (content.tools.hints > 0) assists.push(`${content.tools.hints} hint${content.tools.hints > 1 ? 's' : ''}`);
    if (content.tools.reshuffles > 0) assists.push(`${content.tools.reshuffles} reshuffle${content.tools.reshuffles > 1 ? 's' : ''}`);
    if (content.tools.undo) assists.push('undo');
    if (!assists.length) assists.push('no assists');
    this.show(`
      <h1>${this.esc(content.name)}</h1>
      <p>${chips.join(' ')}</p>
      <div class="card" style="max-width:520px">
        <h3>Rules</h3>
        <p>${this.esc(rule)}</p>
        ${content.ruleset.sideLock ? '<p>Tiles pressed on <strong>both</strong> sides by neighbours are locked until one side opens.</p>' : ''}
        ${(content.layers?.max ?? 1) > 1 ? '<p>Tiles may be stacked; only the top tile of each stack is exposed.</p>' : ''}
        <p class="meta">Board: ${content.pairs} pairs · par ${content.par.score} pts · about ${this.fmtMs(content.par.timeMs)}</p>
        <p class="meta">Assists: ${assists.join(', ')}</p>
        ${opts.blurb ? `<p>${this.esc(opts.blurb)}</p>` : ''}
        <p class="meta">Seed <code>${this.esc(String(content.seed))}</code> · content v${content.contentVersion}</p>
      </div>
      <div class="menu-stack">
        <button class="primary" data-act="begin">Start round</button>
        ${opts.extraButtons || ''}
        <button data-act="back">Back</button>
      </div>
    `, 'modesetup');
  }

  // ------------------------------------------------------------ practice --

  showPractice() {
    const cards = ['easy', 'medium', 'hard', 'expert'].map(d => {
      const desc = {
        easy: 'Five pairs, flat board, sum to 10. No pressure.',
        medium: 'Eight pairs with light stacking, sum to 12.',
        hard: 'Eleven pairs, side-locked matches.',
        expert: 'Fourteen pairs: shifting targets, stacks, side locks.',
      }[d];
      return `<div class="card"><h3>${d[0].toUpperCase() + d.slice(1)}</h3><p>${desc}</p>
        <button data-practice="${d}">Start ${d}</button></div>`;
    }).join('');
    this.show(`
      <h1>Practice</h1>
      <p>Unranked. Hints and undo are unlimited; two reshuffles per round. Nothing here affects your rating.</p>
      <div class="card-grid">${cards}</div>
      <div class="menu-stack"><button data-act="back">Back</button></div>
    `, 'practice');
  }

  // ----------------------------------------------------------- challenges --

  showChallenges(progress) {
    const cards = CHALLENGES.map(c => {
      const best = (progress.challenges || {})[c.id];
      return `<div class="card">
        <h3>${this.esc(c.name)}</h3>
        <p>${this.esc(c.blurb)}</p>
        <p class="meta">${c.pairs} pairs${c.limits.timeMs ? ` · ${this.fmtMs(c.limits.timeMs)}` : ''}${c.limits.moves ? ` · ${c.limits.moves} moves` : ''} · ranked</p>
        ${best ? `<p class="meta">Best: ${best.score} pts in ${this.fmtMs(best.elapsedMs)}</p>` : ''}
        <button data-challenge="${c.id}">Attempt</button>
      </div>`;
    }).join('');
    this.show(`
      <h1>Challenges</h1>
      <p>Constrained goals with fixed seeds. Everyone faces the same board.</p>
      <div class="card-grid">${cards}</div>
      <div class="menu-stack"><button data-act="back">Back</button></div>
    `, 'challenge');
  }

  // --------------------------------------------------------------- learn ---

  showLearn(progress) {
    const cards = LESSONS.map((l, i) => {
      const done = progress.lessons[l.id]?.completed;
      const prevDone = i === 0 || progress.lessons[LESSONS[i - 1].id]?.completed;
      return `<div class="card ${prevDone ? '' : 'locked'}">
        <h3>${this.esc(l.name)} ${done ? '<span class="badge done">done</span>' : ''}</h3>
        <p class="meta">${l.script.length} steps</p>
        <button data-lesson="${l.id}" ${prevDone ? '' : 'disabled'}>${done ? 'Replay' : prevDone ? 'Start' : 'Locked'}</button>
      </div>`;
    }).join('');
    this.show(`
      <h1>Learn</h1>
      <p>Short interactive lessons. Each introduces one rule and asks you to perform it. Replay any time.</p>
      <div class="card-grid">${cards}</div>
      <div class="menu-stack"><button data-act="back">Back</button></div>
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
    $('#pairs-remaining').textContent = `${left} pair${left === 1 ? '' : 's'} left`;
    $('#moves-left').textContent = state.limits.moves != null ? `${state.limits.moves - state.movesUsed} moves` : '';
    const sc = score(state);
    $('#score-value').textContent = sc.total;
    $('#chain-indicator').textContent = state.chain > 1 ? `chain ×${state.chain}` : '';

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
          const label = free
            ? `tile ${t.value}, row ${cells[si].y + 1} column ${cells[si].x + 1}${isTop ? ', top of stack' : ''}${state.ruleset.sideLock ? ', free' : ''}`
            : `covered tile, row ${cells[si].y + 1} column ${cells[si].x + 1}`;
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
    return `${rule}. ${exposed.length} tiles exposed with values: ${vals}. ${remainingTiles(state)} tiles remain.`;
  }

  // -------------------------------------------------------------- results --

  showResults({ state, content, breakdown, stars, newAchievements, boardPlacement, par }) {
    const won = state.status === 'won';
    const headline = won ? 'Board Cleared' : ({ 'no-moves': 'No Moves Remain', 'out-of-moves': 'Out of Moves', 'time-up': 'Time Is Up', 'abandoned': 'Round Left' })[state.reason] || 'Round Over';
    const rows = [
      ['Pairs removed', breakdown.pairs],
      ['Speed bonus', breakdown.speed],
      ['Chain bonus', breakdown.chain],
      ['Clear bonus', breakdown.clear],
      ['Time bonus', breakdown.time],
    ].filter(([, v]) => v > 0 || true).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
    const achHtml = newAchievements.length
      ? `<h2>Achievements</h2><div class="card-grid">${newAchievements.map(a => `<div class="card"><h3>🏅 ${this.esc(a.name)}</h3><p>${this.esc(a.desc)}</p></div>`).join('')}</div>` : '';
    this.show(`
      <h1>${headline}</h1>
      <p>${this.esc(content.name)} · ${won ? `completed in ${this.fmtMs(state.elapsedMs)}` : `reason: ${state.reason}`} · ${state.invalidCount} invalid attempt${state.invalidCount === 1 ? '' : 's'}</p>
      ${stars != null && won ? `<p aria-label="${stars} of 3 stars" style="font-size:1.6rem;color:var(--accent)">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</p>` : ''}
      <table class="score-table" aria-label="Score breakdown">
        ${rows}
        <tr class="total"><td>Total</td><td>${breakdown.total}</td></tr>
      </table>
      <p class="meta">Par: ${par.score} pts in ${this.fmtMs(par.timeMs)}${boardPlacement != null && boardPlacement >= 0 ? ` · placed #${boardPlacement + 1} on the local board` : ''}</p>
      ${achHtml}
      <div class="menu-stack">
        ${won && opts_next(content) ? `<button class="primary" data-act="next">${this.esc(nextLabel(content))}</button>` : ''}
        <button class="${won && opts_next(content) ? '' : 'primary'}" data-act="retry">${won ? 'Replay this board' : 'Try again'}</button>
        <button data-act="scores">Leaderboards</button>
        <button data-act="back">Back to title</button>
      </div>
    `, 'results');
  }

  // ------------------------------------------------------------ settings ---

  showSettings(s) {
    const row = (label, control) => `<div class="setting-row"><label>${label}</label>${control}</div>`;
    const slider = (key, val) => `<input type="range" min="0" max="1" step="0.05" value="${val}" data-set="${key}" aria-label="${key}">`;
    const check = (key, val, label) => `<input type="checkbox" ${val ? 'checked' : ''} data-set="${key}" aria-label="${label || key}">`;
    this.show(`
      <h1>Settings</h1>
      <h2>Audio</h2>
      <div class="settings-grid">
        ${row('Music', slider('music', s.music))}
        ${row('Effects', slider('effects', s.effects))}
        ${row('Ambience', slider('ambience', s.ambience))}
        ${row('Mute all', check('muted', s.muted, 'Mute all audio'))}
        ${row('Sound captions (text cues for meaningful audio)', check('soundCaptions', s.soundCaptions, 'Sound captions'))}
      </div>
      <h2>Graphics</h2>
      <div class="settings-grid">
        ${row('Quality tier', `<select data-set="graphicsTier" aria-label="Quality tier">
          ${['auto', 'low', 'medium', 'high'].map(t => `<option value="${t}" ${s.graphicsTier === t ? 'selected' : ''}>${t}</option>`).join('')}</select>`)}
        ${row('Reduced motion', check('reducedMotion', s.reducedMotion, 'Reduced motion'))}
        ${row('Board view', `<select data-set="camera" aria-label="Camera view">
          ${['default', 'top', 'low'].map(t => `<option value="${t}" ${s.camera === t ? 'selected' : ''}>${t}</option>`).join('')}</select>`)}
        ${row('Use 2D board instead of 3D', check('board2d', s.board2d, 'Use 2D board'))}
        ${row('Cosmetic theme', `<select data-set="themeOverride" aria-label="Cosmetic theme">
          <option value="" ${!s.themeOverride ? 'selected' : ''}>follow the round</option>
          ${Object.entries(THEMES).map(([k, v]) => `<option value="${k}" ${s.themeOverride === k ? 'selected' : ''}>${this.esc(v.label)}</option>`).join('')}</select>`)}
      </div>
      <h2>Accessibility</h2>
      <div class="settings-grid">
        ${row('Larger text', check('largeText', s.largeText, 'Larger text'))}
        ${row('High contrast', check('highContrast', s.highContrast, 'High contrast'))}
        ${row('Colour-vision palette', `<select data-set="palette" aria-label="Colour-vision palette">
          ${['standard', 'deuteranopia', 'protanopia', 'tritanopia'].map(t => `<option value="${t}" ${s.palette === t ? 'selected' : ''}>${t}</option>`).join('')}</select>`)}
        ${row('Left-handed controls', check('leftHanded', s.leftHanded, 'Left-handed controls'))}
        ${row('Timing assistance (+50% round timers)', check('timingAssist', s.timingAssist, 'Timing assistance'))}
        ${row('Replay tutorials', `<button data-act="reset-tutorials">Reset</button>`)}
      </div>
      <h2>Controls</h2>
      <p class="meta">Keyboard: arrows or Tab move focus · Enter/Space select · Esc pause/cancel · H hint · R reshuffle · U undo · C camera. Gamepad: d-pad/stick move · A select · B cancel · Start pause · Y hint · X undo.</p>
      <div class="settings-grid" id="gamepad-remap">
        ${['confirm', 'cancel', 'pause', 'hint', 'undo'].map(a => row(`Gamepad: ${a}`, `<button data-remap="${a}">${this.esc((s.bindings || {})[a] || 'default')}</button>`)).join('')}
      </div>
      <h2>Data</h2>
      <div class="settings-grid">
        ${row('Erase all local progress and settings', `<button class="danger" data-act="erase-all">Erase</button>`)}
      </div>
      <div class="menu-stack"><button data-act="back">Back</button></div>
    `, 'settings');
  }

  // ---------------------------------------------------------------- help ---

  showHelp(bindings) {
    this.show(`
      <h1>Help &amp; Rules</h1>
      <div class="card-grid">
        <div class="card"><h3>⌖ Goal</h3><p>Clear the board by removing pairs of <strong>exposed</strong> tiles. The round's rule is always shown at the top: a sum target, matching twins, or an exact difference.</p></div>
        <div class="card"><h3>▤ Exposure</h3><p>Only the top tile of each stack can be played. In side-locked rounds, a tile is also locked while neighbours press on <em>both</em> its sides — one open side is enough.</p></div>
        <div class="card"><h3>✦ Scoring</h3><p>Each pair scores 100. Removing pairs quickly adds up to 50 speed bonus. Unbroken chains of pairs (no hints, no misses) add up to 150 per pair. Clearing the board adds 500, plus a time bonus in timed rounds. Exploring never costs points.</p></div>
        <div class="card"><h3>⚑ Stuck?</h3><p>If no legal pair exists and no reshuffles remain, the round ends. Hints (H) reveal one legal pair. Reshuffles (R) redeal the remaining tiles solvably. Practice and Journey allow undo (U).</p></div>
        <div class="card"><h3>⌨ Controls</h3><p>Pointer or touch: tap a tile, tap its partner. Keyboard: arrows move, Enter selects, Esc cancels or pauses. Gamepad: d-pad moves, ${this.esc(bindings.confirm || 'A')} confirms, ${this.esc(bindings.cancel || 'B')} cancels, Start pauses. H hints, R reshuffles, U undoes, C resets the camera.</p></div>
        <div class="card"><h3>⚖ Fair play</h3><p>Every board is generated from a visible seed and proven solvable offline. Ranked rounds disallow undo and are submitted with a replay log for validation.</p></div>
      </div>
      <div class="menu-stack"><button data-act="back">Back</button></div>
    `, 'help');
  }

  // --------------------------------------------------------- leaderboards --

  showScores({ boards, progress }) {
    const section = (title, entries, note) => `
      <h2>${title}</h2>
      ${entries.length ? `<table class="score-table"><tr><th>#</th><th>Score</th><th>Time</th><th>Invalid</th><th>When</th></tr>${
        entries.slice(0, 10).map((e, i) => `<tr><td>${i + 1}</td><td>${e.score}</td><td>${this.fmtMs(e.elapsedMs)}</td><td>${e.invalidCount}</td><td>${new Date(e.at).toLocaleDateString()}</td></tr>`).join('')
      }</table>` : `<p class="meta">${note || 'No entries yet — be the first.'}</p>`}`;
    this.show(`
      <h1>Score Chase</h1>
      <p>Asynchronous comparison on validated seeds. Ranked submissions carry a replay log; unverifiable boards are marked casual.</p>
      ${section('Today’s daily', boards.daily, 'Play today’s daily to appear here.')}
      ${section('Journey total', boards.journey)}
      ${section('Zenith Protocol (challenge)', boards.zenith)}
      <h2>Profile</h2>
      <p class="meta">${progress.totals.plays} rounds played · ${progress.totals.wins} wins · ${progress.totals.pairs} pairs removed · mastery ${progress.masteryXp} XP</p>
      <div class="menu-stack"><button data-act="back">Back</button></div>
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
    $('#lesson-text').textContent = text;
    $('#lesson-next').textContent = isLast ? 'Finish' : 'Got it';
    $('#lesson-banner').hidden = false;
  }
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
  return `Next: ${JOURNEY[content.index].name}`;
}
