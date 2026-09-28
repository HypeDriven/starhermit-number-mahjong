// Three.js presentation layer. Consumes immutable rules snapshots + event
// lists; never mutates rules state. Cosmetic randomness uses its own seeded
// stream. Graphics settings (js/app/gfx.js) control shadows, post-processing,
// reflections, scene detail, particles, ambient motion and resolution only —
// never rules, hazard visibility, or picking.

import * as THREE from '../../vendor/three.module.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { makeStream } from '../rules/rng.js';
import { isExposed } from '../rules/engine.js';
import { detectPreset, resolve, SHADOW_MAP, PARTICLES } from './gfx.js';

const TILE_W = 1.0, TILE_H = 0.34, TILE_D = 1.3, GAP = 0.16;
const MAX_PARTICLES = 200;
const MOTES = 90;

// Colour grade: gentle S-curve contrast, a touch of saturation, warm
// highlights / cool shadows, and a vignette. Runs in linear HDR before output.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.26 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = src.rgb;
      vec3 lc = clamp(c, 0.0, 1.0);
      vec3 s = mix(lc, lc * lc * (3.0 - 2.0 * lc), 0.18);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.08);
      s *= mix(vec3(0.95, 0.98, 1.06), vec3(1.04, 1.0, 0.95), smoothstep(0.15, 0.75, l));
      c = mix(c, s + max(c - 1.0, 0.0), uAmount);
      float d = length((vUv - 0.5) * vec2(1.0, 0.9));
      c *= 1.0 - uVignette * smoothstep(0.32, 0.82, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

// ---------------------------------------------------------------------------
// tiny authored tween manager (duration + easing, interruptible, settle-able)
// ---------------------------------------------------------------------------
class Tweens {
  constructor() { this.list = []; }
  add(obj, props, durMs, ease = easeOutCubic, onDone = null) {
    // interrupt: drop prior tweens on same object+prop
    this.list = this.list.filter(t => !(t.obj === obj && Object.keys(props).some(p => p in t.from)));
    const from = {};
    for (const k of Object.keys(props)) from[k] = obj[k];
    this.list.push({ obj, from, to: props, t0: performance.now(), dur: Math.max(1, durMs), ease, onDone });
  }
  cancel(obj) { this.list = this.list.filter(t => t.obj !== obj); }
  update(now) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const t = this.list[i];
      const k = Math.min(1, (now - t.t0) / t.dur);
      const e = t.ease(k);
      for (const p of Object.keys(t.to)) t.obj[p] = t.from[p] + (t.to[p] - t.from[p]) * e;
      if (k >= 1) { this.list.splice(i, 1); if (t.onDone) t.onDone(); }
    }
  }
  settle() {
    for (const t of this.list) { for (const p of Object.keys(t.to)) t.obj[p] = t.to[p]; if (t.onDone) t.onDone(); }
    this.list.length = 0;
  }
}
function easeOutCubic(k) { return 1 - Math.pow(1 - k, 3); }

function isMobileDevice() {
  try {
    return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ||
      (matchMedia('(pointer: coarse)').matches && !matchMedia('(hover: hover)').matches);
  } catch { return false; }
}

// ---------------------------------------------------------------------------

export class Renderer3D {
  constructor(canvas, { gfx = {}, reducedMotion = false } = {}) {
    this.canvas = canvas;
    this.reducedMotion = reducedMotion;
    this.saved = gfx || {};
    this.tweens = new Tweens();
    this.tileViews = new Map();  // tileId -> view
    this.decoRng = makeStream('deco-scene');
    this.disposed = false;
    this.cameraMode = 'default';
    this.adaptiveScale = 1;
    this._frames = [];
    this.size = [0, 0];
    this.pixelRatio = 0;
    this.postKey = '';
    this.postFailed = false;
    this.composer = null;
    this.fps = 0;
    try { this._prefersReduced = matchMedia('(prefers-reduced-motion: reduce)'); } catch { this._prefersReduced = null; }
    this._initGL();
    this._detectGpu();
    this.q = resolve(this.saved, this.detected);
    this._buildEnvironment();
    this._initParticles();
    this._applyGfx(true);
    this._loop = this._loop.bind(this);
    this._lastT = 0;
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    this.canvas.addEventListener('webglcontextlost', this._onLost = (e) => { e.preventDefault(); this.contextLost = true; });
    this.canvas.addEventListener('webglcontextrestored', this._onRestored = () => { this.contextLost = false; this._rebuild(); });
    this._resize();
    this.raf = requestAnimationFrame(this._loop);
  }

  _initGL() {
    // No default-framebuffer MSAA: MSAA, when chosen, runs on the composer's
    // render target so it can be switched live.
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    this.camera.position.set(0, 8, 10);
    this.camera.lookAt(0, 0, 0);
    this.camView = { px: 0, py: 8, pz: 10, lx: 0, ly: 0, lz: 0 };
    this.size = [0, 0];
    this.pixelRatio = 0;
    this.postKey = '';
  }

