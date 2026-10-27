/* Number Mahjong — localization runtime (js/i18n/i18n.js; classic script,
 * loaded by native/i18n.ts with loadClassic and by the node tests in a vm).
 *
 * Nine locales: en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT.
 * English source strings are the keys; js/i18n/strings.js holds the tables
 * (en-GB, es-ES and fr-CA carry only their differences from en-US, es-419
 * and fr-FR). The locale is the runtime's interface language (Options ›
 * Language, else the account's preferred language or the device's), set by
 * native/i18n.ts through setLocale; every string is drawn through T() each
 * frame, so a change shows on the next frame.
 * Global: NMI18N (T, setLocale, lang, locales).
 */
(function (root) {
  'use strict';

  var LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  var PARENT = { 'en-GB': 'en-US', 'es-ES': 'es-419', 'fr-CA': 'fr-FR' };
  var TABLES = root.NM_STRINGS || {};
  var lang = 'en-US';
  var hasOwn = Object.prototype.hasOwnProperty;

  function lookup(key) {
    for (var l = lang; l; l = PARENT[l]) {
      var t = TABLES[l];
      if (t && hasOwn.call(t, key)) return t[key];
    }
    return key;
  }

  /** Translate an English source string; {name} placeholders filled from vars. */
  function T(key, vars) {
    var s = lookup(String(key));
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return hasOwn.call(vars, k) ? String(vars[k]) : m; });
    return s;
  }

  /** Switch the language (an unknown tag falls back to en-US); returns the locale in use. */
  function setLocale(next) {
    lang = LOCALES.indexOf(next) >= 0 ? next : 'en-US';
    return lang;
  }

  root.NMI18N = {
    T: T,
    setLocale: setLocale,
    get lang() { return lang; },
    locales: LOCALES,
    tables: TABLES
  };
})(globalThis);
