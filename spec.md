# Number Mahjong — Game Design Document

Running specification for the shipped game. Everything below describes behaviour that exists in this
repository today, except the final **Design intent not yet implemented** section.

---

## 1. Overview

**Pitch.** An astronomer's desk at dusk: lift two ivory tiles whose numbers satisfy tonight's rule,
and keep lifting until the felt is bare.

| | |
| --- | --- |
| Genre | Single-player number-pair tile solitaire (mahjong-solitaire exposure, arithmetic matching) |
| Players | 1, with asynchronous score comparison on shared seeds |
| Session | 60-90 s for a lesson or an early journey stage; 3-5 min for a daily or a capstone |
| Platforms | Desktop and mobile browsers, portrait and landscape; keyboard, pointer, touch, gamepad |
| Rendering | Three.js (`vendor/three.module.js`, bundled) over a canvas, with a permanently present semantic DOM board as fallback and screen-reader surface |
| Networking | Offline-first; hosted on StarHermit the client authenticates with the `#game_token=` launch token (Bearer on every call) and uses profile, cloud-saves, and its own server's replay-verified score route; standalone play makes only a same-origin `GET /api/v1/time` |

### File map

| File | Responsibility |
| --- | --- |
| `index.html` | Static shell: HUD, board region (`#gl` canvas + `#board2d` mirror), overlays, live regions |
| `css/main.css` | All presentation: theme custom properties, HUD, 2D board, screens, safe areas, motion/contrast modes |
| `js/rules/rng.js` | `hashString` (FNV-1a) and `makeStream` (mulberry32) with `state`, `int`, `range`, `pick`, `shuffle`, `fork` |
| `js/rules/engine.js` | Pure rules: board construction, exposure, legal pairs, command validation/application, scoring, terminal states, serialization, `stateHash`, tie-breaks |
| `js/rules/content.js` | Layouts, solvable board generation, 44 journey stages, daily rotation, 4 practice presets, 6 challenges, 5 lessons, 5 themes |
| `js/rules/validate.js` | Offline solvability proof (`proveSolvable`) and `findSolutionPath`, used by the test suite |
| `js/rules/replay.js` | Replay envelope: schema/build/content versions, command log, checkpoint hashes, `verifyReplay` |
| `js/app/main.js` | Bootstrap, phase machine, input wiring, command dispatch, timers, progression, achievements, gamepad |
| `js/app/ui.js` | Screens, HUD, 2D board render, toasts, announcements, settings, help, leaderboards, achievements list |
| `js/app/render3d.js` | Three.js scene: desk, felt, props, tile meshes with canvas-drawn number textures, tweens, particles, picking |
| `js/app/audio.js` | WebAudio buses, sample playback from `sfx/`, procedural fallback voices, ambience, generative music, captions |
| `js/app/storage.js` | Checksummed, versioned `localStorage` with in-memory fallback: settings, progress, snapshots, replays, local boards |
| `js/app/platform.js` | StarHermit host integration (no-op without a launch token): fragment token read/strip, Bearer auth + 45-min refresh, profile nickname, zip+base64 cloud-save mirror (debounced, pagehide flush), verified score POST, read-only platform leaderboard |
| `server.js` | StarHermit game script: static host, `/api/v1/time`, replay-verified `/api/v1/scores` |
| `tests/run-tests.mjs` | 87 headless assertions over rules, content, replay, storage |
| `tests/browser-test.mjs` | 30 assertions in headless Chrome over the real DOM and canvas |
| `tests/e2e.mjs` | Full desktop + mobile playthrough via playwright-core |
| `sfx/` | 37 Opus clips, `manifest.txt` (canonical), `manifest.json` (generator input), `manifest.md` (prompt history) |
| `assets/` | `title-backdrop.webp`, `tile-stack.webp` |

---

## 2. Design pillars

1. **Arithmetic you can feel, not compute.** The rule is a single short phrase (`Make 10`, `Match
   equals`, `Differ by 3`) plus a dial, and selecting a tile immediately announces what its partner
   must be. *Rules in:* per-tile partner hints, one rule per round, a target dial next to the label.
   *Rules out:* multi-term expressions, hidden modifiers, rules that change without an announcement.
2. **The board is the hero; the desk is the mood.** The 3D scene exists to make ivory tiles on green
   felt look worth touching. *Rules in:* warm key light, brass props, per-value tile textures,
   physical lift-and-settle animation. *Rules out:* camera moves the player did not ask for, effects
   that occlude a tile face, particles that survive `settleImmediately()`.
