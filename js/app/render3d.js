// Three.js presentation layer. Consumes immutable rules snapshots + event
// lists; never mutates rules state. Cosmetic randomness uses its own seeded
// stream. Quality tiers control shadows/particles/pixel ratio only — never
// rules, hazard visibility, or picking.

import * as THREE from '../../vendor/three.module.js';
import { makeStream, hashString } from '../rules/rng.js';
import { isExposed } from '../rules/engine.js';

const TILE_W = 1.0, TILE_H = 0.34, TILE_D = 1.3, GAP = 0.16;

const TIERS = {
  low: { dpr: 1, shadow: 0, particles: 0, props: false },
  medium: { dpr: 1.5, shadow: 512, particles: 60, props: true },
  high: { dpr: 2, shadow: 1024, particles: 200, props: true },
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

// ---------------------------------------------------------------------------

export class Renderer3D {
  constructor(canvas, { tier = 'medium', reducedMotion = false } = {}) {
    this.canvas = canvas;
    this.reducedMotion = reducedMotion;
    this.tierName = tier in TIERS ? tier : 'medium';
    this.tweens = new Tweens();
    this.tileViews = new Map();  // tileId -> view
    this.decoRng = makeStream('deco-scene');
    this.disposed = false;
    this.cameraMode = 'default';
    this._initGL();
    this._buildEnvironment();
    this._initParticles();
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
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: this.tierName !== 'low', powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    this.camera.position.set(0, 8, 10);
    this.camera.lookAt(0, 0, 0);
    this.camView = { px: 0, py: 8, pz: 10, lx: 0, ly: 0, lz: 0 };
  }

  setTheme(theme) {
    this.theme = theme;
    const sky = new THREE.Color(theme.sky);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 18, 40);
    if (this.keyLight) this.keyLight.color.set(theme.glow);
    if (this.deskMat) this.deskMat.color.set(theme.desk);
    if (this.feltMat) this.feltMat.color.set(theme.felt);
    if (this.tileMat) {
      this.tileMat.color.set(theme.tile);
    }
    this.tileInkColor = theme.ink;
    this.accentColor = new THREE.Color(theme.accent);
    this._retintTiles();
  }

  setQuality(tierName) {
    if (!(tierName in TIERS) || tierName === this.tierName) return;
    this.tierName = tierName;
    const t = TIERS[tierName];
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, t.dpr));
    this.renderer.shadowMap.enabled = t.shadow > 0;
    if (this.keyLight) {
      this.keyLight.castShadow = t.shadow > 0;
      if (t.shadow) {
        this.keyLight.shadow.mapSize.set(t.shadow, t.shadow);
        if (this.keyLight.shadow.map) { this.keyLight.shadow.map.dispose(); this.keyLight.shadow.map = null; }
      }
    }
    if (this.particles) this.particles.visible = t.particles > 0;
    if (this.propsGroup) this.propsGroup.visible = t.props;
    this._resize();
  }

  setReducedMotion(v) { this.reducedMotion = v; }

  // ------------------------------------------------------------------ env --

  _buildEnvironment() {
    const t = TIERS[this.tierName];
    // lights: one dominant warm key, soft hemisphere fill, contact shadows
    this.keyLight = new THREE.DirectionalLight(0xffe0b0, 2.4);
    this.keyLight.position.set(5, 9, 4);
    this.keyLight.castShadow = t.shadow > 0;
    if (t.shadow) {
      this.keyLight.shadow.mapSize.set(t.shadow, t.shadow);
      this.keyLight.shadow.camera.left = -9;
      this.keyLight.shadow.camera.right = 9;
      this.keyLight.shadow.camera.top = 9;
      this.keyLight.shadow.camera.bottom = -9;
      this.keyLight.shadow.bias = -0.0015;
    }
    this.scene.add(this.keyLight);
    this.scene.add(new THREE.HemisphereLight(0x8fa3c7, 0x2a2018, 0.55));
    const lamp = new THREE.PointLight(0xffc890, 12, 14, 1.8);
    lamp.position.set(-4.5, 3.2, -2.5);
    this.scene.add(lamp);

    // desk
    this.deskMat = new THREE.MeshStandardMaterial({ color: 0x3a2f28, roughness: 0.82, metalness: 0.05 });
    const desk = new THREE.Mesh(new THREE.BoxGeometry(26, 0.6, 18), this.deskMat);
    desk.position.y = -0.3;
    desk.receiveShadow = true;
    this.scene.add(desk);

    // felt mat under the board
    this.feltMat = new THREE.MeshStandardMaterial({ color: 0x2e4038, roughness: 0.95 });
    const felt = new THREE.Mesh(new THREE.BoxGeometry(15, 0.08, 12), this.feltMat);
    felt.position.y = 0.04;
    felt.receiveShadow = true;
    this.scene.add(felt);

    // selection / hint marker ring (shared)
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(TILE_W * 0.62, TILE_W * 0.78, 40),
      new THREE.MeshBasicMaterial({ color: 0xe8b34b, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
    );
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.visible = false;
    this.scene.add(this.marker);

    this.propsGroup = new THREE.Group();
    this._buildProps(this.propsGroup);
    this.propsGroup.visible = t.props;
    this.scene.add(this.propsGroup);

    // tile material + geometry caches
    this.tileGeo = new THREE.BoxGeometry(TILE_W, TILE_H, TILE_D);
    this.tileMat = new THREE.MeshStandardMaterial({ color: 0xf3ead8, roughness: 0.5, metalness: 0.02 });
    this.tileEdgeMat = new THREE.MeshStandardMaterial({ color: 0xd8cbb2, roughness: 0.62 });
    this.valueTextures = new Map();
  }

  _buildProps(group) {
    const brass = new THREE.MeshStandardMaterial({ color: 0x9a7b3f, roughness: 0.35, metalness: 0.8 });
    const darkWood = new THREE.MeshStandardMaterial({ color: 0x2c221a, roughness: 0.8 });
    // telescope silhouette on the left
    const scope = new THREE.Group();
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 3.4, 20), brass);
    tube.rotation.z = Math.PI / 3.4;
    tube.position.y = 1.7;
    scope.add(tube);
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
    const chart = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 2.4), new THREE.MeshStandardMaterial({ map: chartTex, roughness: 0.9 }));
    chart.position.set(3.8, 1.5, -5.2);
    chart.rotation.x = -0.16;
    group.add(chart);
    // book stack on the right
    const bookCols = [0x6d3b32, 0x2f4a3e, 0x3e3a52];
    for (let i = 0; i < 3; i++) {
      const book = new THREE.Mesh(new THREE.BoxGeometry(1.7 - i * 0.2, 0.26, 1.2), new THREE.MeshStandardMaterial({ color: bookCols[i], roughness: 0.75 }));
      book.position.set(6.2, 0.17 + i * 0.27, -2.2);
      book.rotation.y = (i - 1) * 0.12;
      book.castShadow = true;
      group.add(book);
    }
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

  _valueTexture(value) {
    if (this.valueTextures.has(value)) return this.valueTextures.get(value);
    const c = document.createElement('canvas');
    c.width = 128; c.height = 160;
    const g = c.getContext('2d');
    g.fillStyle = this.theme ? this.theme.tile : '#f3ead8';
    g.fillRect(0, 0, 128, 160);
    // subtle grain
    const rng = makeStream('tile-' + value);
    g.globalAlpha = 0.05;
    for (let i = 0; i < 60; i++) {
      g.fillStyle = rng.next() < 0.5 ? '#000' : '#fff';
      g.fillRect(rng.next() * 128, rng.next() * 160, 2, 2);
    }
    g.globalAlpha = 1;
    g.strokeStyle = this.tileInkColor || '#3b3230';
    g.globalAlpha = 0.35;
    g.lineWidth = 4;
    g.strokeRect(8, 8, 112, 144);
    g.globalAlpha = 1;
    g.fillStyle = this.tileInkColor || '#3b3230';
    g.font = '700 84px Georgia, serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(value), 64, 84);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this.valueTextures.set(value, tex);
    return tex;
  }

  _retintTiles() {
    this.valueTextures.clear();
    for (const view of this.tileViews.values()) {
      view.mesh.material[2] = this._topMat(view.value); // +y is the top face
    }
  }

  _topMat(value) {
    return new THREE.MeshStandardMaterial({
      map: this._valueTexture(value),
      roughness: 0.5, metalness: 0.02,
    });
  }

  // ------------------------------------------------------------- particles --

  _initParticles() {
    const MAX = 200;
    this.particleData = new Float32Array(MAX * 3);
    this.particleVel = new Float32Array(MAX * 3);
    this.particleLife = new Float32Array(MAX);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.particleData, 3));
    this.particleMat = new THREE.PointsMaterial({ color: 0xffd98a, size: 0.07, transparent: true, opacity: 0.9, depthWrite: false });
    this.particles = new THREE.Points(geo, this.particleMat);
    this.particles.visible = TIERS[this.tierName].particles > 0;
    this.particles.frustumCulled = false;
    this.particleCap = TIERS[this.tierName].particles;
    this.scene.add(this.particles);
  }

  burst(x, y, z, count = 14) {
    const cap = Math.min(count, TIERS[this.tierName].particles);
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
    for (let i = 0; i < this.particleCap; i++) {
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
    const mats = [
      this.tileEdgeMat.clone(), this.tileEdgeMat.clone(), this._topMat(tile.value),
      this.tileEdgeMat.clone(), this.tileEdgeMat.clone(), this.tileEdgeMat.clone(),
    ];
    const mesh = new THREE.Mesh(this.tileGeo, mats);
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
        if (isSelected) topMat.emissive.set(this.accentColor).multiplyScalar(0.35);
        else if (isHinted) topMat.emissive.set(this.accentColor).multiplyScalar(0.55);
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
      if (this.accentColor) this.marker.material.color.set(this.accentColor);
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
    const dist = Math.max(distW, distD, 3.8) * 1.18;
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
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, TIERS[this.tierName].dpr));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this._lastState) this._frameCamera(this._lastState);
  }

  _rebuild() {
    // context restored: GPU resources are rebuilt from retained CPU-side state
    this.renderer.dispose();
    this._initGL();
    this.valueTextures.clear();
    const theme = this.theme;
    const tier = this.tierName;
    this._buildEnvironment();
    this._initParticles();
    this.tierName = tier;
    if (theme) this.setTheme(theme);
    if (this._lastState) { this.buildBoard(this._lastState); }
    this._resize();
  }

  _loop(t) {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this._loop);
    if (document.hidden) return; // background tab: rendering paused
    if (this.contextLost) return;
    const dt = Math.min(0.05, (t - this._lastT) / 1000 || 0.016);
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
    this.camera.position.set(this.camView.px, this.camView.py, this.camView.pz);
    this.camera.lookAt(this.camView.lx, this.camView.ly, this.camView.lz);
    this.renderer.render(this.scene, this.camera);
  }

  attachStateGetter(getState) { this._getState = getState; }

  noteState(state) { this._lastState = state; }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this._onResize);
    for (const view of this.tileViews.values()) view.mesh.removeFromParent();
    this.tileViews.clear();
    for (const tex of this.valueTextures.values()) tex.dispose();
    this.tileGeo?.dispose();
    this.particles?.geometry.dispose();
    this.renderer?.dispose();
  }
}

export function detectTier() {
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  const mobile = /Mobi|Android/i.test(navigator.userAgent);
  if (mobile || mem <= 3 || cores <= 4) return 'low';
  if (mem <= 6 || cores <= 6) return 'medium';
  return 'high';
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
