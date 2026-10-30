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
| Platforms | StarHermit engine 1.28.0 script game (`engine.minor=30`): natively in the StarHermit client and in browsers through the engine's web runtime; portrait and landscape; keyboard, pointer, touch, gamepad |
| Rendering | `starhermit:scene` (three.js r185-like) for the desk and tiles, `starhermit:ui` for every screen and the HUD, `starhermit:canvas` for the procedural textures |
| Networking | Offline-first. Signed in (the runtime owns sign-in and tokens), the game uses the player, the cloud save, per-player settings, the platform clock (`serverNow`) for the Daily, the high-score leaderboard (read, and score posts through `score-script.js`) and invite links; guests make no platform request |

### File map

| File | Responsibility |
| --- | --- |
| `starhermit.txt` | Manifest: `engine.*` lines, `server=score-script.js`, `control.*` / `engine.gamepad.*` defaults per action |
| `native/main.ts` | Entry: phase machine, session clock on fixed steps, command dispatch, timer, lessons, progression, achievements, local boards, score posting, interrupted-round resume, input (actions, pointer and touch picking), lifecycle |
| `native/screens.ts` | Every screen, the HUD, action rail / tray, the 2D tile board, the 3D tiles' accessibility targets, focus chip, countdown, lesson banner, pause sheet, toasts, captions |
| `native/render.ts` | The desk on `starhermit:scene`: lights, props, tiles with canvas-drawn faces, tweens, sparks, motes, camera framing, picking |
| `native/quality.ts` | Graphics level → the old presets and budgets |
| `native/audio.ts` | Clips per event, the rendered room tone and pluck stem, captions |
| `native/platform.ts` | Save (progress) with merge and the browser build's foreign save, game options as engine settings with legacy import, device store, player, invite, clock, leaderboard read and score post |
| `native/i18n.ts`, `native/style.ts`, `native/game.ts` | Language from the runtime; UI tokens per theme / palette / contrast; typed facade over the `js/` modules |
| `js/rules/rng.js` | `hashString` (FNV-1a) and `makeStream` (mulberry32) with `state`, `int`, `range`, `pick`, `shuffle`, `fork` |
| `js/rules/engine.js` | Pure rules: board construction, exposure, legal pairs, command validation/application, scoring, terminal states, serialization, `stateHash`, tie-breaks |
| `js/rules/content.js` | Layouts, solvable board generation, 44 journey stages, daily rotation, 4 practice presets, 6 challenges, 5 lessons, 5 themes |
| `js/rules/validate.js` | Offline solvability proof (`proveSolvable`) and `findSolutionPath`, used by the tests and the play-script generator |
| `js/rules/replay.js` | Replay envelope: schema/build/content versions, command log, checkpoint hashes, `verifyReplay` |
| `js/store.js` | Progress record and `mergeProgress`, the game's options, the browser build's cloud save reader, the checksummed device store (boards, snapshots, replays) |
| `js/i18n/strings.js`, `js/i18n/i18n.js`, `js/lang.js`, `js/sh-strings.js` | Translation tables (nine locales), the runtime (`NMI18N`), `T`/`N` for the modules, account strings |
| `tools/ui-style.css` → `assets/ui-style.json` | The old `css/main.css`, class-based, converted with `starhermit css` (`npm run css`) |
| `tools/gen-plays.mjs`, `tools/browser-play.mjs`, `tools/package-web.mjs` | Play-script generator, browser check, web loader + file index |
| `score-script.js` | StarHermit platform script (`server=`): range-checks a finished round's total and posts it to the `high-score` board |
| `server.js` | Local static host (development only; not in the package) |
| `sfx/` | 37 Opus clips and their manifests |
| `assets/` | `title-backdrop.webp`, `tile-stack.webp`, `ui-style.json` |

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
5. **Two boards, one truth.** The 2D board is not a degraded mode; it is the same state rendered
   with buttons, and the 3D tiles carry the same names for assistive technology. *Rules in:* identical labels,
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
the original state with a `rejected` event, which `native/main.ts` surfaces as an error toast plus `invalid`.

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
(`native/main.ts` `showResults`: 1 star for the win, +1 for `total ≥ par.score`, +1 for `elapsedMs ≤ par.timeMs`).

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
decoration (`'deco-scene'`, `'star-chart'`, `'tile-<value>'` in `native/render.ts`), and audio variants
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