3. **Exploration is free.** Trying a wrong pair costs no points and no time penalty — it increments
   `invalidCount`, which is only ever a tie-break. *Rules in:* generous invalid feedback with the
   reason spelled out. *Rules out:* score deductions, lives, punishing miss timers.
4. **Every board is provably solvable, and you can see the seed.** Boards are constructed by
   simulating a legal removal order and then assigning values into it. *Rules in:* seeds printed on
   the setup screen, `reshuffle` that re-deals into a fresh solvable order. *Rules out:* boards
   generated by rejection sampling of random values, difficulty that hides behind unlucky deals.
5. **Two boards, one truth.** The DOM board is not a degraded mode; it is the same state rendered
   with buttons, and it exists at all times for assistive technology. *Rules in:* identical labels,
   identical legality, a settings switch. *Rules out:* interactions that only the canvas supports.

---

## 3. Player experience

**Target player.** Someone who likes mahjong solitaire's shape but wants the matching criterion to
carry a small arithmetic thought; comfortable with 1-9 sums; plays in short sittings, often on a
phone, often with sound off.

**First 60 seconds.** Boot lands on the title with **Play** as the primary button; `Play` opens the
setup card for the first uncompleted journey stage. Stage 1 *First Light* is a six-tile flat row,
`sum` to 10, three pairs, unlimited time, three hints, undo enabled — and it carries `tutorial: 'sum'`.
The setup card states the rule in a full sentence, the pair count, par, assists, and the seed. A 3-2-1
countdown with a `round-start` "Observe" beat opens the round (skipped entirely under reduced motion).
Selecting a tile announces `Tile 4 selected. Partner must be 6.` The Learn menu carries the same
teaching as five scripted lessons (`js/rules/content.js` `LESSONS`), where `lesson-sum` gates on
`requireSelectValue: 4` and then `requirePairValues: [4, 6]` before advancing its banner.

**Session shape.** Title → one round (journey stage, daily, challenge, practice or lesson) → results
with a component breakdown and stars → *Next stage* / *Replay this board* / *Back*. An interrupted
round is offered back on the title as **Resume interrupted round** with tiles-left and elapsed.

**Emotional beat.** The unbroken chain. Pairs cleared back to back without a hint, a miss or a
reshuffle escalate through three distinct chime cascades (`combo-chain-low/mid/high`) while the HUD
prints `chain ×N` — the run's rhythm is audible before it is visible in the score.

---

## 4. Core loop and rules contract

### Entities

A board is a list of grid `cells` (`{x, y}`), a `heights` array, and a `values` array per stack from
bottom to top (`content.js` `generateBoard`). `createGame` (`engine.js`) turns that into `stacks`
(arrays of tile ids, bottom→top) and a `tiles` map of `{id, value, stack, level}`. Tile ids are
assigned bottom-first per stack in both the generator and the engine, so the two agree exactly.

### Exposure (`engine.js` `isExposed`)

- A tile is playable only if it is the top of its stack.
- If `ruleset.sideLock` is set, it is additionally blocked when **both** horizontal grid neighbours
  (`x±1`, same `y`) have stacks taller than this tile's level. One open side is enough.

### Rules (`engine.js` `pairSatisfies`)

| `ruleset.rule` | Condition | Target source |
| --- | --- | --- |
| `sum` | `a + b === target` | `ruleset.target`, or `targetSequence[targetIndex]` when `dynamic` |
| `match` | `a === b` | — |
| `diff` | `Math.abs(a - b) === ruleset.diff` | — |

`currentTarget(state)` is the single accessor; dynamic rounds advance `targetIndex` on every removed
pair, and the sequence is the one the board was generated against (`__fixedTargetSequence`), so the
displayed target always has a solution among the remaining tiles.

### Commands (`engine.js` `validateCommand` / `applyCommand`)

`select` · `pair` · `hint` · `reshuffle` · `undo` · `timeout` · `quit`. Every command carries its own
`atMs` from the app's pausable `SessionClock`; the engine never reads a clock. Resolution order per
command: validate → time-limit check (a command arriving past `limits.timeMs` ends the round before
mutating) → snapshot for undo → clone → `tick++` → `elapsedMs = max(elapsed, atMs)` → apply →
`checkTerminal`. States are immutable: `applyCommand` returns a new state plus an event list, never
throws, and never partially mutates.

Two rejections are *feedback*, not errors, and produce a new state with `invalidCount++` and
`chain = 0`: pairing two exposed tiles that fail the rule (`RULE_MISMATCH`, and the second tile
becomes the new selection) and selecting a covered tile (`NOT_EXPOSED`). Every other rejection returns
the original state with a `rejected` event, which `main.js` surfaces as an error toast plus `invalid`.

