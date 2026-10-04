// Localized strings for the Graphics settings section. The rest of the game is
// English-only; this panel follows navigator.language (exact locale, then the
// language's default regional variant, then en-US).

const en = {
  quality: 'Quality',
  auto: 'Auto (detected: {tier})',
  presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
  renderScale: 'Render scale',
  fromPreset: 'From preset ({tier})',
  cats: {
    shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade',
    antialias: 'Anti-aliasing', reflections: 'Reflections', detail: 'Scene detail',
    particles: 'Particles', ambient: 'Ambient motion',
  },
  tiers: {
    off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    plain: 'Plain', detailed: 'Detailed', static: 'Static', animated: 'Animated',
  },
  adaptive: 'Adaptive resolution',
  showFps: 'Show frame rate',
  postUnavailable: 'Post-processing is unavailable on this device, so the board renders without it.',
  off3d: 'The 3D view is off; these settings apply when it is on.',
  unknownGpu: 'Unknown GPU',
  sum: {
    noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoFull: 'full ambient occlusion',
    bloom: 'bloom', reflections: 'reflections', noAA: 'no anti-aliasing',
  },
  fps: '{fps} fps',
};

const L = {
  'en-US': en,
  'en-GB': { ...en, cats: { ...en.cats, grade: 'Colour grade' } },
  'es-419': {
    quality: 'Calidad',
    auto: 'Automática (detectada: {tier})',
    presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    renderScale: 'Escala de renderizado',
    fromPreset: 'Según calidad ({tier})',
    cats: {
      shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color',
      antialias: 'Antialiasing', reflections: 'Reflejos', detail: 'Detalle de la escena',
      particles: 'Partículas', ambient: 'Movimiento ambiental',
    },
    tiers: {
      off: 'No', on: 'Sí', low: 'Bajo', medium: 'Medio', high: 'Alto',
      fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      plain: 'Simple', detailed: 'Detallado', static: 'Estático', animated: 'Animado',
    },
    adaptive: 'Resolución adaptativa',
    showFps: 'Mostrar cuadros por segundo',
    postUnavailable: 'El posprocesamiento no está disponible en este dispositivo; el tablero se muestra sin él.',
    off3d: 'La vista 3D está desactivada; estos ajustes se aplican cuando esté activada.',
    unknownGpu: 'GPU desconocida',
    sum: {
      noShadows: 'sin sombras', shadows: 'sombras {n}²', ao: 'oclusión ambiental', aoFull: 'oclusión ambiental completa',
      bloom: 'resplandor', reflections: 'reflejos', noAA: 'sin antialiasing',
    },
    fps: '{fps} fps',
  },
  'de-DE': {
    quality: 'Qualität',
    auto: 'Automatisch (erkannt: {tier})',
    presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
    renderScale: 'Renderskalierung',
    fromPreset: 'Aus Voreinstellung ({tier})',
    cats: {
      shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchteffekt', grade: 'Farbkorrektur',
      antialias: 'Kantenglättung', reflections: 'Spiegelungen', detail: 'Szenendetails',
      particles: 'Partikel', ambient: 'Umgebungsbewegung',
    },
    tiers: {
      off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch',
      fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      plain: 'Einfach', detailed: 'Detailliert', static: 'Statisch', animated: 'Animiert',
    },
    adaptive: 'Adaptive Auflösung',
    showFps: 'Bildrate anzeigen',
    postUnavailable: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; das Brett wird ohne sie dargestellt.',
    off3d: 'Die 3D-Ansicht ist aus; diese Einstellungen gelten, sobald sie an ist.',
    unknownGpu: 'Unbekannte GPU',
    sum: {
      noShadows: 'keine Schatten', shadows: '{n}²-Schatten', ao: 'Umgebungsverdeckung', aoFull: 'volle Umgebungsverdeckung',
      bloom: 'Leuchteffekt', reflections: 'Spiegelungen', noAA: 'keine Kantenglättung',
    },
    fps: '{fps} BpS',
  },
  'fr-FR': {
    quality: 'Qualité',
    auto: 'Auto (détectée : {tier})',
    presets: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
    renderScale: 'Échelle de rendu',
    fromPreset: 'Selon le préréglage ({tier})',
    cats: {
      shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage des couleurs',
      antialias: 'Anticrénelage', reflections: 'Reflets', detail: 'Détail de la scène',
      particles: 'Particules', ambient: 'Mouvement d’ambiance',
    },
    tiers: {
      off: 'Désactivé', on: 'Activé', low: 'Bas', medium: 'Moyen', high: 'Élevé',
      fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      plain: 'Simple', detailed: 'Détaillé', static: 'Statique', animated: 'Animé',
    },
    adaptive: 'Résolution adaptative',
    showFps: 'Afficher la fréquence d’images',
    postUnavailable: 'Le post-traitement n’est pas disponible sur cet appareil ; le plateau s’affiche sans.',
    off3d: 'La vue 3D est désactivée ; ces réglages s’appliquent quand elle est activée.',
    unknownGpu: 'GPU inconnu',
    sum: {
      noShadows: 'sans ombres', shadows: 'ombres {n}²', ao: 'occlusion ambiante', aoFull: 'occlusion ambiante complète',
      bloom: 'halo', reflections: 'reflets', noAA: 'sans anticrénelage',
    },
    fps: '{fps} i/s',
  },
  'pt-BR': {
    quality: 'Qualidade',
    auto: 'Automática (detectada: {tier})',
    presets: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    renderScale: 'Escala de renderização',
    fromPreset: 'Da predefinição ({tier})',
    cats: {
      shadows: 'Sombras', ao: 'Oclusão ambiente', bloom: 'Brilho', grade: 'Correção de cor',
      antialias: 'Antisserrilhado', reflections: 'Reflexos', detail: 'Detalhe da cena',
      particles: 'Partículas', ambient: 'Movimento ambiente',
    },
    tiers: {
      off: 'Desligado', on: 'Ligado', low: 'Baixo', medium: 'Médio', high: 'Alto',
      fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      plain: 'Simples', detailed: 'Detalhado', static: 'Estático', animated: 'Animado',
    },
    adaptive: 'Resolução adaptativa',
    showFps: 'Mostrar taxa de quadros',
    postUnavailable: 'O pós-processamento não está disponível neste dispositivo; o tabuleiro é exibido sem ele.',
    off3d: 'A visão 3D está desligada; estas opções valem quando ela estiver ligada.',
    unknownGpu: 'GPU desconhecida',
    sum: {
      noShadows: 'sem sombras', shadows: 'sombras {n}²', ao: 'oclusão ambiente', aoFull: 'oclusão ambiente completa',
      bloom: 'brilho', reflections: 'reflexos', noAA: 'sem antisserrilhado',
    },
    fps: '{fps} qps',
  },
  'it-IT': {
    quality: 'Qualità',
    auto: 'Automatica (rilevata: {tier})',
    presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
    renderScale: 'Scala di rendering',
    fromPreset: 'Da preimpostazione ({tier})',
    cats: {
      shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore',
      antialias: 'Antialiasing', reflections: 'Riflessi', detail: 'Dettaglio della scena',
      particles: 'Particelle', ambient: 'Movimento ambientale',
    },
    tiers: {
      off: 'No', on: 'Sì', low: 'Basso', medium: 'Medio', high: 'Alto',
      fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
      plain: 'Semplice', detailed: 'Dettagliato', static: 'Statico', animated: 'Animato',
    },
    adaptive: 'Risoluzione adattiva',
    showFps: 'Mostra frequenza fotogrammi',
    postUnavailable: 'La post-elaborazione non è disponibile su questo dispositivo; il tavoliere viene mostrato senza.',
    off3d: 'La vista 3D è disattivata; queste impostazioni valgono quando è attiva.',
    unknownGpu: 'GPU sconosciuta',
    sum: {
      noShadows: 'senza ombre', shadows: 'ombre {n}²', ao: 'occlusione ambientale', aoFull: 'occlusione ambientale completa',
      bloom: 'bagliore', reflections: 'riflessi', noAA: 'senza antialiasing',
    },
    fps: '{fps} fps',
  },
};
L['es-ES'] = {
  ...L['es-419'],
  renderScale: 'Escala de renderizado',
  showFps: 'Mostrar fotogramas por segundo',
  adaptive: 'Resolución adaptable',
};
L['fr-CA'] = {
  ...L['fr-FR'],
  cats: { ...L['fr-FR'].cats, bloom: 'Éclat lumineux' },
  sum: { ...L['fr-FR'].sum, bloom: 'éclat' },
};