**Progression state** (`js/store.js` `DEFAULT_PROGRESS`): per-stage stars/bestScore/bestMs/completions,
lesson completion, achievement unlock timestamps, `masteryXp` (`10 + 15 if mastery + 2 × stars` per
win), daily history per ISO date, and lifetime totals. Eight achievements (`native/main.ts` `ACHIEVEMENTS`):
First Light, Every Instrument, Steady Hand, Surveyor, Cartographer of Skies, Zenith, Weekly Watcher,
Long Exposure.

---

## 6. Controls and interaction

| Input | Action |
| --- | --- |
| Tap / click a tile on the 3D desk | First tap selects; second tap attempts the pair (`main.ts` `chooseTile`); the tile is picked by a ray from the press |
| Tap the selected tile | Deselects |
| Drag on the board (> 14 px) | Not a tap: plays `drag-start`, then `drop` on release, no tile chosen |
| Long press (> 0.6 s) | Ignored as a tap |
| Arrow keys / D-pad / left stick (`left` `right` `up` `down`) | Move focus between exposed tiles by grid direction, with wrap (`moveFocus`); a focus chip shows the tile's value on the 3D desk |
| Enter / Space / Num Enter, pad South (`choose`) | Choose the focused tile |
| Esc, pad East (`back`) | Cancel the selection → pause; resumes when paused |
| P, Start (`pause`) · H, North (`hint`) · R (`reshuffle`) · U, West (`undo`) · C, right stick press (`camera`) | Pause · Hint · Reshuffle · Undo · reset the camera |
| Hint / Shuffle / Undo buttons, the pause button | The same as their keys |

Keys and pad buttons are the manifest's defaults; players rebind them in the runtime's controls (Settings ›
Change controls, or Options). Help and Settings show the effective keys (`bindingLabel`).

**Input locking.** Commands are accepted only while the phase is `active`. The countdown, the resolve
settle (45 fixed steps = 750 ms; 4 under reduced motion) and the results are the only non-interactive
phases. A hidden window (`onSuspend`) pauses an active round and quiets the stems.

**Feedback for every input.** Selection: tile lift + ring + `select` + a live announcement with the
partner hint. Invalid pair: red flash and shake + `invalid` + an error toast naming both values and the
rule. Legal pair: `pair` or a chain cascade, spark burst, `expose` when a covered tile is freed,
`target-shift` in dynamic rounds. The pointer cursor turns to a hand over exposed tiles; menu buttons play
a throttled `hover` tick and scrolling lists a `scroll-tick`.

---

## 7. Screens and UI flow

```
title ─┬→ setup → (countdown → active ⇄ paused) → resolving → results ─┬→ setup (Next)
       ├→ journey / practice / challenges / learn → setup              ├→ score chase
       ├→ settings / help / score chase → back                         └→ title
       └→ resume interrupted round → active
```

The pause sheet is a modal dialog over the round (Resume / Settings / Help / Restart round / Leave round);
Settings and Help opened from it come back to it. Leave round records a `quit` and shows the results
("Round Left").