`hint` picks `legalPairs(state)[0]`, decrements a finite hint count, sets `chain = 0`, and stores
`hintedPair`. `reshuffle` re-plans a removal order over the *current* stacks with the rules RNG stream
and re-assigns values pair by pair, so the board is solvable again and the shown target still has a
partner. `undo` restores the previous snapshot but keeps `tick`, `elapsedMs` and `undoCount`
monotonic — undo rewinds the board, never the clock or the audit trail.

### Scoring (`engine.js` `applyCommand` case `pair`, `finalizeClearBonus`)

| Component | Formula |
| --- | --- |
| `pairs` | `+100` per removed pair |
| `speed` | `round(50 × (1 - dt/4000))` where `dt` is ms since the previous pair, capped at 4000 ms; the first pair scores 0 |
| `chain` | `min(25 × (chain - 1), 150)` per pair, chain reset by a hint, an invalid attempt, a reshuffle or an undo |
| `clear` | `+500` once, only on a win |
| `time` | `round(300 × remaining / limits.timeMs)` on a win in a timed round |

**Worked example** — journey 31 *Swift Transit* (6 pairs, 60 s limit), cleared in 38.0 s with pairs at
6.0 s, 9.0 s, 11.5 s, 14.0 s, 16.0 s (one miss here) and 38.0 s:

```
pair 1  base 100  speed   0 (first pair)          chain   0   → 100
pair 2  base 100  speed  13 (dt 3000 ms)          chain  25   → 138
pair 3  base 100  speed  19 (dt 2500 ms)          chain  50   → 169
pair 4  base 100  speed  19 (dt 2500 ms)          chain  75   → 194
pair 5  base 100  speed  25 (dt 2000 ms)          chain 100   → 225   (miss after this: chain → 0)
pair 6  base 100  speed   0 (dt 22000 ms > 4000)  chain   0   → 100
                                     pairs 600 · speed 76 · chain 250
clear 500 · time round(300 × 22000/60000) = 110      TOTAL = 1536
```

Par for the stage is 800 in 45 s, so a 38 s clear at 1536 earns 3 stars
(`main.js` `_showResults`: 1 star for the win, +1 for `total ≥ par.score`, +1 for `elapsedMs ≤ par.timeMs`).

### Terminal states (`engine.js` `TERMINAL`, `checkTerminal`)

`cleared` (won — every tile removed) · `no-moves` (no legal pair **and** no reshuffles left) ·
`out-of-moves` (`movesUsed ≥ limits.moves`) · `time-up` · `abandoned` (`quit` from the pause menu).
Losses still finalize the score parts already earned; only a win adds `clear` and `time`.

### Tie-breaks (`engine.js` `compareResults`)

Completion, then higher score, then fewer invalid attempts, then lower elapsed, then session id as a
stable string comparison. The same ordering is duplicated in `storage.submitBoardEntry` and in
`server.js` so local and server boards agree.

### Determinism

Three separate seeded streams: rules (`content.seed ^ 0x51ed`, persisted as `rngState` in the state),
decoration (`'deco-scene'`, `'star-chart'`, `'tile-<value>'` in `render3d.js`), and audio variants
(`'audio-' + settings.audioSeed`). Cosmetic randomness can never perturb a rules outcome.

---

## 5. Modes and progression

| Mode | Content | Tools | Ranked | Notes |
| --- | --- | --- | --- | --- |
| Journey | 44 authored stages (`JOURNEY`) | 3 hints, 1 reshuffle, undo; mastery stages cut to 0-1 hints, no undo | no | Linear unlock: stage *n* requires *n-1* completed. 3 stars per stage |
| Daily | `dailyContent(iso, dayIndex)` — one ruleset per UTC weekday, layout/theme rotated by seed and day index, 14 pairs | 1 hint, 1 reshuffle, no undo | yes | Immutable after publication; `DAILY_EXCLUDED` marks defective days as unranked rather than replacing them |
| Practice | 4 presets (easy/medium/hard/expert) with a random session salt | ∞ hints, 2 reshuffles, undo | no | Nothing here touches rating |
| Challenges | 6 fixed-seed trials (`CHALLENGES`) | per-challenge, down to none at all | yes | Sprint, Frugal Astronomer, The Locked Gallery, Unstable Instrument, Monolith, Zenith Protocol |
| Learn | 5 scripted lessons with fixed tile values and fixed targets | ∞ hints, undo | no | Sequential unlock; replayable |

