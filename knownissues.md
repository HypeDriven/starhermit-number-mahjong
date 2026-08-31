# Known Issues — Number Mahjong

QA pass 2026-08-20. Static review driven by Qwen3.8 27B on `worker186` (HauhauCS Q3_K_P, 16k ctx),
alongside the game's own unit tests, its headless-Chrome browser suite, and live probing of the server.

## Test results

| Check | Result |
| --- | --- |
| `npm test` (`node tests/run-tests.mjs`) | 78/78 pass — `ALL TESTS PASSED` |
| `node --check` on all modules (`js/**/*.js`, `server.js`, `tests/*.mjs`) | clean |
| `tests/browser-test.mjs` (headless Chrome, served on :39407) | **PASS** — 29/29 assertions, `BROWSER TESTS PASSED`, 0 console errors |
| `tests/e2e.mjs` | not present (`tests/browser-test.mjs` is the equivalent and was run) |
| Corrupt-`localStorage` sweep (8 corruptions × 2 keys, reload each time) | PASS — no page errors, game still renders every time |
| Full-`localStorage` (quota-exceeded) play-through | PASS — no page errors during boot or a played round |
| Rapid-input + resize stress (90 key presses, 40 clicks, 5 viewport changes, 8 pause toggles) | PASS — 0 console errors |

## Confirmed defects

All six were **fixed on 2026-08-26** (see each item for the fix note). The three crash defects were
originally reproduced against the running server on port 39407 and produced a stack trace
in the server log each time; after the fix they return 4xx and the process stays alive (re-verified
on 39407: defect 1 → 422, defect 2 → 400, defect 3 → 422, server still serving afterwards).

### 1. One malformed score submission kills the server process

- **File:** `server.js:54` (`verifySubmission`) — `if (replay.contentId.startsWith('daily-')) {`
- **Trigger:** a single unauthenticated request:

  ```
  POST /api/v1/scores
  {"board":"qa","entry":{"score":1},"replay":{"contentVersion":1}}
  ```

- **Behaviour:** `replay.contentId` is never type-checked (only `entry`/`replay` presence and
  `contentVersion` are), so `.startsWith` throws `TypeError`. `verifySubmission` is called from the
  `async` request listener at `server.js:101` with no `try`/`catch` anywhere in the chain, so the
  rejection is unhandled and Node 22 terminates the process. Complete denial of service from one request.
  `contentId: 123` (any non-string) does the same.
- **Expected:** malformed submissions must be answered `422`, which is exactly what the surrounding code
  does for every other bad input.
- **Evidence:** live server log —

  ```
  file:///home/albert/games/number-mahjong/server.js:54
    if (replay.contentId.startsWith('daily-')) {
                         ^
  TypeError: Cannot read properties of undefined (reading 'startsWith')
      at verifySubmission (file:///home/albert/games/number-mahjong/server.js:54:24)
      at Server.<anonymous> (file:///home/albert/games/number-mahjong/server.js:101:21)
  ```

  and the connection returned `HTTP=000` with the port dead afterwards.
- **Fixed (2026-08-26):** `verifySubmission` now rejects non-string `replay.contentId` with
  `{ ok: false }` (→ 422) before any `startsWith`, and the `verifySubmission` call in the request
  listener is wrapped in `try`/`catch` so any future verifier throw is answered 422 instead of
  taking the process down.

### 2. A malformed percent-escape in the URL path kills the server process

- **File:** `server.js:119` — `let rel = decodeURIComponent(url.pathname);`
- **Trigger:** `GET /%E0%A4%A HTTP/1.1` (any incomplete percent-escape).
- **Behaviour:** `decodeURIComponent` throws `URIError: URI malformed` in the same unguarded `async`
  listener; the process exits. A second, independent one-request DoS.
- **Expected:** a 400/404 response.
- **Evidence:** live server log —

  ```
  URIError: URI malformed
      at decodeURIComponent (<anonymous>)
      at Server.<anonymous> (file:///home/albert/games/number-mahjong/server.js:119:13)
  ```

  Three of the eight games reviewed in this batch share this bug (`open-cells`, `glow-strikers`,
  `number-mahjong`); `gravity-hollow` decodes inside a `try`/`catch` and survives, and `market-manager`
  / `metro-dash` never decode the path.
- **Fixed (2026-08-26):** `decodeURIComponent` at `server.js` static section is wrapped in
  `try`/`catch` and answers `400 bad path` on a malformed escape.

### 3. A replay envelope without `checkpoints` also kills the server process