**Layout** (`native/screens.ts`, picked by the window's logical size). The HUD band across the top holds the
rule label and target dial, pairs (and moves) left, the timer with its bar, the score with the chain line
and the pause button; the 3D desk draws below it (the camera is offset into that rectangle). The action
rail sits at the right middle (left with *Left-handed controls*); at ≤ 720 px wide in portrait it is a
bottom tray with glyphs and counts only; at ≤ 500 px tall in landscape a narrow rail. Menus are a centred
column up to 980 px that scrolls when taller; toasts sit at the top on menus and above the tray in play.
The runtime's UI scale replaces the old `ui-scale.js`.

---

## 8. Art direction

**Palette.** Five cosmetic themes (`content.js` `THEMES`), each supplying scene colours plus a CSS
block. `ivory-dusk` is the default: page `#171a24`, panel `#232838`, ink `#ece4d4`, accent `#e8b34b`,
muted `#9b94a8`, tile `#f3ead8` with edge `#d8cbb2` and tile ink `#3b3230`, desk `#3a2f28`, felt
`#2e4038`, sky `#1b2233`. The others shift the whole set: `emerald-archive` (accent `#63c98a`),
`crimson-meridian` (`#f0705e`), `frost-zenith` (`#6cb8e8`), `gilded-eclipse` (`#d9a441`). Danger is
`#e0604f` throughout. Themes are cosmetic only — never hitboxes, timing, or power.

**Shape language.** Rounded rectangular slabs (1.0 × 0.34 × 1.3 units, 0.16 gap) with warm ivory
faces and a hand-drawn number; brass cylinders and dark wood for props; soft 14 px radii in the UI.

**Typography.** Headings and the objective use a serif stack (`Iowan Old Style`, `Palatino`, Georgia);
body and controls use the system UI stack. Tile numbers are drawn into a canvas texture per value with
a seeded ink jitter so no two values look mechanically identical.

**Motion.** A small authored tween manager (duration + easing + interruptible + `settle()`); tiles
lift, drift and fade on removal, deeper tiles rise into their new top position. `settleImmediately()`
snaps every tween and clears particles to the exact deterministic end state before results. Reduced
motion removes the countdown, screen-in animation, particle bursts and the results art.

**Hero.** The lit felt with its ivory terraces. The desk, lamp, telescope, star chart and books sit
outside the play area, dimmer and out of focus, and are dropped entirely at `plain` scene detail
(the Low preset).

**Graphics.** A warm key light with PCF shadows whose box is fitted to the current board, a hemisphere
fill and an oil-lamp point light (three.js r160 intensities), ACES
filmic tone mapping. On detailed looks the tiles are rounded two-ply slabs (ivory face over a jade backing
layer) with clear coat and engraved numerals (a bump map from the same canvas), the desk has procedural
wood grain, the felt a fibre texture, and the props gain an oil lamp with a flickering flame, telescope
bands and paged books. Reflections light each PBR material from a `RoomEnvironment` through
`PMREMGenerator`, each material keeping its r160 `envMapIntensity` (it takes the environment as its own
map). Selection and hint tints use the face texture as their emissive map, so the numeral stays dark while
the ivory lights up; the selection ring and pair-removal sparks are HDR so they bloom. Post effects are the
engine's: `renderer.ao` (GTAO contact darkening), `renderer.bloom` (threshold 1.3, above lit ivory),
`renderer.grade` (the old GradeShader: S-curve 0.18, saturation 1.08, warm highlights / cool shadows,
vignette 0.26) and `renderer.antialias` (FXAA, SMAA or MSAA). Ambient motion drifts dust motes through
the lamp light and flickers the flame; it stops under reduced motion.

**Graphics levels** (`native/quality.ts`). The runtime's Options › Graphics chooses the level (Auto or one of
ten, `frame().quality` / `frame().levelIndex`); the game keeps the browser build's four presets per tier and
their budgets (each tuned to hold 60 FPS on the weakest GPU Auto gave it). Render scale, the pixel-ratio cap,
adaptive resolution, the frame-rate limit and the FPS readout are the runtime's; the old per-effect overrides
are not offered. Tiles, layout, hit areas and rules are identical on every level.

