// Sound, as the browser build's js/app/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.txt) per logical event — select, deselect,
// expose, pair, the three chain cascades, target shift, hint, reshuffle, undo,
// invalid, board clear, the win and lose stingers, stars, new record,
// achievement, the round-start bowl and countdown ticks, the timer warning,
// pause / resume and the menu sounds — the quiet room tone (brown noise
// lowpassed at 320 Hz under a 0.07 Hz swell) and the generative music stem
// (seeded A-minor-pentatonic sine plucks, 1.6 s, every 0.9–2.3 s with a 72 %
// chance, a fifth above 240 ms later 30 % of the time, silent while hidden).
// The browser build ran the room tone and the plucks live; here they are
// rendered offline at start (OfflineAudioContext, one context a clip): the room tone loops
// on the music bus (the runtime has no ambience bus: its gain folds in the old
// ambience slider's 0.4 against music's 0.5) and the swell is a fade each
// frame; each pluck is a clip played by the seeded timer. The runtime's
// Options own the volumes, the mute and the voice limit. Menu sounds play on
// the "interface" bus, the rest on "effects". The procedural voices the
// browser build used while a sample decoded are not ported (a live synthesis
// graph makes clip loads fail on the engine's web runtime): a clip still
// loading is silent. Every clip loads at once from onStart; the stems wait for
// the mixer (natively at once, in a browser after the first press). Every event
// returns its sound-caption key (the game's Sound captions option).
import { frame } from "starhermit:engine";
import { context, createClip, loadClip, OfflineAudioContext, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
import { Rng } from "./game.ts";

const SAMPLE_FILES: Record<string, string> = {
  select: "tile-select", deselect: "tile-deselect", expose: "tile-expose", pair: "pair-match",
  "chain-low": "combo-chain-low", "chain-mid": "combo-chain-mid", "chain-high": "combo-chain-high",
  hint: "hint-glow", reshuffle: "shuffle", undo: "undo-move", "board-clear": "board-clear", "win-stinger": "win-stinger",
  lose: "lose-stinger", "star-rating": "star-rating", "new-record": "new-record", pause: "ui-pause", resume: "ui-resume",
  countdown: "countdown-tick", "timer-warning": "timer-warning", "round-start": "round-start", ui: "ui-click", hover: "ui-hover",
  confirm: "ui-confirm", back: "ui-back", toggle: "ui-toggle", slider: "ui-slider-drag", "settings-saved": "ui-settings-saved",
  "modal-open": "ui-modal-open", "modal-close": "ui-modal-close", "scroll-tick": "ui-scroll-tick", toast: "ui-toast-notify",
  achievement: "ui-success", invalid: "ui-error", "drag-start": "tile-drag-start", drop: "tile-drop", "tab-switch": "ui-tab-switch",
  "target-shift": "target-shift",
};
const INTERFACE = new Set(["ui", "hover", "confirm", "back", "toggle", "slider", "settings-saved", "modal-open", "modal-close", "scroll-tick", "toast", "tab-switch", "pause", "resume"]);
/** audio.js captionFor: the caption key per event (chain takes {n}). */
const CAPTIONS: Record<string, string> = {
  select: "tile selected", deselect: "selection cleared", invalid: "not a valid pair", "drag-start": "drag started", drop: "dropped",
  "tab-switch": "tab switched", pair: "pair removed", chain: "chain ×{n}", hint: "hint shown", reshuffle: "tiles reshuffled", undo: "move undone",
  "board-clear": "board cleared", "win-stinger": "stage complete", lose: "round over", "star-rating": "star rating", "new-record": "new record",
  resume: "resumed", "timer-warning": "time running out", "round-start": "round begins", expose: "deeper tile exposed",
  "target-shift": "target changed", countdown: "countdown", toast: "notice", "modal-open": "panel opened", "modal-close": "panel closed",
  "settings-saved": "settings saved", achievement: "achievement unlocked",
};

const clips = new Map<string, AudioClip>();
let suspended = false;

/** Loads every clip at once (onStart); a cue whose clip is still loading is silent. */
export function loadSfx(): void {
  for (const n of new Set(Object.values(SAMPLE_FILES))) {
    loadClip(`sfx/${n}.opus`).then((c) => { clips.set(n, c); }, (e: unknown) => { console.warn(`sfx ${n}: ${String(e)}`); });
  }
  renderAmbience().then((c) => { ambClip = c; }, (e: unknown) => console.warn(`audio: ${String(e)}`));
  for (const f of PLUCK_FREQS) renderPluck(f).then((c) => { pluckClips.set(f, c); }, (e: unknown) => console.warn(`audio: ${String(e)}`));
}
/** Pause and a hidden window: the stems quiet (audio.js suspend / resume). */
export function setSuspended(on: boolean): void { suspended = on; }

/** audio.js play(event, { chain }): the event's authored clip; its caption key (or ""). */
export function play(event: string, chain = 0): string {
  const key = event === "chain" ? (chain >= 6 ? "chain-high" : chain >= 4 ? "chain-mid" : "chain-low") : event;
  const file = SAMPLE_FILES[key];
  const clip = file ? clips.get(file) : undefined;
  if (clip && !suspended) {
    try { playClip(clip, { bus: INTERFACE.has(event) ? "interface" : "effects" }); }
    catch { /* the mixer is full this frame: skip it */ }
  }
  return CAPTIONS[event] ?? "";
}

// -- the rendered stems ----------------------------------------------------------------------
const RATE = 22050;
const rng = Rng.makeStream("audio-default");

// The room tone: a 2 s brown-noise loop lowpassed at 320 Hz (periodic once the filter settles, so it joins without a click).
async function renderAmbience(): Promise<AudioClip> {
  const settle = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, settle + RATE * 2, RATE);
  const noise = off.createNoise({ color: "brown", seed: 0x4e4d, seconds: 2 });
  const lp = off.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 320;
  const g = off.createGain();
  g.gain.value = 0.8; // measured rms: +2 dB over the old brown noise and one-pole, unaided
  noise.connect(lp).connect(g).connect(off.destination);
  noise.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE);
}

