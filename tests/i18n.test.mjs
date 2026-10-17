// Localization coverage: every English key the markup and code use is
// translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR
// inherit), placeholders survive, the language follows sh-language.js and
// switches live, and the Graphics and StarHermit strings cover the nine locales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTables, codeKeys, htmlKeys, audit, bootI18n, LOCALES } from './i18n-common.mjs';
import { gfxStrings, shStrings } from '../js/app/gfx-strings.js';
import { JOURNEY, LESSONS, CHALLENGES, THEMES } from '../js/rules/content.js';
import { REJECT } from '../js/rules/engine.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

function usedKeys() {
  const keys = new Set(htmlKeys(read('index.html')));
  // `e(...)` is ui.js's escaped-T shorthand
  for (const f of ['js/app/main.js', 'js/app/ui.js', 'js/app/platform.js', 'js/app/audio.js', 'js/rules/content.js']) codeKeys(read(f), ['e', 'tr']).forEach((k) => keys.add(k));
  // engine rejection reasons reach the player through T()
  for (const r of Object.values(REJECT)) keys.add(r);
  return [...keys].sort();
}

test('every used key is translated in every locale; placeholders intact', () => {
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

test('the locale follows sh-language and switches live', () => {
  const { I18N, events, doc } = bootI18n(ROOT, { strings: 'js/i18n/strings.js', i18n: 'js/i18n/i18n.js', global: 'NMI18N', languages: ['de-DE'] });
  assert.equal(I18N.lang, 'de-DE');
  assert.equal(doc.documentElement.lang, 'de-DE');
  assert.equal(I18N.T('Make {n}', { n: 10 }), 'Ergib 10');
  I18N.language.setChoice('fr-CA');
  assert.equal(I18N.lang, 'fr-CA');
  assert.equal(events.at(-1), 'fr-CA');
  assert.equal(I18N.T('Score'), 'Pointage');
  assert.equal(I18N.T('Reshuffle'), 'Remélanger');
  I18N.language.setChoice('es-ES');
  assert.equal(I18N.T('Settings'), 'Ajustes');
});

test('Graphics and StarHermit strings cover all nine locales', () => {
  const shKeys = Object.keys(shStrings('en-US'));
  for (const l of LOCALES) {
    assert.ok(gfxStrings(l).quality, l);
    for (const k of shKeys) assert.ok(shStrings(l)[k], `${l} ${k}`);
  }
});
