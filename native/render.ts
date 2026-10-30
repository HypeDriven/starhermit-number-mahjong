// The observatory desk on starhermit:scene, as the browser build's
// js/app/render3d.js drew it with three.js r160: the desk and the felt, the
// warm key light with its board-fitted shadow, the hemisphere fill and the oil
// lamp's point light, the props (brass telescope with bands, star chart, book
// stack, oil lamp with its flickering flame, folded cloth), a tile per rules
// tile (a box, or a rounded two-ply slab on detailed looks) with its number
// drawn into a canvas texture per value (seeded ink jitter, ivory veining and
// an engraved-numeral bump map on detailed looks), the selection ring, the
// hint and selection tints, the lift of the selected tile, the removal
// lift-and-fade with its spark burst, the invalid shake, the reshuffle spin,
// the dust motes in the lamp light and the camera framing (default / top /
// low board view). Rendering reads rules snapshots and never writes them.
//
// From three.js r160 (engine.minor 28): light intensities and the fitted
// shadow box as render3d.js set them; r160 applied each material's envMapIntensity to
// scene.environment, so each lit material takes the room environment as its
// own envMap with its old intensity; the post chain (GTAO, UnrealBloom at
// threshold 1.3, the GradeShader in linear light before the output, FXAA /
// SMAA / MSAA) is renderer.ao / bloom / grade / antialias. The board sits
// below the HUD as the old <canvas> did: the camera keeps the playfield's
// aspect and is offset into its rectangle with setViewOffset. Adaptive
// resolution, the pixel-ratio cap and the frame-rate readout are the
// runtime's. Animations run on frame().time.
import {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, CylinderGeometry,
  DirectionalLight, DoubleSide, Fog, Group, HemisphereLight, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial,
  MeshStandardMaterial, NoColorSpace, OrthographicCamera, PerspectiveCamera, PlaneGeometry, PMREMGenerator, PointLight, Points, PointsMaterial, Raycaster,
  RepeatWrapping, RingGeometry, RoomEnvironment, RoundedBoxGeometry, SRGBColorSpace, SphereGeometry, TorusGeometry, Vector2, Vector3,
  renderer, scene, type Material, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import { frame } from "starhermit:engine";
import { E, Rng, type State, type RulesEvent, type Theme } from "./game.ts";
import { MOTE_MAX, SPARK_MAX, sparkCap, type Look } from "./quality.ts";

const PI = Math.PI;
export const TILE_W = 1.0, TILE_H = 0.34, TILE_D = 1.3, GAP = 0.16;
const nowMs = (): number => frame().time * 1000;

// ---------------------------------------------------------------------------- tweens
type Ease = (k: number) => number;
const easeOutCubic: Ease = (k) => 1 - Math.pow(1 - k, 3);
interface Tween { obj: Record<string, number>; from: Record<string, number>; to: Record<string, number>; t0: number; dur: number; ease: Ease; onDone: (() => void) | null }
/** render3d.js Tweens: duration + easing, interruptible per object and property, settle-able. */
class Tweens {
  list: Tween[] = [];
  add(obj: object, props: Record<string, number>, durMs: number, ease: Ease = easeOutCubic, onDone: (() => void) | null = null): void {
    const o = obj as Record<string, number>;
    this.list = this.list.filter((t) => !(t.obj === o && Object.keys(props).some((p) => p in t.from)));
    const from: Record<string, number> = {};
    for (const k of Object.keys(props)) from[k] = o[k]!;
    this.list.push({ obj: o, from, to: props, t0: nowMs(), dur: Math.max(1, durMs), ease, onDone });
  }
  cancel(obj: object): void { this.list = this.list.filter((t) => t.obj !== obj); }
  update(now: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const t = this.list[i]!;
      const k = Math.min(1, (now - t.t0) / t.dur);
      const e = t.ease(k);
      for (const p of Object.keys(t.to)) t.obj[p] = t.from[p]! + (t.to[p]! - t.from[p]!) * e;
      if (k >= 1) { this.list.splice(i, 1); if (t.onDone) t.onDone(); }
    }
  }
  settle(): void {
    const list = this.list;
    this.list = [];
    for (const t of list) { for (const p of Object.keys(t.to)) t.obj[p] = t.to[p]!; if (t.onDone) t.onDone(); }
  }
}

// ---------------------------------------------------------------------------- scene
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const camera = new PerspectiveCamera(32, 1, 0.1, 100);
camera.position.set(0, 8, 10);
camera.lookAt(0, 0, 0);
const camView = { px: 0, py: 8, pz: 10, lx: 0, ly: 0, lz: 0 };

const tweens = new Tweens();
interface TileView {
  mesh: Mesh<Material[]>; id: number; value: number; baseY: number; lift: number;
  removed: boolean; exiting: boolean; basePos: { x: number; y: number; z: number }; jitter: number; spin: { y: number };
  shake: { t0: number; startX: number } | null; flashUntil: number;
}
const tileViews = new Map<number, TileView>();
const decoRng = Rng.makeStream("deco-scene");
let boardRng = Rng.makeStream("deco-board-0");
let theme: Theme | null = null;
let look: Look | null = null;
let reducedMotion = false;
let cameraMode = "default";
let lastState: State | null = null;
let origin = { x: 0, y: 0 };
let cells: { x: number; y: number }[] = [];
let accentColor = new Color(0xe8b34b);
let skyColor = new Color(0x1b2233);
let envTex: Texture | null = null;
let active = false;

// lights: one dominant warm key, soft hemisphere fill, lamp glow
const keyLight = new DirectionalLight(0xffe6c0, 2.3);
keyLight.position.set(5, 9, 4);
keyLight.shadow.bias = -0.0006;
keyLight.shadow.normalBias = 0.02;
keyLight.shadow.radius = 3;
scene.add(keyLight, keyLight.target);
const hemi = new HemisphereLight(0x8fa3c7, 0x2a2018, 0.6);
scene.add(hemi);
const LAMP = 12;
const lamp = new PointLight(0xffc890, LAMP, 14, 1.8);
lamp.position.set(-4.5, 3.2, -2.5);
scene.add(lamp);

