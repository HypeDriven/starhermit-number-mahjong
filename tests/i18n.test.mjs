// Localization coverage: every English key the game's modules use is
// translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR
// inherit), placeholders survive, the tables have no unused rows, and the regional
// tables chain as the engine reads them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { codeKeys, audit } from './i18n-common.mjs';
import { JOURNEY, LESSONS, CHALLENGES, THEMES } from '../js/rules/content.js';
import { REJECT } from '../js/rules/engine.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const tables = JSON.parse(read('assets/strings.json'));

/** Keys the client draws: T()/N() in native/*.ts and the content, the sound captions, the engine's rejection reasons. */
export function usedKeys() {
  const keys = new Set();
  const files = [...readdirSync(new URL('native/', ROOT)).filter((f) => f.endsWith('.ts')).map((f) => 'native/' + f), 'js/rules/content.js'];
  for (const f of files) codeKeys(read(f), ['tr']).forEach((k) => { if (!k.startsWith('starhermit.')) keys.add(k); });
  // audio.ts CAPTIONS values reach the player through T()
  const audio = read('native/audio.ts');
  const caps = audio.slice(audio.indexOf('const CAPTIONS'), audio.indexOf('};', audio.indexOf('const CAPTIONS')));
  for (const m of caps.matchAll(/:\s*"([^"]+)"/g)) keys.add(m[1]);
  for (const r of Object.values(REJECT)) keys.add(r);
  return [...keys].sort();
}

test('every used key is translated in every locale; placeholders intact; no unused rows', () => {
  const used = usedKeys();
  assert.ok(used.length > 300, 'keys found: ' + used.length);
  assert.deepEqual(audit(tables, used), []);
});

test('every stage, lesson, challenge and theme text is a translation key', () => {
  const de = tables['de-DE'];
  const keys = [...JOURNEY.map((s) => s.name), ...LESSONS.flatMap((l) => [l.name, ...l.script.map((s) => s.text)]),
    ...CHALLENGES.flatMap((c) => [c.name, c.blurb]), ...Object.values(THEMES).map((t) => t.label)];
  for (const k of keys) assert.ok(de[k], 'de-DE missing ' + k);
});

test('regional tables inherit as the engine chains them', () => {
  const CHAIN = { 'en-GB': 'en-US', 'es-ES': 'es-419', 'fr-CA': 'fr-FR' };
  const tr = (l, k) => tables[l][k] ?? (CHAIN[l] ? tr(CHAIN[l], k) : k);
  assert.equal(tr('de-DE', 'Make {n}').replace('{n}', '10'), 'Ergib 10');
  assert.equal(tr('fr-CA', 'Score'), 'Pointage');
  assert.equal(tr('fr-CA', 'Shuffle'), 'Mélanger');
  assert.equal(tr('es-ES', 'Settings'), 'Ajustes');
});

test('the account lines the engine lacks cover the full locales', () => {
  for (const l of ['en-US', 'es-419', 'de-DE', 'fr-FR', 'pt-BR', 'it-IT']) for (const k of ['acct.signInSub', 'acct.inviteSub']) assert.ok(tables[l][k], `${l} ${k}`);
});