| Budget | Low | Balanced | High | Ultra |
|---|---|---|---|---|
| Shadows / AO / bloom / grade / AA | off / off / off / off / off | 1024² / off / on / on / FXAA | 2048² / on / on / on / SMAA | 4096² / high / on / on / MSAA |
| Reflections, detail (props, rounded tiles, textures), ambient motion | off | on | on | on |
| Tile shading | Lambert | Standard | clear-coated Physical | as High |
| Tile-face texture (height 1.25×; plain faces 128 px) | 128 px | 256 px | 256 px | 512 px |
| Engraved-numeral bump map | no | no | yes | yes |
| Desk-wood texture (felt ½) | 256 px | 256 px | 512 px | 1024 px |
| Spark pool (Low none; Balanced 30 %) | — | 140 | 200 | 300 |
| Dust motes | 40 | 60 | 90 | 150 |
| Bloom / GTAO resolution | ½ | ½ | ½ | full |

Spark and mote counts grow within a tier with the level above its first (≤ 2×, at most 600 / 300).


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
that fires roughly every 0.9-2.3 s and goes silent while the window is hidden or the round paused.

**Playback** (`native/audio.ts`). `play(event)` plays the event's Opus clip on the runtime's mixer: menu
sounds on the `interface` bus, the rest on `effects`. The clips load once the mixer runs (natively at once,
in a browser after the first press), one at a time; a clip still loading is silent (the browser build's
procedural fallback voices are not ported: a live synthesis graph makes clip loads fail on the web
runtime). The room tone and the plucks are rendered into clips once (a slice a frame) and play on the
`music` bus (the runtime has no ambience bus: the room tone's gain folds in the old 0.4 ambience against
0.5 music); the 0.07 Hz swell is a fade each frame, the plucks follow the seeded timer. Volumes, mute and
the voice limit are the runtime's Options. Every event returns a caption for the *Sound captions* option.


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

**Languages:** en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT — every player-facing
string ships in all nine. Numerals, seeds, scores and times are formatted only at presentation time.

**Where strings live:** `js/i18n/strings.js` holds the tables keyed by the English source text (en-GB,
es-ES and fr-CA list only their differences). `js/i18n/i18n.js` (`NMI18N`, loaded with `loadClassic`)
looks them up; `js/lang.js` gives the content modules `T` / `N`; the engine's `REJECT` reasons stay English
codes that the UI translates. In node the keys come back unchanged, so rules, replays and hashes are
language-independent. Account strings live in `js/sh-strings.js`.

**Language setting:** the runtime's Options › Language (the player's choice, else the account's preferred
language, else the device's), mapped to the nearest shipped locale (es-MX → es-419, en-AU → en-GB,
fr → fr-FR, pt-PT → pt-BR). Every string is drawn through `T()` each frame, so a change shows at once
without ending a round.

---

## 11. Accessibility

- **Keyboard and pad.** Every screen and a whole round work with Tab, arrows, Enter/Space and Esc (or the
  pad); each screen focuses its first control, the pause sheet focuses **Resume**.
- **Screen readers.** Every 3D tile on top of a stack is an accessibility target named like the old 2D
  mirror ("tile 4, row 1 column 3, top of stack", "covered tile, row 2 column 1"); live announcements carry
  selection with the partner hint, pair results, hints, reshuffles, undo, resume, board summaries and the
  round's result.
- **2D board.** Settings › *Use 2D board instead of 3D* draws the same state as rows of tile buttons (each
  stack from the bottom up; covered tiles dimmed and disabled; locked tops dashed; the selection lifted and
  outlined; hinted tiles with a thin double ring) and turns the 3D desk off. It applies at the next round.
- **Captions.** *Sound captions* prints `♪ pair removed`, `♪ chain ×4`, `♪ target changed`, … for 1.4 s.
- **Contrast and palette.** The runtime's high contrast darkens the panels, thickens lines and drops the
  decorative images; four colour-vision palettes (standard, deuteranopia, protanopia, tritanopia) move
  the accent. Selection and hint states are never colour-only.
