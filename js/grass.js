// GPU instanced grass with wind sway + jet-wash (radial push, flattened wake, outward ripple rings)
import * as THREE from 'three';
import { DX, DZ, X0, SEG_X } from './terrain.js?v=33';

const ROWS = 64, COLS = SEG_X + 1, TRAIL = 10;

// tuft geometry: `blades` blades, each `segs` segments + tip; attribute aT = height fraction, aSide = -1..1
function tuftGeo(blades, segs, w, seed) {
  const pos = [], t = [], side = [], idx = [];
  let rs = seed;
  const rnd = () => { rs = (rs * 16807) % 2147483647; return rs / 2147483647; };
  for (let b = 0; b < blades; b++) {
    const a = rnd() * Math.PI, ox = (rnd() - 0.5) * 0.9, oz = (rnd() - 0.5) * 0.9, hk = 0.7 + rnd() * 0.5;
    const ca = Math.cos(a), sa = Math.sin(a), base = pos.length / 3;
    for (let s = 0; s <= segs; s++) {
      const f = s / (segs + 1), ww = w * (1 - f * 0.85);
      for (const sd of [-1, 1]) { pos.push(ox + ca * ww * sd * 0.5, f * hk, oz + sa * ww * sd * 0.5); t.push(f * hk); side.push(sd); }
    }
    pos.push(ox, hk, oz); t.push(hk); side.push(0);
    for (let s = 0; s < segs; s++) { const k = base + s * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    const k = base + segs * 2; idx.push(k, k + 1, k + 2);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(t, 1));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  g.setIndex(idx);
  return g;
}

const VS = /* glsl */`
precision highp float;
uniform sampler2D hMap; uniform vec2 anchor; uniform float spacing; uniform float rIn; uniform float rOut; uniform float hScale; uniform float tallK;
uniform float time; uniform vec3 shipP; uniform float wash; uniform float washR; uniform float spd; uniform float lowK; uniform vec4 trail[${TRAIL}];
attribute float aT; attribute float aSide; attribute vec2 aCell;
varying float vT; varying float vSheen; varying float vVar; varying vec3 vW; varying float vDry;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec2 tex(int i, int j){ int s = j - ${ROWS} * int(floor(float(j) / ${ROWS}.0)); return texelFetch(hMap, ivec2(clamp(i, 0, ${COLS - 1}), s), 0).rg; }
void main(){
  vec2 cell = floor(anchor / spacing) + aCell;
  float h1 = hash(cell), h2 = hash(cell + 17.3), h3 = hash(cell + 41.1);
  vec2 root = (cell + vec2(h1, h2)) * spacing;
  float d = distance(root, cameraPosition.xz);
  // terrain height/density from ring texture (bilinear, matches gridHeight)
  float gx = (root.x - (${X0.toFixed(1)})) / ${DX.toFixed(4)}, gz = -root.y / ${DZ.toFixed(4)};
  int i = int(floor(gx)), j = int(floor(gz)); float fx = fract(gx), fz = fract(gz);
  vec2 a = tex(i, j), b = tex(i + 1, j), c = tex(i, j + 1), e = tex(i + 1, j + 1);
  vec2 hv = mix(mix(a, b, fx), mix(c, e, fx), fz);
  float slope = abs(b.r - a.r) + abs(c.r - a.r);
  float dens = hv.g * smoothstep(9.0, 4.0, slope) * smoothstep(rOut, rOut * 0.82, d) * smoothstep(rIn * 0.8, rIn, d);
  float keep = step(h3, dens * 1.15);
  float H = hScale * (0.55 + 0.9 * h3) * keep * smoothstep(0.0, 0.35, dens) * (1.0 + tallK * 0.55); // tall jungle-grass stretches (~2 m)
  if (H < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // per-tuft yaw
  float yaw = h1 * 6.2832; float cy = cos(yaw), sy = sin(yaw);
  vec3 lp = vec3(position.x * cy - position.z * sy, position.y, position.x * sy + position.z * cy) * vec3(hScale * 0.55, 1.0, hScale * 0.55);
  // wind: travelling gust bands + flutter
  vec2 wd = normalize(vec2(1.0, 0.35));
  // ambient wind grows with ship speed (stronger & faster gusts), and more so the lower the ship flies (turbulent air near it)
  float wk = 1.0 + 2.2 * spd + 1.4 * spd * lowK * exp(-distance(root, shipP.xz) / 120.0);
  float gust = sin(dot(root, wd) * 0.045 - time * (1.6 + 3.4 * spd)) * 0.5 + 0.5;
  float gust2 = sin(dot(root, vec2(-0.4, 1.0)) * 0.11 - time * (2.3 + 5.0 * spd) + h3 * 2.0) * 0.5 + 0.5;
  vec2 bend = wd * (0.12 + 0.38 * gust * gust) * wk + vec2(-0.4, 1.0) * 0.12 * gust2 * spd * wk
            + vec2(sin(time * (3.3 + 6.0 * spd) + h2 * 6.28), cos(time * (2.7 + 5.0 * spd) + h1 * 6.28)) * (0.06 + 0.08 * spd);
  // jet wash
  vec2 push = vec2(0.0); float flt = 0.0;
  vec2 dv = root - shipP.xz; float r = length(dv);
  if (wash > 0.001 && r < 160.0) {
    float k = wash * exp(-r * r / (washR * washR));
    push += dv / max(r, 0.5) * k * (1.6 + 1.2 * spd) + vec2(sin(time * 31.0 + h1 * 6.28), cos(time * 27.0 + h2 * 6.28)) * k * 0.25; flt += k; // radial blast + buffeting flutter
    for (int n = 0; n < ${TRAIL}; n++) {
      vec4 tr = trail[n]; float age = tr.z; float s = tr.w * max(1.0 - age / 1.7, 0.0);
      if (s <= 0.0) continue;
      vec2 dd = root - tr.xy; float rr = length(dd);
      float R2 = washR * (1.0 + age * 0.6);
      float wk = s * exp(-rr * rr / (R2 * R2)) * 0.9;            // flattened wake
      float ring = washR * 0.6 + age * (26.0 + 40.0 * spd);                       // ripple rolling outward
      float rp = s * exp(-pow((rr - ring) / (3.5 + age * 3.0), 2.0)) * 0.75;
      push += dd / max(rr, 0.5) * (wk + rp); flt += wk + rp * 0.6;
    }
  }
  bend += push;
  float bl = length(bend); if (bl > 1.45) bend *= 1.45 / bl;
  float t = aT; float t2 = t * t;
  float sag = min(length(bend), 1.2);
  vec3 off = vec3(bend.x, 0.0, bend.y) * H * t2 * 1.1;
  vec3 wp = vec3(root.x, hv.r - 0.15, root.y) + vec3(lp.x, 0.0, lp.z) + off;
  wp.y += lp.y * H * (1.0 - 0.55 * sag * sag);
  vT = t; vSheen = clamp(flt, 0.0, 1.0); vVar = h2; vW = wp; vDry = h1 * hv.g;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const FS = /* glsl */`
precision highp float;
uniform vec3 sunDir; uniform vec3 sunCol; uniform vec3 skyCol; uniform vec3 gndCol; uniform float sunI; uniform float hemiI;
uniform vec3 fogColor; uniform float fogNear; uniform float fogFar; uniform vec3 hazeCol; uniform float hazeK;
varying float vT; varying float vSheen; varying float vVar; varying vec3 vW; varying float vDry;
void main(){
  vec3 base = mix(vec3(0.07, 0.14, 0.025), vec3(0.2, 0.3, 0.06), vVar);
  base = mix(base, vec3(0.36, 0.33, 0.1), smoothstep(0.55, 0.95, vDry) * 0.7);
  vec3 col = base * mix(0.35, 1.25, vT);
  vec3 v = normalize(cameraPosition - vW);
  float back = pow(max(dot(-v, sunDir), 0.0), 3.0);
  vec3 lit = col * (sunCol * sunI * (0.32 + 0.25 * vT) + mix(gndCol, skyCol, vT) * hemiI * 0.55)
           + col * sunCol * sunI * back * vT * 0.6;
  lit = mix(lit, vec3(0.5, 0.55, 0.3) * sunCol * sunI * 0.35, vSheen * 0.55 * vT); // flattened blades show silvery sheen
  float dist = length(cameraPosition - vW);
  float f = smoothstep(fogNear, fogFar, dist);
  lit = mix(lit, fogColor, f);
  lit = mix(lit, hazeCol, clamp(f * hazeK * pow(max(dot(-v, sunDir), 0.0), 5.0) * 1.3, 0.0, 0.85));
  gl_FragColor = vec4(lit, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Grass {
  constructor(scene, shared, level) {
    this.data = new Float32Array(COLS * ROWS * 2);
    this.tex = new THREE.DataTexture(this.data, COLS, ROWS, THREE.RGFormat, THREE.FloatType);
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter; this.tex.needsUpdate = true;
    this.loaded = new Int32Array(ROWS).fill(-99999);
    this.trail = []; for (let i = 0; i < TRAIL; i++) this.trail.push(new THREE.Vector4(0, 0, 9, 0));
    this.trailT = 0; this.trailI = 0;
    this.U = {
      hMap: { value: this.tex }, time: { value: 0 }, shipP: { value: new THREE.Vector3() }, wash: { value: 0 }, washR: { value: 8 },
      trail: { value: this.trail }, spd: { value: 0 }, lowK: { value: 0 }, tallK: { value: 0 }, ...shared,
    };
    this.layers = [];
    this.group = new THREE.Group(); scene.add(this.group);
    this.setLevel(level);
  }
  setLevel(level) {
    this.level = level;
    for (const l of this.layers) { this.group.remove(l.mesh); l.mesh.geometry.dispose(); l.mesh.material.dispose(); }
    this.layers = [];
    // [spacing, grid N, inner radius, outer radius, blade height, blades, segs, width]
    const cfg = level === 'low'
      ? [[1.5, 110, 0, 70, 1.6, 3, 2, 0.32], [4.5, 110, 66, 230, 2.4, 2, 1, 0.9]]
      : level === 'ultra' ? [[0.75, 230, 0, 82, 1.45, 3, 2, 0.26], [1.9, 200, 78, 190, 1.9, 2, 1, 0.5], [4.4, 175, 182, 380, 2.6, 2, 0, 1.0]]
      : [[1.0, 170, 0, 80, 1.5, 3, 2, 0.28], [2.6, 150, 76, 190, 2.0, 2, 1, 0.6], [6.0, 128, 182, 370, 2.8, 2, 0, 1.3]];
    cfg.forEach(([sp, N, rIn, rOut, hS, bl, sg, w], li) => {
      const g = tuftGeo(bl, sg, w, 7 + li);
      const cells = new Float32Array(N * N * 2);
      for (let j = 0, k = 0; j < N; j++) for (let i = 0; i < N; i++) { cells[k++] = i - N / 2; cells[k++] = j - N / 2; }
      g.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
      g.instanceCount = N * N;
      const U = { ...this.U, anchor: { value: new THREE.Vector2() }, spacing: { value: sp }, rIn: { value: rIn }, rOut: { value: rOut }, hScale: { value: hS } };
      const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: U, vertexShader: VS, fragmentShader: FS, side: THREE.DoubleSide }));
      m.frustumCulled = false; m.renderOrder = 0;
      this.group.add(m);
      this.layers.push({ mesh: m, sp, N, rOut, U });
    });
  }
  reset() { this.loaded.fill(-99999); for (const t of this.trail) t.set(0, 0, 9, 0); }
  // fill ring rows around the camera (height + grass density)
  fill(world, camZ, isGrass) {
    const jc = Math.floor(-camZ / DZ);
    let dirty = false, budget = 24;
    for (let j = jc - 8; j <= jc + ROWS - 10 && budget > 0; j++) {
      const s = ((j % ROWS) + ROWS) % ROWS;
      if (this.loaded[s] === j) continue;
      this.loaded[s] = j; budget--; dirty = true;
      const z = -j * DZ, B = world.biomeAt(z); const ovRow = this.over && this.over(0, z) !== null;
      const gw = ovRow ? 1 : (B.a === 'grass' ? 1 - B.t : 0) + (B.b === 'grass' ? B.t : 0);
      const o = s * COLS * 2;
      for (let i = 0; i < COLS; i++) {
        const ov = this.over ? this.over(X0 + i * DX, z) : null;
        if (ov !== null) { // overlay surface (upper-world deck): dense meadow with patchy clearings
          const x = X0 + i * DX, n = world.noise(x * 0.012 + 7.7, z * 0.012);
          this.data[o + i * 2] = ov; this.data[o + i * 2 + 1] = Math.min(Math.max((n - 0.18) * 2.2, 0), 1); continue;
        }
        const h = gw > 0.01 ? world.height(X0 + i * DX, z) : 0;
        this.data[o + i * 2] = h;
        this.data[o + i * 2 + 1] = gw > 0.01 ? gw * Math.min(Math.max((h - 0.8) / 2, 0), 1) * Math.min(Math.max((150 - h) / 60, 0), 1) : 0;
      }
    }
    if (dirty) this.tex.needsUpdate = true;
  }
  update(dt, t, world, cam, ship, agl, spdN, active) {
    this.group.visible = active;
    this.U.time.value = t;
    // wash strength: grows the lower and faster you fly
    const low = Math.min(Math.max(1 - agl / 48, 0), 1);
    const w = Math.pow(low, 1.1) * (0.6 + 0.6 * spdN);
    this.U.spd.value = spdN; this.U.lowK.value = low;
    this.U.wash.value = w;
    this.U.washR.value = 6 + Math.max(agl, 0) * 0.45 + 5 * spdN;
    this.U.shipP.value.copy(ship);
    for (const tr of this.trail) tr.z += dt;
    this.trailT += dt;
    if (this.trailT > 0.12) { this.trailT = 0; this.trailI = (this.trailI + 1) % TRAIL; this.trail[this.trailI].set(ship.x, ship.z, 0, w); }
    if (!active) return;
    this.fill(world, cam.position.z);
    const fx = -Math.sin(cam.rotation.y), fz = -Math.cos(cam.rotation.y);
    const dir = new THREE.Vector3(); cam.getWorldDirection(dir); dir.y = 0; dir.normalize();
    for (const l of this.layers) {
      const L = l.N * l.sp;
      l.U.anchor.value.set(cam.position.x + dir.x * L * 0.38, cam.position.z + dir.z * L * 0.38);
    }
  }
}
