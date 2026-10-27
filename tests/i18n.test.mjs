// Localization coverage: every English key the game's modules use is
// translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR
// inherit), placeholders survive, the tables have no unused rows, the locale
// switches live, and the account strings cover the nine locales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { loadTables, codeKeys, audit, bootI18n, LOCALES } from './i18n-common.mjs';
import { shStrings } from '../js/sh-strings.js';
import { JOURNEY, LESSONS, CHALLENGES, THEMES } from '../js/rules/content.js';
import { REJECT } from '../js/rules/engine.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

/** Keys the client draws: T()/N() in native/*.ts and the content, the sound captions, the engine's rejection reasons. */
export function usedKeys() {
  const keys = new Set();
  const files = [...readdirSync(new URL('native/', ROOT)).filter((f) => f.endsWith('.ts')).map((f) => 'native/' + f), 'js/rules/content.js'];
  for (const f of files) codeKeys(read(f), ['tr']).forEach((k) => keys.add(k));
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
  assert.deepEqual(audit(loadTables(ROOT, 'js/i18n/strings.js', 'NM_STRINGS'), used), []);
});

test('every stage, lesson, challenge and theme text is a translation key', () => {
  const de = loadTables(ROOT, 'js/i18n/strings.js', 'NM_STRINGS')['de-DE'];
  const keys = [...JOURNEY.map((s) => s.name), ...LESSONS.flatMap((l) => [l.name, ...l.script.map((s) => s.text)]),
    ...CHALLENGES.flatMap((c) => [c.name, c.blurb]), ...Object.values(THEMES).map((t) => t.label)];
  for (const k of keys) assert.ok(de[k], 'de-DE missing ' + k);
});

test('the locale switches live, regional tables inherit', () => {
  const { I18N } = bootI18n(ROOT, { strings: 'js/i18n/strings.js', i18n: 'js/i18n/i18n.js', global: 'NMI18N' });
  assert.equal(I18N.lang, 'en-US');
  assert.equal(I18N.setLocale('de-DE'), 'de-DE');
  assert.equal(I18N.T('Make {n}', { n: 10 }), 'Ergib 10');
  I18N.setLocale('fr-CA');
  assert.equal(I18N.T('Score'), 'Pointage');
  assert.equal(I18N.T('Shuffle'), 'Mélanger');
  I18N.setLocale('es-ES');
  assert.equal(I18N.T('Settings'), 'Ajustes');
  assert.equal(I18N.setLocale('xx-YY'), 'en-US');
});

test('account strings cover all nine locales', () => {
  const keys = Object.keys(shStrings('en-US'));
  for (const l of LOCALES) for (const k of keys) assert.ok(shStrings(l)[k], `${l} ${k}`);
});
