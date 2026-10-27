// The look per graphics level: the browser build's four presets and budgets
// (js/app/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest
// GPU its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the sparks and the dust motes scaled within the tier by the level
// (frame().levelIndex, at most 2×), as the browser build scaled them by its
// hardware level. The runtime owns the rest of what the old Graphics panel
// did: Auto and the level choice, render scale and the pixel-ratio cap,
// adaptive resolution, the frame-rate limit and readout. The old panel's
// per-effect overrides are not offered (the runtime's Options choose a level).
import type { QualityTier } from "starhermit:engine";
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
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map (0 = off). */
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
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

const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "off", reflections: false, detailed: false, particles: "off", ambient: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, detailed: true, particles: "low", ambient: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, detailed: true, particles: "high", ambient: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, detailed: true, particles: "high", ambient: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", tile: 128, bump: false, texture: 256, sparks: 100, motes: 40, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", tile: 256, bump: false, texture: 256, sparks: 140, motes: 60, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", tile: 256, bump: true, texture: 512, sparks: 200, motes: 90, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", tile: 512, bump: true, texture: 1024, sparks: 300, motes: 150, bloomRes: 1, aoRes: 1 },
};
export const SPARK_MAX = 600;
export const MOTE_MAX = 300;
const PARTICLE_SHARE = { off: 0, low: 0.3, high: 1 };
/** The first level index of each tier (quantum, molecular, terrestrial, galactic). */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: particle counts grow with the level above the tier's first, at most 2×.
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.sparks = Math.min(SPARK_MAX, Math.round(b.sparks * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return { preset, ...TABLE[preset], budget: b };
}
/** gfx.js sparkCap: the live spark pool (the Particles tier's share of the budget). */
export function sparkCap(look: Look): number {
  return Math.round(look.budget.sparks * PARTICLE_SHARE[look.particles]);
}
