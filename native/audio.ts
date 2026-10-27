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
// rendered into clips once (createClip, a slice a frame): the room tone loops
// on the music bus (the runtime has no ambience bus: its gain folds in the old
// ambience slider's 0.4 against music's 0.5) and the swell is a fade each
// frame; each pluck is a clip played by the seeded timer. The runtime's
// Options own the volumes, the mute and the voice limit. Menu sounds play on
// the "interface" bus, the rest on "effects". The procedural voices the
// browser build used while a sample decoded are not ported (a live synthesis
// graph makes clip loads fail on the engine's web runtime): a clip still
// loading is silent. Clips load once the mixer runs (natively at once, in a
// browser after the first press), one at a time. Every event returns its
// sound-caption key (the game's Sound captions option).
import { frame } from "starhermit:engine";
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
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
const queue: string[] = [];
let loading = false;
let wantClips = false;
let suspended = false;

/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }
/** Pause and a hidden window: the stems quiet (audio.js suspend / resume). */
export function setSuspended(on: boolean): void { suspended = on; }

/** audio.js play(event, { chain }): the event's authored clip; its caption key (or ""). */
export function play(event: string, chain = 0): string {
  const key = event === "chain" ? (chain >= 6 ? "chain-high" : chain >= 4 ? "chain-mid" : "chain-low") : event;
  const file = SAMPLE_FILES[key];
  const clip = file ? clips.get(file) : undefined;
  if (clip && !suspended) {
    try { playClip(clip, { bus: INTERFACE.has(event) ? "interface" : "effects" }); }
    catch { clips.delete(file!); if (!queue.includes(file!)) queue.push(file!); } // a clip the mixer lost: load it again
  }
  return CAPTIONS[event] ?? "";
}

// -- the rendered stems ----------------------------------------------------------------------
const RATE = 22050;
const rng = Rng.makeStream("audio-default");

// The room tone: a 2 s brown-noise loop through a one-pole 320 Hz lowpass, run twice so it joins without a click.
const AMB_N = RATE * 2;
const amb = new Float32Array(AMB_N);
let ambPos = 0, ambY = 0, brown = 0;
function renderAmbience(count: number): boolean {
  const k = 1 - Math.exp((-2 * Math.PI * 320) / RATE);
  const end = Math.min(2 * AMB_N, ambPos + count);
  for (; ambPos < end; ambPos++) {
    const i = ambPos % AMB_N;
    if (ambPos < AMB_N) {
      brown = (brown + 0.02 * (rng.next() * 2 - 1)) / 1.02;
      amb[i] = brown * 3;
    }
    ambY += k * (amb[i]! - ambY);
    if (ambPos >= AMB_N) amb[i] = ambY;
  }
  return ambPos >= 2 * AMB_N;
}

// The plucks: audio.js _blip(freq, 1.6, sine, gain 1 here (the play gain sets 0.05 / 0.035), 20 ms attack, exponential fall).
const SCALE = [0, 3, 5, 7, 10];
const ROOT = 220;
const PLUCK_DUR = 1.6;
const pluckClips = new Map<number, AudioClip>();
function renderPluck(freq: number): Float32Array {
  const n = Math.round(RATE * (PLUCK_DUR + 0.05));
  const out = new Float32Array(n);
  const w = (2 * Math.PI * freq) / RATE;
  const fall = Math.log(0.0001) / (PLUCK_DUR - 0.02);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const g = t < 0.02 ? t / 0.02 : t > PLUCK_DUR ? 0 : Math.exp(fall * (t - 0.02));
    out[i] = Math.sin(w * i) * g;
  }
  return out;
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

/** Each frame: the clips once the mixer runs (one at a time), then the stems, the swell and the plucks. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const n of new Set(Object.values(SAMPLE_FILES))) if (!queue.includes(n)) queue.push(n);
  }
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
    }
    return;
  }
  if (loading) return;
  if (!ambClip) {
    if (!renderAmbience(8000)) return;
    try { ambClip = createClip([amb], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); ambPos = 0; }
    return;
  }
  if (!ambVoice) {
    try { ambVoice = playClip(ambClip, { bus: "music", gain: 0, loop: true }); } catch { ambVoice = null; }
    return;
  }
  if (pluckClips.size < PLUCK_FREQS.length) {
    const f = PLUCK_FREQS[pluckClips.size]!;
    try { pluckClips.set(f, createClip([renderPluck(f)], RATE)); } catch (e) { console.warn(`audio: ${String(e)}`); }
    return;
  }
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
