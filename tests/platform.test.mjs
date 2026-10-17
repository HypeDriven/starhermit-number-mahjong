// Platform adapter over the shared StarHermit SDK: launch token, profile
// name, game:<slug> cloud-save round-trip, settings KV, controls, and no
// network at all when standalone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Load the shipped SDK copy as a classic script (the package is ESM).
const sdkModule = { exports: {} };
new Function('module', 'self', fs.readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8'))(sdkModule, globalThis);
const SDK = sdkModule.exports;
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = 'h.' + b64u({ sub: 'user-123456', game_scope: 'nm-slug', exp: Math.floor(Date.now() / 1000) + 3600 }) + '.s';

// SDK renewal timers must not keep the test process alive.
const unrefTimeout = (f, ms) => { const t = setTimeout(f, ms); t.unref(); return t; };

function fakeServer() {
  const calls = [], saves = {}, kv = {}, versions = {};
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const headers = init.headers || {};
    calls.push([method, url, headers['If-Match']]);
    const r = (status, body) => new Response(body == null ? null : body, { status });
    if (url.includes('/cloud-saves/')) {
      const rest = decodeURIComponent(url.split('/cloud-saves/')[1]);
      if (rest.endsWith('/info')) {
        const k = rest.slice(0, -5);
        return r(200, JSON.stringify(saves[k] ? { exists: true, etag: `"v${versions[k]}"` } : { exists: false }));
      }
      const key = rest;
      if (method === 'PUT') {
        // writes are conditional on the version the client last read (ETag)
        const cur = saves[key] ? `"v${versions[key]}"` : null;
        if (headers['If-Match'] && headers['If-Match'] !== cur) return r(412, JSON.stringify({ error: 'precondition failed', etag: cur }));
        if (headers['If-None-Match'] === '*' && saves[key]) return r(412, JSON.stringify({ error: 'precondition failed', etag: cur }));
        saves[key] = Buffer.from(JSON.parse(init.body).dataBase64, 'base64');
        versions[key] = (versions[key] || 0) + 1;
        return r(200, JSON.stringify({ etag: `"v${versions[key]}"` }));
      }
      return saves[key] ? r(200, saves[key]) : r(404);
    }
    if (url.endsWith('/profile')) return r(200, JSON.stringify({ username: 'u', nickname: 'Tess' }));
    if (url.endsWith('/settings') && method === 'PATCH') { Object.assign(kv, JSON.parse(init.body).settings); return r(200, '{}'); }
    if (url.endsWith('/settings')) return r(200, JSON.stringify({ settings: kv }));
    if (url.endsWith('/controls')) return r(200, JSON.stringify({ actions: [{ action: 'hint', codes: ['KeyJ'] }] }));
    if (url.endsWith('/api/v1/time')) return r(200, JSON.stringify({ now: Date.now() + 60000 }));
    return r(404);
  };
  // Another device writes the slot (bumps the version behind this client's back).
  const writeElsewhere = (key, doc) => { saves[key] = zipStored(JSON.stringify(doc)); versions[key] = (versions[key] || 0) + 1; };
  return { calls, saves, kv, fetch, writeElsewhere };
}

