import * as THREE from 'three';

export const CHUNK_L = 240;
export const CHUNK_W = 3000;
export const SEG_X = 200;
export const SEG_Z = 16;
export const DX = CHUNK_W / SEG_X;
export const DZ = CHUNK_L / SEG_Z;
export const X0 = -CHUNK_W / 2;

export function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

export class World {
  constructor(seed) { this.setSeed(seed); }

  setSeed(seed, firstBiome) {
    this.seed = seed >>> 0;
    this._pz = this._hz = this._bz = NaN;
    this._hc = new Map(); // grid-node height cache (autopilot planner samples thousands of points per frame)
    const r = makeRng(seed);
    this.sInt = (r() * 2147483647) | 0;
    this.p = [r() * 6.28, r() * 6.28, r() * 6.28, r() * 6.28, r() * 6.28];
    // biome segments along the flight distance (randomised order, ~20% ocean)
    const segs = []; let d = 0, last = firstBiome || 'desert';
    let len = firstBiome ? 12000 : 10000 + r() * 8000;
    segs.push({ start: 0, end: len, type: last }); d = len;
    const others = ['desert', 'fjord', 'volcanic', 'gorge', 'grass', 'grass', 'jungle', 'jungle'];
    // fixed cadences: one ~140 km sea per 1,000 km (with gradual coasts + islands); 300 km checkpoints -> 19% chance of a 250 km snowy mountain region
    const seas = [], mtns = [];
    for (let k = 0; k * 1e6 < 4e6; k++) { const st = k * 1e6 + 60000 + r() * 780000; seas.push([st, st + 140000]); }
    for (let cp = 300000; cp < 4e6; cp += 300000) if (r() < 0.19) { const st = cp, en = st + 250000; if (!seas.some(([a, b]) => st < b + 15000 && en > a - 15000) && !mtns.some(([a, b]) => st < b)) mtns.push([st, en]); }
    if (typeof location !== 'undefined' && /[?&]mtntest/.test(location.search)) { mtns.unshift([0, 250000]); segs[0].type = 'fjord'; segs[0].mtn = true; }
    this.mtns = mtns; this.seas = seas;
    const inR = (L, x) => L.find(([a, b]) => x >= a && x < b);
    while (d < 4e6) {
      const sea = seas.find(([a]) => a - 14000 >= d && a - 14000 < d + 32000), mt = inR(mtns, d);
      if (sea && d < sea[0] - 14000 + 1) { // coast run-in, open sea, coast run-out
        if (sea[0] - 14000 > d) { segs.push({ start: d, end: sea[0] - 14000, type: last === 'desert' ? 'grass' : 'desert' }); d = sea[0] - 14000; }
        segs.push({ start: d, end: sea[0], type: 'coast' }); segs.push({ start: sea[0], end: sea[1], type: 'ocean' }); segs.push({ start: sea[1], end: sea[1] + 14000, type: 'coast' }); d = sea[1] + 14000; last = 'coast'; continue;
      }
      if (mt) { segs.push({ start: d, end: mt[1], type: 'fjord', mtn: true }); d = mt[1]; last = 'fjord'; continue; }
      let t; do { t = others[(r() * others.length) | 0]; } while (t === last);
      len = 10000 + r() * 20000; const nm = mtns.find(([a]) => a > d && a < d + len); if (nm) len = nm[0] - d;
      segs.push({ start: d, end: d + len, type: t }); d += len; last = t;
    }
    this.segs = segs;
  }

