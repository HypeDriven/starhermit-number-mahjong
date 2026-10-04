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
  const calls = [], saves = {}, kv = {};
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push([method, url]);
    const r = (status, body) => new Response(body == null ? null : body, { status });
    if (url.includes('/cloud-saves/')) {
      const key = decodeURIComponent(url.split('/cloud-saves/')[1]);
      if (method === 'PUT') { saves[key] = Buffer.from(JSON.parse(init.body).dataBase64, 'base64'); return r(200, '{}'); }
      return saves[key] ? r(200, saves[key]) : r(404);
    }
    if (url.endsWith('/profile')) return r(200, JSON.stringify({ username: 'u', nickname: 'Tess' }));
    if (url.endsWith('/settings') && method === 'PATCH') { Object.assign(kv, JSON.parse(init.body).settings); return r(200, '{}'); }
    if (url.endsWith('/settings')) return r(200, JSON.stringify({ settings: kv }));
    if (url.endsWith('/controls')) return r(200, JSON.stringify({ actions: [{ action: 'hint', codes: ['KeyJ'] }] }));
    if (url.endsWith('/api/v1/time')) return r(200, JSON.stringify({ now: Date.now() + 60000 }));
    return r(404);
  };
  return { calls, saves, kv, fetch };
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