- **File:** `js/rules/replay.js:68` (`verifyReplay`) — `const checkpoints = new Map(envelope.checkpoints.map(c => [c.at, c.hash]));`
- **Trigger:** a POST that gets past the content lookup but omits `checkpoints`:

  ```
  POST /api/v1/scores
  {"board":"qa","entry":{"score":1},
   "replay":{"contentVersion":1,"contentId":"daily-2026-08-20","schema":1,"initialHash":"x"}}
  ```

- **Behaviour:** `verifyReplay` dereferences `envelope.checkpoints` (and, a line later,
  `envelope.commands.length`) with no guard. The `TypeError` propagates through
  `verifySubmission` (`server.js:67`) and the unguarded `async` listener (`server.js:101`); the process
  exits. A third one-request DoS on the same endpoint, reachable even after defect 1 is fixed, because
  `contentId` is now well-formed.
- **Expected:** the function's contract is "Returns { ok, errors, finalState }" — a malformed envelope
  is exactly the tampering it exists to catch, and should produce `{ ok: false, errors: [...] }`.
- **Evidence:** live server log —

  ```
  TypeError: Cannot read properties of undefined (reading 'map')
      at verifyReplay (file:///home/albert/games/number-mahjong/js/rules/replay.js:68:52)
      at verifySubmission (file:///home/albert/games/number-mahjong/server.js:67:18)
      at Server.<anonymous> (file:///home/albert/games/number-mahjong/server.js:101:21)
  ```
- **Fixed (2026-08-26):** `verifyReplay` now checks `Array.isArray(envelope.checkpoints)` /
  `Array.isArray(envelope.commands)` and returns
  `{ ok: false, errors: ['malformed envelope: missing checkpoints or commands'] }` (→ 422).

### 4. No rate limiting on any API route

- **File:** `server.js:81-131` (the whole request handler)
- **Trigger:** repeated POSTs to `/api/v1/scores`.
- **Behaviour:** there is a payload bound (`raw.length > 256 * 1024`) but no per-identity or per-IP rate
  limiting, no identity at all, and no cap on submissions per board beyond the 100-entry truncation.
  Each accepted submission also does a full replay through the engine and a synchronous board rewrite.
- **Expected:** `spec.md` §5 — "Validate all network input for identity, session membership, turn/tick,
  bounds, **rate**, payload size, and legal action." Every sibling game in this batch that accepts
  scores (`market-manager`, `open-cells`, `jewel-cascade`) implements a limiter.
- **Evidence:** no `rate`, `bucket`, `limit` or throttle logic exists anywhere in `server.js`.
- **Fixed (2026-08-26):** per-IP token-bucket limiter added to `server.js` (same pattern as
  `market-manager`): 60 requests/minute on all `/api/` routes, with score submissions costing 5;
  excess is answered `429`.

### 5. `rank` is returned 0-based and computed before truncation

- **File:** `server.js:110` — `return send(200, { ok: true, rank: entries.indexOf(entry) });`
- **Trigger:** any accepted submission.
- **Behaviour:** the first-place entry is reported as `rank: 0`. The lookup also runs against `entries`
  (the full, untruncated array) while the board that is persisted and later served is
  `entries.slice(0, 100)` — so an entry ranked 100+ reports a rank for a row that was discarded.
- **Expected:** a 1-based rank consistent with the stored board (`market-manager/server.js` and
  `open-cells/server.js` both use `findIndex(...) + 1`).
- **Evidence:** source as quoted. No user-visible impact today — `js/app/main.js` never reads the
  `rank` field from the response — so this is an API-contract defect rather than a gameplay one.
- **Fixed (2026-08-26):** the response rank is now `kept.indexOf(entry) + 1` computed against the
  persisted, truncated board (`kept = entries.slice(0, 100)`), so it is 1-based and consistent with
  what is stored (0 when the entry did not make the board).

### 6. `.server-data/` is not gitignored

- **File:** `.gitignore` (`node_modules/`, `.local-data/`, `*.log`, `.DS_Store`) vs `server.js:19`
  (`const DATA_DIR = path.join(ROOT, '.server-data');`)
- **Behaviour:** the leaderboard store is written into the working tree as untracked files containing
  player-supplied entries. The `.local-data/` entry appears to be the intended ignore rule but nothing
  writes there. `market-manager` and `open-cells` have exactly the same mismatch.
- **Expected:** the runtime data directory should be ignored.
- **Evidence:** the two paths as quoted; `server.js` does defend the *serving* side
  (`if (file.includes('.server-data')) return send(404, …)`), so the omission is clearly an oversight
  rather than intent.