  // returns { a, b, t }: blend from biome a to b by t (transition band 1.5 km)
  biomeAt(z) {
    if (z === this._bz && this._B) return this._B;
    this._bz = z;
    const d = -z, segs = this.segs;
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (segs[m].end < d) lo = m + 1; else hi = m; }
    const sg = segs[Math.max(0, lo)];
    const B = this._B || (this._B = { a: 'desert', b: 'desert', t: 0 });
    const HB = 750;
    if (d > sg.end - HB && lo + 1 < segs.length) { B.a = sg.type; B.b = segs[lo + 1].type; B.t = smooth(sg.end - HB, sg.end + HB, d); }
    else if (d < sg.start + HB && lo > 0) { B.a = segs[lo - 1].type; B.b = sg.type; B.t = smooth(sg.start - HB, sg.start + HB, d); }
    else { B.a = sg.type; B.b = sg.type; B.t = 0; }
    return B;
  }
  mtnAt(z) { const d = -z; if (!this.mtns) return 0; for (const [a, b] of this.mtns) if (d > a - 3000 && d < b + 3000) return Math.min(1, (d - a + 3000) / 3000, (b + 3000 - d) / 3000); return 0; }
  biomeMain(z) { const B = this.biomeAt(z); return B.t > 0.5 ? B.b : B.a; }

  height(x, z) {
    const B = this.biomeAt(z);
    const a = B.a, b = B.b, t = B.t;
    if (t <= 0 || a === b) return this.bh(a, x, z);
    if (t >= 1) return this.bh(b, x, z);
    return this.bh(a, x, z) * (1 - t) + this.bh(b, x, z) * t;
  }

  bh(type, x, z) {
    switch (type) {
      case 'desert': return this.canyonH(x, z) + 12;
      case 'volcanic': return this.canyonH(x, z) * 0.95 + 12 + (this.noise(x * 0.012, z * 0.012) - 0.5) * 18;
      case 'fjord': if (this.mtnAt(z)) { const rid = 1 - Math.abs(this.noise(x * 0.0035, z * 0.0035) * 2 - 1); return this.canyonH(x, z) * 1.45 + 10 + rid * rid * 90 * Math.min(1, Math.abs(x - this.pathX(z)) / 400); } return this.canyonH(x, z) * 1.2 - 24; // snowy mountain region
      case 'ocean': return this.oceanH(x, z);
      case 'coast': return this.coastH(x, z);
      case 'gorge': return this.gorgeH(x, z);
      case 'grass': return this.grassH(x, z);
      case 'jungle': return this.jungleH(x, z);
    }
    return 0;
  }

  oceanH(x, z) {
    const cx = this.pathX(z), d = Math.abs(x - cx);
    const n = this.fbm(x * 0.004, z * 0.004, 3);
    let h = -40 + n * 18;
    if (d > 260) { const isl = this.fbm(x * 0.0016 + 3.3, z * 0.0016 - 1.7, 3); if (isl > 0.6) h += Math.min(1, (isl - 0.6) / 0.08) * (52 + 30 * this.noise(x * 0.01, z * 0.01)); } // scattered islands off the flight line
    const e = d - 1000 + (n - 0.5) * 360;
    if (e > 0) { let t = Math.min(e / 260, 1); t = t * t * (3 - 2 * t); h += t * (200 + 140 * this.noise(x * 0.002, z * 0.002)) + (this.noise(x * 0.02, z * 0.02) - 0.5) * 20 * t; }
    return h;
  }

  coastH(x, z) {
    const cx = this.pathX(z), hw = this.halfW(z), d = Math.abs(x - cx);
    const n = this.fbm(x * 0.004 + 5.5, z * 0.004, 3);
    let h = -8 + n * 7;
    const e = d - hw * 0.8 + (n - 0.5) * 200;
    if (e > 0) {
      h += Math.min(e / 45, 1) * 11;
      const c = e - 55;
      if (c > 0) {
        let t = Math.min(c / 85, 1); t = t * t * (3 - 2 * t);
        const top = 110 + 110 * this.noise(x * 0.0025, z * 0.0025);
        h += t * top + (this.noise(x * 0.025, z * 0.025) - 0.5) * 14 * t + Math.max(0, c - 85) * 0.08;
      }
    }
    return h;
  }

  riverW(z) { return 55 + 20 * Math.sin(z * 0.0021 + this.p[4]); }
  gorgeH(x, z) {
    const cx = this.pathX(z), d = Math.abs(x - cx);
    let h = this.canyonH(x, z) * 1.15 + 9;
    const rw = this.riverW(z);
    const ch = smooth(rw, rw * 0.45, d);
    return h + (-6 - h) * ch;
  }

  // rolling highland meadows: broad grassy valley, rounded hills and a few tors
  grassH(x, z) {
    const cx = this.pathX(z), hw = this.halfW(z), d = Math.abs(x - cx);
    const n = this.fbm(x * 0.003 + 21.7, z * 0.003, 3);
    let h = 14 + (n - 0.5) * 16 + 3.5 * Math.sin(x * 0.011 + z * 0.007 + n * 3);
    const e = d - hw * 1.05 + (n - 0.5) * 260;
    if (e > 0) { let t = Math.min(e / 420, 1); t = t * t * (3 - 2 * t); h += t * (120 + 170 * this.noise(x * 0.0018 + 1.7, z * 0.0018)) + (this.noise(x * 0.01, z * 0.01) - 0.5) * 30 * t; }
    return h;
  }

  // tropical jungle: rounded karst hills, broad river winding through the valley
  jungleH(x, z) {
    const cx = this.pathX(z), hw = this.halfW(z), d = Math.abs(x - cx);
    const n = this.fbm(x * 0.004 + 41.3, z * 0.004, 3);
    let h = 8 + (n - 0.5) * 14;
    const e = d - hw * 0.9 + (n - 0.5) * 220;
    if (e > 0) { let t = Math.min(e / 300, 1); t = t * t * (3 - 2 * t); const k = this.noise(x * 0.004 + 3.1, z * 0.004); h += t * (140 + 220 * k * k) + (this.noise(x * 0.015, z * 0.015) - 0.5) * 40 * t; }
    const rw = this.riverW(z) * 1.6;
    const ch = smooth(rw, rw * 0.5, d);
    return h + (-7 - h) * ch;
  }

  surface(x, z) { return Math.max(this.gridHeight(x, z), 0); }

  hash(ix, iz) {
    let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + this.sInt) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  noise(x, z) {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
    const a = this.hash(ix, iz), b = this.hash(ix + 1, iz), c = this.hash(ix, iz + 1), d = this.hash(ix + 1, iz + 1);
    return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
  }

  fbm(x, z, oct) {
    let s = 0, a = 0.5, f = 1, n = 0;
    for (let i = 0; i < oct; i++) { s += a * this.noise(x * f, z * f); n += a; a *= 0.5; f *= 2.03; }
    return s / n;
  }

  // meandering valley centre line
  pathX(z) {
    if (z === this._pz) return this._pv;
    this._pz = z; return (this._pv = this._pathX(z));
  }
  _pathX(z) {
    const p = this.p;
    // keep the first ~800 m almost straight
    const ramp = smooth(0, -900, z);
    return ramp * (300 * Math.sin(z * 0.00085 + p[0]) + 150 * Math.sin(z * 0.0021 + p[1]) + 50 * Math.sin(z * 0.0047 + p[2])
      - (300 * Math.sin(p[0]) + 150 * Math.sin(p[1]) + 50 * Math.sin(p[2])));
  }
  pathDX(z) { return (this._pathX(z + 1) - this._pathX(z - 1)) * 0.5; }

  halfW(z) {
    if (z === this._hz) return this._hv;
    this._hz = z; return (this._hv = this._halfW(z));
  }
  _halfW(z) {
    return 290 + 90 * Math.sin(z * 0.0013 + this.p[3]) + 60 * (this.noise(z * 0.002, 7.3) - 0.5);
  }

  canyonH(x, z) {
    const cx = this.pathX(z), hw = this.halfW(z);
    const d = Math.abs(x - cx);
    const n = this.fbm(x * 0.0035 + 11.1, z * 0.0035, 3);
    let h = (n - 0.5) * 12 + 2.2 * Math.sin(x * 0.031 + z * 0.012 + n * 4);
    const edge = d - hw + (n - 0.5) * 170;
    if (edge > 0) {
      let t = Math.min(edge / 280, 1); t = t * t * (3 - 2 * t);
      const big = 400 + 260 * this.noise(x * 0.0016 + 3.3, z * 0.0016);
      let w = t * big;
      const step = 36 + 10 * Math.sin(z * 0.001 + x * 0.002);
      const k = w / step, fl = Math.floor(k), f = k - fl;
      const tf = f < 0.72 ? f * 0.12 / 0.72 : 0.12 + (f - 0.72) / 0.28 * 0.88;
      w = w * 0.3 + (fl + tf) * step * 0.7;
      w += (this.noise(x * 0.03, z * 0.03) - 0.5) * 16 * t;
      h += w;
    }
    return h;
  }

  // height matching the rendered triangle grid (bilinear on grid nodes)
  nodeH(i, j, x, z) {
    const k = j * 8192 + i + 4096; let v = this._hc.get(k);
    if (v === undefined) { if (this._hc.size > 400000) this._hc.clear(); v = this.height(x, z); this._hc.set(k, v); }
    return v;
  }
  gridHeight(x, z) {
    const gx = (x - X0) / DX, gz = -z / DZ;
    const i = Math.floor(gx), j = Math.floor(gz);
    const fx = gx - i, fz = gz - j;
    const x0 = X0 + i * DX, z0 = -j * DZ;
    const a = this.nodeH(i, j, x0, z0), b = this.nodeH(i + 1, j, x0 + DX, z0), c = this.nodeH(i, j + 1, x0, z0 - DZ), d = this.nodeH(i + 1, j + 1, x0 + DX, z0 - DZ);
    return a * (1 - fx) * (1 - fz) + b * fx * (1 - fz) + c * (1 - fx) * fz + d * fx * fz;
  }
}

