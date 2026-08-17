# Number Mahjong

A calm observatory-desk puzzle: remove pairs of exposed numbered tiles whose
values satisfy the round's rule (sum target, matching twins, or exact
difference), uncovering deeper tiles as you play.

## Run

- **Any static server**: `npx serve .` or `python3 -m http.server`, then open `index.html`.
- **With the authoritative backend** (server time + verified leaderboards):
  `node server.js 8080` and open http://localhost:8080 — no dependencies required.

## Test

```
node tests/run-tests.mjs          # rules, replay, fuzz, content validation
npm --prefix tests install        # once: puppeteer-core for the e2e suite
node server.js 8123 &             # any port; browser suite needs a live host
node tests/browser-test.mjs       # headless-Chrome end-to-end
```

## Layout

- `js/rules/` — pure deterministic rules engine, seeded RNG, content
  generator + validators, replay envelopes. Runs identically in Node and the
  browser.
- `js/app/` — DOM UI shell, Three.js renderer, WebAudio engine, persistence.
- `server.js` — StarHermit authoritative script (static host, `/api/v1/time`,
  replay-validated score submission).
- `starhermit.txt` — distribution manifest (`name`, `launch`, `server`).
- `vendor/three.module.js` — pinned Three.js r160.