**Difficulty curve.** Journey blocks introduce one idea at a time and close with a mastery stage that
removes assists: 1-5 `sum` · 6-10 `match` · 11-15 `diff` · 16-20 stacked layers · 21-25 side locks ·
26-30 dynamic targets · 31-35 time pressure · 36-40 combined with move limits · 41-44 capstones,
ending in *The Zenith* (16 pairs, dynamic target 5-17, side locks, 3 layers, 20 moves, 200 s, no tools).

**Progression state** (`storage.js` `DEFAULT_PROGRESS`): per-stage stars/bestScore/bestMs/completions,
lesson completion, achievement unlock timestamps, `masteryXp` (`10 + 15 if mastery + 2 × stars` per
win), daily history per ISO date, and lifetime totals. Eight achievements (`ui.js` `ACHIEVEMENTS`):
First Light, Every Instrument, Steady Hand, Surveyor, Cartographer of Skies, Zenith, Weekly Watcher,
Long Exposure.

---

## 6. Controls and interaction

| Input | Action |
| --- | --- |
| Tap / click a tile | First tap selects; second tap attempts the pair (`main.js` `chooseTile`) |
| Tap the selected tile | Deselects |
| Drag on the canvas (> 14 px) | Not a tap: plays `drag-start`, then `drop` on release, no tile chosen |
| Long press (> 600 ms) | Ignored as a tap |
| Arrow keys | Move focus between exposed tiles by grid direction, with wrap (`_moveFocus`) |
| Enter / Space | Choose the focused tile |
| Esc | Cancel selection → pause; resumes when already paused |
| P / H / R / U / C | Pause · Hint · Reshuffle · Undo · reset camera |
| Gamepad | Stick or d-pad moves focus; A confirm, B cancel, X undo, Y hint, Start pause; all five remappable in Settings |

**Input locking.** Commands are accepted only while `phase === 'active'`. The countdown, the 750 ms
resolve settle (60 ms under reduced motion) and the results screen are the only non-interactive
phases. Backgrounding the tab pauses an active round and suspends audio; the countdown checks
`document.hidden` on activation so the authoritative clock never runs unseen.

**Feedback for every input.** Selection: tile lift + `select` + a live-region partner hint. Invalid
pair: `invalid` + an error toast naming both values and the rule. Legal pair: `pair` or a chain
cascade, particle burst, `expose` when a covered tile is freed, `target-shift` in dynamic rounds.
Hover on the canvas switches the cursor to `pointer` only over exposed tiles; hover on any menu
control plays a throttled `hover` tick.

---

## 7. Screens and UI flow

`#app[data-screen]` drives the state machine; `play` hides `#screen-root`, everything else hides the
play root.

```
boot → title ─┬→ modesetup → (countdown → active ⇄ paused) → resolving → results ─┬→ modesetup
              ├→ journey / practice / challenge / learn → modesetup               ├→ scores
              ├→ settings / help / scores → back                                  └→ title
              └→ resume → active
```

The pause overlay is a modal dialog over the play screen with Resume / Settings / Help / Restart /
Leave; opening Settings or Help from it hides the overlay and remembers `_settingsReturn = 'pause'`
so **Back** returns to the paused round rather than the title.

**Layout.** `#hud-top` holds the objective (rule label plus target dial), progress line, score with
chain indicator, the timer block, and the pause button; `#board-region` fills the middle; `#hud-actions`
floats bottom-right (bottom-left with *Left-handed controls*). All four edges use
`env(safe-area-inset-*)`. On narrow portrait the HUD wraps and the 2D board rows scroll; the objective,
the score, the timer and the action buttons must never be clipped, and the canvas is never allowed to
cover the toast stack or the lesson banner.

---

## 8. Art direction

**Palette.** Five cosmetic themes (`content.js` `THEMES`), each supplying scene colours plus a CSS
block. `ivory-dusk` is the default: page `#171a24`, panel `#232838`, ink `#ece4d4`, accent `#e8b34b`,
muted `#9b94a8`, tile `#f3ead8` with edge `#d8cbb2` and tile ink `#3b3230`, desk `#3a2f28`, felt
`#2e4038`, sky `#1b2233`. The others shift the whole set: `emerald-archive` (accent `#63c98a`),
`crimson-meridian` (`#f0705e`), `frost-zenith` (`#6cb8e8`), `gilded-eclipse` (`#d9a441`). Danger is
`#e0604f` throughout. Themes are cosmetic only — never hitboxes, timing, or power.

**Shape language.** Rounded rectangular slabs (1.0 × 0.34 × 1.3 units, 0.16 gap) with warm ivory
faces and a hand-drawn number; brass cylinders and dark wood for props; soft 14 px radii in the DOM.