let sharedIndex = null;
function getIndex() {
  if (sharedIndex) return sharedIndex;
  const idx = [];
  const row = SEG_X + 1;
  for (let j = 0; j < SEG_Z; j++) for (let i = 0; i < SEG_X; i++) {
    const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  sharedIndex = new THREE.BufferAttribute(new Uint32Array(idx), 1);
  return sharedIndex;
}

const SAND = [0.82, 0.42, 0.18], SAND2 = [0.95, 0.56, 0.27];
const ROCK_A = [0.30, 0.13, 0.06], ROCK_B = [0.56, 0.26, 0.11], ROCK_C = [0.18, 0.08, 0.04];
const mix3 = (o, a, b, t) => { o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t; return o; };
const _ca = [0, 0, 0], _cb = [0, 0, 0], _cc = [0, 0, 0];
const UW = { jungle: [[0.2, 0.3, 0.18], [0.04, 0.09, 0.05]], gorge: [[0.18, 0.34, 0.26], [0.03, 0.1, 0.08]], ocean: [[0.10, 0.32, 0.34], [0.01, 0.05, 0.09]], coast: [[0.62, 0.86, 0.74], [0.04, 0.22, 0.30]], fjord: [[0.12, 0.2, 0.2], [0.01, 0.04, 0.06]] };
// writes biome colour into out
function biomeColor(type, out, h, slope, n, band, band2) {
  if (h < 0 && UW[type]) { const u = UW[type]; return mix3(out, u[0], u[1], smooth(0, type === 'coast' ? 12 : 35, -h)); }
  switch (type) {
    case 'desert': case 'ocean': {
      mix3(_ca, ROCK_A, ROCK_B, band); mix3(_ca, _ca, ROCK_C, 0.25 * band2);
      if (type === 'ocean') { _ca[0] *= 0.55; _ca[1] *= 0.6; _ca[2] *= 0.75; }
      const s = Math.min(smooth(0.30, 0.10, slope) * (0.65 + 0.35 * smooth(170, 10, h)) + smooth(42, 12, h) * 0.5, 1);
      mix3(_cb, SAND, SAND2, n);
      if (type === 'ocean') { _cb[0] = 0.25; _cb[1] = 0.3; _cb[2] = 0.2; }
      return mix3(out, _ca, _cb, s);
    }
    case 'volcanic': {
      mix3(_ca, [0.05, 0.04, 0.04], [0.14, 0.09, 0.07], band); mix3(_ca, _ca, [0.02, 0.02, 0.02], 0.4 * band2);
      const s = smooth(0.25, 0.08, slope) * 0.8;
      mix3(_cb, [0.16, 0.14, 0.13], [0.24, 0.2, 0.18], n);
      mix3(out, _ca, _cb, s);
      if (h < 20 && slope > 0.2) { out[0] += 0.35 * smooth(20, 6, h) * band2; out[1] += 0.06 * smooth(20, 6, h) * band2; } // glowing lava seams
      return out;
    }
    case 'fjord': {
      mix3(_ca, [0.18, 0.19, 0.21], [0.36, 0.37, 0.4], band); mix3(_ca, _ca, [0.1, 0.1, 0.11], 0.3 * band2);
      const snow = smooth(0.32, 0.12, slope) * smooth(15, 60, h);
      const grass = smooth(0.3, 0.1, slope) * smooth(60, 15, h) * (h > 0 ? 1 : 0);
      mix3(out, _ca, [0.2, 0.26, 0.14], grass);
      return mix3(out, out, [0.88, 0.92, 0.97], snow);
    }
    case 'gorge': {
      mix3(_ca, [0.2, 0.2, 0.15], [0.38, 0.35, 0.27], band); mix3(_ca, _ca, [0.12, 0.12, 0.09], 0.3 * band2);
      const moss = smooth(0.4, 0.12, slope);
      mix3(_cb, [0.12, 0.27, 0.06], [0.24, 0.36, 0.1], n);
      mix3(out, _ca, _cb, moss * 0.9);
      if (h < 12 && h >= 0) mix3(out, out, [0.5, 0.46, 0.36], smooth(12, 2, h) * 0.6); // pebble banks
      return out;
    }
    case 'jungle': {
      mix3(_ca, [0.2, 0.17, 0.11], [0.32, 0.27, 0.18], band);
      mix3(_cb, [0.04, 0.16, 0.03], [0.1, 0.26, 0.05], n);
      mix3(out, _ca, _cb, smooth(0.9, 0.4, slope));
      if (h < 6 && h >= 0) mix3(out, out, [0.3, 0.24, 0.14], smooth(6, 1, h) * 0.7); // muddy banks
      return out;
    }
    case 'grass': {
      mix3(_ca, [0.24, 0.23, 0.2], [0.42, 0.4, 0.35], band);
      mix3(_cb, [0.13, 0.24, 0.05], [0.36, 0.36, 0.11], n * n);
      const g = smooth(0.42, 0.16, slope);
      mix3(out, _ca, _cb, g);
      if (h < 1.5) mix3(out, out, [0.12, 0.16, 0.08], 0.5);
      return out;
    }
    case 'coast': {
      mix3(_ca, [0.66, 0.62, 0.54], [0.88, 0.85, 0.78], band); mix3(_ca, _ca, [0.5, 0.46, 0.4], 0.25 * band2);
      const beach = smooth(9, 2, h) * smooth(0.35, 0.1, slope);
      const green = smooth(0.32, 0.12, slope) * smooth(8, 22, h);
      mix3(out, _ca, [0.94, 0.86, 0.66], beach);
      mix3(_cb, [0.20, 0.30, 0.09], [0.32, 0.38, 0.14], n);
      return mix3(out, out, _cb, green * 0.9);
    }
  }
  return mix3(out, ROCK_A, ROCK_B, band);
}

export function buildChunkGeometry(world, idx) {
  const W = SEG_X + 3, H = SEG_Z + 3;
  const hs = new Float32Array(W * H);
  const zBase = -idx * CHUNK_L;
  for (let j = 0; j < H; j++) {
    const z = zBase - (j - 1) * DZ;
    for (let i = 0; i < W; i++) hs[j * W + i] = world.height(X0 + (i - 1) * DX, z);
  }
  const nV = (SEG_X + 1) * (SEG_Z + 1);
  const pos = new Float32Array(nV * 3), nor = new Float32Array(nV * 3), col = new Float32Array(nV * 3);
  let v = 0;
  for (let j = 0; j <= SEG_Z; j++) {
    for (let i = 0; i <= SEG_X; i++, v++) {
      const k = (j + 1) * W + (i + 1);
      const h = hs[k];
      const x = X0 + i * DX, zl = -j * DZ;
      pos[v * 3] = x; pos[v * 3 + 1] = h; pos[v * 3 + 2] = zl;
      const dhdx = (hs[k + 1] - hs[k - 1]) / (2 * DX);
      const dhdz = (hs[k - W] - hs[k + W]) / (2 * DZ);
      let nx = -dhdx, ny = 1, nz = -dhdz;
      const L = Math.hypot(nx, ny, nz); nx /= L; ny /= L; nz /= L;
      nor[v * 3] = nx; nor[v * 3 + 1] = ny; nor[v * 3 + 2] = nz;
      const slope = 1 - ny;
      const zw = zBase + zl;
      const n = world.noise(x * 0.02, zw * 0.02);
      const band = 0.5 + 0.5 * Math.sin(h * 0.19 + n * 2.5);
      const band2 = 0.5 + 0.5 * Math.sin(h * 0.53 + n * 5.0);
      const B = world.biomeAt(zw);
      if (B.t <= 0 || B.a === B.b) biomeColor(B.a, _cc, h, slope, n, band, band2);
      else { const t = B.t, bA = B.a, bB = B.b; biomeColor(bA, _cc, h, slope, n, band, band2); const r0 = _cc[0], g0 = _cc[1], b0 = _cc[2]; biomeColor(bB, _cc, h, slope, n, band, band2); _cc[0] = r0 + (_cc[0] - r0) * t; _cc[1] = g0 + (_cc[1] - g0) * t; _cc[2] = b0 + (_cc[2] - b0) * t; }
      const mk = world.mtnAt(zw); if (mk > 0) { const sn = mk * Math.min(1, Math.max(0, (h - 25) / 50 + n * 0.4) * Math.max(0, 1 - slope * 1.6)); _cc[0] += (0.9 - _cc[0]) * sn; _cc[1] += (0.93 - _cc[1]) * sn; _cc[2] += (0.97 - _cc[2]) * sn; } // snow caps
      col[v * 3] = _cc[0]; col[v * 3 + 1] = _cc[1]; col[v * 3 + 2] = _cc[2];
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(getIndex());
  geo.computeBoundingSphere();
  return geo;
}

// Objects (rock spires, mesas, boulders) + rings for a chunk
export const ROCK_COL = { gorge: [0.26, 0.25, 0.2], desert: [0.42, 0.19, 0.09], volcanic: [0.07, 0.055, 0.05], fjord: [0.33, 0.34, 0.36], ocean: [0.2, 0.19, 0.17], coast: [0.82, 0.78, 0.68], grass: [0.4, 0.39, 0.35], jungle: [0.22, 0.24, 0.17] };
export function genChunkContent(world, idx) {
  const rng = makeRng((world.seed * 9301 + idx * 49297 + 233280) >>> 0);
  const objs = [];
  const z0 = -idx * CHUNK_L;
  const dist = idx * CHUNK_L;
  const diff = Math.min(dist / 40000, 1);
  const inStart = dist < 900;
  const biome = world.biomeMain(z0 - CHUNK_L / 2);
  const rc = ROCK_COL[biome];
  const place = (type, x, z, r, h, valley) => {
    let ground = world.gridHeight(x, z);
    if (type !== 'boulder' && type !== 'tree') for (let a = 0; a < 6; a++) ground = Math.min(ground, world.gridHeight(x + Math.cos(a) * r * 1.1, z + Math.sin(a) * r * 1.1));
    if ((type === 'boulder' || type === 'tree') && ground < 0.5) return;
    const y = type === 'boulder' ? ground - r * 0.35 : type === 'tree' ? ground - 0.5 : ground - 4;
    const tint = 0.8 + rng() * 0.4;
    const col = type === 'tree' ? [0.6 + rng() * 0.5, 0.75 + rng() * 0.4, 0.6 + rng() * 0.3] : [rc[0] * tint, rc[1] * tint, rc[2] * tint];
    objs.push({ type, x, y, z, r, h: type === 'boulder' ? 0 : h + (ground - y) - 4 + 4, valley, rot: rng() * Math.PI * 2, variant: Math.floor(rng() * 4), col, near: false, done: false });
  };
  const water = biome === 'ocean' || biome === 'coast';
  const falls = [];
  // obstacles in the flight corridor (sea stacks / islets over water)
  const nV = inStart ? 0 : Math.floor(1 + diff * 4 + rng() * 2.2) + (water ? 1 : 0);
  for (let i = 0; i < nV; i++) {
    const z = z0 - rng() * CHUNK_L;
    const cx = world.pathX(z), hw = biome === 'ocean' ? 700 : world.halfW(z);
    const x = cx + (rng() * 2 - 1) * hw * 0.92;
    if (rng() < 0.74) place('spire', x, z, 5 + rng() * 10, 45 + rng() * 110, true);
    else place('mesa', x, z, 14 + rng() * 26, 25 + rng() * 70, true);
  }
  // flank scenery
  const nF = biome === 'ocean' ? 3 : 9 + Math.floor(rng() * 6);
  for (let i = 0; i < nF; i++) {
    const z = z0 - rng() * CHUNK_L;
    const cx = world.pathX(z), hw = biome === 'ocean' ? 900 : world.halfW(z);
    const side = rng() < 0.5 ? -1 : 1;
    const x = cx + side * (hw * 0.82 + rng() * 560);
    if (rng() < 0.58) place('spire', x, z, 8 + rng() * 16, 80 + rng() * 210, false);
    else place('mesa', x, z, 35 + rng() * 80, 60 + rng() * 220, false);
  }
  // boulders (land only)
  const nB = water ? 6 : 22 + Math.floor(rng() * 22);
  for (let i = 0; i < nB; i++) {
    const z = z0 - rng() * CHUNK_L;
    const cx = world.pathX(z), hw = world.halfW(z);
    const x = cx + (rng() * 2 - 1) * (hw + 90);
    const rr = rng();
    place('boulder', x, z, 1.2 + rr * rr * 7, 0, true);
  }
  // pine-like trees on coast & fjord slopes
  if (biome === 'coast' || biome === 'fjord' || biome === 'gorge' || biome === 'grass') {
    const nT = biome === 'coast' ? 90 : biome === 'gorge' ? 110 : biome === 'grass' ? 35 : 50;
    for (let i = 0; i < nT; i++) {
      const z = z0 - rng() * CHUNK_L;
      const cx = world.pathX(z), hw = world.halfW(z);
      const side = rng() < 0.5 ? -1 : 1;
      const x = cx + side * (hw * 0.75 + rng() * 420);
      const g = world.gridHeight(x, z);
      if (g < 6 || g > 260) continue;
      const g2 = world.gridHeight(x + 6, z), g3 = world.gridHeight(x, z - 6);
      if (Math.abs(g2 - g) > 4 || Math.abs(g3 - g) > 4) continue;
      place('tree', x, z, 2.2 + rng() * 2.2, 8 + rng() * 10, false);
    }
  }
  // dense jungle canopy (broadleaf + palms) everywhere except the river
  if (biome === 'jungle') {
    const nJ = 620;
    for (let i = 0; i < nJ; i++) {
      const z = z0 - rng() * CHUNK_L;
      const cx = world.pathX(z), rw = world.riverW(z) * 1.6;
      const side = rng() < 0.5 ? -1 : 1;
      const x = cx + side * (rw * 0.72 + Math.pow(rng(), 2.2) * 1000);
      const g = world.gridHeight(x, z);
      if (g < 1.5 || g > 420) continue;
      const palm = rng() < (g < 25 ? 0.45 : 0.12);
      const r = palm ? 3.5 + rng() * 2 : 8 + rng() * 8, hh = palm ? 14 + rng() * 10 : 16 + rng() * 16;
      const ground = g;
      objs.push({ type: 'jtree', x, y: ground - 0.5, z, r, h: hh, valley: false, rot: rng() * Math.PI * 2, variant: palm ? 3 + Math.floor(rng() * 2) : Math.floor(rng() * 3), col: [0.75 + rng() * 0.45, 0.8 + rng() * 0.4, 0.7 + rng() * 0.4], near: false, done: false });
    }
  }
  // waterfalls cascading down the gorge / jungle walls
  if ((biome === 'gorge' || biome === 'jungle') && !inStart && rng() < 0.7) {
    const z = z0 - CHUNK_L * (0.2 + rng() * 0.6);
    const cx = world.pathX(z), hw = world.halfW(z), side = rng() < 0.5 ? -1 : 1;
    const xt = cx + side * (hw + 230 + rng() * 80), ht = world.gridHeight(xt, z);
    const xb = cx + side * (hw * 0.55), hb = Math.max(world.gridHeight(xb, z), 0);
    if (ht - hb > 90) falls.push({ xt, ht, xb, hb, z, w: 22 + rng() * 30, side });
  }
  if (biome === 'grass') for (const o of objs) if (o.type === 'spire' || o.type === 'mesa') { o.h = Math.max(o.h * 0.42, 14); o.r *= 1.25; }
  return { objs, falls };
}

export function radiusAt(o, y) {
  const yn = (y - o.y) / o.h;
  if (yn < 0 || yn > 1) return -1;
  if (o.type === 'spire') return o.r * (1 - 0.72 * yn) * 0.92;
  if (o.type === 'tree') return o.r * (1 - yn) * 0.9 + 0.3;
  if (o.type === 'jtree') return yn < 0.45 ? 0.6 : o.r * 0.8 * Math.sin(Math.PI * Math.min((yn - 0.45) / 0.55, 1)) + 0.6;
  return o.r * (yn < 0.15 ? 1 + 0.3 * (0.15 - yn) / 0.15 : 1) * 0.95;
}

// ---- rock geometry variants ----
function displace(geo, fn) {
  const p = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); fn(v, i); p.setXYZ(i, v.x, v.y, v.z); }
  const g2 = geo.index ? geo.toNonIndexed() : geo; g2.computeVertexNormals(); return g2;
}

export function makeSpireGeos() {
  const out = [];
  for (let k = 0; k < 4; k++) {
    const rng = makeRng(100 + k);
    const ph = [rng() * 6, rng() * 6, rng() * 6];
    const geo = new THREE.CylinderGeometry(1, 1, 1, 9, 10, false);
    geo.translate(0, 0.5, 0);
    out.push(displace(geo, (v) => {
      const y = v.y, a = Math.atan2(v.z, v.x);
      let r = Math.hypot(v.x, v.z);
      if (r < 1e-4) { v.y = y >= 0.999 ? 1 + 0.06 * Math.sin(ph[0]) : y; return; }
      let prof = 1 - 0.72 * y;
      prof *= 1 + 0.22 * Math.sin(a * 3 + ph[0] + y * 4) + 0.12 * Math.sin(a * 5 + ph[1] - y * 9);
      // ledges
      prof *= 1 + 0.12 * Math.max(0, Math.sin(y * 18 + ph[2]));
      if (y > 0.999) prof *= 0.85;
      v.x = Math.cos(a) * prof * r; v.z = Math.sin(a) * prof * r;
      v.x += Math.sin(y * 3 + ph[1]) * 0.25 * y;
    }));
  }
  return out;
}

export function makeMesaGeos() {
  const out = [];
  for (let k = 0; k < 4; k++) {
    const rng = makeRng(300 + k);
    const ph = [rng() * 6, rng() * 6, rng() * 6];
    const geo = new THREE.CylinderGeometry(1, 1, 1, 14, 7, false);
    geo.translate(0, 0.5, 0);
    out.push(displace(geo, (v) => {
      const y = v.y, a = Math.atan2(v.z, v.x);
      const r = Math.hypot(v.x, v.z);
      if (r < 1e-4) { if (y > 0.99) v.y = 1 + 0.02 * Math.sin(ph[2]); return; }
      let prof = y < 0.18 ? 1 + 0.45 * Math.pow((0.18 - y) / 0.18, 1.5) : 1 - 0.06 * y;
      prof *= 1 + 0.16 * Math.sin(a * 2 + ph[0]) + 0.09 * Math.sin(a * 5 + ph[1] + y * 3) + 0.05 * Math.sin(a * 11 + y * 20);
      if (y > 0.999) prof *= 0.97;
      v.x = Math.cos(a) * prof * r; v.z = Math.sin(a) * prof * r;
    }));
  }
  return out;
}

function mergeColored(parts) {
  let n = 0; const ps = parts.map(([g, c]) => { const gg = g.index ? g.toNonIndexed() : g; n += gg.attributes.position.count; return [gg, c]; });
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3); let o = 0;
  for (const [g, c] of ps) { const p = g.attributes.position; for (let i = 0; i < p.count; i++, o++) { pos[o * 3] = p.getX(i); pos[o * 3 + 1] = p.getY(i); pos[o * 3 + 2] = p.getZ(i); col[o * 3] = c[0]; col[o * 3 + 1] = c[1]; col[o * 3 + 2] = c[2]; } }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.computeVertexNormals(); return g;
}
// unit-height pine (base at y=0, radius ~1)
export function makeTreeGeos() {
  const out = [];
  for (let k = 0; k < 3; k++) {
    const parts = [[new THREE.CylinderGeometry(0.12, 0.18, 0.35, 5).translate(0, 0.175, 0), [0.28, 0.17, 0.08]]];
    const tiers = 3 + (k % 2);
    for (let i = 0; i < tiers; i++) {
      const y0 = 0.25 + i * (0.6 / tiers), r = 1 - i * 0.22, hh = 0.42 - i * 0.04;
      parts.push([new THREE.ConeGeometry(r, hh, 7).translate(0, y0 + hh / 2, 0), [0.13 + 0.03 * i, 0.24 + 0.03 * i, 0.08]]);
    }
    out.push(mergeColored(parts));
  }
  // umbrella pine (Mediterranean)
  out.push(mergeColored([[new THREE.CylinderGeometry(0.1, 0.15, 0.7, 5).translate(0, 0.35, 0), [0.3, 0.2, 0.1]], [new THREE.SphereGeometry(1, 8, 5).scale(1, 0.38, 1).translate(0, 0.78, 0), [0.17, 0.27, 0.09]]]));
  return out;
}