- **Fixed (2026-08-26):** `.server-data/` added to `.gitignore`.

## Suspected — not confirmed

### 1. `storage.js` does not guard `localStorage.setItem` against quota errors

- **File:** `js/app/storage.js:51` — `function setItem(k, v) { if (hasLocal) localStorage.setItem(k, v); else memoryFallback.set(k, v); }`
- **Concern:** the `available()` probe runs once at module load and only proves the API exists; a later
  `QuotaExceededError` would throw out of `saveSettings` / `saveProgress` / snapshot writes into
  whatever UI handler called them. `write` in the sibling games wraps the call in `try`/`catch`.
- **Why unconfirmed:** filling `localStorage` to the quota in headless Chrome (79 × 64 KB blobs until
  `QuotaExceededError`) and then booting and playing a round produced **no** page errors, so no
  observable failure could be demonstrated.

### 2. Static-file boundary check is a string prefix, not a path boundary

- **File:** `server.js:121` — `if (!file.startsWith(ROOT)) return send(403, 'forbidden', 'text/plain');`
- **Concern:** `ROOT = path.dirname(fileURLToPath(import.meta.url))` has no trailing separator, so a
  sibling directory named `number-mahjong-something/` would satisfy the prefix test and be served.
- **Why unconfirmed:** no such sibling exists in this checkout and a live raw
  `GET /../fleet-signals/spec.md` correctly returned 404. Proving the escape would require creating a
  prefix-sharing directory in `~/games`, which was out of scope.
- **Fixed anyway (2026-08-26):** the check is now a real path boundary —
  `if (file !== ROOT && !file.startsWith(ROOT + path.sep))` — so a prefix-sharing sibling directory
  can never be served.

### 3. No `Cache-Control` on any static response

- **File:** `server.js:123-125`
- **Concern:** responses carry only `content-type`, so caching is left entirely to heuristics; the spec
  asks for "Cache immutable hashed assets and the last safe local snapshot" (§5).
- **Why unconfirmed:** absence of a header is not incorrect behaviour on its own, and the distribution
  has no hashed filenames to mark immutable anyway.

## Checked, no defects found

- **Rules engine** (`js/rules/engine.js`): 78 unit tests cover construction/exposure/legal actions,
  commands and invalid reasons, undo, hints, reshuffle, selection toggling, the no-moves terminal and
  its reshuffle escape, time and move limits, quit, dynamic targets, serialization + migration, replay
  determinism, malformed-command fuzzing, all journey stages, lessons, challenges, practice presets,
  60 days of dailies, four golden sessions and tie-break ordering — all pass.
- **Score validation** (`server.js:48`, `verifySubmission`): unlike two sibling games in this batch,
  this server rebuilds the authoritative content itself (`dailyContent(iso, …)` / `challengeContent` /
  `JOURNEY.find`) and replays against **that**, never against a client-supplied config. It also
  requires `finalState.status === 'won'` and re-checks the claimed score against the summed
  `scoreParts`. This is the correct pattern.
- **Corrupt / absent `localStorage`:** 16 reload cycles with `number-mahjong.settings` and
  `number-mahjong.progress` set to `''`, `'{'`, `'null'`, `'[]'`, `'"x"'`, `'{"v":999999}'`,
  `' garbage'` and `'{"version":-1,"data":null}'` all booted cleanly with no page errors.
- **Board key handling** (`server.js:37`): `encodeURIComponent(key)` escapes `/` and `.` sequences, so
  the 128-character board name cannot escape `DATA_DIR`.
- **Browser behaviour:** the shipped browser suite exercises the DOM board *and* the 3D canvas
  raycast input path, pause/undo/hint, the authoritative clock stopping while paused, persistence
  across reload, ranked-daily undo rejection, and tile ghosting after removal — all 29 assertions pass
  with zero console errors.

## Runtime data generated by this pass

None. `.server-data/` is only created on a *successful* submission (`saveBoard`), and every
submission attempted during this pass was rejected or crashed the process first, so the working tree
is clean apart from this file. `git status --porcelain` shows only `?? knownissues.md` (plus the
pre-existing untracked `sfx/`).

## Not tested

- **Server behaviour under concurrent submissions** — `loadBoard`/`saveBoard` do a read-modify-write
  with no locking, but no concurrency test was run.
- **Multi-day daily rollover / timezone boundaries** beyond the current UTC day.
- **Audio** (`js/app/audio.js`): headless Chrome blocks the AudioContext before a user gesture.
- **`npm run test:browser` against a non-default port** was covered by passing the base URL directly.
