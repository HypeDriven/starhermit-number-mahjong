// Writes the native play scripts (tests/native/*.play) from the rules: each
// round's board comes from the shipped content and its solution from the
// offline solver (js/rules/validate.js findSolutionPath), so a script clicks
// each pair's tiles by their accessibility names ("tile 4, row 1 column 3, top
// of stack" — the 3D tiles' ui.target names and the 2D board's widget labels,
// screens.ts tileLabel). Run after a content or label change: npm run plays.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../js/rules/engine.js';
import { JOURNEY, prepareContent, challengeContent, lessonContent } from '../js/rules/content.js';
import { findSolutionPath } from '../js/rules/validate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = (name, lines) => writeFileSync(join(root, 'tests/native', name), lines.join('\n') + '\n');

/** screens.ts tileLabel (English) for an exposed tile. */
function label(st, id) {
  const t = st.tiles[id];
  const cell = st.layout.cells[t.stack];
  return [`tile ${t.value}, row ${cell.y + 1} column ${cell.x + 1}`, 'top of stack', st.ruleset.sideLock ? 'free' : ''].filter(Boolean).join(', ');
}
/** The solution's clicks: each pair is the first tile (select) then its partner. */
function solve(content, { press = 'click', limit = Infinity } = {}) {
  const { content: c, board } = prepareContent(content);
  let st = E.createGame(c, board);
  const path = findSolutionPath(st);
  if (!path) throw new Error('no solution for ' + content.id);
  const lines = [];
  let n = 0;
  for (const [a, b] of path) {
    if (n++ >= limit) break;
    lines.push('frames 5', `${press} =${label(st, a)}`, 'frames 5', `${press} =${label(st, b)}`, 'frames 12');
    st = E.applyCommand(st, { type: 'pair', tileA: a, tileB: b, atMs: 0 }).state;
  }
  return { lines, state: st, pairs: path.length };
}
const header = (text) => text.split('\n').map((l) => '# ' + l);
const GEN = '(tools/gen-plays.mjs; generated: do not edit)';
/** The 3-2-1 countdown ends 27 steps after "Observe" shows: the round takes input from then. */
const ACTIVE = ['until 300 Observe', 'frames 40'];

// 1. Journey stage 1 at the desktop size: the menus, a pause with Settings and Help from it, a hint, an undo, the
//    board cleared by clicking the 3D tiles, the results and the next stage's setup.
{
  const s1 = JOURNEY[0];
  const { lines } = solve(s1);
  const first = lines.slice(0, 5), rest = lines.slice(5);
  out('journey-1.play', [
    ...header(`Journey stage 1 "First Light" cleared on the 3D desk ${GEN}: the title, the journey map, the setup,\nthe countdown, a hint, a pause with Settings and Help opened from it and back, one pair, an undo, the pair again,\nthe rest of the board by its solution, the results with three stars, and the next stage's setup.`),
    'until 300 Number Mahjong', 'frames 30', 'save title',
    'click =Journey', 'until 60 Forty-four', 'frames 10', 'save journey',
    'click Stage 1: First Light', 'until 60 Start round', 'frames 10', 'save setup',
    'click =Start round', 'until 300 3 pairs left', ...ACTIVE,
    'key KeyH 1', 'until 60 Hint: ', 'frames 30', 'save hint',
    'key KeyP 1', 'until 60 =Resume', 'frames 10', 'save pause',
    'click =Settings', 'until 60 Board view', 'frames 10', 'click =Back', 'until 60 =Resume', 'frames 10',
    'click =Help', 'until 60 Fair play', 'frames 10', 'save help', 'click =Back', 'until 60 =Resume', 'frames 10',
    'click =Resume', 'frames 20',
    ...first, 'until 60 2 pairs left', 'frames 10', 'click =Undo', 'until 60 3 pairs left', 'frames 10',
    // undo goes back one command: to the first tile selected, so only its partner is clicked again
    ...first.slice(2), ...rest,
    'until 300 Board Cleared', 'frames 30', 'expect ★★★', 'save results',
    'click =Next: Brass and Glass', 'until 60 Start round', 'frames 10', 'expect Brass and Glass', 'save next-setup',
  ]);
}