// jungle trees: layered alpha-cut foliage cards around branching trunks (3 broadleaf variants + 2 palms).
// Geometry carries uv (into a procedural leaf atlas: left half = leaf clusters, right half = palm frond),
// vertex colour variation and "spherical" crown normals so canopies shade softly.
function mergeCards(parts) {
  let n = 0; for (const p of parts) n += p.pos.length / 3;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const p of parts) { pos.set(p.pos, o * 3); nor.set(p.nor, o * 3); col.set(p.col, o * 3); uv.set(p.uv, o * 2); o += p.pos.length / 3; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}
function partFromGeo(geo, c, uvc) { // solid part (trunk): uv points at an opaque atlas pixel
  const g = geo.index ? geo.toNonIndexed() : geo; g.computeVertexNormals();
  const n = g.attributes.position.count, col = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { col.set(c, i * 3); uv[i * 2] = uvc[0]; uv[i * 2 + 1] = uvc[1]; }
  return { pos: g.attributes.position.array, nor: g.attributes.normal.array, col, uv };
}
// one quad card: centre, right/up vectors, uv rect, colour, normal source (crown centre)
function card(cx, cy, cz, rx, ry, rz, ux, uy, uz, u0, v0, u1, v1, c, nc) {
  const P = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
  const pos = [], nor = [], col = [], uv = [];
  for (const [a, b] of P) {
    const x = cx + rx * a + ux * (b + 1) * 0.5 * 2 - ux, y = cy + ry * a + uy * (b + 1) * 0.5 * 2 - uy, z = cz + rz * a + uz * (b + 1) * 0.5 * 2 - uz;
    pos.push(x, y, z);
    let nx = x - nc[0], ny = (y - nc[1]) * 1.3 + 0.35, nz = z - nc[2]; const L = Math.hypot(nx, ny, nz) || 1; nor.push(nx / L, ny / L, nz / L);
    col.push(c[0], c[1], c[2]); uv.push(a < 0 ? u0 : u1, b < 0 ? v0 : v1);
  }
  return { pos, nor, col, uv };
}
export function makeLeafAtlas() {
  const W = 640, H = 256, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const x = cv.getContext('2d'); const rng = makeRng(77);
  x.clearRect(0, 0, W, H);
  // left: dense broadleaf cluster
  // lobed cluster: several sub-clumps so the silhouette is irregular, leaves stay well inside the cell
  const lobes = []; for (let i = 0; i < 7; i++) { const a = rng() * 6.283, r = i ? 22 + rng() * 34 : 0; lobes.push([128 + Math.cos(a) * r, 132 + Math.sin(a) * r * 0.8, 28 + rng() * 16]); }
  // solid dark core under the leaves so the clump keeps its shape at distance (mipmaps + alpha test)
  for (const lb of lobes) { x.fillStyle = 'rgb(38,82,30)'; x.beginPath(); x.arc(lb[0], lb[1], lb[2] * 0.8, 0, 6.283); x.fill(); }
  for (let i = 0; i < 420; i++) {
    const lb = lobes[i % lobes.length], r = Math.sqrt(rng()) * lb[2], a = rng() * 6.283, px = lb[0] + Math.cos(a) * r, py = lb[1] + Math.sin(a) * r * 0.85;
    const L = 7 + rng() * 9, ang = rng() * 6.283, g = 0.45 + rng() * 0.55 * (1 - (py - 60) / 260);
    x.save(); x.translate(px, py); x.rotate(ang);
    x.fillStyle = `rgb(${Math.round(70 * g)},${Math.round(150 * g + 40)},${Math.round(45 * g)})`;
    x.beginPath(); x.ellipse(0, 0, L, L * 0.42, 0, 0, 6.283); x.fill();
    x.strokeStyle = `rgba(20,50,10,0.5)`; x.lineWidth = 1; x.beginPath(); x.moveTo(-L, 0); x.lineTo(L, 0); x.stroke();
    x.restore();
  }
  // right: palm frond (central rachis + many narrow leaflets)
  x.save(); x.translate(260, 128);
  x.strokeStyle = 'rgb(90,110,40)'; x.lineWidth = 4; x.beginPath(); x.moveTo(0, 0); x.quadraticCurveTo(115, -10, 236, 6); x.stroke();
  for (let i = 0; i < 70; i++) {
    const t = i / 70, px = t * 226, py = -10 * Math.sin(t * 3.1) + t * 6, len = 70 * Math.sin(Math.PI * Math.min(t * 1.1, 1)) + 10;
    for (const sd of [-1, 1]) {
      const g = 0.6 + rng() * 0.4;
      x.strokeStyle = `rgb(${Math.round(60 * g)},${Math.round(140 * g + 30)},${Math.round(40 * g)})`; x.lineWidth = 3.2;
      x.beginPath(); x.moveTo(px, py); x.quadraticCurveTo(px + 12, py + sd * len * 0.6, px + 22, py + sd * len); x.stroke();
    }
  }
  x.restore();
  // opaque trunk texel (bottom-left corner)
  x.fillStyle = 'rgb(255,255,255)'; x.fillRect(544, 0, 96, 256);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.generateMipmaps = true;
  return t;
}
export function makeJungleGeos() {
  const out = [], TRUNK_UV = [592 / 640, 0.5];
  // UV note: CanvasTexture flipY=true -> v = 1 - y/H
  const LU0 = 0, LU1 = 0.4, LV0 = 0, LV1 = 1, FU0 = 0.4, FU1 = 0.8, FV0 = 0.0, FV1 = 1.0;
  for (let k = 0; k < 3; k++) {
    const rng = makeRng(900 + k), parts = [];
    parts.push(partFromGeo(new THREE.CylinderGeometry(0.03, 0.07, 0.7, 7).translate(0, 0.35, 0), [0.36, 0.3, 0.22], TRUNK_UV));
    // branches
    for (let i = 0; i < 4; i++) {
      const a = rng() * 6.283, br = new THREE.CylinderGeometry(0.01, 0.022, 0.4, 5).translate(0, 0.2, 0);
      br.rotateZ(0.9).rotateY(a).translate(0, 0.5 + rng() * 0.15, 0);
      parts.push(partFromGeo(br, [0.34, 0.28, 0.2], TRUNK_UV));
    }
    // crown: several foliage clumps, each = 3 crossed cards + 1 horizontal card
    const clumps = 7 + k * 2, crownY = 0.78;
    for (let i = 0; i < clumps; i++) {
      const a = rng() * 6.283, rr = (i === 0 ? 0 : 0.25 + rng() * 0.4), cx = Math.cos(a) * rr, cz = Math.sin(a) * rr, cy = crownY + (rng() - 0.3) * 0.22 - rr * 0.15;
      const s = 0.26 + rng() * 0.16, cg = 0.75 + rng() * 0.5, c = [cg * (0.85 + rng() * 0.2), cg, cg * (0.8 + rng() * 0.3)];
      const nc = [0, crownY - 0.1, 0];
      for (let j = 0; j < 3; j++) {
        const t = (j / 3) * Math.PI + rng() * 0.4;
        parts.push(card(cx, cy, cz, Math.cos(t) * s, 0, Math.sin(t) * s, 0, s * 0.62, 0, LU0, LV0, LU1, LV1, c, nc));
      }
      parts.push(card(cx, cy + s * 0.25, cz, s, 0, 0, 0, 0, s * 0.95, LU0, LV0, LU1, LV1, c, nc));
    }
    out.push(mergeCards(parts));
  }
  for (let k = 0; k < 2; k++) {
    const parts = [], segs = 7, bend = 0.12 + k * 0.08;
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs, t1 = (i + 1) / segs;
      const g = new THREE.CylinderGeometry(0.03, 0.04, 0.84 / segs + 0.01, 6).translate(bend * 1.2 * ((t0 + t1) / 2) ** 2, 0.84 * (t0 + t1) / 2, 0);
      parts.push(partFromGeo(g, [0.42, 0.36, 0.26], TRUNK_UV));
    }
    const tx = bend * 1.2, ty = 0.86, nc = [tx, ty - 0.2, 0];
    const rng = makeRng(950 + k);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * 6.283 + rng() * 0.3, droop = 0.15 + rng() * 0.35, L = 0.42 + rng() * 0.12;
      const dx = Math.cos(a), dz = Math.sin(a);
      // frond card: from crown outward and drooping, width across
      const ex = tx + dx * L * 0.5, ey = ty - droop * 0.5 * L, ez = dz * L * 0.5;
      const c = [0.9 + rng() * 0.2, 0.95 + rng() * 0.15, 0.85];
      // right vector = along frond (half length), up = across (half width)
      parts.push(card(ex, ey + 0.06, ez, dx * L * 0.5, -droop * L * 0.5, dz * L * 0.5, -dz * 0.11, 0.03, dx * 0.11, FU0, FV0, FU1, FV1, c, nc));
    }
    out.push(mergeCards(parts));
  }
  return out;
}