/** Lit materials and their r160 envMapIntensity (given the room environment as their own map when reflections are on). */
const envMats: [MeshStandardMaterial, number][] = [];
function envMat<M extends MeshStandardMaterial>(m: M, intensity = 1): M { envMats.push([m, intensity]); applyEnv(m, intensity); return m; }
function applyEnv(m: MeshStandardMaterial, intensity: number): void {
  m.envMap = look?.reflections ? envTex : null;
  m.envMapIntensity = intensity;
}

// desk and felt
const deskMat = envMat(new MeshStandardMaterial({ color: 0x3a2f28, roughness: 0.82, metalness: 0.05 }), 0.12);
const desk = new Mesh(new BoxGeometry(26, 0.6, 18), deskMat);
desk.position.y = -0.3;
desk.receiveShadow = true;
scene.add(desk);
const feltMat = envMat(new MeshStandardMaterial({ color: 0x2e4038, roughness: 0.95 }), 0.12);
const felt = new Mesh(new BoxGeometry(15, 0.08, 12), feltMat);
felt.position.y = 0.04;
felt.receiveShadow = true;
scene.add(felt);

// selection / hint marker ring (shared); HDR colour so it blooms
const markerMat = new MeshBasicMaterial({ color: 0xe8b34b, transparent: true, opacity: 0.9, side: DoubleSide, depthWrite: false });
const marker = new Mesh(new RingGeometry(TILE_W * 0.62, TILE_W * 0.78, 48), markerMat);
marker.rotation.x = -PI / 2;
marker.visible = false;
scene.add(marker);

// props
const propsGroup = new Group();
const clothMat = envMat(new MeshStandardMaterial({ color: 0x4a3d33, roughness: 0.9 }));
const flameMat = envMat(new MeshStandardMaterial({ color: 0x000000, emissive: 0xffd98a, emissiveIntensity: 3.2 }));
let flame: Mesh | null = null;
function buildProps(): void {
  const brass = envMat(new MeshPhysicalMaterial({ color: 0xa6823f, roughness: 0.32, metalness: 0.85, clearcoat: 0.4 }), 0.35);
  const darkWood = envMat(new MeshStandardMaterial({ color: 0x2c221a, roughness: 0.7 }));
  // telescope silhouette on the left
  const scope = new Group();
  const tube = new Mesh(new CylinderGeometry(0.22, 0.3, 3.4, 28), brass);
  tube.rotation.z = PI / 3.4;
  tube.position.y = 1.7;
  scope.add(tube);
  for (const k of [-1.1, 0.2, 1.3]) {
    // bands ride on the tube (its local y axis), following its taper
    const band = new Mesh(new TorusGeometry(0.27 - k * 0.0235, 0.035, 8, 28), darkWood);
    band.rotation.x = PI / 2;
    band.position.y = k;
    tube.add(band);
  }
  const eye = new Mesh(new CylinderGeometry(0.12, 0.16, 0.5, 14), darkWood);
  eye.rotation.z = PI / 3.4;
  eye.position.set(-1.35, 0.82, 0);
  scope.add(eye);
  for (let i = 0; i < 3; i++) {
    const leg = new Mesh(new CylinderGeometry(0.05, 0.07, 1.6, 8), darkWood);
    const a = (i / 3) * PI * 2;
    leg.position.set(Math.cos(a) * 0.45, 0.5, Math.sin(a) * 0.45);
    leg.rotation.x = Math.sin(a) * 0.4;
    leg.rotation.z = Math.cos(a) * -0.4;
    scope.add(leg);
  }
  scope.position.set(-6.4, 0, -3.4);
  scope.traverse((o) => { if (o instanceof Mesh) o.castShadow = true; });
  propsGroup.add(scope);
  // star chart leaning at the back
  const chart = new Mesh(new PlaneGeometry(3.6, 2.4), envMat(new MeshStandardMaterial({ map: chartTexture(), roughness: 0.9 }), 0.2));
  chart.position.set(3.8, 1.5, -5.2);
  chart.rotation.x = -0.16;
  propsGroup.add(chart);
  // book stack on the right
  const bookCols = [0x6d3b32, 0x2f4a3e, 0x3e3a52];
  const pages = envMat(new MeshStandardMaterial({ color: 0xe9dcc0, roughness: 0.9 }));
  for (let i = 0; i < 3; i++) {
    const cover = envMat(new MeshStandardMaterial({ color: bookCols[i]!, roughness: 0.6 }), 0.15);
    const book = new Mesh(new BoxGeometry(1.7 - i * 0.2, 0.26, 1.2), [cover, pages, cover, cover, pages, pages]);
    book.position.set(6.2, 0.17 + i * 0.27, -2.2);
    book.rotation.y = (i - 1) * 0.12;
    book.castShadow = true;
    book.receiveShadow = true;
    propsGroup.add(book);
  }
  // oil lamp beside the telescope: brass base, glass chimney, flame
  const lampG = new Group();
  const base = new Mesh(new CylinderGeometry(0.28, 0.36, 0.22, 28), brass);
  base.position.y = 0.11;
  const font = new Mesh(new SphereGeometry(0.3, 28, 16), brass);
  font.scale.y = 0.6;
  font.position.y = 0.36;
  const glass = new Mesh(new CylinderGeometry(0.16, 0.2, 0.7, 24, 1, true),
    envMat(new MeshStandardMaterial({ color: 0x3a3226, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.22, depthWrite: false }), 0.3));
  glass.position.y = 0.87;
  flame = new Mesh(new SphereGeometry(0.06, 16, 10), flameMat);
  flame.scale.set(1, 2.1, 1);
  flame.position.y = 0.78;
  base.castShadow = font.castShadow = true;
  lampG.add(base, font, glass, flame);
  lampG.position.set(-4.5, 0, -2.5);
  propsGroup.add(lampG);
  // a folded cloth under the lamp
  const cloth = new Mesh(new BoxGeometry(1.4, 0.03, 1.1), clothMat);
  cloth.position.set(-4.6, 0.015, -2.6);
  cloth.rotation.y = 0.3;
  cloth.receiveShadow = true;
  propsGroup.add(cloth);
}
scene.add(propsGroup);