- **Motion.** The runtime's reduced motion removes the countdown, the tweens and the results art, and
  shortens the resolve settle.
- **Text size and targets.** The runtime's text size and UI scale apply to every screen; action buttons
  are at least 44 px; the 2D tiles grow with larger text. *Timing assistance* multiplies every round
  timer by 1.5 and is recorded in the round's `assists` string.

---

## 12. StarHermit integration

`starhermit.txt` declares `name`, `description`, `owner`, `server=score-script.js`, `version`, `cover`,
`launch=index.html` (the web loader `npm run package` writes), `engine.api=1`, `engine.entry=native/main.ts`,
`engine.version=1.28.0`, `engine.minor=30`, `engine.capabilities=platform,storage,clipboard`, and a
`control.<action>` and `engine.gamepad.<action>` default for every action.

- *Player* — the runtime signs players in (`player()`); the title offers **Sign in with StarHermit**
  (`requestSignIn`) to guests and **Invite a friend** (copies `inviteLink()`) when signed in. The account
  chip on menus shows the avatar, the display name and the save's sync state. A session that ends
  ("signed out — playing locally") keeps the game running as a guest.
- *Cloud save* — the progress is the engine save (`saves`, schema 1: `{ v, progress }`) on the device and
  in the account; a conflict merges both sides with `mergeProgress` (per stage the better stars/score,
  faster time, more completions; union of lessons, achievements with the earliest unlock and daily
  history; the better challenge score; the larger totals). The browser build's slot (`game:<slug>`,
  `{ version, savedAt, progress, settings }`) shows as foreign: its progress is merged in, its game
  options adopted, and it is replaced once (`replaceForeign`).
- *Settings* — the game's own options (board view, 2D board, cosmetic theme, colour-vision palette,
  left-handed controls, sound captions, timing assistance) are engine `settings`, kept with the account.
  The browser build's per-player KV values for those keys are adopted unless set since; all its old keys
  (volumes, mute, graphics, reduced motion, high contrast, larger text, gamepad remaps, `ui.language`) are
  removed — those are the runtime's Options and controls now.
- *Leaderboard* — every finished Daily round (won or lost) and every won Challenge posts its total through
  `score-script.js` (a practice session whose game socket carries `{ type: 'result', scores: { 'high-score':
  total } }`); the script range-checks it and posts to `high-score`. The results show "Posting score to the
  leaderboard…", then "Leaderboard rank: #N" (or posted / not posted). Score Chase lists the board's top
  ten. Journey, Practice and Learn post nothing.
- *Clock* — the Daily's UTC day comes from the platform clock when it has answered (`serverNow`), else
  the device's.
- *Not used* — matchmaking, rooms, chat, voice, replays and platform achievements (achievements are
  local, in the save).

---

## 13. Technical architecture

**Module boundaries.** `js/rules/*` is pure and shared unchanged with the node tests; `native/main.ts` is the
only module that dispatches commands; `screens.ts` and `render.ts` read immutable snapshots plus event
lists and never mutate rules state. Widget presses run after the frame's UI is built (`later`).

**Time.** The session clock advances 1000/60 ms per fixed step (60 Hz) while a round is active; commands
carry `atMs` from it; the countdown (39 steps a number, 27 for "Observe") and the resolve settle count
steps. Pauses and a hidden window cost no time, and play scripts replay exactly.

**Determinism and replay.** `openReplay` / `recordCommand` / `closeReplay` as before (checkpoint hash every
8 commands and at the end); the last replay per content is kept on the device (at most 60).

**Persistence.** The engine save holds the progress; the device store (`js/store.js` over
`starhermit:storage` `storage`) keeps `number-mahjong.session.<id>` snapshots (written after every
command, cleared on results, offered back on the title as **Resume interrupted round**),
`.replay.<id>` and `.board.<key>` local boards, each `{body, sum}` with an FNV-1a checksum (a mismatch
reads as absent; a refused write stays in memory for the session).