**Typography.** Headings and the objective use a serif stack (`Iowan Old Style`, `Palatino`, Georgia);
body and controls use the system UI stack. Tile numbers are drawn into a canvas texture per value with
a seeded ink jitter so no two values look mechanically identical.

**Motion.** A small authored tween manager (duration + easing + interruptible + `settle()`); tiles
lift, drift and fade on removal, deeper tiles rise into their new top position. `settleImmediately()`
snaps every tween and clears particles to the exact deterministic end state before results. Reduced
motion removes the countdown, screen-in animation, particle bursts and the results art.

**Hero.** The lit felt with its ivory terraces. The desk, lamp, telescope, star chart and books sit
outside the play area, dimmer and out of focus, and are dropped entirely on the `low` quality tier.

**Visual assets the design calls for**

| Asset | Use |
| --- | --- |
| `assets/title-backdrop.webp` | Title-screen key art behind the wordmark, scrimmed to keep menu contrast; removed under high contrast |
| `assets/tile-stack.webp` | Masked banner above the results headline; removed under high contrast or reduced motion |
| `coverart.png` | 1200×675 StarHermit cover, matching the observatory art direction |
| `favicon.svg`, `icon.png` | Ivory tile mark |

---

## 9. Audio direction

**Mix philosophy.** A quiet room you are working in. Three buses (`music`, `effects`, `ambience`)
under a master gain, defaulting to 0.5 / 0.8 / 0.4. Loudness rises strictly with meaning: input
acknowledgement < legal move < chain/goal < round completion. Ambience is a filtered brown-noise room
tone under an 0.07 Hz LFO; music is a generative pentatonic pluck line (root A3, scale 0-3-5-7-10)
that fires roughly every 0.9-2.3 s and goes silent while the tab is hidden.

**Playback.** `AudioEngine.play(event)` looks the event up in `SAMPLE_FILES`, plays the decoded Opus
clip if it is loaded, otherwise starts a lazy fetch and covers the gap with the procedural voice for
that event. Sample failures are cached as `null` and never retried, so a missing file degrades to
synthesis rather than repeating 404s. Every call also emits a caption string for the *Sound captions*
setting. The context is created on the first pointer or key gesture.

**SFX event table** — this table is the source of `sfx/manifest.txt`; all files are 48 kHz mono Opus.

| Event id | File | Description | Context |
| --- | --- | --- | --- |
| `select` | `tile-select.opus` | Ivory tile lifted off wood | Tile selected |
| `deselect` | `tile-deselect.opus` | Tile set back down | Selection cleared |
| `expose` | `tile-expose.opus` | Tile sliding aside, revealing beneath | A removal frees a covered tile |
| `pair` | `pair-match.opus` | Two tiles tapped together | Valid pair, chain 1 |
| `chain` (2-3) | `combo-chain-low.opus` | Two rising clacks + warm chime | Short chain |
| `chain` (4-5) | `combo-chain-mid.opus` | Three rising chime notes | Medium chain |
| `chain` (6+) | `combo-chain-high.opus` | Five-note cascade with shimmer | Long chain |
| `target-shift` | `target-shift.opus` | Brass dial clicking one notch | Dynamic target advances after a pair |
| `hint` | `hint-glow.opus` | Glass-chime glimmer | Hint highlights a legal pair |
| `reshuffle` | `shuffle.opus` | Ceramic tiles clattering | Board reshuffled |
| `undo` | `undo-move.opus` | Tile sliding backward | Undo |
| `invalid` | `ui-error.opus` | Muted double clack | Rule mismatch, covered tile, or a refused tool |
| `board-clear` | `board-clear.opus` | Warm gong swell | Board cleared (terminal) |
| `win-stinger` | `win-stinger.opus` | Brass and ceramic fanfare | Results screen after a win |
| `lose` | `lose-stinger.opus` | Descending marimba pair | Any losing terminal |
| `star-rating` | `star-rating.opus` | Three ascending dings | Stars revealed |
| `new-record` | `new-record.opus` | Glass glissando | First place on a local board |
| `achievement` | `ui-success.opus` | Three-note chime with shimmer | Achievement unlocked |
| `round-start` | `round-start.opus` | Brass singing bowl | The "Observe" beat |
| `countdown` | `countdown-tick.opus` | Brass clock tick | Countdown 3-2-1 |
| `timer-warning` | `timer-warning.opus` | Small hand-bell | Each second under 10.5 s remaining |
| `pause` / `resume` | `ui-pause.opus` / `ui-resume.opus` | Drawer closing / bright tick | Pause and resume |
| `ui` | `ui-click.opus` | Ceramic button click | Default menu press |
| `hover` | `ui-hover.opus` | Soft tick | Pointer over a control, 120 ms throttle |
| `confirm` | `ui-confirm.opus` | Two-note chime | "Start round" |
| `back` | `ui-back.opus` | Descending tone | Back to title |
| `tab-switch` | `ui-tab-switch.opus` | Tab flipping on wood | Moving between top-level sections |
| `toggle` / `slider` | `ui-toggle.opus` / `ui-slider-drag.opus` | Toggle click / knob on rail | Settings changes |
| `settings-saved` | `ui-settings-saved.opus` | Rubber stamp | Leaving the Settings screen |
| `modal-open` / `modal-close` | `ui-modal-open.opus` / `ui-modal-close.opus` | Airy whoosh up / down | Settings or Help from the pause overlay, and back |
| `scroll-tick` | `ui-scroll-tick.opus` | Notched wheel tick | List scrolling, 150 ms throttle |
| `toast` | `ui-toast-notify.opus` | Small bell pop | Non-error toast |
| `drag-start` / `drop` | `tile-drag-start.opus` / `tile-drop.opus` | Scrape / snug knock | Canvas drag threshold and release |

