// Unit tests for the pure graphics quality model (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// js/app/gpu-level.js is a classic script in the page (window.StarHermitGpu); evaluate it the same way here.
new Function('window', 'module', readFileSync(new URL('../js/app/gpu-level.js', import.meta.url), 'utf8'))(globalThis, undefined);
const { detectPreset, detectLevel, presetForLevel, budgetFor, sparkCap, resolve, presetTier, choosePreset, describe, PRESETS, CATEGORIES, LEVELS, BUDGETS, SPARK_MAX, MOTE_MAX } = await import('../js/app/gfx.js');
const { pickLocale, gfxStrings, GFX_LOCALES } = await import('../js/app/gfx-strings.js');

const DESK = { cores: 8, memoryGb: 8 };
const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

test('hardware level picks the Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', DESK), 'low');
  assert.equal(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK), 0);
  assert.equal(detectPreset('', DESK), 'low', 'no WebGL');
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  assert.equal(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 20);
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  for (const [p, lv] of Object.entries(LEVELS)) assert.equal(presetForLevel(lv), p);
  assert.equal(presetForLevel(3), 'low');
  assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets are Balanced at most; software GPUs stay Low', () => {
  assert.equal(detectPreset('Adreno (TM) 740', PHONE), 'balanced');
  assert.ok(detectLevel('Adreno (TM) 740', PHONE) <= 9);
  assert.equal(detectPreset('Apple M2', PHONE), 'balanced');
  assert.equal(detectPreset('SwiftShader', PHONE), 'low');
});

test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
  const keys = ['material', 'tile', 'bump', 'texture', 'sparks', 'motes', 'bloomRes', 'aoRes'];
  for (const p of PRESETS) for (const k of keys) assert.ok(BUDGETS[p][k] != null, `${p}.${k}`);
  for (let i = 1; i < PRESETS.length; i++) for (const k of keys) {
    if (typeof BUDGETS.low[k] === 'number') assert.ok(BUDGETS[PRESETS[i]][k] >= BUDGETS[PRESETS[i - 1]][k], `${PRESETS[i]}.${k}`);
  }
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].bloomRes), [0.5, 0.5, 0.5, 1], 'half-res bloom below Ultra');
  assert.deepEqual(resolve({ preset: 'high' }, 'low', 10).budget, BUDGETS.high, 'floor level = the tuned budget');
  assert.deepEqual(resolve({ preset: 'ultra' }, 'low', 0).budget, resolve({ preset: 'ultra' }, 'ultra', 17).budget);
  assert.ok(budgetFor('balanced', 9).motes > budgetFor('balanced', 4).motes, 'counts scale up within the preset');
  assert.ok(budgetFor('ultra', 20).sparks <= SPARK_MAX && budgetFor('ultra', 20).motes <= MOTE_MAX);
  assert.equal(sparkCap(resolve({ preset: 'high' }, 'low', 10)), BUDGETS.high.sparks);
  assert.equal(sparkCap(resolve({ preset: 'low' }, 'low', 0)), 0, 'Low: particles off');
  assert.equal(resolve({}, 'low', 0).budget.material, 'lambert', 'headless SwiftShader: Low, Lambert');
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