// The plucks: audio.js _blip(freq, 1.6, sine, gain 1 here (the play gain sets 0.05 / 0.035), 20 ms attack, exponential fall).
const SCALE = [0, 3, 5, 7, 10];
const ROOT = 220;
const PLUCK_DUR = 1.6;
const pluckClips = new Map<number, AudioClip>();
async function renderPluck(freq: number): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, Math.round(RATE * (PLUCK_DUR + 0.05)), RATE);
  const osc = off.createOscillator();
  osc.frequency.value = freq;
  const g = off.createGain();
  g.gain.value = 0;
  g.gain.setValueAtTime(0, 0);
  g.gain.linearRampToValueAtTime(1, 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, PLUCK_DUR);
  g.gain.setValueAtTime(0, PLUCK_DUR);
  osc.connect(g).connect(off.destination);
  osc.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0)], RATE);
}
const PLUCK_FREQS: number[] = [];
for (const oct of [0, 1]) for (const d of SCALE) PLUCK_FREQS.push(ROOT * Math.pow(2, (d + 12 * oct) / 12));

let ambClip: AudioClip | null = null;
let ambVoice: Sound | null = null;
let nextPluck = 0;
const pendingFifths: { at: number; freq: number }[] = [];

function pluck(freq: number, gain: number, fifth: boolean): void {
  // the fifth above (×1.5) plays the note's clip faster: its fall is a little quicker than the browser's 1.4 s
  const clip = pluckClips.get(fifth ? freq / 1.5 : freq);
  if (!clip) return;
  try { playClip(clip, { bus: "music", gain, pitch: fifth ? 1.5 : 1 }); } catch { /* the mixer restarted */ }
}

/** Each frame, once the mixer runs: the stems, the swell and the plucks. */
export function update(): void {
  if (context.state !== "running" || !ambClip) return;
  if (!ambVoice) {
    try { ambVoice = playClip(ambClip, { bus: "music", gain: 0, loop: true }); } catch { ambVoice = null; }
    return;
  }
  if (pluckClips.size < PLUCK_FREQS.length) return;
  const t = frame().time;
  // the room tone at gain 0.35 × the old ambience 0.4 / music 0.5 balance, swelling ±0.1 at 0.07 Hz
  try { ambVoice.fade(suspended ? 0 : (0.35 + 0.1 * Math.sin(2 * Math.PI * 0.07 * t)) * 0.8, 0.15); } catch { /* the mixer restarted */ }
  if (suspended) { nextPluck = Math.max(nextPluck, t + 2); pendingFifths.length = 0; return; }
  for (let i = pendingFifths.length - 1; i >= 0; i--) {
    if (pendingFifths[i]!.at <= t) { pluck(pendingFifths[i]!.freq, 0.035, true); pendingFifths.splice(i, 1); }
  }
  if (t < nextPluck) return;
  if (rng.next() < 0.72) {
    const degree = rng.pick(SCALE) + 12 * rng.int(2);
    const freq = ROOT * Math.pow(2, degree / 12);
    const base = PLUCK_FREQS.find((f) => Math.abs(f - freq) < 0.01) ?? freq;
    pluck(base, 0.05, false);
    if (rng.next() < 0.3) pendingFifths.push({ at: t + 0.24, freq: base * 1.5 });
  }
  nextPluck = t + (900 + rng.int(1400)) / 1000;
}