**Performance.** Textures are drawn once per value / look into `OffscreenCanvas`es; materials are rebuilt
only when the look or theme changes; the 3D scene draws only in the round's view (menus and the 2D board
turn the camera off).

---

## 14. Testing and acceptance criteria

`npm test` runs:

- `tests/run-tests.mjs` (87 assertions): RNG determinism, construction, exposure and side-lock, every
  legal action and rejection, scoring, undo/hint/reshuffle, terminals, limits, dynamic targets,
  serialization, replay determinism and tamper detection, fuzzing, solvability of every journey stage,
  lesson, challenge, practice preset and 60 dailies, golden sessions, tie-breaks, the device store's
  quota fallback.
- `tests/store.test.mjs`: progress merge, normalization, the browser build's cloud save and options,
  option validation, local board order, the replay cap.
- `tests/i18n.test.mjs`: every key the client uses translated in every locale with placeholders intact,
  no unused rows, content texts, live switching, account strings.
- `tests/native.mjs`: the web index up to date, `tsc`, `starhermit check .` with zero warnings, and every
  `tests/native/*.play` as a signed-out render check: `journey-1` (menus, hint, pause with Settings and
  Help, undo, the board cleared on the 3D desk, three stars, the next stage), `lesson-phone` (390×844@3 by
  touch, the lesson banner's steps), `challenge-landscape` (844×390@3, the Sprint cleared with a time
  bonus), `board2d-keyboard` (the 2D board, a tile chosen by arrows and Enter), `daily-practice` (the
  Daily left from the pause sheet, an Expert practice reshuffled, the camera reset, restart and leave).
  The scripts are generated from the solver (`npm run plays`).

`npm run test:browser` (`tools/browser-play.mjs`) plays the packaged web build in Chrome on the GPU at
1280×800 (stage 1 by mouse, a drag, a hint, the pause sheet), 390×844 at DPR 3 (lesson 1 by touch) and
844×390 at DPR 3 (the Sprint by touch), failing on console errors or warnings.

---

## 15. Asset inventory

| Path | Purpose | Source |
| --- | --- | --- |
| `assets/title-backdrop.webp` | Title key art (1280×720), behind the menu under a scrim | FLUX.2 klein, seed 70414 |
| `assets/tile-stack.webp` | Results banner (960×538) | FLUX.2 klein, seed 31877 |
| `assets/ui-style.json` | UI styles converted from `tools/ui-style.css` | `npm run css` |
| `cover.jpg`, `coverart.png`, `icon.png`, `favicon.png`, `favicon.svg` | Cover and marks | generated / authored |
| `sfx/*.opus` | The SFX event table (§9) | MOSS-SoundEffect v2.0 |
| Tile faces, star chart, felt, desk, props | In-scene visuals | procedural (canvas textures + scene primitives, seeded) |
| Music and room tone | Generative pentatonic plucks, brown-noise room tone | rendered into clips at start |

---

## 16. Known limitations

- **Local leaderboards stay on the device.** Signed in, Daily rounds and won Challenges reach the platform
  `high-score` board (range-checked by `score-script.js`, not replay-verified: the user's decision for solo
  scores); every other board is local.
- **Guests' old browser progress does not migrate** (it lived in the old page's localStorage); signed-in
  players' cloud saves do.
- **The old Graphics panel's per-effect overrides** are not offered: the runtime's graphics level chooses
  the look.
- **Procedural fallback voices** are gone: a sound whose clip is still loading is silent.
- **The pad's B button** (East) is the `back` action: it deselects or pauses, where the browser build's B
  only deselected.
- **Hints are not ranked by quality**: `hint` always returns `legalPairs(state)[0]`.

## Design intent not yet implemented

- **`tutorialSeen`, `sessionsPlayed`, `bestStreakDays`** are in the progress record but never written to.
- **Hold to confirm** (a stored-but-dead browser setting) is not ported.