// 2. Lesson 1 on a phone held upright, by touch: the lesson banner's steps follow the selection and the pair.
{
  const lesson = lessonContent('lesson-sum');
  const { content: c, board } = prepareContent(lesson);
  let st = E.createGame(c, board);
  const id = (v) => E.exposedTiles(st).find((t) => st.tiles[t].value === v);
  const four = id(4), six = id(6);
  const l4 = label(st, four), l6 = label(st, six);
  st = E.applyCommand(st, { type: 'pair', tileA: four, tileB: six, atMs: 0 }).state;
  const path = findSolutionPath(st);
  const rest = [];
  for (const [a, b] of path) {
    rest.push('frames 5', `touch =${label(st, a)}`, 'frames 5', `touch =${label(st, b)}`, 'frames 12');
    st = E.applyCommand(st, { type: 'pair', tileA: a, tileB: b, atMs: 0 }).state;
  }
  out('lesson-phone.play', [
    ...header(`Lesson 1 "Making Ten" on a phone held upright, by touch ${GEN}: the Learn cards, the lesson's banner\nsteps (Got it, select the 4, pair it with the 6), the rest of the board, the results; then Score Chase.`),
    '# viewport 390x844@3',
    'until 300 Number Mahjong', 'frames 30', 'save title',
    'touch =Learn', 'until 60 Short interactive lessons', 'frames 10', 'save learn',
    'touch =Start', 'until 300 Welcome to the observatory', ...ACTIVE, 'save banner',
    'touch =Got it', 'until 60 Try the 4', 'frames 10',
    `touch =${l4}`, 'until 60 Now tap the 6', 'frames 10', 'save lesson-select',
    `touch =${l6}`, 'until 60 The pair is removed', 'frames 10',
    ...rest,
    'until 300 Board Cleared', 'frames 30', 'save results',
    'touch =Leaderboards', 'until 60 Score Chase', 'frames 10', 'save scores',
  ]);
}

// 3. The Sprint challenge (90 s) in a phone held sideways, played to its clear against the clock.
{
  const c = challengeContent('chal-sprint');
  const { lines } = solve(c, { press: 'touch' });
  out('challenge-landscape.play', [
    ...header(`The "Sprint: Ninety Seconds" challenge cleared in a phone held sideways, by touch ${GEN}:\nthe timer runs, the board is cleared by its solution, the results carry a time bonus.`),
    '# viewport 844x390@3',
    'until 300 Number Mahjong', 'frames 30',
    'touch =Challenges', 'until 60 Constrained goals', 'frames 10', 'save challenges',
    'touch =Attempt', 'until 60 Start round', 'frames 10', 'expect Clear the board before the lens closes', 'save sprint-setup',
    'touch =Start round', 'until 300 10 pairs left', ...ACTIVE, 'save sprint-play',
    ...lines,
    'until 300 Board Cleared', 'frames 30', 'expect Time bonus', 'save sprint-results',
  ]);
}

// 4. Journey stages 1 and 2 on the 2D board (Settings › Use 2D board), the tiles chosen by keyboard and clicks.
{
  const s1 = solve(JOURNEY[0]);
  const s2 = solve(JOURNEY[1]);
  out('board2d-keyboard.play', [
    ...header(`The 2D tile board ${GEN}: Settings › Use 2D board, stage 1 cleared by clicking the tile buttons, then\nstage 2 from the results' Next with its first tile chosen by the keyboard (arrows and Enter) and the rest clicked.`),
    'until 300 Number Mahjong', 'frames 30',
    'click =Settings', 'until 60 Board view', 'frames 10',
    'click =Use 2D board instead of 3D', 'frames 10', 'save settings-2d', 'click =Back', 'until 60 Number Mahjong', 'frames 10',
    'click =Play', 'until 60 Start round', 'frames 10', 'click =Start round', 'until 300 3 pairs left', ...ACTIVE, 'save board2d',
    ...s1.lines,
    'until 300 Board Cleared', 'frames 30',
    'click =Next: Brass and Glass', 'until 60 Start round', 'frames 10', 'click =Start round', 'until 300 4 pairs left', ...ACTIVE,
    'key ArrowRight 1', 'frames 5', 'key Enter 1', 'until 60 =Undo', 'frames 10', 'save board2d-keyboard',
    'key Escape 1', 'frames 10',
    ...s2.lines,
    'until 300 Board Cleared', 'frames 30', 'save board2d-results',
  ]);
}

// 5. The Daily: its setup, the round left from the pause sheet (its results), a practice round reshuffled and restarted.
out('daily-practice.play', [
  ...header(`The Daily's setup and round left from the pause sheet ("Round Left" results), then an Expert practice\nround with a reshuffle, the board view's camera reset, Restart round and Leave round. (Generated alongside the others.)`),
  'until 300 Number Mahjong', 'frames 30',
  'click Daily Challenge', 'until 60 Next daily in', 'frames 10', 'expect RANKED', 'save daily-setup',
  'click =Start round', 'until 300 14 pairs left', ...ACTIVE, 'save daily-play',
  'key Escape 1', 'until 60 =Resume', 'frames 10', 'click =Leave round', 'until 120 Round Left', 'frames 20', 'save daily-left',
  'click =Back to title', 'until 60 Number Mahjong', 'frames 10',
  'click =Practice', 'until 60 Unranked.', 'frames 10', 'click =Start Expert', 'until 60 Start round', 'frames 10',
  'click =Start round', 'until 300 14 pairs left', ...ACTIVE,
  'key KeyR 1', 'frames 40', 'key KeyC 1', 'frames 60', 'save practice-reshuffled',
  'key KeyP 1', 'until 60 =Resume', 'frames 10', 'click =Restart round', 'until 300 14 pairs left', ...ACTIVE,
  'key KeyP 1', 'until 60 =Resume', 'frames 10', 'click =Leave round', 'until 120 Round Left', 'frames 10',
]);
console.log('wrote tests/native/*.play');
