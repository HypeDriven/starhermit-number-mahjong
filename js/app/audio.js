// Procedural WebAudio: original short transients per logical event, quiet
// ambience, and a generative music stem. Buses: music / effects / ambience.
// Randomized pitch variants come from a seeded stream for replay consistency.

import { makeStream } from '../rules/rng.js';

// Recorded one-shot samples (sfx/, see sfx/manifest.md) keyed by logical event.
// When a sample is unavailable (not yet fetched, decode failed) the procedural
// voice in play() is used instead.
const SAMPLE_FILES = {
  select: 'tile-select',
  deselect: 'tile-deselect',
  expose: 'tile-expose',
  pair: 'pair-match',
  'chain-low': 'combo-chain-low',
  'chain-mid': 'combo-chain-mid',
  'chain-high': 'combo-chain-high',
  hint: 'hint-glow',
  reshuffle: 'shuffle',
  undo: 'undo-move',
  'board-clear': 'board-clear',
  'win-stinger': 'win-stinger',
  lose: 'lose-stinger',
  'star-rating': 'star-rating',
  'new-record': 'new-record',
  pause: 'ui-pause',
  resume: 'ui-resume',
  countdown: 'countdown-tick',
  'timer-warning': 'timer-warning',
  'round-start': 'round-start',
  ui: 'ui-click',
  hover: 'ui-hover',
  confirm: 'ui-confirm',
  back: 'ui-back',
  toggle: 'ui-toggle',
  slider: 'ui-slider-drag',
  'settings-saved': 'ui-settings-saved',
  'modal-open': 'ui-modal-open',
  'modal-close': 'ui-modal-close',
  'scroll-tick': 'ui-scroll-tick',
  toast: 'ui-toast-notify',
  achievement: 'ui-success',
  invalid: 'ui-error',
  'drag-start': 'tile-drag-start',
  drop: 'tile-drop',
  'tab-switch': 'ui-tab-switch',
};