---

## 10. Localization

The shipping language set is **en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT**.

Today all player-facing strings are authored inline in English in `js/app/ui.js` (screens, help,
settings), `js/app/main.js` (announcements, toasts), `js/rules/content.js` (stage names, challenge
blurbs, lesson scripts, `describeRule`) and `index.html`; `<html lang="en">` is fixed. There is no
string table and no locale negotiation — see **Design intent not yet implemented**. The intended
design: one catalogue per locale keyed by string id, selected from the StarHermit launch token's
locale claim and falling back to `navigator.languages` then `en-US`; regional variants inherit from
their base (`fr-CA` ← `fr-FR`). Layout already tolerates expansion — every button, badge and card
wraps rather than truncating — and the design allowance is +40% over en-US for German, with numerals,
seeds, scores and times formatted only at presentation time from integers held in state.

---

## 11. Accessibility

- **Keyboard-only path.** Title → every screen → a full round → results is reachable with Tab, arrows,
  Enter/Space and Esc. Each screen focuses its first control on entry; the pause dialog focuses
  **Resume** and restores the previously focused element on close. `#board2d` tiles are real
  `<button role="gridcell">` elements, exposed tiles `tabindex="0"` and covered ones `disabled`.
- **Focus.** A 3 px accent outline with a 2 px offset on every focusable element. In 3D mode a
  floating `#focus-chip` tracks the focused tile's projected screen position and shows its value.
- **Screen reader.** `#live-polite` carries selection, pair results, hints, reshuffles, undo, resume
  and board summaries (`boardSummary` lists the rule, every exposed value and the remaining count);
  `#live-assertive` carries round results. Every announcement is generated from state, not from
  animation.
- **Captions.** *Sound captions* prints `♪ pair removed`, `♪ chain ×4`, `♪ target changed`, and so on
  into `#sound-caption` for 1.4 s.
- **Contrast and palette.** *High contrast* darkens panels behind text, thickens button and card borders, and drops both decorative images.
  Four colour-vision palettes (standard, deuteranopia, protanopia, tritanopia) as `data-palette`.
  Selection and hint states are never colour-only: selection lifts and outlines, hints use a dashed
  outline, locked tiles dim *and* are `disabled`.
- **Motion.** *Reduced motion* removes the countdown, screen transitions, particle bursts and the
  results art, and shortens the resolve settle to 60 ms.
- **Targets.** Action buttons are 44 px minimum on touch; the 2D tiles scale with the *Larger text*
  setting. *Timing assistance* multiplies every round timer by 1.5 and is recorded in the run's
  `assists` string rather than hidden.

---

## 12. StarHermit integration

`starhermit.txt` declares `name`, `launch=index.html`, `owner`, `server=server.js`, `version`,
`cover=coverart.png`, per https://wiki.starhermit.com/ packaging conventions.

