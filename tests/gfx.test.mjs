// Unit tests for the pure graphics quality model (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPreset, resolve, presetTier, choosePreset, describe, PRESETS, CATEGORIES } from '../js/app/gfx.js';
import { pickLocale, gfxStrings, GFX_LOCALES } from '../js/app/gfx-strings.js';

test('detectPreset maps GPU strings to tiers', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'high');
  assert.equal(detectPreset('Apple M2'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'balanced');
  assert.equal(detectPreset('Adreno (TM) 650'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
  // touch/mobile devices cap Auto at balanced
  assert.equal(detectPreset('Apple M2', { mobile: true }), 'balanced');
  assert.equal(detectPreset('SwiftShader', { mobile: true }), 'low');
});

test('resolve: Auto follows the detected preset', () => {
  const r = resolve({ preset: 'auto' }, 'low');
  assert.equal(r.preset, 'low');
  assert.equal(r.auto, true);
  assert.equal(r.shadows, 'off');
  assert.equal(r.post, false, 'Low renders without a composer');
  assert.equal(resolve(null, 'high').preset, 'high');
  assert.equal(resolve({}, 'bogus').preset, 'balanced');
});

test('resolve: explicit preset, overrides and scale clamp', () => {
  const r = resolve({ preset: 'high', shadows: 'off', bloom: 'off', render_scale: 5 }, 'low');
  assert.equal(r.preset, 'high');
  assert.equal(r.auto, false);
  assert.equal(r.shadows, 'off');
  assert.equal(r.bloom, 'off');
  assert.equal(r.ao, presetTier('high', 'ao'));
  assert.equal(r.renderScale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }).renderScale, 0.5);
  // an unknown tier falls back to the preset's own
  assert.equal(resolve({ preset: 'ultra', shadows: 'extreme' }).shadows, presetTier('ultra', 'shadows'));
  // any anti-aliasing (or effect) turns the post chain on
  assert.equal(resolve({ preset: 'low', antialias: 'smaa' }).post, true);
  assert.equal(resolve({ preset: 'low' }).adaptive, true);
  assert.equal(resolve({ preset: 'low', adaptive: false, show_fps: true }).showFps, true);
});

test('choosing a preset clears overrides but keeps scale and toggles', () => {
  const s = choosePreset({ preset: 'high', shadows: 'off', ao: 'high', render_scale: 1.5, adaptive: false, show_fps: true }, 'low');
  assert.deepEqual(s, { preset: 'low', render_scale: 1.5, adaptive: false, show_fps: true });
  for (const cat of Object.keys(CATEGORIES)) assert.equal(resolve(s)[cat], presetTier('low', cat));
  assert.equal(choosePreset({}, 'nonsense').preset, 'auto');
});

test('every preset defines every category with an allowed tier', () => {
  for (const p of PRESETS) {
    for (const [cat, tiers] of Object.entries(CATEGORIES)) assert.ok(tiers.includes(presetTier(p, cat)), `${p}.${cat}`);
  }
});

test('describe summarises cost and pixels', () => {
  const text = describe(resolve({ preset: 'high' }), [1280, 720]);
  assert.match(text, /2048² shadows/);
  assert.match(text, /1280×720 px/);
  assert.match(describe(resolve({ preset: 'low' })), /no shadows/);
});

test('graphics strings exist for every required locale', () => {
  for (const loc of ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT']) {
    assert.ok(GFX_LOCALES.includes(loc), loc);
    const T = gfxStrings(loc);
    for (const cat of Object.keys(CATEGORIES)) assert.ok(T.cats[cat], `${loc} cats.${cat}`);
    for (const tiers of Object.values(CATEGORIES)) for (const t of tiers) assert.ok(T.tiers[t], `${loc} tiers.${t}`);
    for (const p of PRESETS) assert.ok(T.presets[p], `${loc} presets.${p}`);
    for (const k of ['quality', 'auto', 'renderScale', 'fromPreset', 'adaptive', 'showFps', 'postUnavailable', 'off3d', 'unknownGpu']) assert.ok(T[k], `${loc}.${k}`);
  }
  assert.equal(pickLocale(['de-AT']), 'de-DE');
  assert.equal(pickLocale(['es-MX']), 'es-419');
  assert.equal(pickLocale(['es-ES']), 'es-ES');
  assert.equal(pickLocale(['fr-CA']), 'fr-CA');
  assert.equal(pickLocale(['ja-JP']), 'en-US');
});