// ---------------------------------------------------------------------------- textures
function chartTexture(): Texture {
  const c = new OffscreenCanvas(512, 340);
  const g = c.getContext("2d");
  g.fillStyle = "#20262e";
  g.fillRect(0, 0, 512, 340);
  g.strokeStyle = "#3d4a58";
  g.lineWidth = 2;
  g.strokeRect(12, 12, 488, 316);
  const rng = Rng.makeStream("star-chart");
  const pts: [number, number][] = [];
  for (let i = 0; i < 40; i++) {
    const x = 30 + rng.next() * 452, y = 30 + rng.next() * 280;
    pts.push([x, y]);
    g.fillStyle = "#cfe0f4";
    g.beginPath(); g.arc(x, y, 1 + rng.next() * 2.2, 0, 7); g.fill();
  }
  g.strokeStyle = "rgba(160,190,220,0.35)";
  g.lineWidth = 1;
  for (let i = 0; i < 14; i++) {
    const a = pts[rng.int(pts.length)]!, b = pts[rng.int(pts.length)]!;
    g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

// Procedural textures are near-white greyscale so theme colours still tint them.
let woodTex: Texture | null = null, feltTex: Texture | null = null, sideTexture: Texture | null = null;
let woodSize = 0;
function wood(): Texture {
  const n = look?.budget.texture ?? 256; // authored at 512 px, drawn into the budget's texture size
  if (woodTex && woodSize === n) return woodTex;
  woodTex?.dispose(); feltTex?.dispose();
  woodTex = feltTex = null;
  woodSize = n;
  const c = new OffscreenCanvas(n, n);
  const g = c.getContext("2d");
  g.scale(n / 512, n / 512);
  g.fillStyle = "#d8d8d8";
  g.fillRect(0, 0, 512, 512);
  const rng = Rng.makeStream("desk-wood");
  for (let i = 0; i < 180; i++) {
    const y = rng.next() * 512;
    const shade = 150 + Math.floor(rng.next() * 105);
    g.strokeStyle = `rgba(${shade},${shade},${shade},${0.18 + rng.next() * 0.3})`;
    g.lineWidth = 1 + rng.next() * 4;
    g.beginPath();
    g.moveTo(0, y);
    const amp = 2 + rng.next() * 6, f = 0.004 + rng.next() * 0.01, ph = rng.next() * 6;
    for (let x = 0; x <= 512; x += 16) g.lineTo(x, y + Math.sin(x * f * 6.283 + ph) * amp);
    g.stroke();
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(2.5, 1.7);
  tex.anisotropy = 4;
  woodTex = tex;
  return tex;
}
function feltTexture(): Texture {
  if (feltTex) return feltTex;
  const n = (look?.budget.texture ?? 256) / 2; // authored at 256 px
  const c = new OffscreenCanvas(n, n);
  const g = c.getContext("2d");
  g.scale(n / 256, n / 256);
  g.fillStyle = "#e6e6e6";
  g.fillRect(0, 0, 256, 256);
  const rng = Rng.makeStream("felt");
  for (let i = 0; i < 5000; i++) {
    const v = 190 + Math.floor(rng.next() * 65);
    g.fillStyle = `rgba(${v},${v},${v},0.5)`;
    g.fillRect(rng.next() * 256, rng.next() * 256, 1 + rng.next() * 2, 1);
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(6, 5);
  feltTex = tex;
  return tex;
}
/** Tile side: ivory above a jade backing layer, like a traditional two-ply tile. */
function sideTex(): Texture {
  if (sideTexture) return sideTexture;
  const c = new OffscreenCanvas(4, 64);
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 4, 64);
  g.fillStyle = "#5f9a86";
  g.fillRect(0, 40, 4, 24);
  g.fillStyle = "#c9c0b0";
  g.fillRect(0, 39, 4, 1);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  sideTexture = tex;
  return tex;
}
function softSprite(): Texture {
  const c = new OffscreenCanvas(64, 64);
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

const detailed = (): boolean => !!look?.detailed;
const valueTextures = new Map<number, { map: Texture; bump: Texture | null }>();
/** The number on an ivory face (authored at 128 px, drawn into the budget's size), with a seeded ink jitter. */
function valueTexture(value: number): { map: Texture; bump: Texture | null } {
  const hit = valueTextures.get(value);
  if (hit) return hit;
  const det = detailed();
  const W = det ? look!.budget.tile : 128, H = W * 1.25, k = W / 128;
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext("2d");
  const tile = theme ? theme.tile : "#f3ead8";
  const ink = theme ? theme.ink : "#3b3230";
  g.fillStyle = tile;
  g.fillRect(0, 0, W, H);
  const rng = Rng.makeStream("tile-" + value);
  if (det) {
    // faint ivory veining
    g.globalAlpha = 0.05;
    g.strokeStyle = "#6b5a3a";
    for (let i = 0; i < 7; i++) {
      g.lineWidth = 0.6 * k + rng.next() * k;
      g.beginPath();
      const y0 = rng.next() * H;
      g.moveTo(0, y0);
      g.bezierCurveTo(W * 0.3, y0 + (rng.next() - 0.5) * 60, W * 0.7, y0 + (rng.next() - 0.5) * 60, W, y0 + (rng.next() - 0.5) * 40);
      g.stroke();
    }
  }
  g.globalAlpha = 0.05;
  for (let i = 0; i < 60 * k; i++) {
    g.fillStyle = rng.next() < 0.5 ? "#000" : "#fff";
    g.fillRect(rng.next() * W, rng.next() * H, 2 * k, 2 * k);
  }
  g.globalAlpha = 0.35;
  g.strokeStyle = ink;
  g.lineWidth = 4 * k;
  g.strokeRect(8 * k, 8 * k, 112 * k, 144 * k);
  if (det) {
    g.lineWidth = 1.2 * k;
    g.strokeRect(14 * k, 14 * k, 100 * k, 132 * k);
  }
  g.globalAlpha = 1;
  const fontSpec = `700 ${84 * k}px Georgia, serif`;
  g.font = fontSpec;
  g.textAlign = "center";
  g.textBaseline = "middle";
  if (det) {
    // engraved: a light lower-right lip under the ink
    g.fillStyle = "rgba(255,255,255,0.55)";
    g.fillText(String(value), 64 * k + 1.5 * k, 84 * k + 1.5 * k);
  }
  g.fillStyle = ink;
  g.fillText(String(value), 64 * k, 84 * k);
  const map = new CanvasTexture(c);
  map.colorSpace = SRGBColorSpace;
  map.anisotropy = 4;
  let bump: Texture | null = null;
  if (det && look!.budget.bump) {
    const b = new OffscreenCanvas(W, H);
    const bg = b.getContext("2d");
    bg.fillStyle = "#fff";
    bg.fillRect(0, 0, W, H);
    bg.fillStyle = "#000";
    bg.font = fontSpec; bg.textAlign = "center"; bg.textBaseline = "middle";
    bg.fillText(String(value), 64 * k, 84 * k);
    bg.strokeStyle = "#555";
    bg.lineWidth = 4 * k;
    bg.strokeRect(8 * k, 8 * k, 112 * k, 144 * k);
    bump = new CanvasTexture(b);
    bump.colorSpace = NoColorSpace;
  }
  const entry = { map, bump };
  valueTextures.set(value, entry);
  return entry;
}

// ---------------------------------------------------------------------------- tile geometry and materials
/**
 * render3d.js twoGroups: a tile draws as two groups — the numbered top (material 2) and every other face (material 0) —
 * instead of six, so each tile is two draw calls on every look.
 */
function twoGroups(geo: BufferGeometry): BufferGeometry {
  if (!geo.index) { // RoundedBoxGeometry is non-indexed: index it 1:1 so the faces can be regrouped
    const n = geo.getAttribute("position")!.count;
    const id = new Uint32Array(n);
    for (let i = 0; i < n; i++) id[i] = i;
    geo.setIndex(new BufferAttribute(id, 1));
  }
  const idx = geo.index!.array as Uint32Array | Uint16Array;
  const groups = geo.groups;
  const top = groups[2]!;
  const out = new Uint32Array(idx.length);
  for (let i = 0; i < top.count; i++) out[i] = idx[top.start + i]!;
  let o = top.count;
  for (let gi = 0; gi < groups.length; gi++) {
    if (gi === 2) continue;
    const g = groups[gi]!;
    for (let i = 0; i < g.count; i++) out[o++] = idx[g.start + i]!;
  }
  geo.setIndex(new BufferAttribute(out, 1));
  geo.clearGroups();
  geo.addGroup(0, top.count, 2);
  geo.addGroup(top.count, o - top.count, 0);
  return geo;
}
/** A rounded tile with box-compatible UVs: the top face maps x/z like a plain box (numbers upright), the sides map v to height. */
function roundedTileGeometry(): BufferGeometry {
  const geo = new RoundedBoxGeometry(TILE_W, TILE_H, TILE_D, 3, 0.06);
  const pos = geo.getAttribute("position") as BufferAttribute, uv = geo.getAttribute("uv") as BufferAttribute;
  const top = geo.groups[2]!;
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (i >= top.start && i < top.start + top.count) uv.setXY(i, clamp01(x / TILE_W + 0.5), clamp01(0.5 - z / TILE_D));
    else uv.setXY(i, 0.5, clamp01(y / TILE_H + 0.5));
  }
  uv.needsUpdate = true;
  return geo;
}
const tileGeoPlain = twoGroups(new BoxGeometry(TILE_W, TILE_H, TILE_D));
let tileGeoRound: BufferGeometry | null = null;
function tileGeo(): BufferGeometry {
  if (!detailed()) return tileGeoPlain;
  if (!tileGeoRound) tileGeoRound = twoGroups(roundedTileGeometry());
  return tileGeoRound;
}

/** Tile shading per the budget: Lambert on Low, Standard on Balanced, clear-coated Physical ivory on High/Ultra (Detail on). */
function topMat(value: number): Material {
  const t = valueTexture(value), tier = look?.budget.material ?? "standard";
  // emissiveMap keeps the numeral dark while a selection / hint tint lights the ivory
  if (tier === "lambert") return new MeshLambertMaterial({ map: t.map, emissiveMap: t.map });
  if (detailed() && tier === "standard") return envMat(new MeshStandardMaterial({ map: t.map, emissiveMap: t.map, roughness: 0.45, metalness: 0 }), 0.14);
  if (detailed()) {
    return envMat(new MeshPhysicalMaterial({
      map: t.map, emissiveMap: t.map, bumpMap: t.bump, bumpScale: 0.6, roughness: 0.42, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.3,
    }), 0.14);
  }
  return envMat(new MeshStandardMaterial({ map: t.map, emissiveMap: t.map, roughness: 0.5, metalness: 0.02 }));
}
function edgeMat(): Material {
  const tier = look?.budget.material ?? "standard", det = detailed();
  if (tier === "lambert") return new MeshLambertMaterial({ color: 0xd8cbb2, map: det ? sideTex() : null });
  if (det && tier === "standard") return envMat(new MeshStandardMaterial({ color: 0xd8cbb2, map: sideTex(), roughness: 0.55 }), 0.14);
  if (det) return envMat(new MeshPhysicalMaterial({ color: 0xd8cbb2, map: sideTex(), roughness: 0.5, clearcoat: 0.4, clearcoatRoughness: 0.35 }), 0.14);
  return envMat(new MeshStandardMaterial({ color: 0xd8cbb2, roughness: 0.62 }));
}
/** One edge material shared by the five side faces (group 0 draws them), the numbered top as material 2. */
function tileMaterials(value: number): Material[] {
  const edge = edgeMat();
  return [edge, edge, topMat(value), edge, edge, edge];
}
function disposeMaterials(mats: Material[]): void {
  for (const m of new Set(mats)) {
    const i = envMats.findIndex(([e]) => e === m);
    if (i >= 0) envMats.splice(i, 1);
    m.dispose();
  }
}
function emissiveOf(m: Material): Color | null { return (m as MeshStandardMaterial).emissive ?? null; }
function colorOf(m: Material): Color | null { return (m as MeshStandardMaterial).color ?? null; }

// ---------------------------------------------------------------------------- particles
const sprite = softSprite();
const particleData = new Float32Array(SPARK_MAX * 3);
const particleVel = new Float32Array(SPARK_MAX * 3);
const particleLife = new Float32Array(SPARK_MAX);
for (let i = 0; i < SPARK_MAX; i++) particleData[i * 3 + 1] = -10;
const particleGeo = new BufferGeometry();
particleGeo.setAttribute("position", new BufferAttribute(particleData, 3));
const particleMat = new PointsMaterial({ color: 0xffd98a, map: sprite, size: 0.11, transparent: true, opacity: 0.95, depthWrite: false, blending: AdditiveBlending });
particleMat.color.multiplyScalar(2.2);
const particles = new Points(particleGeo, particleMat);
particles.frustumCulled = false;
scene.add(particles);
let particleCap = 0;

// dust motes drifting through the lamp light (ambient motion)
const moteBase = new Float32Array(MOTE_MAX * 3);
const motePos = new Float32Array(MOTE_MAX * 3);
{
  const rng = Rng.makeStream("motes");
  for (let i = 0; i < MOTE_MAX; i++) {
    moteBase[i * 3] = -8 + rng.next() * 16;
    moteBase[i * 3 + 1] = 0.4 + rng.next() * 4.2;
    moteBase[i * 3 + 2] = -5.5 + rng.next() * 9;
  }
  motePos.set(moteBase);
}
const moteGeo = new BufferGeometry();
moteGeo.setAttribute("position", new BufferAttribute(motePos, 3));
const moteMat = new PointsMaterial({ color: 0xffd98a, map: sprite, size: 0.05, transparent: true, opacity: 0.35, depthWrite: false, blending: AdditiveBlending });
const motes = new Points(moteGeo, moteMat);
motes.frustumCulled = false;
scene.add(motes);
let moteCount = 0;

function burst(x: number, y: number, z: number, count: number): void {
  const cap = Math.min(count, particleCap);
  if (!cap) return;
  let placed = 0;
  for (let i = 0; i < particleCap && placed < cap; i++) {
    if (particleLife[i]! > 0) continue;
    const j = i * 3;
    particleData[j] = x; particleData[j + 1] = y; particleData[j + 2] = z;
    const a = decoRng.next() * PI * 2, up = decoRng.next();
    const sp = 1.2 + decoRng.next() * 1.6;
    particleVel[j] = Math.cos(a) * sp * 0.5;
    particleVel[j + 1] = up * sp;
    particleVel[j + 2] = Math.sin(a) * sp * 0.5;
    particleLife[i] = 0.7;
    placed++;
  }
  (particleGeo.getAttribute("position") as BufferAttribute).needsUpdate = true;
}
function stepParticles(dt: number): void {
  if (!particles.visible) return;
  let any = false;
  for (let i = 0; i < SPARK_MAX; i++) {
    if (particleLife[i]! <= 0) continue;
    any = true;
    particleLife[i] = particleLife[i]! - dt;
    const j = i * 3;
    particleVel[j + 1] = particleVel[j + 1]! - 3.4 * dt;
    particleData[j] = particleData[j]! + particleVel[j]! * dt;
    particleData[j + 1] = particleData[j + 1]! + particleVel[j + 1]! * dt;
    particleData[j + 2] = particleData[j + 2]! + particleVel[j + 2]! * dt;
    if (particleLife[i]! <= 0) particleData[j + 1] = -10;
  }
  if (any) (particleGeo.getAttribute("position") as BufferAttribute).needsUpdate = true;
}
function clearParticles(): void {
  for (let i = 0; i < SPARK_MAX; i++) { particleLife[i] = 0; particleData[i * 3 + 1] = -10; }
  (particleGeo.getAttribute("position") as BufferAttribute).needsUpdate = true;
}
function stepAmbient(tMs: number): void {
  const animate = !!look?.ambient && !reducedMotion;
  const s = tMs / 1000;
  if (motes.visible && animate) {
    for (let i = 0; i < moteCount; i++) {
      const j = i * 3, p = i * 1.7;
      motePos[j] = moteBase[j]! + Math.sin(s * 0.13 + p) * 0.6;
      motePos[j + 1] = moteBase[j + 1]! + Math.sin(s * 0.09 + p * 1.3) * 0.35;
      motePos[j + 2] = moteBase[j + 2]! + Math.cos(s * 0.11 + p * 0.7) * 0.5;
    }
    (moteGeo.getAttribute("position") as BufferAttribute).needsUpdate = true;
  }
  // lamp shimmer
  const flick = animate ? (Math.sin(s * 7.3) * 0.5 + Math.sin(s * 12.9 + 1.3) * 0.3 + Math.sin(s * 3.1) * 0.2) : 0;
  lamp.intensity = LAMP * (1 + flick * 0.04);
  if (flame) flame.scale.set(1, 2.1 + flick * 0.18, 1);
}

// ---------------------------------------------------------------------------- theme and look
export function setTheme(t: Theme): void {
  if (theme === t) return;
  theme = t;
  skyColor = new Color(t.sky);
  scene.background = skyColor;
  scene.fog = new Fog(skyColor, (scene.fog as Fog | null)?.near ?? 18, (scene.fog as Fog | null)?.far ?? 40);
  keyLight.color.set(t.glow).lerp(new Color(0xffffff), 0.35);
  deskMat.color.set(t.desk);
  feltMat.color.set(t.felt);
  clothMat.color.set(t.deskCloth || t.desk);
  accentColor = new Color(t.accent);
  flameMat.emissive.set(t.glow);
  particleMat.color.set(t.glow).multiplyScalar(2.2);
  moteMat.color.set(t.glow);
  retintTiles();
}

let propsBuilt = false;
/** The graphics level's look (quality.ts): post effects, shadows, reflections, shading, detail, particles, motes. */
export function applyLook(next: Look): void {
  const prev = look;
  if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
  look = next;
  const b = next.budget;
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.75, radius: 0.45, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: next.ao === "high" ? 16 : 8, resolution: b.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // high threshold: only emissive highlights (selection, hints, sparks, the lamp flame) bloom
  // render3d.js: three r160 UnrealBloomPass(0.5, 0.4, 1.3), drawn by the r160 bloom model at the page's strength.
  renderer.bloom = next.bloom ? { model: "r160", strength: 0.5, radius: 0.4, threshold: 1.3, resolution: b.bloomRes } : null;
  // render3d.js GradeShader (linear, before the output): S-curve 0.18, saturation 1.08, cool shadows / warm highlights
  // between 0.15 and 0.75 luma, the 0.26 vignette from 0.32 to 0.82 (vertical axis 0.9).
  renderer.grade = next.grade ? {
    space: "linear", contrast: 0.18, saturation: 1.08, shadows: [0.95, 0.98, 1.06], highlights: [1.04, 1.0, 0.95], split: [0.15, 0.75],
    vignette: { amount: 0.26, inner: 0.32, outer: 0.82, scale: [1, 0.9] },
    overRange: "keep", // minor 29: mix(c, s + max(c - 1, 0), amount) as the page's grade
  } : null;
  renderer.antialias = next.antialias;
  const on = next.shadows > 0;
  renderer.shadowMap.enabled = on;
  keyLight.castShadow = on;
  if (on) keyLight.shadow.mapSize = next.shadows;
  if (next.reflections && !envTex) {
    try { const pageRoom = new RoomEnvironment(renderer); pageRoom.position.y = 0; /* the page's three r160 (pre-r183) builds the room at the origin */ envTex = new PMREMGenerator(renderer).fromScene(pageRoom, 0.04).texture; }
    catch (e) { console.warn(`environment: ${e instanceof Error ? e.message : String(e)}`); }
  }
  scene.environment = null;
  hemi.intensity = next.reflections ? 0.45 : 0.6;
  if (next.detailed && !propsBuilt) { buildProps(); propsBuilt = true; }
  propsGroup.visible = next.detailed;
  if (!prev || prev.budget.texture !== b.texture) { woodTex?.dispose(); feltTex?.dispose(); woodTex = feltTex = null; }
  deskMat.map = next.detailed ? wood() : null;
  feltMat.map = next.detailed ? feltTexture() : null;
  deskMat.roughness = next.detailed ? 0.62 : 0.82;
  for (const [m, k] of envMats) applyEnv(m, k);
  particleCap = sparkCap(next);
  for (let i = particleCap; i < SPARK_MAX; i++) { particleLife[i] = 0; particleData[i * 3 + 1] = -10; }
  particles.visible = particleCap > 0;
  moteCount = Math.min(MOTE_MAX, b.motes);
  moteGeo.setDrawRange(0, moteCount);
  motes.visible = next.ambient;
  retintTiles();
}

function retintTiles(): void {
  for (const e of valueTextures.values()) { e.map.dispose(); e.bump?.dispose(); }
  valueTextures.clear();
  if (!look || !theme) return;
  for (const view of tileViews.values()) {
    const old = view.mesh.material;
    view.mesh.material = tileMaterials(view.value);
    view.mesh.geometry = tileGeo();
    disposeMaterials(old);
  }
  if (lastState && tileViews.size) syncState(lastState, [], true);
}

export function setReducedMotion(on: boolean): void { reducedMotion = on; }
export function setCameraMode(mode: string): void { cameraMode = mode; }
/** The 3D board on or off (menus and the 2D board: nothing 3D renders, as the old canvas was hidden then). */
export function setActive(on: boolean): void {
  active = on;
  renderer.camera = on ? camera : null;
}

// ---------------------------------------------------------------------------- board
function tilePos(stack: number, level: number): { x: number; y: number; z: number } {
  const cell = cells[stack]!;
  return {
    x: (cell.x - origin.x) * (TILE_W + GAP),
    y: 0.08 + TILE_H / 2 + level * (TILE_H + 0.02),
    z: (cell.y - origin.y) * (TILE_D + GAP),
  };
}

/** Shadow camera fitted to the play area (half-extents in world units), as render3d.js fitted it. */
function fitShadow(halfW: number, halfD: number): void {
  const r = Math.hypot(halfW, halfD) + 0.9;
  const cam = keyLight.shadow.camera as OrthographicCamera;
  cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
  cam.near = 2; cam.far = 26;
  cam.updateProjectionMatrix();
}

export function buildBoard(state: State): void {
  for (const view of tileViews.values()) { scene.remove(view.mesh); disposeMaterials(view.mesh.material); }
  tileViews.clear();
  tweens.list = [];
  clearParticles();
  boardRng = Rng.makeStream("deco-board-" + String(state.seed));
  cells = state.layout.cells;
  lastState = state;
  const xs = cells.map((c) => c.x), ys = cells.map((c) => c.y);
  origin = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  frameCamera(state);
  fitShadow((Math.max(...xs) - Math.min(...xs) + 1) * (TILE_W + GAP) / 2, (Math.max(...ys) - Math.min(...ys) + 1) * (TILE_D + GAP) / 2);
  for (const key of Object.keys(state.tiles)) {
    const tile = state.tiles[Number(key)]!;
    const mesh = new Mesh(tileGeo(), tileMaterials(tile.value));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const pos = tilePos(tile.stack, tile.level);
    mesh.position.set(pos.x, pos.y, pos.z);
    const jitter = (boardRng.next() - 0.5) * 0.04;
    mesh.rotation.y = jitter;
    tileViews.set(tile.id, { mesh, id: tile.id, value: tile.value, baseY: pos.y, lift: 0, removed: false, exiting: false, basePos: pos, jitter, spin: { y: jitter }, shake: null, flashUntil: 0 });
    scene.add(mesh);
  }
  syncState(state, [], true);
}

/** render3d.js syncState: positions, lift, tints, exposure and the selection ring from a snapshot; event effects. */
export function syncState(state: State, events: RulesEvent[] = [], instant = false): void {
  lastState = state;
  cells = state.layout.cells;
  const doTween = !instant && !reducedMotion;
  const now = nowMs();
  for (const view of tileViews.values()) {
    const tile = state.tiles[view.id]!;
    const stillPresent = state.stacks[tile.stack]!.includes(tile.id);
    const exposed = stillPresent && E.isExposed(state, tile.id);
    // keep removed tiles visible only while their exit animation runs
    view.mesh.visible = stillPresent || (view.removed && view.exiting);
    if (!stillPresent) continue;
    const pos = tilePos(tile.stack, tile.level);
    if (view.removed) {
      // restored by undo: reset the removal animation and drop stale exit tweens
      view.removed = false;
      view.exiting = false;
      tweens.cancel(view.mesh.position);
      tweens.cancel(view.mesh.scale);
      view.mesh.scale.setScalar(1);
      view.mesh.position.set(pos.x, pos.y, pos.z);
      view.mesh.visible = true;
    }
    view.basePos = pos;
    view.baseY = pos.y;
    const isSelected = state.selected === tile.id;
    const isHinted = !!state.hintedPair && state.hintedPair.includes(tile.id);
    if (doTween) {
      if (Math.abs(view.mesh.position.x - pos.x) > 0.001 || Math.abs(view.mesh.position.z - pos.z) > 0.001) {
        tweens.add(view.mesh.position, { x: pos.x, z: pos.z }, 180);
      }
    } else {
      view.mesh.position.x = pos.x; view.mesh.position.z = pos.z;
    }
    view.lift = isSelected ? 0.22 : 0;
    const top = view.mesh.material[2]!;
    const em = emissiveOf(top);
    if (em && view.flashUntil <= now) {
      if (isSelected) em.copy(accentColor).multiplyScalar(0.26);
      else if (isHinted) em.copy(accentColor).multiplyScalar(0.45);
      else em.setRGB(0, 0, 0);
    }
    view.mesh.scale.setScalar(exposed ? 1 : 0.97);
    colorOf(view.mesh.material[0]!)?.set(exposed ? (theme ? theme.tileEdge : "#d8cbb2") : "#8d8474");
  }
  // selection marker
  const sel = state.selected != null ? tileViews.get(state.selected) : undefined;
  if (sel) {
    marker.visible = true;
    marker.position.set(sel.basePos.x, 0.1, sel.basePos.z);
    markerMat.color.copy(accentColor).multiplyScalar(1.7);
  } else marker.visible = false;

  // event-driven effects
  for (const ev of events) {
    if (ev.type === "pair") {
      for (const id of [ev.tileA, ev.tileB]) {
        const view = id != null ? tileViews.get(id) : undefined;
        if (!view) continue;
        view.removed = true;
        view.exiting = true;
        view.mesh.visible = true;
        const p = view.mesh.position;
        burst(p.x, p.y + 0.2, p.z, 12);
        if (doTween) {
          tweens.add(view.mesh.position, { y: p.y + 1.4 }, 420, easeOutCubic, () => { view.exiting = false; view.mesh.visible = false; });
          tweens.add(view.mesh.scale, { x: 0.6, y: 0.6, z: 0.6 }, 420);
        } else {
          view.exiting = false;
          view.mesh.visible = false;
        }
      }
    } else if (ev.type === "invalid") {
      for (const id of [ev.tileA, ev.tileB]) {
        const view = id != null ? tileViews.get(id) : undefined;
        if (!view || view.removed) continue;
        emissiveOf(view.mesh.material[2]!)?.setRGB(0.55, 0.08, 0.05);
        view.flashUntil = now + (doTween ? 260 : 300);
        if (doTween) view.shake = { t0: now, startX: view.mesh.position.x };
      }
    } else if (ev.type === "reshuffle") {
      for (const view of tileViews.values()) {
        const tile = state.tiles[view.id]!;
        if (!state.stacks[tile.stack]!.includes(tile.id) || view.value === tile.value) continue;
        view.value = tile.value;
        const old = view.mesh.material[2]!;
        const mats = view.mesh.material.slice();
        mats[2] = topMat(tile.value);
        view.mesh.material = mats;
        disposeMaterials([old]);
        if (doTween) {
          view.spin.y = view.mesh.rotation.y + PI * 2;
          tweens.add(view.spin, { y: view.jitter }, 350);
        } else view.spin.y = view.jitter;
      }
    }
  }
}

/** Snaps every tween and clears particles to the exact end state (before results). */
export function settleImmediately(): void {
  tweens.settle();
  clearParticles();
}

// ---------------------------------------------------------------------------- camera
/** render3d.js _frameCamera: fit the board's width and depth, per the board view; fog starts beyond the fitted distance. */
function frameCamera(state: State, instant = false): void {
  const cs = state.layout.cells;
  const xs = cs.map((c) => c.x), ys = cs.map((c) => c.y);
  const w = (Math.max(...xs) - Math.min(...xs) + 1) * (TILE_W + GAP);
  const d = (Math.max(...ys) - Math.min(...ys) + 1) * (TILE_D + GAP);
  const aspect = camera.aspect || 1.6;
  const tanV = Math.tan((camera.fov * PI) / 360);
  const tanH = tanV * Math.min(aspect, 1.8);
  const distW = (w / 2) / tanH;
  const distD = ((d / 2) * 0.85) / tanV;
  const dist = Math.max(distW, distD, 3.8) * (aspect < 0.8 ? 1.05 : 1.18); // tighter on portrait: width-bound tiles stay ≥ 44 px
  const fog = scene.fog as Fog | null;
  if (fog) { fog.near = Math.max(18, dist * 1.6); fog.far = Math.max(40, dist * 3.2); }
  let target: typeof camView;
  if (cameraMode === "top") target = { px: 0, py: dist * 1.35, pz: 0.8, lx: 0, ly: 0, lz: 0 };
  else if (cameraMode === "low") target = { px: 0, py: dist * 0.62, pz: dist * 0.95, lx: 0, ly: 0, lz: 0 };
  else target = { px: 0, py: dist * 0.92, pz: dist * 0.78, lx: 0, ly: 0, lz: 0 };
  if (reducedMotion || instant) { tweens.cancel(camView); Object.assign(camView, target); }
  else tweens.add(camView, target, 900);
}
export function resetCamera(): void { if (lastState) frameCamera(lastState); }

/** The playfield's window rectangle (px): the camera keeps its aspect and draws into it. */
const pf = { x: 0, y: 0, w: 0, h: 0 };
export function setPlayfield(x: number, y: number, w: number, h: number): void { pf.x = x; pf.y = y; pf.w = w; pf.h = h; }

const ray = new Raycaster();
/** The exposed-or-not tile under a window point, or null (a tile animating off the board blocks without counting). */
export function pick(x: number, y: number): number | null {
  const f = frame();
  if (!active || f.width <= 0 || f.height <= 0) return null;
  if (x < pf.x || y < pf.y || x > pf.x + pf.w || y > pf.y + pf.h) return null;
  camera.updateMatrixWorld();
  ray.setFromCamera(new Vector2((x / f.width) * 2 - 1, -(y / f.height) * 2 + 1), camera);
  const meshes = [...tileViews.values()].filter((v) => v.mesh.visible).map((v) => v.mesh);
  const hits = ray.intersectObjects(meshes, false);
  if (!hits.length) return null;
  const hit = [...tileViews.values()].find((v) => v.mesh === hits[0]!.object);
  return hit && !hit.removed ? hit.id : null;
}

/** A tile's top centre in window pixels (render3d.js tileScreenPos), or null when it is not shown. */
export function tileScreenPos(id: number): { x: number; y: number } | null {
  const view = tileViews.get(id);
  const f = frame();
  if (!view || !view.mesh.visible || !active || f.width <= 0) return null;
  const v = new Vector3();
  camera.updateMatrixWorld();
  view.mesh.getWorldPosition(v);
  v.y += TILE_H;
  v.project(camera);
  return { x: (v.x + 1) / 2 * f.width, y: (1 - v.y) / 2 * f.height };
}

/** A shown tile's top-face rectangle in window pixels (its accessibility target), or null. */
export function tileRect(id: number): { x: number; y: number; width: number; height: number } | null {
  const view = tileViews.get(id);
  const f = frame();
  if (!view || !view.mesh.visible || view.removed || !active || f.width <= 0) return null;
  camera.updateMatrixWorld();
  const p = view.mesh.position;
  const v = new Vector3();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [dx, dz] of [[-0.46, -0.6], [0.46, -0.6], [-0.46, 0.6], [0.46, 0.6]] as const) {
    v.set(p.x + dx, p.y + TILE_H / 2, p.z + dz).project(camera);
    const x = (v.x + 1) / 2 * f.width, y = (1 - v.y) / 2 * f.height;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// ---------------------------------------------------------------------------- the frame
let lastT = 0;
/** render3d.js _loop: tweens, lift, shakes, the ring's pulse, particles, ambience, the camera in the playfield. */
export function update(): void {
  const f = frame();
  const t = nowMs();
  const dt = Math.min(0.05, lastT ? Math.max(0, (t - lastT) / 1000) : 0.016);
  lastT = t;
  if (!active) return;
  if (f.width > 0 && f.height > 0) {
    const w = pf.w > 0 ? pf.w : f.width, h = pf.h > 0 ? pf.h : f.height;
    const aspect = w / h;
    const v = camera.view;
    const stale = !v || !v.enabled || v.fullWidth !== w || v.fullHeight !== h || v.offsetX !== -pf.x || v.offsetY !== -pf.y || v.width !== f.width || v.height !== f.height;
    if (aspect !== camera.aspect || stale) {
      const reframe = Math.abs(aspect - camera.aspect) > 1e-6;
      camera.aspect = aspect;
      camera.setViewOffset(w, h, -pf.x, -pf.y, f.width, f.height);
      camera.updateProjectionMatrix();
      if (reframe && lastState) frameCamera(lastState, true);
    }
  }
  tweens.update(t);
  for (const view of tileViews.values()) {
    if (!view.mesh.visible) continue;
    const targetY = view.baseY + view.lift;
    if (Math.abs(view.mesh.position.y - targetY) > 0.002 && !view.removed) {
      // critically damped approach, frame-rate independent
      const k = 1 - Math.exp(-12 * dt);
      view.mesh.position.y += (targetY - view.mesh.position.y) * k;
    }
    view.mesh.rotation.y = view.spin.y;
    if (view.shake) {
      const k = Math.min(1, (t - view.shake.t0) / 260);
      const e = easeOutCubic(k);
      if (k >= 1) { view.mesh.position.x = view.basePos.x; view.shake = null; }
      else view.mesh.position.x = view.shake.startX + Math.sin(e * PI * 5) * 0.06 * (1 - e);
    }
    if (view.flashUntil && view.flashUntil <= t) {
      view.flashUntil = 0;
      if (lastState) {
        const em = emissiveOf(view.mesh.material[2]!);
        const sel = lastState.selected === view.id, hinted = !!lastState.hintedPair && lastState.hintedPair.includes(view.id);
        if (em) { if (sel) em.copy(accentColor).multiplyScalar(0.26); else if (hinted) em.copy(accentColor).multiplyScalar(0.45); else em.setRGB(0, 0, 0); }
      }
    }
  }
  if (marker.visible && !reducedMotion) {
    const s = 1 + Math.sin(t / 280) * 0.06;
    marker.scale.set(s, s, s);
  }
  stepParticles(dt);
  stepAmbient(t);
  camera.position.set(camView.px, camView.py, camView.pz);
  camera.lookAt(camView.lx, camView.ly, camView.lz);
}