**Used.** Static launch from the platform; the launch token is read from the URL
fragment `#game_token=` (read once, then stripped; `?token=` / `?launch=` /
`window.__STARHERMIT__` remain as local-dev fallbacks) and decoded for its
`sub` / `game_scope` claims, held in memory and never persisted; hosted calls
carry `Authorization: Bearer`, with a 45-min `POST /api/v1/games/{slug}/launch-token`
refresh (60 s retry on failure). `GET /api/v1/time` (clock offset for the UTC day
boundary) and the profile nickname via `GET /api/v1/users/{sub}/profile` (never
`/api/v1/me`, never usernames; `Player ` + id8 fallback) shown in the account chip
and title status. Cloud save mirrors progress+settings to
`GET`/`PUT /api/v1/me/cloud-saves/{slug}` as a stored zip+base64 doc (2 s debounce,
`pagehide` flush, remote-preferred load guarded by the last-synced timestamp;
localStorage stays the offline cache; sync status in the account chip). The server
script `server.js`, which serves the distribution, answers `/api/v1/time`, and
validates `POST /api/v1/scores` by rebuilding the content itself
(`dailyContent` / `challengeContent` / `JOURNEY.find`) and re-running the submitted
replay envelope through the real engine — accepting only `won` states whose
reported score equals the replayed `scoreParts` sum, with per-IP token-bucket rate
limits and a 256 KB body cap; the hosted client POSTs ranked wins there with the
replay log and degrades to the local board when the route is absent. The platform
leaderboard is read-only: `GET /api/v1/games/{slug}` → `leaderboardId`, then
`GET /api/v1/leaderboards/{leaderboardId}/entries` with userIds resolved to nicknames.

**Not used.** Platform score submission to script-owned leaderboards (the client
only reads), presence, matchmaking, entitlements, IAP, and platform achievement
unlock routes. Leaderboard records remain personal-best-first (`storage.js` board
keys `daily.<iso>`, `journey.<id>`, `journey.all`, `challenge.<id>`,
`casual.<kind>`); without a `leaderboardId` only local records show. Achievements
are local and unlocked from progress only, mirrored in the cloud save doc.

---

## 13. Technical architecture

**Module boundaries.** `js/rules/*` is pure: no DOM, no `Date.now()`, no imports from `js/app/*`.
`js/app/main.js` is the only module that dispatches commands; `ui.js` and `render3d.js` consume
immutable snapshots plus event lists and never mutate state.

**Determinism and replay.** `openReplay` records schema, build, content and rules versions, seed and
initial hash; `recordCommand` appends `{id, tick, type, tileA, tileB, atMs}` and writes a checkpoint
hash every 8 commands and at terminal; `verifyReplay` re-runs the log from a freshly generated board
and compares initial, checkpoint and final hashes, rejecting duplicate command ids. `stateHash`
digests stacks, values, selection, tick, moves, score parts, chain, status, reason, tool counters and
the rules RNG state.

**Persistence.** `storage.js` wraps each payload as `{body, sum}` with an FNV-1a checksum and a store
version; a checksum mismatch or a future version reads as absent rather than throwing. A
`QuotaExceededError` or denied storage falls through to an in-memory map that supersedes stale
persistent values for the session. Keys: `number-mahjong.settings`, `.progress`, `.session.<id>`,
`.replay.<id>`, `.board.<key>`. Session snapshots are written after every command and cleared on
results; `beforeunload` writes a final one.

**Performance budgets.** Quality tiers set device pixel ratio, shadow map size, particle cap and prop
visibility only: `low` 1×/no shadows/no particles/no props, `medium` 1.5×/512/60, `high` 2×/1024/200.
The particle pool is fixed at 200 and reused. The render loop stops while the tab is hidden. The
target is 60 fps on desktop and a stable 30+ fps on mid-range phones at the `low` tier; input
acknowledgement is immediate because rules resolution is synchronous and animation is decorative.

**e2e driving.** `tests/e2e.mjs` boots its own static server on an ephemeral port (the repo's
`server.js` is the platform script), then drives the real visible UI in headless Chrome: it clicks
menu buttons, opens and closes settings, enters the journey map and stage setup, waits out the
countdown, pauses and resumes with the HUD button, presses Hint, and clears the board by clicking the
3D canvas at each tile's projected screen position. State reads (`window.__nm`) are used only for
synchronisation — phase, legal pairs, tile screen positions.

---

## 14. Testing and acceptance criteria

`npm test` (`tests/run-tests.mjs`, **87 assertions**) covers: RNG determinism and forking; construction,
exposure and side-lock; every legal action and every rejection reason; selection toggling; scoring
components; undo/hint/reshuffle semantics; the no-moves terminal and its reshuffle escape; move and
time limits; quit; dynamic targets; serialization, `Infinity` round-tripping and migration; replay
determinism and tamper detection; malformed-command fuzzing; solvability of every journey stage, every
lesson, every challenge, every practice preset and 60 days of dailies; golden sessions; tie-break
ordering; and the storage quota fallback.

