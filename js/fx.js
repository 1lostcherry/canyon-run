import * as THREE from 'three';

export const fogU = { fogColor: { value: new THREE.Color() }, fogNear: { value: 100 }, fogFar: { value: 2600 } };

function canvasTex(size, draw) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

export function makeDustTexture() {
  return canvasTex(128, (g, s) => {
    let seed = 7; const r = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 46; i++) {
      const a = r() * Math.PI * 2, d = r() * s * 0.2;
      const x = s / 2 + Math.cos(a) * d, y = s / 2 + Math.sin(a) * d;
      const rad = s * (0.1 + r() * 0.22);
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      const al = 0.16 + r() * 0.2;
      gr.addColorStop(0, `rgba(255,255,255,${al})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, s, s);
    }
    g.globalCompositeOperation = 'destination-in';
    const m = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    m.addColorStop(0, 'rgba(0,0,0,1)'); m.addColorStop(0.55, 'rgba(0,0,0,0.75)'); m.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = m; g.fillRect(0, 0, s, s);
  });
}

export function makeGlowTexture() {
  return canvasTex(128, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.15, 'rgba(255,255,255,0.65)');
    gr.addColorStop(0.45, 'rgba(255,255,255,0.15)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  });
}

export function makeRingGlowTexture() {
  return canvasTex(256, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,0.0)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.05)');
    gr.addColorStop(0.62, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.72, 'rgba(255,255,255,0.15)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  });
}

const PVS = `
attribute vec3 iPos; attribute float iSize; attribute vec4 iCol; attribute float iRot;
varying vec2 vUv; varying vec4 vCol; varying float vDepth;
void main(){
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float c = cos(iRot), s = sin(iRot);
  vec2 p = vec2(c * position.x - s * position.y, s * position.x + c * position.y);
  mv.xy += p * iSize;
  vDepth = -mv.z; vUv = uv; vCol = iCol;
  gl_Position = projectionMatrix * mv;
}`;
const PFS = `
uniform sampler2D map; uniform vec3 fogColor; uniform float fogNear; uniform float fogFar;
varying vec2 vUv; varying vec4 vCol; varying float vDepth;
void main(){
  float tex = texture2D(map, vUv).a;
  float nearF = smoothstep(0.6, 6.0, vDepth);
  float f = smoothstep(fogNear, fogFar, vDepth);
#ifdef ADDITIVE
  gl_FragColor = vec4(vCol.rgb, tex * vCol.a * nearF * (1.0 - f));
#else
  gl_FragColor = vec4(mix(vCol.rgb, fogColor, f), tex * vCol.a * nearF);
#endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class ParticlePool {
  constructor(cap, tex, additive) {
    this.cap = cap; this.n = 0;
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    const mk = (n) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.aPos = mk(3); this.aSize = mk(1); this.aCol = mk(4); this.aRot = mk(1);
    geo.setAttribute('iPos', this.aPos); geo.setAttribute('iSize', this.aSize); geo.setAttribute('iCol', this.aCol); geo.setAttribute('iRot', this.aRot);
    geo.instanceCount = 0;
    this.geo = geo;
    this.S = 18;
    this.st = new Float32Array(cap * this.S);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, fogColor: fogU.fogColor, fogNear: fogU.fogNear, fogFar: fogU.fogFar },
      vertexShader: PVS, fragmentShader: PFS, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      defines: additive ? { ADDITIVE: 1 } : {},
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.scale = 1;
  }
  clear() { this.n = 0; this.geo.instanceCount = 0; }
  // life s, size start/end, alpha, colour, drag, gravity
  spawn(x, y, z, vx, vy, vz, life, s0, s1, a0, r, g, b, drag = 0.6, grav = 0) {
    let i;
    if (this.n < this.cap) i = this.n++;
    else i = (Math.random() * this.cap) | 0;
    const o = i * this.S, st = this.st;
    st[o] = x; st[o + 1] = y; st[o + 2] = z; st[o + 3] = vx; st[o + 4] = vy; st[o + 5] = vz;
    st[o + 6] = 0; st[o + 7] = life; st[o + 8] = s0; st[o + 9] = s1; st[o + 10] = a0; st[o + 11] = drag; st[o + 12] = grav;
    st[o + 13] = r; st[o + 14] = g; st[o + 15] = b; st[o + 16] = Math.random() * 6.283; st[o + 17] = (Math.random() - 0.5) * 0.8;
  }
  update(dt) {
    const st = this.st, S = this.S;
    const P = this.aPos.array, Z = this.aSize.array, C = this.aCol.array, R = this.aRot.array;
    let i = 0;
    while (i < this.n) {
      const o = i * S;
      st[o + 6] += dt;
      if (st[o + 6] >= st[o + 7]) {
        this.n--;
        if (i !== this.n) st.copyWithin(o, this.n * S, this.n * S + S);
        continue;
      }
      const dr = Math.exp(-st[o + 11] * dt);
      st[o + 3] *= dr; st[o + 4] = st[o + 4] * dr + st[o + 12] * dt; st[o + 5] *= dr;
      st[o] += st[o + 3] * dt; st[o + 1] += st[o + 4] * dt; st[o + 2] += st[o + 5] * dt;
      st[o + 16] += st[o + 17] * dt;
      const t = st[o + 6] / st[o + 7];
      const u = 1 - t;
      P[i * 3] = st[o]; P[i * 3 + 1] = st[o + 1]; P[i * 3 + 2] = st[o + 2];
      Z[i] = st[o + 8] + (st[o + 9] - st[o + 8]) * (1 - u * u);
      C[i * 4] = st[o + 13]; C[i * 4 + 1] = st[o + 14]; C[i * 4 + 2] = st[o + 15];
      C[i * 4 + 3] = st[o + 10] * Math.min(t * 6, 1) * Math.pow(u, 1.3);
      R[i] = st[o + 16];
      i++;
    }
    this.geo.instanceCount = this.n;
    for (const [a, k] of [[this.aPos, 3], [this.aSize, 1], [this.aCol, 4], [this.aRot, 1]]) {
      a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, this.n) * k); a.needsUpdate = true;
    }
  }
}

// Motion streaks: world-fixed specks stretched along velocity
export class Streaks {
  constructor(n) {
    this.n = n;
    this.p = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) this.p[i] = (Math.random() - 0.5) * 200;
    const pos = new Float32Array(n * 4 * 3), al = new Float32Array(n * 4), idx = [];
    for (let i = 0; i < n; i++) { const b = i * 4; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(al, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(1.0, 0.86, 0.66) } },
      vertexShader: `attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 color; varying float vA; void main(){ gl_FragColor = vec4(color, vA); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 20;
    this._d = new THREE.Vector3(); this._s = new THREE.Vector3(); this._v = new THREE.Vector3();
  }
  update(cam, vel, intensity) {
    this.mesh.visible = intensity > 0.01;
    if (!this.mesh.visible) return;
    const sp = vel.length();
    const d = this._d.copy(vel).multiplyScalar(-1 / Math.max(sp, 1));
    const len = Math.min(sp * 0.05, 34);
    const cx = cam.x + vel.x * 0.15, cy = cam.y, cz = cam.z + vel.z * 0.15;
    const HX = 70, HY = 36, HZ = 130;
    const P = this.geo.attributes.position.array, A = this.geo.attributes.alpha.array;
    const s = this._s, v = this._v;
    for (let i = 0; i < this.n; i++) {
      let x = this.p[i * 3], y = this.p[i * 3 + 1], z = this.p[i * 3 + 2];
      x = cx + ((((x - cx) + HX) % (2 * HX)) + 2 * HX) % (2 * HX) - HX;
      y = cy + ((((y - cy) + HY) % (2 * HY)) + 2 * HY) % (2 * HY) - HY;
      z = cz + ((((z - cz) + HZ) % (2 * HZ)) + 2 * HZ) % (2 * HZ) - HZ;
      this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
      v.set(x - cam.x, y - cam.y, z - cam.z);
      const dist = v.length();
      s.crossVectors(d, v).normalize().multiplyScalar(0.035 + dist * 0.0018);
      const bx = x + d.x * len, by = y + d.y * len, bz = z + d.z * len;
      const o = i * 12;
      P[o] = x + s.x; P[o + 1] = y + s.y; P[o + 2] = z + s.z;
      P[o + 3] = x - s.x; P[o + 4] = y - s.y; P[o + 5] = z - s.z;
      P[o + 6] = bx + s.x; P[o + 7] = by + s.y; P[o + 8] = bz + s.z;
      P[o + 9] = bx - s.x; P[o + 10] = by - s.y; P[o + 11] = bz - s.z;
      const fade = Math.min(dist / 12, 1) * (1 - Math.min(dist / 140, 1));
      const a = intensity * fade * 0.55;
      A[i * 4] = a; A[i * 4 + 1] = a; A[i * 4 + 2] = 0; A[i * 4 + 3] = 0;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
  }
}

// Expanding shock rings (sonic boom, explosions)
export class Shockwaves {
  constructor(scene) {
    this.scene = scene; this.list = [];
    this.geo = new THREE.RingGeometry(0.86, 1.0, 72);
  }
  spawn(pos, normal, maxR, dur, color, opacity) {
    const m = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    m.position.copy(pos);
    m.lookAt(pos.clone().add(normal));
    m.renderOrder = 15; m.frustumCulled = false;
    this.scene.add(m);
    this.list.push({ m, t: 0, dur, maxR, op: opacity });
  }
  update(dt) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const w = this.list[i]; w.t += dt;
      const k = w.t / w.dur;
      if (k >= 1) { this.scene.remove(w.m); w.m.material.dispose(); this.list.splice(i, 1); continue; }
      const e = 1 - Math.pow(1 - k, 3);
      w.m.scale.setScalar(1 + e * w.maxR);
      w.m.material.opacity = w.op * Math.pow(1 - k, 1.5);
    }
  }
  clear() { for (const w of this.list) { this.scene.remove(w.m); w.m.material.dispose(); } this.list.length = 0; }
}

// Rain / hail: world-space drops falling + wrapping around the camera, drawn as
// quads stretched along the drop's velocity relative to the ship (longer at speed).
export class Precip {
  constructor(n) {
    this.n = n;
    this.p = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) this.p[i] = (Math.random() - 0.5) * 200;
    this.rnd = new Float32Array(n); for (let i = 0; i < n; i++) this.rnd[i] = Math.random();
    const pos = new Float32Array(n * 4 * 3), al = new Float32Array(n * 4), idx = [];
    for (let i = 0; i < n; i++) { const b = i * 4; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(al, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(0.7, 0.75, 0.85) } },
      vertexShader: `attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 color; varying float vA; void main(){ gl_FragColor = vec4(color, vA); }`,
      transparent: true, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 19;
    this._r = new THREE.Vector3(); this._s = new THREE.Vector3(); this._v = new THREE.Vector3();
  }
  // o: { fall, wind, lenK, width, alpha, color, count(0..1) }
  update(dt, cam, shipVel, o) {
    const cnt = Math.floor(this.n * Math.min(o.count, 1));
    this.mesh.visible = cnt > 0 && o.alpha > 0.01;
    if (!this.mesh.visible) return;
    this.mat.uniforms.color.value.copy(o.color);
    const HX = 55, HY = 40, HZ = 110;
    const cx = cam.x + shipVel.x * 0.12, cy = cam.y, cz = cam.z + shipVel.z * 0.12;
    const r = this._r.set(o.wind - shipVel.x, -o.fall - shipVel.y, -shipVel.z);
    const rl = r.length();
    const d = r.clone().multiplyScalar(-1 / Math.max(rl, 1));
    const len = Math.min(rl * o.lenK, 28);
    const P = this.geo.attributes.position.array, A = this.geo.attributes.alpha.array;
    const s = this._s, v = this._v;
    for (let i = 0; i < cnt; i++) {
      let x = this.p[i * 3] + o.wind * dt, y = this.p[i * 3 + 1] - o.fall * dt * (0.8 + 0.4 * this.rnd[i]), z = this.p[i * 3 + 2];
      x = cx + ((((x - cx) + HX) % (2 * HX)) + 2 * HX) % (2 * HX) - HX;
      y = cy + ((((y - cy) + HY) % (2 * HY)) + 2 * HY) % (2 * HY) - HY;
      z = cz + ((((z - cz) + HZ) % (2 * HZ)) + 2 * HZ) % (2 * HZ) - HZ;
      this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
      v.set(x - cam.x, y - cam.y, z - cam.z);
      const dist = v.length();
      s.crossVectors(d, v).normalize().multiplyScalar(o.width * (1 + dist * 0.012));
      const bx = x + d.x * len, by = y + d.y * len, bz = z + d.z * len;
      const k = i * 12;
      P[k] = x + s.x; P[k + 1] = y + s.y; P[k + 2] = z + s.z;
      P[k + 3] = x - s.x; P[k + 4] = y - s.y; P[k + 5] = z - s.z;
      P[k + 6] = bx + s.x; P[k + 7] = by + s.y; P[k + 8] = bz + s.z;
      P[k + 9] = bx - s.x; P[k + 10] = by - s.y; P[k + 11] = bz - s.z;
      const fade = Math.min(dist / 4, 1) * (1 - Math.min(dist / 120, 1));
      const a = o.alpha * fade * (0.6 + 0.4 * this.rnd[i]);
      A[i * 4] = a; A[i * 4 + 1] = a; A[i * 4 + 2] = a * o.tail; A[i * 4 + 3] = a * o.tail;
    }
    this.geo.setDrawRange(0, cnt * 6);
    this.geo.attributes.position.clearUpdateRanges(); this.geo.attributes.position.addUpdateRange(0, cnt * 12);
    this.geo.attributes.alpha.clearUpdateRanges(); this.geo.attributes.alpha.addUpdateRange(0, cnt * 4);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
  }
}
