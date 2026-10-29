# Number Mahjong

A calm observatory-desk puzzle: remove pairs of exposed numbered tiles whose
values satisfy the round's rule (sum target, matching twins, or exact
difference), uncovering deeper tiles as you play.

A StarHermit engine script game (engine 1.26.1, `engine.minor=28`): one package
played natively by the StarHermit client and in browsers by the engine's web
runtime. See `spec.md` for the full design.

## Run

```
export STARHERMIT=~/sh/runtime/1.26.1/starhermit-1.26.1-linux-x86_64/starhermit
$STARHERMIT .                     # play natively
npm run package                   # after every change: writes index.html + starhermit-files.json
node server.js 8080               # serve the folder for the web runtime
```

## Test

```
npm test                          # rules, store, localization, then native checks and play scripts
npm run test:browser              # the packaged web build in Chrome (desktop, phone, landscape)
npm run plays                     # regenerate tests/native/*.play from the solver
npm run css                       # tools/ui-style.css → assets/ui-style.json
```

## Layout

- `native/` — the engine client (TypeScript on the host API): flow, screens,
  the 3D desk, audio, platform, localization, styles.
- `js/rules/` — pure deterministic rules engine, seeded RNG, content
  generator + validators, replay envelopes (shared unchanged with node tests).
- `js/store.js` — progress and its merge, the game's options, the device store.
- `js/i18n/` — translation tables for nine locales.
- `score-script.js` — StarHermit platform script (`server=`) posting scores.
- `server.js` — local static host for development.