export const GFX_LOCALES = Object.keys(L);

const DEFAULT_REGION = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

export function pickLocale(langs) {
  for (const raw of langs || []) {
    const tag = String(raw || '');
    const exact = GFX_LOCALES.find(l => l.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
    const lang = tag.split('-')[0].toLowerCase();
    if (lang === 'es' && /^es-es$/i.test(tag)) return 'es-ES';
    if (DEFAULT_REGION[lang]) return DEFAULT_REGION[lang];
  }
  return 'en-US';
}

export function gfxStrings(locale) {
  const loc = locale || (typeof navigator !== 'undefined' ? pickLocale(navigator.languages?.length ? navigator.languages : [navigator.language]) : 'en-US');
  return L[loc] || en;
}

export function fill(str, vars) {
  return String(str).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}

// StarHermit account strings (sign-in / invite buttons and toasts) in every
// shipping locale; same locale pick as the Graphics section.
const SH = {
  'en-US': { signIn: 'Sign in with StarHermit', signInSub: 'sync progress and settings', invite: 'Invite a friend', inviteSub: 'copy your invite link', copied: 'Invite link copied to the clipboard', copyFailed: 'Could not copy the invite link', signedOut: 'Signed out — playing locally' },
  'en-GB': { signIn: 'Sign in with StarHermit', signInSub: 'sync progress and settings', invite: 'Invite a friend', inviteSub: 'copy your invite link', copied: 'Invite link copied to the clipboard', copyFailed: 'Couldn’t copy the invite link', signedOut: 'Signed out — playing locally' },
  'es-419': { signIn: 'Iniciar sesión con StarHermit', signInSub: 'sincroniza progreso y ajustes', invite: 'Invitar a un amigo', inviteSub: 'copia tu enlace de invitación', copied: 'Enlace de invitación copiado al portapapeles', copyFailed: 'No se pudo copiar el enlace de invitación', signedOut: 'Sesión cerrada: juegas en modo local' },
  'es-ES': { signIn: 'Iniciar sesión con StarHermit', signInSub: 'sincroniza progreso y ajustes', invite: 'Invitar a un amigo', inviteSub: 'copia tu enlace de invitación', copied: 'Enlace de invitación copiado al portapapeles', copyFailed: 'No se ha podido copiar el enlace de invitación', signedOut: 'Sesión cerrada: juegas en local' },
  'de-DE': { signIn: 'Mit StarHermit anmelden', signInSub: 'Fortschritt und Einstellungen synchronisieren', invite: 'Freund einladen', inviteSub: 'Einladungslink kopieren', copied: 'Einladungslink in die Zwischenablage kopiert', copyFailed: 'Einladungslink konnte nicht kopiert werden', signedOut: 'Abgemeldet – du spielst lokal weiter' },
  'fr-FR': { signIn: 'Se connecter avec StarHermit', signInSub: 'synchroniser progression et réglages', invite: 'Inviter un ami', inviteSub: 'copier votre lien d’invitation', copied: 'Lien d’invitation copié dans le presse-papiers', copyFailed: 'Impossible de copier le lien d’invitation', signedOut: 'Déconnecté — vous jouez en local' },
  'fr-CA': { signIn: 'Se connecter avec StarHermit', signInSub: 'synchroniser progression et paramètres', invite: 'Inviter un ami', inviteSub: 'copier votre lien d’invitation', copied: 'Lien d’invitation copié dans le presse-papiers', copyFailed: 'Impossible de copier le lien d’invitation', signedOut: 'Déconnecté — vous jouez en local' },
  'pt-BR': { signIn: 'Entrar com StarHermit', signInSub: 'sincronize progresso e configurações', invite: 'Convidar um amigo', inviteSub: 'copie seu link de convite', copied: 'Link de convite copiado para a área de transferência', copyFailed: 'Não foi possível copiar o link de convite', signedOut: 'Sessão encerrada — jogando localmente' },
  'it-IT': { signIn: 'Accedi con StarHermit', signInSub: 'sincronizza progressi e impostazioni', invite: 'Invita un amico', inviteSub: 'copia il tuo link di invito', copied: 'Link di invito copiato negli appunti', copyFailed: 'Impossibile copiare il link di invito', signedOut: 'Disconnesso: giochi in locale' },
};
export const SH_LOCALES = Object.keys(SH);
export function shStrings(locale) {
  const loc = locale || (typeof navigator !== 'undefined' ? pickLocale(navigator.languages?.length ? navigator.languages : [navigator.language]) : 'en-US');
  return SH[loc] || SH['en-US'];
}
