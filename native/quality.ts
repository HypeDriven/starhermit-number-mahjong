// The look per graphics level. The engine's level table owns the engine effects
// (levelSettings(): shadows and their map size, AO, bloom, grade, anti-aliasing,
// the texture cap); the browser build's four presets (js/app/gfx.js TABLE /
// BUDGETS) keep the game-only art, keyed by the quality tier: materials, tile
// textures, reflections, props. Sparks and dust motes scale with the level's
// particle budget against the tier's anchor level, at most 2×. The runtime owns
// the rest of what the old Graphics panel did: Auto and the level choice, render
// scale and the pixel-ratio cap, adaptive resolution, the frame-rate limit and
// readout. The old panel's per-effect overrides are not offered (the runtime's
// Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Tile shading: Lambert (Low), Standard (Balanced), clear-coated Physical (High, Ultra; Detail on). */
  material: "lambert" | "standard" | "physical";
  /** Detailed tile-face texture width in px (height 1.25×; plain faces 128). */
  tile: number;
  /** Engraved-numeral bump map on detailed tiles. */
  bump: boolean;
  /** Desk-wood texture size in px (felt ½; Detail on). */
  texture: number;
  /** Spark pool at Particles high (low: 30 %). */
  sparks: number;
  /** Dust motes in the lamp light (Ambient animated). */
  motes: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map: the level's size (0 = off). */
  shadows: number;
  /** The level's AO (null = off). */
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null = off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  /** Room-light environment map + clear coat on tiles and brass. */
  reflections: boolean;
  /** Desk props, rounded two-ply tiles, procedural wood / felt / ivory textures. */
  detailed: boolean;
  particles: "off" | "low" | "high";
  /** Drifting dust in the lamp light, the lamp's shimmer. */
  ambient: boolean;
  budget: Budget;
}

type Art = Pick<Look, "reflections" | "detailed" | "particles" | "ambient">;
const ART: Record<QualityTier, Art> = {
  low: { reflections: false, detailed: false, particles: "off", ambient: false },
  balanced: { reflections: true, detailed: true, particles: "low", ambient: true },
  high: { reflections: true, detailed: true, particles: "high", ambient: true },
  ultra: { reflections: true, detailed: true, particles: "high", ambient: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", tile: 128, bump: false, texture: 256, sparks: 100, motes: 40 },
  balanced: { material: "standard", tile: 256, bump: false, texture: 256, sparks: 140, motes: 60 },
  high: { material: "physical", tile: 256, bump: true, texture: 512, sparks: 200, motes: 90 },
  ultra: { material: "physical", tile: 512, bump: true, texture: 1024, sparks: 300, motes: 150 },
};
export const SPARK_MAX = 600;
export const MOTE_MAX = 300;
const PARTICLE_SHARE = { off: 0, low: 0.3, high: 1 };
/** Each tier's anchor level: its budgets are written for it. */
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a level's settings. Plain data: render.applyLook compares it as JSON. */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = BUDGETS[preset];
  // The level's particle budget against the anchor's: more sparks and motes above the anchor, at most 2×.
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: { ...b, texture: Math.min(b.texture, s.maxTextureSize),
      sparks: Math.min(SPARK_MAX, Math.round(b.sparks * k)), motes: Math.min(MOTE_MAX, Math.round(b.motes * k)) },
  };
}
/** gfx.js sparkCap: the live spark pool (the Particles tier's share of the budget). */
export function sparkCap(look: Look): number {
  return Math.round(look.budget.sparks * PARTICLE_SHARE[look.particles]);
}