export function makeBoulderGeos() {
  const out = [];
  for (let k = 0; k < 4; k++) {
    const rng = makeRng(500 + k);
    const ph = [rng() * 6, rng() * 6, rng() * 6];
    const geo = new THREE.IcosahedronGeometry(1, 1);
    out.push(displace(geo, (v) => {
      const s = 1 + 0.25 * Math.sin(v.x * 3 + ph[0]) * Math.sin(v.y * 3 + ph[1]) + 0.15 * Math.sin(v.z * 5 + ph[2]);
      v.multiplyScalar(s); v.y *= 0.7;
    }));
  }
  return out;
}

// world-space detail noise, strata and low-altitude haze for terrain/rocks
// CC0 PBR detail textures (Poly Haven) shared by all terrain/rock materials, triplanar-mapped
export const TRI = { tRockD: { value: null }, tRockN: { value: null }, tSandD: { value: null }, tSandN: { value: null }, tGrassD: { value: null }, triK: { value: 0 }, triMean: { value: new THREE.Vector3(0.296, 0.388, 0.374) } };
export function patchRockMaterial(mat, strata, hazeU, tri = false) {
  mat.defines = Object.assign(mat.defines || {}, { ROCKSTRATA: strata.toFixed(2) });
  if (tri) mat.defines.TRIPLANAR = 1;
  mat.extensions = { derivatives: true };
  mat.onBeforeCompile = (sh) => {
    if (hazeU) Object.assign(sh.uniforms, hazeU);
    Object.assign(sh.uniforms, TRI);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWN;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 wpX = vec4(transformed, 1.0);
        vec3 wnX = objectNormal;
        #ifdef USE_INSTANCING
          wpX = instanceMatrix * wpX; wnX = mat3(instanceMatrix) * wnX;
        #endif
        vWPos = (modelMatrix * wpX).xyz; vWN = normalize(mat3(modelMatrix) * wnX);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos; varying vec3 vWN;
        uniform sampler2D tRockD; uniform sampler2D tRockN; uniform sampler2D tSandD; uniform sampler2D tSandN; uniform sampler2D tGrassD; uniform float triK; uniform vec3 triMean;
        vec3 triW(vec3 n){ vec3 w = pow(abs(n), vec3(4.0)); return w / (w.x + w.y + w.z); }
        uniform vec3 hazeSun; uniform vec3 hazeCol; uniform float hazeK; uniform float hazeH;
        float hshR(vec2 p){ p = mod(p, 512.0); return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnR(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(hshR(i), hshR(i+vec2(1.0,0.0)), f.x), mix(hshR(i+vec2(0.0,1.0)), hshR(i+vec2(1.0,1.0)), f.x), f.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 wp = vWPos;
          float n1 = vnR(wp.xz * 0.07 + wp.y * 0.02);
          float n2 = vnR(wp.xz * 0.55 + vec2(wp.y * 0.35));
          float n3 = vnR(vec2(wp.x + wp.z, wp.y) * 1.7);
          float strata = 0.5 + 0.5 * sin(wp.y * 0.55 + n1 * 3.0);
          diffuseColor.rgb *= 0.80 + 0.22 * n1 + 0.16 * (n2 - 0.5) + 0.08 * (n3 - 0.5);
          diffuseColor.rgb *= mix(1.0, 0.80 + 0.32 * strata, ROCKSTRATA);
          #ifdef TRIPLANAR
          if (triK > 0.0) {
            vec3 N = normalize(vWN), w = triW(N);
            float dW = length(vWPos - cameraPosition);
            float near = 1.0 - smoothstep(250.0, 1400.0, dW);
            vec3 sc = wp * 0.09, sm = wp * 0.013;
            float rx = dot(texture2D(tRockD, sc.zy).rgb, vec3(0.333)) * 0.6 + dot(texture2D(tRockD, sm.zy).rgb, vec3(0.333)) * 0.4;
            float rz = dot(texture2D(tRockD, sc.xy).rgb, vec3(0.333)) * 0.6 + dot(texture2D(tRockD, sm.xy).rgb, vec3(0.333)) * 0.4;
            float green = clamp((diffuseColor.g - diffuseColor.r) * 6.0 + 0.3, 0.0, 1.0);
            float gs = dot(texture2D(tSandD, sc.xz).rgb, vec3(0.333)) / triMean.y * 0.6 + dot(texture2D(tSandD, sm.xz).rgb, vec3(0.333)) / triMean.y * 0.4;
            float gg = dot(texture2D(tGrassD, sc.xz * 0.6).rgb, vec3(0.333)) / triMean.z * 0.6 + dot(texture2D(tGrassD, sm.xz).rgb, vec3(0.333)) / triMean.z * 0.4;
            float det = (rx * w.x + rz * w.z) / triMean.x + mix(gs, gg, green) * w.y;
            diffuseColor.rgb *= mix(1.0, clamp(det, 0.35, 1.9), triK * mix(0.45, 1.0, near));
          }
          #endif
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        #ifdef TRIPLANAR
        if (triK > 0.0) {
          vec3 N = normalize(vWN), w = triW(N), wp = vWPos * 0.09;
          float k = triK * (1.0 - smoothstep(150.0, 900.0, length(vWPos - cameraPosition))) * 0.9;
          vec3 tx = texture2D(tRockN, wp.zy).xyz * 2.0 - 1.0, ty = texture2D(tSandN, wp.xz).xyz * 2.0 - 1.0, tz = texture2D(tRockN, wp.xy).xyz * 2.0 - 1.0;
          tx.xy *= k; ty.xy *= k; tz.xy *= k;
          vec3 nX = vec3(tx.xy + N.zy, abs(tx.z) * N.x), nY = vec3(ty.xy + N.xz, abs(ty.z) * N.y), nZ = vec3(tz.xy + N.xy, abs(tz.z) * N.z);
          vec3 wn = normalize(nX.zyx * w.x + nY.xzy * w.y + nZ.xyz * w.z);
          normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
        }
        #endif`)
      .replace('#include <fog_fragment>', `#include <fog_fragment>
        #ifdef USE_FOG
        {
          float distW = length(vWPos - cameraPosition);
          float hf = (1.0 - smoothstep(0.0, 150.0, vWPos.y)) * smoothstep(fogNear * 0.3, fogFar * 0.7, distW) * hazeH;
          gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, hf);
          // forward scattering: haze glows toward the sun colour when looking sunward
          float sunAmt = pow(max(dot(normalize(vWPos - cameraPosition), hazeSun), 0.0), 5.0);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, hazeCol, clamp((fogFactor + hf) * sunAmt * hazeK, 0.0, 0.85));
        }
        #endif`);
  };
}