export class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.buses = {};
    this.started = false;
    this.rng = makeStream('audio-' + (settings.audioSeed || 'default'));
    this.musicTimer = null;
    this.ambienceNodes = null;
    this.onCaption = null; // (text) => void, for sound captions
  }

  // Must be called from a user gesture.
  start() {
    if (this.started) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const master = this.ctx.createGain();
    master.gain.value = this.settings.muted ? 0 : 1;
    master.connect(this.ctx.destination);
    this.master = master;
    for (const bus of ['music', 'effects', 'ambience']) {
      const g = this.ctx.createGain();
      g.gain.value = this.settings[bus] ?? 0.5;
      g.connect(master);
      this.buses[bus] = g;
    }
    this.started = true;
    this._startAmbience();
    this._startMusic();
  }

  // --- recorded samples ------------------------------------------------------

  // Samples are fetched lazily on first use (after the user-gesture unlock in
  // start()) and cached. While a sample is in flight, or if it fails to load,
  // play() falls through to the procedural voice for that event.
  _loadSample(name) {
    this.samples = this.samples || {};
    this._sampleLoads = this._sampleLoads || {};
    if (name in this.samples || this._sampleLoads[name]) return this._sampleLoads[name];
    this._sampleLoads[name] = (async () => {
      try {
        const res = await fetch(new URL(`../../sfx/${name}.opus`, import.meta.url));
        if (res.ok) this.samples[name] = await this.ctx.decodeAudioData(await res.arrayBuffer());
        else this.samples[name] = null; // missing file: keep the procedural voice
      } catch { this.samples[name] = null; /* decode/fetch failed: procedural fallback */ }
      delete this._sampleLoads[name];
    })();
    return this._sampleLoads[name];
  }

  _sample(name) {
    const buf = this.samples && this.samples[name];
    if (!buf || this.ctx.state !== 'running') return false;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.buses.effects);
    src.start();
    return true;
  }

  setVolume(bus, v) {
    this.settings[bus] = v;
    if (this.buses[bus]) this.buses[bus].gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  setMuted(m) {
    this.settings.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.03);
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  _caption(text) { if (this.onCaption) this.onCaption(text); }

  // --- primitive voices -----------------------------------------------------

  _blip(freq, dur, { type = 'sine', gain = 0.2, bus = 'effects', slide = 0, attack = 0.004 } = {}) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.buses[bus]);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  _noise(dur, { gain = 0.15, bus = 'effects', low = 400, high = 4000 } = {}) {
    if (!this.started) return;
    const t = this.ctx.currentTime;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (this.rng.next() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = (low + high) / 2;
    bp.Q.value = 0.8;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(bp).connect(g).connect(this.buses[bus]);
    src.start(t);
  }

  // --- event map (input ack < legal move < combo/goal < round completion) ---

  play(event, opts = {}) {
    if (!this.started || this.settings.muted) { this._caption(captionFor(event, opts)); return; }
    const sampleKey = event === 'chain'
      ? (opts.chain >= 6 ? 'chain-high' : opts.chain >= 4 ? 'chain-mid' : 'chain-low')
      : event;
    const sampleName = SAMPLE_FILES[sampleKey];
    if (sampleName) {
      if (this._sample(sampleName)) {
        this._caption(captionFor(event, opts));
        return;
      }
      this._loadSample(sampleName); // lazy fetch; synthesis below covers the gap
    }
    const v = 1 + (this.rng.next() - 0.5) * 0.06; // seeded pitch variant
    switch (event) {
      case 'select':
        this._blip(660 * v, 0.07, { type: 'triangle', gain: 0.12 });
        break;
      case 'deselect':
        this._blip(440 * v, 0.06, { type: 'triangle', gain: 0.09 });
        break;
      case 'invalid':
        this._blip(140, 0.16, { type: 'square', gain: 0.07, slide: -40 });
        this._noise(0.08, { gain: 0.05, low: 100, high: 500 });
        break;
      case 'drag-start':
        this._noise(0.09, { gain: 0.06, low: 300, high: 1200 });
        break;
      case 'drop':
        this._blip(300 * v, 0.08, { type: 'triangle', gain: 0.1 });
        this._noise(0.05, { gain: 0.06, low: 200, high: 900 });
        break;
      case 'tab-switch':
        this._blip(540 * v, 0.05, { type: 'triangle', gain: 0.06 });
        break;
      case 'pair': {
        const base = 520 * v;
        this._blip(base, 0.12, { type: 'sine', gain: 0.18 });
        this._blip(base * 1.5, 0.2, { type: 'sine', gain: 0.14 });
        this._noise(0.05, { gain: 0.08, low: 1500, high: 5000 });
        break;
      }
      case 'chain': {
        const base = 560 * v;
        const steps = Math.min(2 + (opts.chain || 0), 7);
        for (let i = 0; i < steps; i++) {
          setTimeout(() => this._blip(base * Math.pow(1.25, i), 0.14, { type: 'sine', gain: 0.12 }), i * 55);
        }
        break;
      }
      case 'hint':
        this._blip(880, 0.3, { type: 'sine', gain: 0.08, slide: 220 });
        break;
      case 'reshuffle':
        this._noise(0.35, { gain: 0.12, low: 300, high: 3000 });
        this._blip(330, 0.25, { type: 'triangle', gain: 0.08, slide: 120 });
        break;
      case 'undo':
        this._blip(500, 0.12, { type: 'triangle', gain: 0.1, slide: -180 });
        break;
      case 'win': {
        const notes = [523, 659, 784, 1047];
        notes.forEach((f, i) => setTimeout(() => this._blip(f, 0.4, { type: 'sine', gain: 0.16 }), i * 130));
        this._noise(0.5, { gain: 0.05, low: 2000, high: 8000 });
        break;
      }
      case 'lose':
        this._blip(330, 0.3, { type: 'sine', gain: 0.12, slide: -90 });
        setTimeout(() => this._blip(220, 0.45, { type: 'sine', gain: 0.1, slide: -60 }), 180);
        break;
      case 'pause':
        this._blip(392, 0.1, { type: 'triangle', gain: 0.09 });
        break;
      case 'tick-urgent':
        this._blip(920, 0.05, { type: 'square', gain: 0.05 });
        break;
      case 'ui':
        this._blip(700 * v, 0.05, { type: 'triangle', gain: 0.07 });
        break;
      case 'achievement':
        [784, 988, 1175].forEach((f, i) => setTimeout(() => this._blip(f, 0.3, { type: 'sine', gain: 0.12 }), i * 90));
        break;
    }
    this._caption(captionFor(event, opts));
  }

  // --- ambience: quiet room tone -------------------------------------------

  _startAmbience() {
    const t = this.ctx.currentTime;
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // brown-ish noise
      const white = this.rng.next() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    const g = this.ctx.createGain();
    g.gain.value = 0.35;
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    lfo.frequency.value = 0.07;
    lfoGain.gain.value = 0.1;
    lfo.connect(lfoGain).connect(g.gain);
    src.connect(lp).connect(g).connect(this.buses.ambience);
    src.start(t);
    lfo.start(t);
    this.ambienceNodes = { src, lfo };
  }

  // --- generative music stem: slow pentatonic plucks -------------------------

  _startMusic() {
    const scale = [0, 3, 5, 7, 10];
    const root = 220;
    const step = () => {
      if (!this.started) return;
      if (document.hidden || this.settings.muted) { this.musicTimer = setTimeout(step, 2000); return; }
      if (this.rng.next() < 0.72) {
        const degree = this.rng.pick(scale) + 12 * this.rng.int(2);
        const freq = root * Math.pow(2, degree / 12);
        this._blip(freq, 1.6, { type: 'sine', gain: 0.05, bus: 'music', attack: 0.02 });
        if (this.rng.next() < 0.3) {
          setTimeout(() => this._blip(freq * 1.5, 1.4, { type: 'sine', gain: 0.035, bus: 'music', attack: 0.02 }), 240);
        }
      }
      this.musicTimer = setTimeout(step, 900 + this.rng.int(1400));
    };
    step();
  }
}

function captionFor(event, opts = {}) {
  switch (event) {
    case 'select': return 'tile selected';
    case 'deselect': return 'selection cleared';
    case 'invalid': return 'not a valid pair';
    case 'drag-start': return 'drag started';
    case 'drop': return 'dropped';
    case 'tab-switch': return 'tab switched';
    case 'pair': return 'pair removed';
    case 'chain': return `chain ×${opts.chain || 1}`;
    case 'hint': return 'hint shown';
    case 'reshuffle': return 'tiles reshuffled';
    case 'undo': return 'move undone';
    case 'win': return 'round complete';
    case 'board-clear': return 'board cleared';
    case 'win-stinger': return 'stage complete';
    case 'lose': return 'round over';
    case 'star-rating': return 'star rating';
    case 'new-record': return 'new record';
    case 'resume': return 'resumed';
    case 'timer-warning': return 'time running out';
    case 'round-start': return 'round begins';
    case 'expose': return 'deeper tile exposed';
    case 'settings-saved': return 'settings saved';
    case 'achievement': return 'achievement unlocked';
    default: return '';
  }
}