`tests/browser-test.mjs` (30 assertions, headless Chrome) exercises the DOM board and the canvas
raycast path, pause/hint/undo, the authoritative clock stopping while paused, persistence across
reload, ranked-daily undo rejection, and tile ghosting after removal, with zero console errors.

`tests/e2e.mjs` runs the playthrough above twice — desktop 1280×800 and mobile 390×844 with touch —
and asserts 20 checkpoints plus a console-error budget of zero (a benign GPU/autoplay noise filter aside).

**QA bar, as checkable statements.**

1. Boot to an interactive title with no console errors, in both 3D and forced-2D modes.
2. The first 60 seconds teach the sum rule without external text: setup card, countdown, partner hint.
3. Every input produces an acknowledgement within one frame; no input is silently dropped.
4. No board can dead-end while a reshuffle remains; a board with neither a legal pair nor a reshuffle
   ends the round with `no-moves` rather than hanging.
5. Corrupt, absent or quota-exhausted `localStorage` never blocks boot or play.
6. A malformed score submission is answered 4xx and the server process survives.
7. Reduced motion, high contrast, larger text, left-handed and the 2D board each apply without reload
   (except the 2D board switch, which reloads deliberately).
8. Nothing in the HUD is clipped at 390×844 portrait or 844×390 landscape with safe-area insets.

---

## 15. Asset inventory

| Path | Purpose | Source | Status |
| --- | --- | --- | --- |
| `assets/title-backdrop.webp` | Title key art (1280×720, 35 KB) | FLUX.2 klein, seed 70414 | generated in this pass, wired via `css/main.css` |
| `assets/tile-stack.webp` | Results banner (960×538, 22 KB) | FLUX.2 klein, seed 31877 | generated in this pass, wired via `.results-art` |
| `coverart.png` | StarHermit cover (1200×675, 384 KB) | FLUX.2 klein, seed 70414 | regenerated in this pass, replacing the placeholder |
| `favicon.svg`, `icon.png` | Tile mark | authored SVG / raster | shipped |
| `vendor/three.module.js` | Renderer | Three.js, vendored | shipped |
| Tile faces, star chart, felt, desk, props | In-scene visuals | procedural (canvas textures + Three.js primitives, seeded) | shipped |
| `sfx/target-shift.opus` | `target-shift` cue | MOSS-SoundEffect v2.0 | generated in this pass, wired in `audio.js`/`main.js` |
| `sfx/*.opus` (36 others) | Full event table in §9 | MOSS-SoundEffect v2.0 | shipped |
| `sfx/manifest.txt` | Canonical file → event → description → context | authored from §9 | generated in this pass |
| `sfx/manifest.json` | Generator input (name, seconds, prompt, event) | authored | regenerated in this pass |
| Music and ambience | Generative pentatonic stem, brown-noise room tone | procedural WebAudio | shipped |
| Character animation | — | — | not applicable: no animated humanoid |
| 3D model files | — | — | not applicable: every prop is a Three.js primitive |

---

## 16. Known limitations

- **Single language.** All strings are inline English; the locale set in §10 is not yet implemented.
- **Leaderboards are personal-best-first.** `server.js` verifies and stores ranked
  submissions, but only when the client runs hosted with a launch token and the
  host serves the script; otherwise every board a player sees is local to their
  device.
- **`localStorage` is the offline cache, not the only copy when hosted.** On
  StarHermit, progress and settings mirror to the platform cloud-save slot;
  clearing site data still erases the local copy, and there is no export.
- **Concurrent submissions to `server.js`** do an unlocked read-modify-write per board file (noted in
  `knownissues.md` as untested rather than as a defect).
- **Static responses carry no `Cache-Control`**; the distribution has no hashed filenames to mark
  immutable.
- **The generative music stem is a texture, not a score** — no themes, no adaptive layering.
- **Hints are not ranked by quality**: `hint` always returns `legalPairs(state)[0]`, which may not be
  the move that best preserves solvability.
- **`knownissues.md` records no confirmed defects** as of the 2026-08-26 re-verification pass.

## Design intent not yet implemented

- **Localization** (§10): no string catalogue, no locale negotiation, `<html lang="en">` fixed.
- **Platform leaderboard submission**: clients cannot post to script-owned leaderboards;
  ranked wins go to the game's own replay-validated `/api/v1/scores` when hosted, and the
  platform leaderboard is read-only.
- **`holdToConfirm`** exists in the settings defaults but has no UI control and no behaviour.
- **`tutorialSeen`, `sessionsPlayed`, `bestStreakDays`** are persisted but never written to.
- **Telemetry** is collected into a 200-event in-memory ring and never leaves the device or is read.