  _detectGpu() {
    let gpu = '';
    try {
      const gl = this.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch { /* keep unknown */ }
    this.gpu = String(gpu || '');
    this.detected = detectPreset(this.gpu, { mobile: isMobileDevice() });
  }

  setTheme(theme) {
    this.theme = theme;
    const sky = new THREE.Color(theme.sky);
    this.skyColor = sky;
    this.scene.fog = new THREE.Fog(sky, this.scene.fog?.near ?? 18, this.scene.fog?.far ?? 40);
    this._applyBackground();
    if (this.keyLight) this.keyLight.color.set(theme.glow).lerp(new THREE.Color(0xffffff), 0.35);
    if (this.deskMat) this.deskMat.color.set(theme.desk);
    if (this.feltMat) this.feltMat.color.set(theme.felt);
    if (this.clothMat) this.clothMat.color.set(theme.deskCloth || theme.desk);
    this.tileInkColor = theme.ink;
    this.accentColor = new THREE.Color(theme.accent);
    if (this.flameMat) this.flameMat.emissive.set(theme.glow);
    if (this.particleMat) this.particleMat.color.set(theme.glow).multiplyScalar(2.2);
    if (this.moteMat) this.moteMat.color.set(theme.glow);
    this._retintTiles();
  }

  _applyBackground() {
    // a plain colour (not a texture): background textures bleed into GTAO's
    // normal pass, and with post-processing a colour stays correctly converted
    if (this.skyColor) this.scene.background = this.skyColor;
  }

  // --------------------------------------------------------- graphics ----

  /** Apply saved graphics settings live (no reload). */
  setGraphics(saved) {
    this.saved = saved || {};
    const prev = this.q;
    this.q = resolve(this.saved, this.detected);
    this._applyGfx(false, prev);
  }

  graphicsInfo() {
    return {
      gpu: this.gpu,
      detected: this.detected,
      resolved: this.q,
      pixels: this._expectedPixels(),
      postFailed: this.postFailed,
      fps: this.fps,
    };
  }

  // Drawing-buffer size the current settings produce (the canvas may be hidden
  // behind a menu and not yet resized, so compute rather than read it).
  _expectedPixels() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, this.q.dprCap) * this.q.scale * this.adaptiveScale;
    return [Math.round(w * ratio), Math.round(h * ratio)];
  }

  _applyGfx(initial, prev = {}) {
    const q = this.q;
    const size = SHADOW_MAP[q.shadows];
    const shadowChanged = initial || prev.shadows !== q.shadows;
    this.renderer.shadowMap.enabled = size > 0;
    this.keyLight.castShadow = size > 0;
    if (size && (initial || this.keyLight.shadow.mapSize.x !== size)) {
      this.keyLight.shadow.mapSize.set(size, size);
      if (this.keyLight.shadow.map) { this.keyLight.shadow.map.dispose(); this.keyLight.shadow.map = null; }
    }
    this.scene.environment = q.reflections === 'on' ? this._envMap() : null;
    this.hemi.intensity = q.reflections === 'on' ? 0.45 : 0.6;
    const detailChanged = initial || prev.detail !== q.detail;
    if (detailChanged) {
      this.propsGroup.visible = q.detail === 'detailed';
      this.deskMat.map = q.detail === 'detailed' ? this._woodTex() : null;
      this.feltMat.map = q.detail === 'detailed' ? this._feltTex() : null;
      this.deskMat.roughness = q.detail === 'detailed' ? 0.62 : 0.82;
      this._retintTiles();
    }
    this.particleCap = PARTICLES[q.particles];
    this.particles.visible = this.particleCap > 0;
    this.motes.visible = q.ambient === 'animated';
    if (shadowChanged || detailChanged || initial || prev.reflections !== q.reflections) {
      this.scene.traverse(o => {
        if (!o.material) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
      });
    }
    if (!q.adaptive) this.adaptiveScale = 1;
    this.postKey = ''; // rebuild the post chain on the next frame
    this.pixelRatio = 0;
    if (!initial) this._prewarm();
  }

  _envMap() {
    if (!this.envTex) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.envTex = pmrem.fromScene(new RoomEnvironment(this.renderer), 0.04).texture;
      pmrem.dispose();
    }
    return this.envTex;
  }

  _postKey(w, h) {
    const q = this.q;
    return [w, h, this.pixelRatio, q.post, q.ao, q.bloom, q.grade, q.antialias].join('|');
  }

  _buildPost(w, h) {
    const q = this.q;
    this.composer?.dispose?.();
    this.composer = null;
    if (!q.post || this.postFailed) return;
    const pr = this.pixelRatio;
    const pw = Math.max(1, Math.round(w * pr)), ph = Math.max(1, Math.round(h * pr));
    try {
      const target = new THREE.WebGLRenderTarget(pw, ph, { type: THREE.HalfFloatType, samples: q.antialias === 'msaa' ? 4 : 0 });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (q.ao !== 'off') {
        const ao = new GTAOPass(this.scene, this.camera, pw, ph);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.75;
        ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: q.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: q.ao === 'high' ? 6 : 4, rings: 2, samples: q.ao === 'high' ? 16 : 8 });
        composer.addPass(ao);
      }
      if (q.bloom === 'on') {
        // high threshold: only emissive highlights (selection, hints, sparks, the lamp flame) bloom
        composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.5, 0.4, 1.3));
      }
      if (q.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
      composer.addPass(new OutputPass());
      if (q.antialias === 'smaa') composer.addPass(new SMAAPass(pw, ph));
      if (q.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch {
      // post-processing is an enhancement: render directly and say so in the Graphics panel
      this.postFailed = true;
      this.composer = null;
    }
  }

  // Adaptive resolution: step the scale down when frames are slow, back up when fast.
  _adapt(dtMs) {
    const f = this._frames;
    f.push(dtMs);
    if (f.length < 90) return false;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    this.fps = 1000 / avg;
    const el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = `${Math.round(this.fps)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    if (!this.q.adaptive) return false;
    const before = this.adaptiveScale;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
    return before !== this.adaptiveScale;
  }

  setReducedMotion(v) { this.reducedMotion = v; }

  _motionReduced() { return this.reducedMotion || !!this._prefersReduced?.matches; }

  // ------------------------------------------------------------------ env --

  _buildEnvironment() {
    // lights: one dominant warm key, soft hemisphere fill, lamp glow
    this.keyLight = new THREE.DirectionalLight(0xffe6c0, 2.3);
    this.keyLight.position.set(5, 9, 4);
    this.keyLight.shadow.bias = -0.0006;
    this.keyLight.shadow.normalBias = 0.02;
    this.keyLight.shadow.radius = 3;
    this._fitShadow(8, 6);
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);
    this.hemi = new THREE.HemisphereLight(0x8fa3c7, 0x2a2018, 0.6);
    this.scene.add(this.hemi);
    this.lamp = new THREE.PointLight(0xffc890, 12, 14, 1.8);
    this.lamp.position.set(-4.5, 3.2, -2.5);
    this.scene.add(this.lamp);

    // desk
    this.deskMat = new THREE.MeshStandardMaterial({ color: 0x3a2f28, roughness: 0.82, metalness: 0.05, envMapIntensity: 0.12 });
    const desk = new THREE.Mesh(new THREE.BoxGeometry(26, 0.6, 18), this.deskMat);
    desk.position.y = -0.3;
    desk.receiveShadow = true;
    this.scene.add(desk);

    // felt mat under the board
    this.feltMat = new THREE.MeshStandardMaterial({ color: 0x2e4038, roughness: 0.95, envMapIntensity: 0.12 });
    const felt = new THREE.Mesh(new THREE.BoxGeometry(15, 0.08, 12), this.feltMat);
    felt.position.y = 0.04;
    felt.receiveShadow = true;
    this.scene.add(felt);

    // selection / hint marker ring (shared); HDR colour so it blooms
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(TILE_W * 0.62, TILE_W * 0.78, 48),
      new THREE.MeshBasicMaterial({ color: 0xe8b34b, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
    );
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.visible = false;
    this.scene.add(this.marker);

    this.propsGroup = new THREE.Group();
    this._buildProps(this.propsGroup);
    this.scene.add(this.propsGroup);

    // tile geometry caches: plain box, or rounded with remapped UVs
    this.tileGeoPlain = new THREE.BoxGeometry(TILE_W, TILE_H, TILE_D);
    this.tileGeoRound = roundedTileGeometry();
    this.valueTextures = new Map();
  }

  // Shadow camera fitted to the play area (half-extents in world units).
  _fitShadow(halfW, halfD) {
    const r = Math.hypot(halfW, halfD) + 0.9;
    const cam = this.keyLight.shadow.camera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 2; cam.far = 26;
    cam.updateProjectionMatrix();
  }

  _buildProps(group) {
    const brass = new THREE.MeshPhysicalMaterial({ color: 0xa6823f, roughness: 0.32, metalness: 0.85, clearcoat: 0.4, envMapIntensity: 0.35 });
    const darkWood = new THREE.MeshStandardMaterial({ color: 0x2c221a, roughness: 0.7 });
    this.clothMat = new THREE.MeshStandardMaterial({ color: 0x4a3d33, roughness: 0.9 });
    // telescope silhouette on the left
    const scope = new THREE.Group();
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 3.4, 28), brass);
    tube.rotation.z = Math.PI / 3.4;
    tube.position.y = 1.7;
    scope.add(tube);
    for (const k of [-1.1, 0.2, 1.3]) {
      // bands ride on the tube (its local y axis), following its taper
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.27 - k * 0.0235, 0.035, 8, 28), darkWood);
      band.rotation.x = Math.PI / 2;
      band.position.y = k;
      tube.add(band);
    }
    const eye = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.5, 14), darkWood);
    eye.rotation.z = Math.PI / 3.4;
    eye.position.set(-1.35, 0.82, 0);
    scope.add(eye);
    for (let i = 0; i < 3; i++) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 1.6, 8), darkWood);
      const a = (i / 3) * Math.PI * 2;
      leg.position.set(Math.cos(a) * 0.45, 0.5, Math.sin(a) * 0.45);
      leg.rotation.x = Math.sin(a) * 0.4;
      leg.rotation.z = Math.cos(a) * -0.4;
      scope.add(leg);
    }
    scope.position.set(-6.4, 0, -3.4);
    scope.traverse(o => { if (o.isMesh) o.castShadow = true; });
    group.add(scope);
    // star chart leaning at the back
    const chartTex = this._makeChartTexture();
    const chart = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 2.4), new THREE.MeshStandardMaterial({ map: chartTex, roughness: 0.9, envMapIntensity: 0.2 }));
    chart.position.set(3.8, 1.5, -5.2);
    chart.rotation.x = -0.16;
    group.add(chart);
    // book stack on the right
    const bookCols = [0x6d3b32, 0x2f4a3e, 0x3e3a52];
    const pages = new THREE.MeshStandardMaterial({ color: 0xe9dcc0, roughness: 0.9 });
    for (let i = 0; i < 3; i++) {
      const cover = new THREE.MeshStandardMaterial({ color: bookCols[i], roughness: 0.6, envMapIntensity: 0.15 });
      const book = new THREE.Mesh(new THREE.BoxGeometry(1.7 - i * 0.2, 0.26, 1.2), [cover, pages, cover, cover, pages, pages]);
      book.position.set(6.2, 0.17 + i * 0.27, -2.2);
      book.rotation.y = (i - 1) * 0.12;
      book.castShadow = true;
      book.receiveShadow = true;
      group.add(book);
    }
    // oil lamp beside the telescope: brass base, glass chimney, flame
    const lampG = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.36, 0.22, 28), brass);
    base.position.y = 0.11;
    const font = new THREE.Mesh(new THREE.SphereGeometry(0.3, 28, 16), brass);
    font.scale.y = 0.6;
    font.position.y = 0.36;
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.7, 24, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x3a3226, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.22, envMapIntensity: 0.3, depthWrite: false }));
    glass.position.y = 0.87;
    this.flameMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffd98a, emissiveIntensity: 3.2 });
    this.flame = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 10), this.flameMat);
    this.flame.scale.set(1, 2.1, 1);
    this.flame.position.y = 0.78;
    base.castShadow = font.castShadow = true;
    lampG.add(base, font, glass, this.flame);
    lampG.position.set(-4.5, 0, -2.5);
    group.add(lampG);
    // a folded cloth under the lamp
    const cloth = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.03, 1.1), this.clothMat);
    cloth.position.set(-4.6, 0.015, -2.6);
    cloth.rotation.y = 0.3;
    cloth.receiveShadow = true;
    group.add(cloth);
  }

  _makeChartTexture() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 340;
    const g = c.getContext('2d');
    g.fillStyle = '#20262e';
    g.fillRect(0, 0, 512, 340);
    g.strokeStyle = '#3d4a58';
    g.lineWidth = 2;
    g.strokeRect(12, 12, 488, 316);
    const rng = makeStream('star-chart');
    const pts = [];
    for (let i = 0; i < 40; i++) {
      const x = 30 + rng.next() * 452, y = 30 + rng.next() * 280;
      pts.push([x, y]);
      g.fillStyle = '#cfe0f4';
      g.beginPath(); g.arc(x, y, 1 + rng.next() * 2.2, 0, 7); g.fill();
    }
    g.strokeStyle = 'rgba(160,190,220,0.35)';
    g.lineWidth = 1;
    for (let i = 0; i < 14; i++) {
      const a = pts[rng.int(pts.length)], b = pts[rng.int(pts.length)];
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // Procedural textures are near-white greyscale so theme colours still tint them.
  _woodTex() {
    if (this._wood) return this._wood;
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#d8d8d8';
    g.fillRect(0, 0, 512, 512);
    const rng = makeStream('desk-wood');
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
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(2.5, 1.7);
    tex.anisotropy = 4;
    this._wood = tex;
    return tex;
  }

  _feltTex() {
    if (this._felt) return this._felt;
    const c = document.createElement('canvas');
    c.width = 256; c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#e6e6e6';
    g.fillRect(0, 0, 256, 256);
    const rng = makeStream('felt');
    for (let i = 0; i < 5000; i++) {
      const v = 190 + Math.floor(rng.next() * 65);
      g.fillStyle = `rgba(${v},${v},${v},0.5)`;
      g.fillRect(rng.next() * 256, rng.next() * 256, 1 + rng.next() * 2, 1);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(6, 5);
    this._felt = tex;
    return tex;
  }

  // Tile side: ivory above a jade backing layer, like a traditional two-ply tile.
  _sideTex() {
    if (this._side) return this._side;
    const c = document.createElement('canvas');
    c.width = 4; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 4, 64);
    g.fillStyle = '#5f9a86';
    g.fillRect(0, 40, 4, 24);
    g.fillStyle = '#c9c0b0';
    g.fillRect(0, 39, 4, 1);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this._side = tex;
    return tex;
  }

  _valueTexture(value) {
    if (this.valueTextures.has(value)) return this.valueTextures.get(value);
    const detailed = this.q.detail === 'detailed';
    const W = detailed ? 256 : 128, H = detailed ? 320 : 160, k = W / 128;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const tile = this.theme ? this.theme.tile : '#f3ead8';
    const ink = this.tileInkColor || '#3b3230';
    g.fillStyle = tile;
    g.fillRect(0, 0, W, H);
    const rng = makeStream('tile-' + value);
    if (detailed) {
      // faint ivory veining
      g.globalAlpha = 0.05;
      g.strokeStyle = '#6b5a3a';
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
      g.fillStyle = rng.next() < 0.5 ? '#000' : '#fff';
      g.fillRect(rng.next() * W, rng.next() * H, 2 * k, 2 * k);
    }
    g.globalAlpha = 0.35;
    g.strokeStyle = ink;
    g.lineWidth = 4 * k;
    g.strokeRect(8 * k, 8 * k, 112 * k, 144 * k);
    if (detailed) {
      g.lineWidth = 1.2 * k;
      g.strokeRect(14 * k, 14 * k, 100 * k, 132 * k);
    }
    g.globalAlpha = 1;
    g.font = `700 ${84 * k}px Georgia, serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (detailed) {
      // engraved: a light lower-right lip under the ink
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.fillText(String(value), 64 * k + 1.5 * k, 84 * k + 1.5 * k);
    }
    g.fillStyle = ink;
    g.fillText(String(value), 64 * k, 84 * k);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    let bump = null;
    if (detailed) {
      const b = document.createElement('canvas');
      b.width = W; b.height = H;
      const bg = b.getContext('2d');
      bg.fillStyle = '#fff';
      bg.fillRect(0, 0, W, H);
      bg.fillStyle = '#000';
      bg.font = g.font; bg.textAlign = 'center'; bg.textBaseline = 'middle';
      bg.fillText(String(value), 64 * k, 84 * k);
      bg.strokeStyle = '#555';
      bg.lineWidth = 4 * k;
      bg.strokeRect(8 * k, 8 * k, 112 * k, 144 * k);
      bump = new THREE.CanvasTexture(b);
    }
    const entry = { map: tex, bump };
    this.valueTextures.set(value, entry);
    return entry;
  }

  _retintTiles() {
    for (const e of this.valueTextures.values()) { e.map.dispose(); e.bump?.dispose(); }
    this.valueTextures.clear();
    for (const view of this.tileViews.values()) {
      const old = view.mesh.material;
      view.mesh.material = this._tileMaterials(view.value);
      view.mesh.geometry = this._tileGeo();
      for (const m of old) m.dispose();
    }
    if (this._lastState && this.tileViews.size) this.syncState(this._lastState, [], true);
  }

  _tileGeo() { return this.q.detail === 'detailed' ? this.tileGeoRound : this.tileGeoPlain; }

  _topMat(value) {
    const t = this._valueTexture(value);
    if (this.q.detail === 'detailed') {
      return new THREE.MeshPhysicalMaterial({
        map: t.map, emissiveMap: t.map, bumpMap: t.bump, bumpScale: 0.6, roughness: 0.42, metalness: 0,
        clearcoat: 0.5, clearcoatRoughness: 0.3, envMapIntensity: 0.14,
      });
    }
    // emissiveMap keeps the numeral dark while a selection/hint tint lights the ivory
    return new THREE.MeshStandardMaterial({ map: t.map, emissiveMap: t.map, roughness: 0.5, metalness: 0.02 });
  }

  _edgeMat() {
    if (this.q.detail === 'detailed') {
      return new THREE.MeshPhysicalMaterial({ color: 0xd8cbb2, map: this._sideTex(), roughness: 0.5, clearcoat: 0.4, clearcoatRoughness: 0.35, envMapIntensity: 0.14 });
    }
    return new THREE.MeshStandardMaterial({ color: 0xd8cbb2, roughness: 0.62 });
  }

  // BoxGeometry group order: +x, -x, +y, -y, +z, -z — top face is index 2
  _tileMaterials(value) {
    return [this._edgeMat(), this._edgeMat(), this._topMat(value), this._edgeMat(), this._edgeMat(), this._edgeMat()];
  }

  // ------------------------------------------------------------- particles --

  _initParticles() {
    this.particleData = new Float32Array(MAX_PARTICLES * 3);
    this.particleVel = new Float32Array(MAX_PARTICLES * 3);
    this.particleLife = new Float32Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) this.particleData[i * 3 + 1] = -10;
    const sprite = softSprite();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.particleData, 3));
    this.particleMat = new THREE.PointsMaterial({ color: 0xffd98a, map: sprite, size: 0.11, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending });
    this.particleMat.color.multiplyScalar(2.2);
    this.particles = new THREE.Points(geo, this.particleMat);
    this.particles.frustumCulled = false;
    this.particleCap = PARTICLES[this.q.particles];
    this.scene.add(this.particles);

    // dust motes drifting through the lamp light (ambient motion)
    this.moteBase = new Float32Array(MOTES * 3);
    this.motePos = new Float32Array(MOTES * 3);
    const rng = makeStream('motes');
    for (let i = 0; i < MOTES; i++) {
      this.moteBase[i * 3] = -8 + rng.next() * 16;
      this.moteBase[i * 3 + 1] = 0.4 + rng.next() * 4.2;
      this.moteBase[i * 3 + 2] = -5.5 + rng.next() * 9;
    }
    this.motePos.set(this.moteBase);
    const mgeo = new THREE.BufferGeometry();
    mgeo.setAttribute('position', new THREE.BufferAttribute(this.motePos, 3));
    this.moteMat = new THREE.PointsMaterial({ color: 0xffd98a, map: sprite, size: 0.05, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending });
    this.motes = new THREE.Points(mgeo, this.moteMat);
    this.motes.frustumCulled = false;
    this.scene.add(this.motes);
  }

  burst(x, y, z, count = 14) {
    const cap = Math.min(count, this.particleCap || 0);
    if (!cap) return;
    let placed = 0;
    for (let i = 0; i < this.particleCap && placed < cap; i++) {
      if (this.particleLife[i] > 0) continue;
      const j = i * 3;
      this.particleData[j] = x; this.particleData[j + 1] = y; this.particleData[j + 2] = z;
      const a = this.decoRng.next() * Math.PI * 2, up = this.decoRng.next();
      const sp = 1.2 + this.decoRng.next() * 1.6;
      this.particleVel[j] = Math.cos(a) * sp * 0.5;
      this.particleVel[j + 1] = up * sp;
      this.particleVel[j + 2] = Math.sin(a) * sp * 0.5;
      this.particleLife[i] = 0.7;
      placed++;
    }
    this.particles.geometry.attributes.position.needsUpdate = true;
  }

  _stepParticles(dt) {
    if (!this.particles.visible) return;
    let any = false;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.particleLife[i] <= 0) continue;
      any = true;
      this.particleLife[i] -= dt;
      const j = i * 3;
      this.particleVel[j + 1] -= 3.4 * dt;
      this.particleData[j] += this.particleVel[j] * dt;
      this.particleData[j + 1] += this.particleVel[j + 1] * dt;
      this.particleData[j + 2] += this.particleVel[j + 2] * dt;
      if (this.particleLife[i] <= 0) this.particleData[j + 1] = -10;
    }
    if (any) this.particles.geometry.attributes.position.needsUpdate = true;
  }

  _stepAmbient(t) {
    const animate = this.q.ambient === 'animated' && !this._motionReduced();
    const s = t / 1000;
    if (this.motes.visible && animate) {
      for (let i = 0; i < MOTES; i++) {
        const j = i * 3, p = i * 1.7;
        this.motePos[j] = this.moteBase[j] + Math.sin(s * 0.13 + p) * 0.6;
        this.motePos[j + 1] = this.moteBase[j + 1] + Math.sin(s * 0.09 + p * 1.3) * 0.35;
        this.motePos[j + 2] = this.moteBase[j + 2] + Math.cos(s * 0.11 + p * 0.7) * 0.5;
      }
      this.motes.geometry.attributes.position.needsUpdate = true;
    }
    // lamp shimmer
    const flick = animate ? (Math.sin(s * 7.3) * 0.5 + Math.sin(s * 12.9 + 1.3) * 0.3 + Math.sin(s * 3.1) * 0.2) : 0;
    this.lamp.intensity = 12 * (1 + flick * 0.04);
    if (this.flame) this.flame.scale.set(1, 2.1 + flick * 0.18, 1);
  }

  // ---------------------------------------------------------------- board --

  buildBoard(state) {
    // clear previous
    for (const view of this.tileViews.values()) {
      view.mesh.removeFromParent();
    }
    this.tileViews.clear();
    this.boardRng = makeStream('deco-board-' + String(state.seed));
    this._cells = state.layout.cells;
    this._lastState = state;

    const cells = state.layout.cells;
    const xs = cells.map(c => c.x), ys = cells.map(c => c.y);
    this.origin = {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
    };
    this._frameCamera(state);
    {
      const w = (Math.max(...xs) - Math.min(...xs) + 1) * (TILE_W + GAP);
      const d = (Math.max(...ys) - Math.min(...ys) + 1) * (TILE_D + GAP);
      this._fitShadow(w / 2, d / 2);
    }

    for (const idStr of Object.keys(state.tiles)) {
      const tile = state.tiles[idStr];
      const view = this._makeTileView(tile);
      this.tileViews.set(tile.id, view);
      this.scene.add(view.mesh);
    }
    this.syncState(state, [], true);
    this._prewarm();
  }

  _makeTileView(tile) {
    // BoxGeometry group order: +x, -x, +y, -y, +z, -z — top face is index 2
    const mesh = new THREE.Mesh(this._tileGeo(), this._tileMaterials(tile.value));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.tileId = tile.id;
    const pos = this._tilePos(tile);
    mesh.position.set(pos.x, pos.y, pos.z);
    const jitter = (this.boardRng.next() - 0.5) * 0.04;
    mesh.rotation.y = jitter;
    return { mesh, value: tile.value, baseY: pos.y, lift: 0, opacity: 1, scale: 1, removed: false, exiting: false, shakeX: 0, basePos: pos, jitter };
  }

  _tilePos(tile) {
    const cell = this._cellOf(tile.stack);
    return {
      x: (cell.x - this.origin.x) * (TILE_W + GAP),
      y: 0.08 + TILE_H / 2 + tile.level * (TILE_H + 0.02),
      z: (cell.y - this.origin.y) * (TILE_D + GAP),
    };
  }

  _cellOf(stackIndex) { return this._cells[stackIndex]; }

  syncState(state, events = [], instant = false) {
    this._cells = state.layout.cells;
    const doTween = !instant && !this.reducedMotion;

    for (const view of this.tileViews.values()) {
      const tile = state.tiles[view.mesh.userData.tileId];
      const col = state.stacks[tile.stack];
      const stillPresent = col.includes(tile.id);
      const exposed = stillPresent && isExposed(state, tile.id);
      // keep removed tiles visible only while their exit animation runs
      view.mesh.visible = stillPresent || (view.removed && view.exiting);

      if (stillPresent) {
        const pos = this._tilePos(tile);
        if (view.removed) {
          // restored by undo: reset the removal animation state and drop any
          // stale exit tweens so they cannot re-hide or move the tile
          view.removed = false;
          view.exiting = false;
          this.tweens.cancel(view.mesh.position);
          this.tweens.cancel(view.mesh.scale);
          view.mesh.scale.setScalar(1);
          view.mesh.position.set(pos.x, pos.y, pos.z);
          view.mesh.visible = true;
        }
        view.basePos = pos;
        view.baseY = pos.y;
        const isSelected = state.selected === tile.id;
        const isHinted = state.hintedPair && state.hintedPair.includes(tile.id);
        const targetLift = isSelected ? 0.22 : 0;
        if (doTween) {
          if (Math.abs(view.mesh.position.x - pos.x) > 0.001 || Math.abs(view.mesh.position.z - pos.z) > 0.001) {
            this.tweens.add(view.mesh.position, { x: pos.x, z: pos.z }, 180);
          }
        } else {
          view.mesh.position.x = pos.x; view.mesh.position.z = pos.z;
        }
        view.lift = targetLift;
        const topMat = view.mesh.material[2];
        topMat.emissive = topMat.emissive || new THREE.Color();
        if (isSelected) topMat.emissive.set(this.accentColor).multiplyScalar(0.26);
        else if (isHinted) topMat.emissive.set(this.accentColor).multiplyScalar(0.45);
        else topMat.emissive.setRGB(0, 0, 0);
        view.mesh.scale.setScalar(exposed ? 1 : 0.97);
        const edgeColor = exposed ? (this.theme ? this.theme.tileEdge : '#d8cbb2') : '#8d8474';
        for (let m = 0; m < 6; m++) {
          if (m !== 2) view.mesh.material[m].color.set(edgeColor);
        }
        topMat.opacity = 1;
      }
    }

    // selection marker
    if (state.selected != null && this.tileViews.has(state.selected)) {
      const v = this.tileViews.get(state.selected);
      this.marker.visible = true;
      this.marker.position.set(v.basePos.x, 0.1, v.basePos.z);
      if (this.accentColor) this.marker.material.color.set(this.accentColor).multiplyScalar(1.7);
    } else {
      this.marker.visible = false;
    }

    // event-driven effects (bounded hierarchy)
    for (const ev of events) {
      if (ev.type === 'pair') {
        for (const id of [ev.tileA, ev.tileB]) {
          const view = this.tileViews.get(id);
          if (!view) continue;
          view.removed = true;
          view.exiting = true;
          view.mesh.visible = true;
          const p = view.mesh.position;
          this.burst(p.x, p.y + 0.2, p.z, 12);
          if (doTween) {
            this.tweens.add(view.mesh.position, { y: p.y + 1.4 }, 420, easeOutCubic, () => { view.exiting = false; view.mesh.visible = false; });
            this.tweens.add(view.mesh.scale, { x: 0.6, y: 0.6, z: 0.6 }, 420);
          } else {
            view.exiting = false;
            view.mesh.visible = false;
          }
        }
      } else if (ev.type === 'invalid') {
        for (const id of [ev.tileA, ev.tileB]) {
          if (id == null) continue;
          const view = this.tileViews.get(id);
          if (!view || view.removed) continue;
          const topMat = view.mesh.material[2];
          topMat.emissive = topMat.emissive || new THREE.Color();
          topMat.emissive.setRGB(0.55, 0.08, 0.05);
          if (doTween) {
            const startX = view.mesh.position.x;
            const shake = { k: 0 };
            const shakeTween = { obj: shake, from: { k: 0 }, to: { k: 1 }, t0: performance.now(), dur: 260, ease: easeOutCubic, onDone: () => { view.mesh.position.x = view.basePos.x; topMat.emissive.setRGB(0, 0, 0); } };
            // custom shake path
            this.tweens.list.push(shakeTween);
            const tick = () => {
              if (shake.k >= 1) return;
              view.mesh.position.x = startX + Math.sin(shake.k * Math.PI * 5) * 0.06 * (1 - shake.k);
              requestAnimationFrame(tick);
            };
            tick();
          } else {
            setTimeout(() => topMat.emissive.setRGB(0, 0, 0), 300);
          }
        }
      } else if (ev.type === 'reshuffle') {
        for (const view of this.tileViews.values()) {
          const tile = state.tiles[view.mesh.userData.tileId];
          if (!state.stacks[tile.stack].includes(tile.id)) continue;
          if (view.value !== tile.value) {
            view.value = tile.value;
            view.mesh.material[2].dispose();
            view.mesh.material[2] = this._topMat(tile.value);
            if (doTween) {
              view.mesh.rotation.y += Math.PI * 2;
              this.tweens.add(view.mesh.rotation, { y: view.jitter }, 350);
            } else {
              view.mesh.rotation.y = view.jitter;
            }
          }
        }
      }
    }
  }

  settleImmediately() { this.tweens.settle(); }

  _frameCamera(state) {
    const cells = state.layout.cells;
    const xs = cells.map(c => c.x), ys = cells.map(c => c.y);
    const w = (Math.max(...xs) - Math.min(...xs) + 1) * (TILE_W + GAP);
    const d = (Math.max(...ys) - Math.min(...ys) + 1) * (TILE_D + GAP);
    const aspect = this.camera.aspect || 1.6;
    // fit both axes: width against the horizontal half-angle, depth against
    // the vertical half-angle compressed by the camera's elevation tilt
    const tanV = Math.tan((this.camera.fov * Math.PI) / 360);
    const tanH = tanV * Math.min(aspect, 1.8);
    const distW = (w / 2) / tanH;
    const distD = ((d / 2) * 0.85) / tanV;
    const dist = Math.max(distW, distD, 3.8) * (aspect < 0.8 ? 1.05 : 1.18); // tighter on portrait: width-bound tiles stay ≥44px
    // fog starts beyond the fitted distance so tile faces never dim on far
    // (narrow-viewport) framings
    if (this.scene.fog) { this.scene.fog.near = Math.max(18, dist * 1.6); this.scene.fog.far = Math.max(40, dist * 3.2); }
    let target;
    if (this.cameraMode === 'top') target = { px: 0, py: dist * 1.35, pz: 0.8, lx: 0, ly: 0, lz: 0 };
    else if (this.cameraMode === 'low') target = { px: 0, py: dist * 0.62, pz: dist * 0.95, lx: 0, ly: 0, lz: 0 };
    else target = { px: 0, py: dist * 0.92, pz: dist * 0.78, lx: 0, ly: 0, lz: 0 };
    if (this.reducedMotion) {
      Object.assign(this.camView, target);
    } else {
      this.tweens.add(this.camView, target, 900);
    }
  }

  setCameraMode(mode) { this.cameraMode = mode; }
  resetCamera() { if (this._lastState) this._frameCamera(this._lastState); }

  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const meshes = [];
    for (const view of this.tileViews.values()) {
      if (view.mesh.visible) meshes.push(view.mesh);
    }
    const hits = ray.intersectObjects(meshes, false);
    if (!hits.length) return null;
    // A tile animating off the board still occludes whatever is behind it:
    // report no pick rather than a tile the player cannot see.
    const hit = this.tileViews.get(hits[0].object.userData.tileId);
    return hit && !hit.removed ? hits[0].object.userData.tileId : null;
  }

  // project a tile to CSS pixel coords (shared layout model for DOM labels)
  tileScreenPos(tileId) {
    const view = this.tileViews.get(tileId);
    if (!view || !view.mesh.visible) return null;
    const v = new THREE.Vector3();
    view.mesh.getWorldPosition(v);
    v.y += TILE_H;
    v.project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + (v.x + 1) / 2 * rect.width, y: rect.top + (-v.y + 1) / 2 * rect.height };
  }

  _prewarm() {
    // compile all shader variants before active play
    this.renderer.compile(this.scene, this.camera);
  }

  _resize() {
    // pixel ratio and size are applied in the render loop (they depend on settings and adaptive scale)
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this._lastState) this._frameCamera(this._lastState);
  }

  _rebuild() {
    // context restored: GPU resources are rebuilt from retained CPU-side state
    this.composer?.dispose?.();
    this.composer = null;
    this.renderer.dispose();
    this.envTex = null;
    this._wood = this._felt = this._side = null;
    this._initGL();
    this.valueTextures.clear();
    const theme = this.theme;
    this._buildEnvironment();
    this._initParticles();
    this._applyGfx(true);
    if (theme) this.setTheme(theme);
    if (this._lastState) { this.buildBoard(this._lastState); }
    this._resize();
  }

  _loop(t) {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this._loop);
    if (document.hidden) return; // background tab: rendering paused
    if (this.contextLost) return;
    // The play field is visibility:hidden behind menu screens (and when the
    // 2D board replaces the canvas). Rendering then is invisible work that
    // starves the main thread — worst on software-GL desktop, where it can
    // block menu clicks entirely. Skip until the canvas is shown again.
    if (this.canvas.checkVisibility && !this.canvas.checkVisibility({ checkVisibilityCSS: true })) {
      this._lastT = t;
      return;
    }
    const dtMs = this._lastT ? Math.min(250, t - this._lastT) : 16;
    const dt = Math.min(0.05, dtMs / 1000 || 0.016);
    this._lastT = t;
    this.tweens.update(t);
    // lift animation toward target (deterministic spring-less approach via tween on demand)
    for (const view of this.tileViews.values()) {
      if (!view.mesh.visible) continue;
      const targetY = view.baseY + view.lift;
      if (Math.abs(view.mesh.position.y - targetY) > 0.002 && !view.removed) {
        // critically damped approach, frame-rate independent
        const k = 1 - Math.exp(-12 * dt);
        view.mesh.position.y += (targetY - view.mesh.position.y) * k;
      }
    }
    if (this.marker.visible && !this.reducedMotion) {
      const s = 1 + Math.sin(t / 280) * 0.06;
      this.marker.scale.set(s, s, s);
    }
    this._stepParticles(dt);
    this._stepAmbient(t);
    this.camera.position.set(this.camView.px, this.camView.py, this.camView.pz);
    this.camera.lookAt(this.camView.lx, this.camView.ly, this.camView.lz);

    const rescale = this._adapt(dtMs);
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    const ratio = Math.min(window.devicePixelRatio || 1, this.q.dprCap) * this.q.scale * this.adaptiveScale;
    if (w !== this.size[0] || h !== this.size[1] || ratio !== this.pixelRatio || rescale) {
      this.size = [w, h];
      this.pixelRatio = ratio;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(w, h, false);
    }
    const key = this._postKey(w, h);
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost(w, h);
    }
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  attachStateGetter(getState) { this._getState = getState; }

  noteState(state) { this._lastState = state; }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this._onResize);
    for (const view of this.tileViews.values()) view.mesh.removeFromParent();
    this.tileViews.clear();
    for (const e of this.valueTextures.values()) { e.map.dispose(); e.bump?.dispose(); }
    this.tileGeoPlain?.dispose();
    this.tileGeoRound?.dispose();
    this.composer?.dispose?.();
    this.envTex?.dispose();
    this.particles?.geometry.dispose();
    this.renderer?.dispose();
  }
}

// Rounded tile with BoxGeometry-compatible UVs: the top face maps x/z like a
// plain box (numbers stay upright) and the sides map v to height, so the
// two-ply side texture lines up on every face.
function roundedTileGeometry() {
  const geo = new RoundedBoxGeometry(TILE_W, TILE_H, TILE_D, 3, 0.06);
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  const top = geo.groups[2];
  const index = geo.index;
  const topVerts = new Set();
  for (let i = top.start; i < top.start + top.count; i++) topVerts.add(index ? index.getX(i) : i);
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (topVerts.has(i)) uv.setXY(i, clamp01(x / TILE_W + 0.5), clamp01(0.5 - z / TILE_D));
    else uv.setXY(i, 0.5, clamp01(y / TILE_H + 0.5));
  }
  uv.needsUpdate = true;
  return geo;
}

function softSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export { TILE_W, TILE_H, TILE_D, GAP };
