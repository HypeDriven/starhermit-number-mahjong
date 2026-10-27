// Localization access for the game modules. The tables and the runtime live
// in js/i18n/strings.js + js/i18n/i18n.js (classic scripts that native/i18n.ts
// loads first, global NMI18N); outside the runtime (node tests, without the
// tables) English keys come back unchanged, so rules and replays stay
// language-independent.

/** Translate an English source string; {name} placeholders are filled from vars. */
export function T(key, vars) {
  const I = globalThis.NMI18N;
  if (I) return I.T(key, vars);
  return vars ? String(key).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : String(key);
}

/** Marks an English key for a later T() (content tables). */
export const N = (key) => key;

/** The game's current locale (en-US outside the runtime). */
export function lang() {
  return globalThis.NMI18N?.lang ?? 'en-US';
}