/* A minimal stored (uncompressed) zip with one save.json entry, as the platform serves it. */
function zipStored(text) {
  const data = Buffer.from(text, 'utf8');
  const name = Buffer.from('save.json');
  let c = ~0;
  for (const b of data) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  const crc = (~c) >>> 0;
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

function install(hash, srv, hostname = 'nm-slug.starhermit.com') {
  const win = {
    location: { hash, search: '', pathname: '/', hostname, origin: 'https://' + hostname, href: 'https://' + hostname + '/' },
    history: { replaceState() {} },
    addEventListener() {},
  };
  win.StarHermit = SDK.create({ window: win, fetch: srv.fetch, setTimeout: unrefTimeout });
  globalThis.window = win;
  globalThis.location = win.location;
  globalThis.fetch = srv.fetch; // any direct request is counted too
  return win;
}

test('hosted: token, profile, cloud save game:<slug>, settings, controls', async () => {
  const srv = fakeServer();
  install('#game_token=' + token, srv, 'nm-slug.starhermit.com');
  const P = await import('../js/app/platform.js?hosted');
  assert.equal(P.readLaunchToken(), true);
  assert.equal(P.platform.userId, 'user-123456');
  assert.equal(P.platform.slug, 'nm-slug');
  assert.equal(await P.loadProfile(), 'Tess');

  P.scheduleCloudSave({ version: 1, savedAt: 5, progress: { journey: { a: 1 } } });
  assert.equal(await P.flushCloudSave(), true);
  assert.deepEqual(Object.keys(srv.saves), ['game:nm-slug']);
  assert.deepEqual(await P.loadCloudSave(), { version: 1, savedAt: 5, progress: { journey: { a: 1 } } });

  P.patchPlatformSettings({ muted: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(srv.kv.muted, true);
  assert.deepEqual(await P.getPlatformSettings(), { muted: true });

  assert.deepEqual(await P.loadBindings({ hint: ['KeyH'], undo: ['KeyU'] }), { hint: ['KeyJ'], undo: ['KeyU'] });
  assert.ok(P.inviteLink().endsWith('/game-invite/user-123456/nm-slug'));
  assert.equal(P.canSignIn(), false);
  // the client never posts scores; the platform clock is read only signed in
  assert.equal(P.submitVerifiedScore, undefined);
  assert.equal(await P.syncServerTime(), true);
  assert.ok(P.platform.serverOffsetMs > 50000);
  assert.ok(!srv.calls.some(([, u]) => /\/scores/.test(u)));
});

test('standalone: no token means no platform fetch at all', async () => {
  const srv = fakeServer();
  install('', srv, 'localhost');
  const P = await import('../js/app/platform.js?standalone');
  assert.equal(P.readLaunchToken(), false);
  assert.equal(await P.loadProfile(), null);
  assert.equal(await P.loadCloudSave(), null);
  P.scheduleCloudSave({ v: 1 });
  await P.flushCloudSave();
  P.patchPlatformSettings({ muted: true });
  assert.equal(await P.getPlatformSettings(), null);
  assert.deepEqual(await P.loadBindings({ hint: ['KeyH'] }), { hint: ['KeyH'] });
  assert.equal(P.inviteLink(), null);
  assert.equal(P.canSignIn(), false);
  assert.equal(await P.fetchOnlineBoard(), null);
  assert.equal(await P.syncServerTime(), false); // device clock, no request
  assert.equal(P.platform.serverOffsetMs, 0);
  assert.equal(srv.calls.length, 0);
});

test('hosted: a save conflict reloads the cloud copy, merges it (onConflict) and saves the merge', async () => {
  const srv = fakeServer();
  install('#game_token=' + token, srv, 'nm-slug.starhermit.com');
  const P = await import('../js/app/platform.js?conflict');
  const { mergeProgress } = await import('../js/app/storage.js');
  assert.equal(P.readLaunchToken(), true);
  assert.equal(await P.loadCloudSave(), null); // empty slot: the first write is If-None-Match: *
  const mine = { version: 1, journey: { 'journey-01': { stars: 3, bestScore: 400, bestMs: 30000, completions: 2 } }, lessons: { 'lesson-sum': { completed: true } }, achievements: { 'first-clear': 50 }, masteryXp: 30, dailyHistory: {}, totals: { pairs: 20, wins: 2, plays: 3 } };
  P.scheduleCloudSave({ version: 1, savedAt: 1, progress: mine });
  assert.equal(await P.flushCloudSave(), true);
  srv.writeElsewhere('game:nm-slug', { version: 1, savedAt: 2, progress: { version: 1, journey: { 'journey-01': { stars: 2, bestScore: 450, bestMs: 40000, completions: 1 }, 'journey-02': { stars: 1, bestScore: 300, bestMs: 50000, completions: 1 } }, achievements: { 'first-clear': 10, 'streak-3': 20 }, masteryXp: 25, dailyHistory: { '2026-10-16': { score: 900, completed: true } }, totals: { pairs: 40, wins: 3, plays: 5 } } });
  let merged = null;
  P.platform.onConflict = (remote) => { merged = mergeProgress(mine, remote.progress); return { version: 1, savedAt: 3, progress: merged }; };
  P.scheduleCloudSave({ version: 1, savedAt: 2, progress: mine });
  assert.equal(await P.flushCloudSave(), false); // refused: another device saved first
  for (let i = 0; i < 20 && !merged; i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(merged.journey['journey-01'], { stars: 3, bestScore: 450, bestMs: 30000, completions: 2 });
  assert.ok(merged.journey['journey-02']);
  assert.deepEqual(merged.achievements, { 'first-clear': 10, 'streak-3': 20 });
  assert.equal(merged.masteryXp, 30);
  assert.deepEqual(merged.totals, { pairs: 40, wins: 3, plays: 5 });
  assert.equal(merged.dailyHistory['2026-10-16'].score, 900);
  const puts = srv.calls.filter(([m, u]) => m === 'PUT' && u.includes('cloud-saves'));
  assert.equal(puts.at(-1)[2], '"v2"');
  assert.deepEqual((await P.loadCloudSave()).progress, merged);
});
