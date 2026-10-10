import * as THREE from 'three';
import { World, makeRng, CHUNK_L, buildChunkGeometry, genChunkContent, radiusAt, makeSpireGeos, makeMesaGeos, makeBoulderGeos, makeTreeGeos, makeJungleGeos, makeLeafAtlas, patchRockMaterial, TRI } from './terrain.js?v=50';
import { buildShip, upgradeShip, SHIP_PROBES, PROBE_ZONE, FROST } from './ship.js?v=50';
import { loadAssets } from './assets.js?v=50';
const ASSETS = await loadAssets().catch((e) => { console.warn(e); return {}; });
import { Grass } from './grass.js?v=50';
import { GpuDust } from './gpudust.js?v=50';
import { PostFX } from './postfx.js?v=50';
import { ParticlePool, Streaks, Shockwaves, Precip, makeDustTexture, makeGlowTexture, fogU } from './fx.js?v=50';
import { GameAudio } from './audio.js?v=50';
import { Controls } from './input.js?v=50';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const params = new URLSearchParams(location.search);
const TEST = params.has('test');

const MAX_KMH = 8700, MIN_KMH = 150, MACH_KMH = 1235; // MAX_KMH = handling/effects reference speed, not the cap
const NORMAL_KMH = 35620, ULTRA_KMH = 124700, BLAST_KMH = 470000, MPOV_KMH = 500;
let TOP_KMH = NORMAL_KMH;
const thrKmh = (t) => MIN_KMH + Math.pow(t, 2.2) * (TOP_KMH - MIN_KMH); // curved throttle: fine control at low speed, full range to the top
let AHEAD = 16; const BEHIND = 2; // 3.8 km of terrain + obstacles ahead (>1.5 s at 8700 km/h)
const CEILING = 100000; // v42: no absolute ceiling; the cap is terrain-relative (MAX_AGL)
const MAX_AGL = 500, SAFE_AGL = 450, OBJ_CAP = 450;

window.addEventListener('error', (e) => { const el = $('err'); el.classList.remove('hidden'); el.textContent += (e.message || e) + '\n'; });

// ---------- renderer ----------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const DPR = window.devicePixelRatio || 1;
const quality = { maxPR: Math.min(DPR, 3), pr: Math.min(DPR, 3), minPR: Math.min(1, DPR), failPR: 99, shadows: true, particles: 1 };
if (params.get('q') === 'low') { quality.pr = quality.maxPR = 1; quality.shadows = false; }
let lockQ = params.has('q');
const post = new PostFX(renderer);
renderer.setPixelRatio(quality.pr);

const scene = new THREE.Scene();
const LIN = THREE.LinearSRGBColorSpace;
const FOG_BASE = new THREE.Color().setRGB(0.82, 0.40, 0.14, LIN);
const FOG_STORM = new THREE.Color().setRGB(0.62, 0.33, 0.15, LIN);
scene.fog = new THREE.Fog(FOG_BASE.clone(), 150, 2600);
scene.background = FOG_BASE.clone();

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 6000);
scene.add(camera);

// ---------- sky ----------
const SUN = new THREE.Vector3(0.34, 0.15, -1).normalize();
const skyMat = new THREE.ShaderMaterial({
  uniforms: { sunDir: { value: SUN }, time: { value: 0 }, storm: { value: 0 }, flash: { value: 0 }, fogCol: { value: scene.fog.color }, horC: { value: new THREE.Color(0.98, 0.52, 0.18) }, midC: { value: new THREE.Color(0.72, 0.34, 0.12) }, zenC: { value: new THREE.Color(0.26, 0.13, 0.07) } },
  vertexShader: `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
  fragmentShader: `
    uniform vec3 sunDir; uniform float time; uniform float storm; uniform float flash; uniform vec3 fogCol; uniform vec3 horC; uniform vec3 midC; uniform vec3 zenC; varying vec3 vDir;
    float h2(vec2 p){ p = mod(p, 289.0); return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
      return mix(mix(h2(i), h2(i+vec2(1,0)), f.x), mix(h2(i+vec2(0,1)), h2(i+vec2(1,1)), f.x), f.y); }
    float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * vn(p); p = p * 2.02 + vec2(1.7, 9.2); a *= 0.5; } return s; }
    void main(){
      vec3 d = normalize(vDir);
      float h = d.y;
      vec3 horizon = horC;
      vec3 mid = midC;
      vec3 zen = zenC;
      vec3 col = mix(horizon, mid, smoothstep(0.0, 0.2, h));
      col = mix(col, zen, smoothstep(0.18, 0.75, h));
      float sd = max(dot(d, sunDir), 0.0);
      col += mix(vec3(1.0, 0.62, 0.28), horizon, 0.5) * pow(sd, 4.0) * 0.6 + vec3(1.0, 0.85, 0.55) * pow(sd, 40.0) * 1.2;
      // stormy clouds
      vec2 uv = d.xz / (max(h, 0.0) + 0.14) * 1.1 + vec2(time * 0.012, time * 0.005);
      float c = fbm(uv);
      float thick = fbm(uv * 2.3 + 4.0);
      float cm = smoothstep(0.30, 0.70, c) * smoothstep(-0.03, 0.06, h);
      vec3 cDark = zen * 0.75 + vec3(0.01);
      vec3 cLit = horizon * 1.28;
      vec3 cc = mix(cDark, cLit, clamp(pow(sd, 2.5) * 1.1 + 0.35 * (1.0 - thick) + 0.25 * smoothstep(0.25, 0.0, h), 0.0, 1.0));
      col = mix(col, cc, cm * 0.92);
      col += vec3(1.0, 0.75, 0.4) * pow(sd, 6.0) * cm * (1.0 - thick) * 1.8;
      col += vec3(1.0, 0.6, 0.25) * pow(sd, 2.0) * 0.25;
      // god-ray-ish streaks around the sun
      float ang = atan(d.x - sunDir.x, d.y - sunDir.y);
      col += vec3(1.0, 0.75, 0.4) * pow(sd, 3.0) * (0.5 + 0.5 * sin(ang * 14.0 + fbm(vec2(ang * 3.0, time * 0.05)) * 6.0)) * 0.12 * (1.0 - cm * 0.5);
      // sun disc
      col += vec3(1.0, 0.95, 0.8) * smoothstep(0.9990, 0.9996, sd) * 4.0 * (1.0 - cm * 0.6);
      // haze toward horizon / below
      col = mix(col, fogCol, (1.0 - smoothstep(0.0, 0.08, h)) * 0.55 * (1.0 - pow(sd, 6.0) * 0.8));
      col = mix(col, fogCol, smoothstep(0.0, -0.05, h));
      col = mix(col, fogCol, storm);
      col += vec3(0.75, 0.8, 1.0) * flash * (0.6 + 0.8 * cm);
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  side: THREE.BackSide, depthWrite: false, fog: false,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(4000, 48, 24), skyMat);
sky.renderOrder = -10; sky.frustumCulled = false;
scene.add(sky);

// environment map from the sky for metallic hull reflections
let envMap = null;
{
  const pm = new THREE.PMREMGenerator(renderer);
  const es = new THREE.Scene();
  const s2 = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMat);
  es.add(s2);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(48, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(0.5, 0.26, 0.12, LIN) }));
  ground.position.y = -6; es.add(ground);
  envMap = pm.fromScene(es, 0.02, 0.1, 200).texture;
  pm.dispose();
}

// ---------- lights ----------
const sunLight = new THREE.DirectionalLight(new THREE.Color().setRGB(1.0, 0.74, 0.46, LIN), 3.8);
sunLight.castShadow = quality.shadows;
sunLight.shadow.mapSize.set(2048, 2048);
const sc = sunLight.shadow.camera; sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 10; sc.far = 1600;
sunLight.shadow.bias = -0.0006; sunLight.shadow.normalBias = 0.6;
scene.add(sunLight, sunLight.target);
const hemi = new THREE.HemisphereLight(new THREE.Color().setRGB(1.0, 0.66, 0.40, LIN), new THREE.Color().setRGB(0.42, 0.22, 0.10, LIN), 0.85);
scene.add(hemi);

// ---------- materials & rocks ----------
const hazeU = { hazeSun: { value: SUN }, hazeCol: { value: new THREE.Color(1, 0.7, 0.4) }, hazeK: { value: 0.5 }, hazeH: { value: 0.45 } };
const terrainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
patchRockMaterial(terrainMat, 0.35, hazeU, true);
const rockMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(1, 1, 1), roughness: 0.92, metalness: 0, flatShading: true });
patchRockMaterial(rockMat, 1.0, hazeU, true);
const boulderMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.85, 0.85, 0.85), roughness: 0.95, metalness: 0, flatShading: true });
patchRockMaterial(boulderMat, 0.3, hazeU, true);

class RockSet {
  constructor(geos, mat, cap, cast) {
    this.meshes = geos.map((g) => {
      const m = new THREE.InstancedMesh(g, mat, cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false; m.receiveShadow = true; m.castShadow = !!cast; m.count = 0;
      m.setColorAt(0, new THREE.Color(1, 1, 1));
      scene.add(m);
      return m;
    });
    this.cap = cap;
  }
}
const spires = new RockSet(makeSpireGeos(), rockMat, 500);
const mesas = new RockSet(makeMesaGeos(), rockMat, 300);
const boulders = new RockSet(makeBoulderGeos(), boulderMat, 1400);
const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, flatShading: true });
const trees = new RockSet(makeTreeGeos(), treeMat, 2600);
const jungleMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: makeLeafAtlas(), alphaTest: 0.42, alphaToCoverage: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide });
patchRockMaterial(jungleMat, 0.0, hazeU);
const jtrees = new RockSet(makeJungleGeos(), jungleMat, 9000);
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _c = new THREE.Color();

function rebuildInstances() {
  const sets = { spire: spires, mesa: mesas, boulder: boulders, tree: trees, jtree: jtrees };
  for (const k in sets) for (const m of sets[k].meshes) m.count = 0;
  for (const ch of chunks.values()) {
    for (const o of ch.objs) {
      if (o.dead) continue;
      const set = sets[o.type]; if (!set) continue;
      const m = set.meshes[o.variant % set.meshes.length];
      if (m.count >= set.cap) continue;
      _p.set(o.x, o.y, o.z);
      _e.set(0, o.rot, 0); _q.setFromEuler(_e);
      if (o.type === 'boulder') _s.set(o.r * 1.2, o.r, o.r * 1.1); else if (o.type === 'tree' || o.type === 'jtree') _s.set(o.r, o.h, o.r); else _s.set(o.r, o.h + 4, o.r);
      _m4.compose(_p, _q, _s);
      m.setMatrixAt(m.count, _m4);
      _c.setRGB(o.col[0], o.col[1], o.col[2]);
      m.setColorAt(m.count, _c);
      m.count++;
    }
  }
  for (const k in sets) for (const m of sets[k].meshes) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
}

// ---------- biomes: environment palettes ----------
const BIOME_NAMES = { gorge: 'WATERFALL GORGE', desert: 'DESERT CANYON', ocean: 'OPEN OCEAN', coast: 'MEDITERRANEAN COAST', fjord: 'ICE FJORD', volcanic: 'VOLCANIC BADLANDS', grass: 'HIGHLAND MEADOWS', jungle: 'TROPICAL JUNGLE' };
const ENV = {
  desert:   { fog: [0.82, 0.40, 0.14], hor: [0.98, 0.52, 0.18], mid: [0.72, 0.34, 0.12], zen: [0.26, 0.13, 0.07], sun: [1.0, 0.74, 0.46], sunI: 3.8, hs: [1.0, 0.66, 0.40], hg: [0.42, 0.22, 0.10], hemiI: 0.85, far: 2600, dust: [1.35, 0.86, 0.48], water: [0.03, 0.16, 0.2], exp: 0.95, haze: 0.55, hazeH: 0.45 },
  ocean:    { fog: [0.46, 0.60, 0.76], hor: [0.68, 0.77, 0.87], mid: [0.42, 0.58, 0.82], zen: [0.08, 0.22, 0.52], sun: [1.0, 0.9, 0.76], sunI: 4.0, hs: [0.70, 0.80, 1.0], hg: [0.12, 0.22, 0.32], hemiI: 1.0, far: 3800, dust: [1.5, 1.55, 1.6], water: [0.005, 0.06, 0.16], exp: 0.88, haze: 0.4, hazeH: 0.3 },
  coast:    { fog: [0.66, 0.72, 0.76], hor: [1.0, 0.86, 0.66], mid: [0.48, 0.68, 0.90], zen: [0.12, 0.30, 0.62], sun: [1.0, 0.92, 0.80], sunI: 4.4, hs: [0.75, 0.85, 1.0], hg: [0.42, 0.38, 0.28], hemiI: 1.1, far: 3000, dust: [1.5, 1.45, 1.3], water: [0.02, 0.28, 0.32], exp: 0.92, haze: 0.7, hazeH: 0.6 },
  fjord:    { fog: [0.52, 0.58, 0.66], hor: [0.88, 0.84, 0.82], mid: [0.50, 0.57, 0.68], zen: [0.16, 0.21, 0.30], sun: [1.0, 0.88, 0.76], sunI: 3.2, hs: [0.75, 0.82, 0.95], hg: [0.28, 0.30, 0.34], hemiI: 1.0, far: 2400, dust: [1.4, 1.45, 1.55], water: [0.01, 0.06, 0.09], exp: 0.95, haze: 0.6, hazeH: 0.7 },
  gorge:    { fog: [0.56, 0.63, 0.56], hor: [0.98, 0.88, 0.70], mid: [0.50, 0.66, 0.72], zen: [0.14, 0.27, 0.40], sun: [1.0, 0.9, 0.74], sunI: 3.8, hs: [0.72, 0.86, 0.8], hg: [0.2, 0.28, 0.12], hemiI: 1.0, far: 2400, dust: [1.4, 1.5, 1.45], water: [0.04, 0.16, 0.13], exp: 0.95, haze: 0.7, hazeH: 0.7 },
  jungle:   { fog: [0.40, 0.52, 0.42], hor: [0.80, 0.88, 0.78], mid: [0.46, 0.66, 0.66], zen: [0.12, 0.30, 0.42], sun: [1.0, 0.93, 0.78], sunI: 3.8, hs: [0.62, 0.84, 0.66], hg: [0.10, 0.22, 0.07], hemiI: 1.0, far: 3200, dust: [1.1, 1.25, 1.05], water: [0.04, 0.12, 0.07], exp: 0.95, haze: 0.5, hazeH: 0.45 },
  grass:    { fog: [0.62, 0.70, 0.74], hor: [1.0, 0.90, 0.72], mid: [0.50, 0.66, 0.86], zen: [0.13, 0.28, 0.56], sun: [1.0, 0.92, 0.78], sunI: 4.2, hs: [0.72, 0.84, 1.0], hg: [0.24, 0.3, 0.12], hemiI: 1.05, far: 2800, dust: [1.0, 1.05, 0.72], water: [0.03, 0.14, 0.12], exp: 0.92, haze: 0.65, hazeH: 0.6 },
  volcanic: { fog: [0.34, 0.15, 0.08], hor: [0.80, 0.30, 0.10], mid: [0.42, 0.14, 0.07], zen: [0.07, 0.035, 0.035], sun: [1.0, 0.52, 0.28], sunI: 3.0, hs: [0.85, 0.40, 0.22], hg: [0.22, 0.08, 0.04], hemiI: 0.75, far: 2000, dust: [0.32, 0.28, 0.26], water: [0.05, 0.02, 0.01], exp: 1.0, haze: 0.5, hazeH: 0.55 },
};
const E = { fog: FOG_BASE.clone(), sunI: 3.8, hemiI: 0.85, far: 2600, dust: [1.35, 0.86, 0.48], waterK: 0, name: 'DESERT CANYON', main: 'desert' };
const _ea = new THREE.Color(), _eb = new THREE.Color();
function envMix(key, a, b, t, out) { _ea.setRGB(...a[key], LIN); _eb.setRGB(...b[key], LIN); return out.copy(_ea).lerp(_eb, t); }
const SWELL = { ocean: 1, coast: 0.75, fjord: 0.45, gorge: 0, jungle: 0 };
const WATER_BIOMES = { ocean: 1, coast: 1, fjord: 1, gorge: 1, jungle: 1 };
// animated water: wave normals, fresnel sky reflection, sun glint; semi-transparent so shallows show turquoise sand
const WTRAIL = []; for (let i = 0; i < 10; i++) WTRAIL.push(new THREE.Vector4(0, 0, 9, 0));
// ---------- v41: floating origin (render-space rebasing) ----------
// Simulation stays in absolute world metres (JS doubles). The whole scene graph is shifted by -RO so GPU-side
// positions stay small and precise far from spawn; shaders that need absolute coords for patterns add uRO back.
const RO = new THREE.Vector3(), RO_U = { value: RO };
const toSim = (v) => v.add(RO); // matrixWorld-derived positions -> simulation space
{ // Object3D.lookAt takes a world-space target; game code passes simulation-space targets, so shift them into render space
  const la = THREE.Object3D.prototype.lookAt, _t = new THREE.Vector3();
  THREE.Object3D.prototype.lookAt = function (x, y, z) {
    if (x.isVector3) _t.copy(x); else _t.set(x, y, z);
    if (RO.x !== 0 || RO.z !== 0) { let o = this.parent; while (o && o !== scene) o = o.parent; if (o === scene) _t.sub(RO); }
    return la.call(this, _t);
  };
}
const waterMat = new THREE.ShaderMaterial({
  uniforms: { uRO: RO_U, flow: { value: 0 }, hazeSun: hazeU.hazeSun, hazeCol: hazeU.hazeCol, hazeK: hazeU.hazeK, time: { value: 0 }, waterCol: { value: new THREE.Color(0.02, 0.2, 0.25) }, horC: skyMat.uniforms.horC, zenC: skyMat.uniforms.zenC, sunDir: { value: SUN }, sunCol: { value: new THREE.Color(1, 0.9, 0.75) }, fogColor: fogU.fogColor, fogNear: fogU.fogNear, fogFar: fogU.fogFar, glint: { value: 1 }, swell: { value: 1 }, frozen: { value: 0 },
    trail: { value: WTRAIL }, wash: { value: 0 }, washR: { value: 8 }, shipP: { value: new THREE.Vector3() } },
  vertexShader: `uniform vec3 uRO; uniform float time; uniform float swell; uniform float flow; varying vec3 vW;
    // long swells displace the surface (Gerstner, vertical + horizontal)
    vec3 gw(vec2 p, vec2 d, float L, float A, float Q){ float k = 6.2832 / L, w = sqrt(9.8 * k), ph = k * dot(d, p) - w * time; return vec3(d.x * Q * A * cos(ph), A * sin(ph), d.y * Q * A * cos(ph)); }
    void main(){ vec4 w = modelMatrix * vec4(position, 1.0);
      float fade = smoothstep(3500.0, 900.0, length(w.xz - cameraPosition.xz)) * swell * (1.0 - flow);
      vec2 wa = w.xz + uRO.xz; vec3 o = gw(wa, normalize(vec2(1.0, 0.25)), 210.0, 1.1, 0.6) + gw(wa, normalize(vec2(0.7, -0.7)), 140.0, 0.7, 0.6) + gw(wa, normalize(vec2(-0.3, 1.0)), 96.0, 0.45, 0.5);
      w.xyz += o * fade; vW = w.xyz + uRO; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `uniform vec3 uRO;

    uniform float flow; uniform vec3 hazeSun; uniform vec3 hazeCol; uniform float hazeK; uniform float time; uniform vec3 waterCol; uniform vec3 horC; uniform vec3 zenC; uniform vec3 sunDir; uniform vec3 sunCol; uniform float glint; uniform float swell; uniform float frozen;
    uniform vec3 fogColor; uniform float fogNear; uniform float fogFar; uniform vec4 trail[10]; uniform float wash; uniform float washR; uniform vec3 shipP; varying vec3 vW;
    float hsh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(hsh(i), hsh(i + vec2(1, 0)), f.x), mix(hsh(i + vec2(0, 1)), hsh(i + vec2(1, 1)), f.x), f.y); }
    // Gerstner slope + height for one wave
    void gw(vec2 p, vec2 d, float L, float A, float Q, float att, inout vec3 n, inout float h){ float k = 6.2832 / L, w = sqrt(9.8 * k), ph = k * dot(d, p) - w * time; float c = cos(ph), s = sin(ph); n.x -= d.x * k * A * c * att; n.z -= d.y * k * A * c * att; n.y -= Q * k * A * s * att; h += A * s * att; }
    void main(){
      vec2 p = vW.xz - vec2(0.0, time * 14.0 * flow);
      float dist = length((cameraPosition + uRO) - vW);
      float aMed = 1.0 / (1.0 + dist * 0.0012), aFine = 1.0 / (1.0 + dist * 0.006);
      vec3 n = vec3(0.0, 1.0, 0.0); float h = 0.0;
      float sw = swell * (1.0 - flow);
      gw(p, normalize(vec2(1.0, 0.25)), 210.0, 1.1, 0.6, sw, n, h);
      gw(p, normalize(vec2(0.7, -0.7)), 140.0, 0.7, 0.6, sw, n, h);
      gw(p, normalize(vec2(-0.3, 1.0)), 96.0, 0.45, 0.5, sw, n, h);
      gw(p, normalize(vec2(0.9, 0.45)), 41.0, 0.22, 0.5, aMed, n, h);
      gw(p, normalize(vec2(-0.6, 0.8)), 27.0, 0.13, 0.5, aMed, n, h);
      gw(p, normalize(vec2(0.2, -1.0)), 17.0, 0.07, 0.4, aMed, n, h);
      // fine detail, low strength
      vec2 q = p * 0.25 + vec2(time * 0.35, time * 0.2);
      float e = 0.5, d0 = vn(q), dx = vn(q + vec2(e, 0.0)) - d0, dz = vn(q + vec2(0.0, e)) - d0;
      n.xz -= vec2(dx, dz) * 0.22 * aFine;
      n = normalize(n);
      vec3 v = normalize((cameraPosition + uRO) - vW);
      float fres = 0.02 + 0.72 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
      vec3 r = reflect(-v, n); r.y = abs(r.y);
      vec3 refl = mix(horC * 0.5 + zenC * 0.35, zenC * 1.1, pow(clamp(r.y, 0.0, 1.0), 0.35));
      float rs = max(dot(r, sunDir), 0.0);
      float spec = (pow(rs, 900.0) * 10.0 + pow(rs, 120.0) * 0.45 + pow(rs, 12.0) * 0.025) * glint;
      // subsurface tint on wave faces toward the sun
      vec3 deep = waterCol * (0.8 + 0.6 * max(h, 0.0));
      vec3 col = mix(deep, refl, fres) + sunCol * spec;
      // subtle foam on crests (broken up by noise)
      float foam = smoothstep(1.35, 2.0, h + vn(p * 0.08) * 0.8) * sw * aMed * 0.55;
      // jet-wash: wake foam + outward ripple rings + churn under the ship
      float wk = 0.0;
      vec2 dv = vW.xz - shipP.xz; float rd = length(dv);
      if (wash > 0.001 && rd < 260.0) {
        wk += wash * exp(-rd * rd / (washR * washR)) * 0.55 * smoothstep(0.35, 0.8, vn(vW.xz * 0.6 + time * 3.0));
        for (int i = 0; i < 10; i++) { vec4 t = trail[i]; float s = t.w * max(1.0 - t.z / 2.4, 0.0); if (s <= 0.0) continue;
          float rr = length(vW.xz - t.xy), R = washR * (1.0 + t.z * 0.8);
          wk += s * exp(-rr * rr / (R * R)) * 0.5 * smoothstep(0.4, 0.85, vn(vW.xz * 0.35 + t.z));
          float ring = washR * 0.7 + t.z * 20.0; wk += s * exp(-pow((rr - ring) / (2.0 + t.z * 2.5), 2.0)) * 0.1; }
      }
      foam = clamp(foam + wk, 0.0, 1.0);
      col = mix(col, vec3(0.92, 0.95, 0.97) * (sunCol * 0.6 + 0.35), foam);
      if (frozen > 0.001) { // Ice Age: static sea ice with cracks and snow patches (no waves, no wake)
        vec2 q = vW.xz * 0.02;
        float n1 = sin(q.x * 1.7 + sin(q.y * 1.3)) * sin(q.y * 1.9 + sin(q.x * 0.7));
        float n2 = sin(q.x * 5.3 + q.y * 2.1) * sin(q.y * 4.7 - q.x * 1.6);
        float crack = smoothstep(0.035, 0.0, abs(n1 * 0.6 + n2 * 0.4)) + smoothstep(0.02, 0.0, abs(sin(q.x * 3.1 - q.y * 0.4) * sin(q.y * 2.6 + q.x * 0.9))) * 0.6;
        float snowP = smoothstep(0.15, 0.55, sin(vW.x * 0.004 + sin(vW.z * 0.003)) * sin(vW.z * 0.005 + 1.3) + n2 * 0.25);
        vec3 ice = mix(vec3(0.62, 0.76, 0.86), vec3(0.80, 0.88, 0.94), 0.5 + 0.5 * n1) * (sunCol * 0.75 + 0.3);
        ice = mix(ice, vec3(0.95, 0.97, 1.0) * (sunCol * 0.8 + 0.35), snowP);
        ice = mix(ice, vec3(0.25, 0.38, 0.5), clamp(crack, 0.0, 1.0) * (1.0 - snowP) * 0.8);
        ice += sunCol * pow(max(dot(reflect(-v, vec3(0.0, 1.0, 0.0)), sunDir), 0.0), 60.0) * 0.4 * (1.0 - snowP);
        col = mix(col, ice, frozen); foam *= 1.0 - frozen;
      }
      float f = smoothstep(fogNear, fogFar, dist);
      col = mix(col, fogColor, f);
      float sunAmt = pow(max(dot(-v, hazeSun), 0.0), 5.0);
      col = mix(col, hazeCol, clamp(f * sunAmt * hazeK * 0.8 + smoothstep(600.0, 3000.0, dist) * 0.12 * hazeK, 0.0, 0.7));
      float a = mix(0.7, 0.98, fres);
      gl_FragColor = vec4(col, mix(max(max(max(a, f), min(spec, 1.0)), foam), 1.0, frozen));
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  transparent: true, depthWrite: true,
});
const water = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000, 300, 300).rotateX(-Math.PI / 2), waterMat);
water.renderOrder = 1; water.frustumCulled = false; water.visible = false;
scene.add(water);
let lastBiome = null;
function updateBiomeEnv(dt) {
  const z = camera.position.z;
  const B0 = world.biomeAt(z);
  const B = { a: B0.a, b: B0.b, t: B0.t };
  const a = ENV[B.a], b = ENV[B.b], t = B.t;
  envMix('fog', a, b, t, FOG_BASE);
  envMix('hor', a, b, t, skyMat.uniforms.horC.value);
  envMix('mid', a, b, t, skyMat.uniforms.midC.value);
  envMix('zen', a, b, t, skyMat.uniforms.zenC.value);
  envMix('sun', a, b, t, sunLight.color);
  waterMat.uniforms.sunCol.value.copy(sunLight.color);
  envMix('hs', a, b, t, hemi.color); envMix('hg', a, b, t, hemi.groundColor);
  envMix('water', a, b, t, waterMat.uniforms.waterCol.value);
  E.sunI = lerp(a.sunI, b.sunI, t); E.hemiI = lerp(a.hemiI, b.hemiI, t); E.far = lerp(a.far, b.far, t);
  for (let i = 0; i < 3; i++) E.dust[i] = lerp(a.dust[i], b.dust[i], t);
  renderer.toneMappingExposure = lerp(a.exp, b.exp, t);
  hazeU.hazeK.value = lerp(a.haze, b.haze, t); hazeU.hazeH.value = lerp(a.hazeH, b.hazeH, t);
  hazeU.hazeCol.value.copy(sunLight.color).lerp(skyMat.uniforms.horC.value, 0.4).multiplyScalar(1.15);
  waterMat.uniforms.flow.value = (B.a === 'gorge' || B.a === 'jungle' ? 1 - t : 0) + (B.b === 'gorge' || B.b === 'jungle' ? t : 0);
  const main = t > 0.5 ? B.b : B.a;
  E.main = main; E.name = BIOME_NAMES[main];
  const ahead = world.biomeMain(z - 2500), behind = world.biomeMain(z + 300);
  water.visible = !!(WATER_BIOMES[B.a] || WATER_BIOMES[B.b] || WATER_BIOMES[ahead] || WATER_BIOMES[behind]);
  E.waterK = (WATER_BIOMES[B.a] ? 1 - t : 0) + (WATER_BIOMES[B.b] ? t : 0);
  water.position.set(Math.round(camera.position.x / 30) * 30, 0, Math.round(z / 30) * 30);
  waterMat.uniforms.swell.value = lerp(SWELL[B.a] ?? 0.35, SWELL[B.b] ?? 0.35, t);
  waterMat.uniforms.time.value = S.t;
  rxIceEnv(dt);
  if (S.mode === 'playing' && lastBiome && main !== lastBiome) { pop('ENTERING ' + E.name, 'unlock'); }
  lastBiome = main;
}

// ---------- waterfalls ----------
const fallsMat = new THREE.ShaderMaterial({
  uniforms: { time: { value: 0 }, iceK: { value: 0 }, fogColor: fogU.fogColor, fogNear: fogU.fogNear, fogFar: fogU.fogFar },
  vertexShader: `varying vec2 vUv; varying float vD; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vD = -mv.z; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform float time; uniform float iceK; uniform vec3 fogColor; uniform float fogNear; uniform float fogFar; varying vec2 vUv; varying float vD;
    float h(float n){ return fract(sin(n) * 43758.5453); }
    void main(){
      float col = floor(vUv.x * 40.0);
      float sp = 0.6 + 0.6 * h(col);
      float streak = fract(vUv.y * 3.0 + time * sp + h(col + 7.0));
      float s = smoothstep(0.0, 0.5, streak) * (0.55 + 0.45 * h(col + 3.0));
      float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
      float a = edge * (0.45 + 0.5 * s) * (0.75 + 0.25 * vUv.y);
      vec3 c = mix(vec3(0.75, 0.85, 0.9), vec3(1.15), s);
      if (iceK > 0.0) { float col2 = h(col + 11.0), st = smoothstep(0.2, 0.9, col2) * (0.6 + 0.4 * vUv.y); vec3 ic = mix(vec3(0.62, 0.78, 0.9), vec3(0.95, 0.98, 1.0), st); c = mix(c, ic, iceK); a = mix(a, edge * (0.85 + 0.15 * st), iceK); } // frozen icefall: static
      float f = smoothstep(fogNear, fogFar, vD);
      gl_FragColor = vec4(mix(c, fogColor, f), a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  transparent: true, depthWrite: false, side: THREE.DoubleSide,
});
function makeFalls(f) {
  const g = new THREE.BufferGeometry();
  const o = f.side * 4; // stand a little off the cliff
  const p = [f.xt - o, f.ht + 2, f.z - f.w / 2, f.xt - o, f.ht + 2, f.z + f.w / 2, f.xb - o * 0.5, f.hb + 1, f.z - f.w * 0.8, f.xb - o * 0.5, f.hb + 1, f.z + f.w * 0.8];
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 0, 0, 1, 0], 2));
  g.setIndex([0, 2, 1, 1, 2, 3]);
  const m = new THREE.Mesh(g, fallsMat); m.renderOrder = 3; m.frustumCulled = false;
  scene.add(m); return m;
}

// ---------- grass ----------
const grass = new Grass(scene, {
  sunDir: { value: SUN }, sunCol: { value: sunLight.color }, skyCol: { value: hemi.color }, gndCol: { value: hemi.groundColor },
  sunI: { value: 3.8 }, hemiI: { value: 1 }, fogColor: fogU.fogColor, fogNear: fogU.fogNear, fogFar: fogU.fogFar, hazeCol: hazeU.hazeCol, hazeK: hazeU.hazeK,
}, 'high');
const gdust = new GpuDust(scene, fogU, SUN, sunLight.color, 262144);
const isGrassNear = (z) => { const B = world.biomeAt(z); if (B.a === 'grass' || B.b === 'grass') return true; return world.biomeMain(z - 450) === 'grass' || world.biomeMain(z + 60) === 'grass'; };

// ---------- world streaming ----------
let world = new World(1);
const chunks = new Map();
const AIC = new Map(); // AI analysis: chunk idx -> procedurally generated objects (not rendered), small LRU
const CHIPPED = new Map(); // stable uid -> reduced radius after localized rock damage
const DESTROYED = new Map(); // chunk idx -> Set of destroyed object indices (stable id = idx*4096+i)
function addChunk(idx) {
  RX.noPatch = true;
  const geo = buildChunkGeometry(world, idx);
  const mesh = new THREE.Mesh(geo, terrainMat);
  mesh.position.z = -idx * CHUNK_L;
  mesh.receiveShadow = true;
  scene.add(mesh);
  const { objs, falls } = genChunkContent(world, idx);
  rxDeckObjs(idx, objs); RX.noPatch = false;
  const dead = DESTROYED.get(idx); objs.forEach((o, i) => { o.uid = idx * 4096 + i; if (dead && dead.has(i)) o.dead = true; const cr = CHIPPED.get(o.uid); if (cr) o.r = cr; const B = S.boomZone; if (B && Math.hypot(o.x - B.x, o.z - B.z) < B.r) o.dead = true; const bf = baseFlatK(o.x, o.z); if (bf && bf[0] > 0.3) o.dead = true; capObj(o); }); // base pad is cleared of rocks
  for (let i = falls.length - 1; i >= 0; i--) if (!params.has('falls') && makeRng(((S.seed || 1) ^ (idx * 0x2c1b3c6d)) >>> 0)() >= 0.02) falls.splice(i, 1); // rare: ~2% of eligible cliffs
  for (const f of falls) f.mesh = makeFalls(f);
  chunks.set(idx, { idx, mesh, objs, falls });
}
function removeChunk(idx) {
  const ch = chunks.get(idx);
  { const set = new Set(); ch.objs.forEach((o, i) => { if (o.dead) set.add(i); }); if (set.size) DESTROYED.set(idx, set); else DESTROYED.delete(idx); } // destroyed state persists across streaming
  scene.remove(ch.mesh); ch.mesh.geometry.dispose();
  for (const f of ch.falls || []) { scene.remove(f.mesh); f.mesh.geometry.dispose(); }
  chunks.delete(idx);
}
function streamChunks(z, force) {
  AHEAD = clamp(Math.ceil(S.speed * 0.9 / CHUNK_L) + 4, 16, 46);
  const cur = Math.floor(-z / CHUNK_L);
  let changed = false;
  for (const idx of [...chunks.keys()]) if (idx < cur - BEHIND || idx > cur + AHEAD) { removeChunk(idx); changed = true; }
  // generate 1 chunk per frame normally; catch up faster if the ship outruns the generator (8700 km/h)
  let missing = 0; for (let i = cur; i <= cur + AHEAD; i++) if (i >= 0 && !chunks.has(i)) missing++;
  let budget = force ? 99 : missing > 12 ? 5 : missing > 4 ? 3 : missing > 1 ? 2 : 1;
  for (let i = cur - BEHIND; i <= cur + AHEAD && budget > 0; i++) {
    if (i < 0 || chunks.has(i)) continue;
    addChunk(i); budget--; changed = true;
  }
  if (changed) rebuildInstances();
}
function resetWorld(seed) {
  DESTROYED.clear(); CHIPPED.clear(); S.boomZone = null; AIC.clear();
  for (const idx of [...chunks.keys()]) removeChunk(idx);
  const fb = params.get('biome');
  world = new World(seed); if (fb && ENV[fb]) world.setSeed(seed, fb);
  rxPatchWorld(world); rxClearDeckMeshes(); RX.zones = rxGenZones(seed); RX.nearZones.length = 0; RX.above = false;
  lastBiome = null; grass.reset();
  streamChunks(0, true);
}

// ---------- ship ----------
const ship = buildShip(envMap);
let hdrEnv = envMap;
if (ASSETS.hdr) { const pm = new THREE.PMREMGenerator(renderer); hdrEnv = pm.fromEquirectangular(ASSETS.hdr).texture; pm.dispose(); }
if (ASSETS.ship) upgradeShip(ship, ASSETS.ship, ASSETS.ao, hdrEnv);
if (ASSETS.rockD && ASSETS.sandD) { TRI.tRockD.value = ASSETS.rockD; TRI.tRockN.value = ASSETS.rockN; TRI.tSandD.value = ASSETS.sandD; TRI.tSandN.value = ASSETS.sandN; TRI.tGrassD.value = ASSETS.grassD || ASSETS.sandD; TRI.triK.value = 1; }
TRI.uRO.value = RO; grass.U.uRO.value = RO; gdust.U.uRO.value = RO;
scene.add(ship);
ship.rotation.order = 'YXZ';
const glowTex = makeGlowTexture();
const dustTex = makeDustTexture();
const engineGlows = [];
for (const s of [-1, 1]) {
  const a = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(1.0, 0.42, 0.1), blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, transparent: true, opacity: 0.75 }));
  a.position.set(s * 1.78, -0.15, 6.0); a.renderOrder = 12;
  const b = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(1.0, 0.33, 0.05), blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, transparent: true, opacity: 0.28 }));
  b.position.set(s * 1.78, -0.15, 6.6); b.renderOrder = 12;
  ship.userData.body.add(a, b);
  engineGlows.push(a, b);
}
const engineLight = new THREE.PointLight(new THREE.Color(1.0, 0.5, 0.18), 0, 60, 1.6);
engineLight.position.set(0, -3.5, 13);
ship.userData.body.add(engineLight);
// vapor cone for transonic
const vaporMat = new THREE.ShaderMaterial({
  uniforms: { k: { value: 0 }, time: { value: 0 } },
  vertexShader: `varying float vF; varying float vT; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vec3 n = normalize(normalMatrix*normal); vF = 1.0 - abs(dot(n, normalize(-mv.xyz))); vT = position.y; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform float k; uniform float time; varying float vF; varying float vT; void main(){ float t = clamp(vT / 10.0 + 0.5, 0.0, 1.0); float a = k * pow(vF, 1.5) * smoothstep(1.0, 0.55, t) * smoothstep(0.0, 0.35, t) * (0.75 + 0.25 * sin(t * 40.0 - time * 30.0)); gl_FragColor = vec4(vec3(1.0, 0.97, 0.92), a * 0.7); }`,
  transparent: true, depthWrite: false, side: THREE.DoubleSide,
});
const vaporGeo = new THREE.ConeGeometry(6.5, 10, 40, 1, true);
const vapor = new THREE.Mesh(vaporGeo, vaporMat);
vapor.rotation.x = Math.PI / 2; // apex (+y) -> -z? we want apex forward
vapor.rotation.x = -Math.PI / 2;
vapor.position.set(0, 0.2, -0.5);
vapor.renderOrder = 13;
ship.userData.body.add(vapor);

// ---------- particles / fx ----------
const dust = new ParticlePool(3000, dustTex, false);
const glow = new ParticlePool(700, glowTex, true);
dust.mesh.renderOrder = 6; glow.mesh.renderOrder = 8;
scene.add(dust.mesh, glow.mesh);
const streaks = new Streaks(170);
scene.add(streaks.mesh);
const shock = new Shockwaves(scene);
// ambient floating specks
const SPECKS = 700;
const speckGeo = new THREE.BufferGeometry();
const speckPos = new Float32Array(SPECKS * 3);
for (let i = 0; i < speckPos.length; i++) speckPos[i] = (Math.random() - 0.5) * 160;
speckGeo.setAttribute('position', new THREE.BufferAttribute(speckPos, 3).setUsage(THREE.DynamicDrawUsage));
const speckMat = new THREE.PointsMaterial({ size: 0.35, map: glowTex, color: new THREE.Color().setRGB(1.0, 0.75, 0.48, LIN), transparent: true, opacity: 0.7, depthWrite: false, sizeAttenuation: true });
const specks = new THREE.Points(speckGeo, speckMat);
specks.frustumCulled = false; specks.renderOrder = 7;
scene.add(specks);
// debris
const debrisGeo = new THREE.TetrahedronGeometry(1, 0);
const debrisMat = new THREE.MeshStandardMaterial({ color: 0x222226, metalness: 0.5, roughness: 0.5, flatShading: true, emissive: new THREE.Color(1, 0.35, 0.05), emissiveIntensity: 1 });
const debris = [];
for (let i = 0; i < 28; i++) { const m = new THREE.Mesh(debrisGeo, debrisMat); m.visible = false; m.castShadow = true; scene.add(m); debris.push({ m, v: new THREE.Vector3(), w: new THREE.Vector3() }); }

// ---------- audio / input ----------
const audio = new GameAudio();
const controls = new Controls();
const isUI = (t) => !!(t && t.closest && t.closest('button, .ui'));
controls.attachPointer(window, isUI);
const pitchLabels = ['Tilt pitch: normal', 'Tilt pitch: inverted', 'Tilt pitch: off'];
$('pitchBtn').textContent = pitchLabels[controls.pitchMode];
$('pitchBtn').addEventListener('click', (e) => { e.stopPropagation(); controls.setPitchMode((controls.pitchMode + 1) % 3); $('pitchBtn').textContent = pitchLabels[controls.pitchMode]; });
$('apBtn').addEventListener('click', (e) => { e.stopPropagation(); if (S.mode === 'playing') setAutopilot(!S.autopilot); });
$('safeBtn').addEventListener('click', (e) => { e.stopPropagation(); setSafe(!safeMode); pop(safeMode ? 'SAFE MODE ON · SCORE x0.6' : 'SAFE MODE OFF', 'banked'); });
$('safeChip').addEventListener('click', (e) => { e.stopPropagation(); setSafe(!safeMode); });
$('recal').addEventListener('click', (e) => { e.stopPropagation(); controls.calibrate(0.05); pop('LEVEL SET', 'close'); });

// prevent scrolling / zoom / iOS gestures
document.addEventListener('touchmove', (e) => { e.preventDefault(); }, { passive: false });
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- game state ----------
const S = {
  mode: 'attract', pos: new THREE.Vector3(0, 30, 0), heading: 0, pitch: 0, roll: 0, steerS: 0,
  speed: 900 / 3.6, prevSpeed: 900 / 3.6, vel: new THREE.Vector3(), score: 0, combo: 0, comboT: 0, skimT: 0, skimAcc: 0, maxCombo: 0, bestBeaten: false, dist: 0, best: +(localStorage.getItem('canyon.best') || 0), bestDist: +(localStorage.getItem('canyon.bestDist') || 0),
  boost: 0, boomArmed: true, crashT: 0, t: 0, shake: 0, storm: { k: 0, target: 0, next: 38 + Math.random() * 20, dur: 0 },
  camYaw: 0, camPitch: 0, camY: 35, fov: 60, agl: 30, autopilot: false, noCollide: false, hintT: 0, spawnAcc: { kick: 0, trail: 0, storm: 0, amb: 0, ember: 0 },
};
window.__game = { S, controls, quality, renderer, scene, dust, glow, grass, chunks, get gdust() { return gdust; }, get world() { return world; } };

function fmtTime(t) { const m = Math.floor(t / 60), sec = Math.floor(t % 60); return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0'); }
function pop(text, cls = '') {
  const d = document.createElement('div'); d.className = 'pop ' + cls; d.textContent = text;
  const P = $('pops'); for (const q of P.children) if (q.textContent === text) return; P.appendChild(d); while (P.childElementCount > 3) P.firstElementChild.remove(); setTimeout(() => d.remove(), 1350); // max 3 stacked, no duplicates
}
let flashV = 0;
function flash(v) { flashV = Math.max(flashV, v); }

const todayKey = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const dailySeed = () => { let h = 2166136261; for (const c of 'canyon-' + todayKey()) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
let daily = false;
function refreshModeUI() {
  $('modeChip').textContent = daily ? 'Mode: Daily ' + todayKey() : 'Mode: Endless';
  const db = +(localStorage.getItem('canyon.daily.' + todayKey()) || 0);
  $('modeChip').title = 'Daily best: ' + db;
}
function resetRun(mode) {
  S.mode = mode;
  if (typeof resetMissiles === 'function' && misPool.length) resetMissiles();
  controls.altTarget = 30;
  S.seed = params.has('seed') ? +params.get('seed') : daily && mode === 'playing' ? dailySeed() : (Math.random() * 1e9) | 0;
  RX.air = rxGenAir(S.seed); // before any chunk is built: base pads level the terrain
  resetWorld(S.seed);
  S.pos.set(world.pathX(0), world.surface(world.pathX(0), 0) + (TEST && params.get('alt') ? +params.get('alt') + 2 : 30), 0);
  S.heading = 0; S.pitch = 0; S.roll = 0; S.steerS = 0;
  S.speed = S.prevSpeed = Math.min(thrKmh(controls.throttle) / 3.6, S.autopilot ? 2000 / 3.6 : 1e9);
  S.time = 0; S.topKmh = 0; S.nearMisses = 0; S.assist = 0; S.safeEs = null; S.safeEp = null; S.apSteer = 0;
  S.score = 0; S.combo = 0; S.comboT = 0; S.skimT = 0; S.skimAcc = 0; S.maxCombo = 0; S.bestBeaten = false; S.dist = 0; S.lastDist = 0; S.boost = 0; S.boomArmed = S.speed * 3.6 < MACH_KMH; S.crashT = 0;
  S.camYaw = 0; S.camY = S.pos.y; S.storm.k = 0;
  S.hp = { L: 100, R: 100, B: 100 }; S.noContactT = 0; S.scrapeCool = 0; S.scrapes = 0; S.crashCause = '';
  S.wx = { events: makeSchedule(daily && mode === 'playing' ? makeRng(S.seed ^ 0x5bd1e995) : Math.random), cur: null, type: null, k: 0, flash: 0, boltT: 0, nextBolt: 2, rainK: 0, hailK: 0, fogK: 0, anyK: 0 };
  rxReset();
  ship.visible = true;
  for (const d of debris) d.m.visible = false;
  dust.clear(); glow.clear(); shock.clear(); gdust.clear();
  $('storm').classList.remove('on');
}

function startGame() {
  audio.init();
  controls.requestTilt().then((r) => {
    if (r !== 'granted' && matchMedia('(pointer: coarse)').matches) pop('TILT OFF · DRAG TO STEER', 'close');
  });
  const de = document.documentElement;
  try { const rf = de.requestFullscreen || de.webkitRequestFullscreen; if (rf && !document.fullscreenElement) { const p = rf.call(de, { navigationUI: 'hide' }); if (p && p.catch) p.catch(() => {}); } } catch (e) { /* iPhone Safari: no fullscreen API */ }
  try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); } catch (e) { /* ignore */ }
  if (!TEST) controls.throttle = 0.35;
  resetRun('playing');
  controls.enabled = true;
  controls.calibrate(0.3);
  $('start').classList.add('hidden'); $('crash').classList.add('hidden'); $('hud').classList.remove('hidden');
  S.hintUntil = performance.now() + 4000;
  const coarse = matchMedia('(pointer: coarse)').matches;
  S.tut = localStorage.getItem('canyon.tut') ? [] : (coarse ? [[0.3, 'Drag left / right to steer · finger height sets altitude'], [4.5, 'Finger low = skim the ground · high = 500 m safe band'], [8.7, 'Right slider = throttle · draw a half-circle to roll'], [12.9, 'Skim low & shave past rocks for combos'], [17.1, 'AUTO / SAFE / GOD buttons if you need help']]
    : [[0.3, 'A / D or ← / → to steer'], [4.5, '↑ / ↓ to climb / dive'], [8.7, 'W / S, drag or scroll to throttle'], [12.9, 'Skim low & shave past rocks for combos'], [17.1, 'R = barrel roll · AUTO / SAFE buttons if you need help']]);
  setTimeout(() => { if (!controls.hasTilt && matchMedia('(pointer: coarse)').matches) $('hint').textContent = 'Drag left / right to steer · finger height = altitude'; }, 1500);
}
$('start').addEventListener('click', startGame);
$('crash').addEventListener('click', () => { if (S.crashT > 0.5) startGame(); });
addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.code !== 'Enter') return;
  if (S.mode === 'attract') startGame(); else if (S.mode === 'crashed' && S.crashT > 0.5) startGame();
});

function crash() {
  if (S.mode !== 'playing') return;
  if (RX.god) { S.engineFail = false; S.fallSeq = false; S.crashCause = ''; S.hp.L = S.hp.R = S.hp.B = 100; return; } // GOD MODE: nothing ends the run
  if (!RX.xsurv && !S.engineFail && !S.car && !RX.blast && S.agl > 6 && !params.has('instantcrash')) { // unprotected impact: airframe breaks up and falls before the result screen
    S.engineFail = true; S.fallSeq = true; S.fallV = 0; flash(0.6); S.shake = 2; audio.explode(); airburst(S.pos.clone());
    pop((S.crashCause || 'IMPACT') + ' · GOING DOWN', 'close'); return;
  }
  if (RX.xsurv && !S.engineFail) { // X SURVIVAL: absorb water / rock impacts
    const g = world.surface(S.pos.x, S.pos.z); S.pos.y = Math.max(S.pos.y, g + 18); S.pitch = Math.max(S.pitch, 0.15);
    for (const k of ['L', 'R', 'B']) S.hp[k] = Math.max(S.hp[k], 40); flash(0.4); S.shake = 1.5; audio.scrape(1);
    S.xSaves = (S.xSaves || 0) + 1; if (S.t - (S.xPopT || -9) > 1) { S.xPopT = S.t; pop('X SURVIVAL · IMPACT ABSORBED', 'close'); } return;
  }
  S.mode = 'crashed'; S.crashT = 0;
  endRide(); RX.blast = null; S.land = null;
  controls.enabled = false;
  ship.visible = false;
  const p = S.pos;
  audio.explode();
  flash(0.9); S.shake = 2.5;
  for (let i = 0; i < 90; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(20 + Math.random() * 60).addScaledVector(S.vel, 0.15);
    const c = Math.random();
    glow.spawn(p.x, p.y, p.z, v.x, v.y, v.z, 0.6 + Math.random() * 0.9, 3 + Math.random() * 4, 14 + Math.random() * 18, 0.9, 1.0, 0.45 + c * 0.35, 0.12 + c * 0.1, 2.2, 6);
  }
  for (let i = 0; i < 70; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(8 + Math.random() * 30).addScaledVector(S.vel, 0.1);
    const g = 0.12 + Math.random() * 0.12;
    dust.spawn(p.x, p.y, p.z, v.x, v.y + 6, v.z, 2.5 + Math.random() * 3, 6, 34 + Math.random() * 30, 0.75, g * 1.4, g, g * 0.7, 1.2, 3);
  }
  for (const d of debris) {
    d.m.visible = true; d.m.position.copy(p); d.m.scale.setScalar(0.3 + Math.random() * 0.9);
    d.v.randomDirection().multiplyScalar(25 + Math.random() * 50).addScaledVector(S.vel, 0.25); d.v.y = Math.abs(d.v.y) + 10;
    d.w.set(Math.random() * 10, Math.random() * 10, Math.random() * 10);
  }
  shock.spawn(p, new THREE.Vector3(0, 1, 0), 70, 1.0, new THREE.Color(1, 0.7, 0.4), 0.9);
  const score = Math.floor(S.score);
  if (daily) {
    const key = 'canyon.daily.' + todayKey(), db = +(localStorage.getItem(key) || 0);
    if (score > db) localStorage.setItem(key, String(score));
    $('dailyRes').textContent = 'DAILY ' + todayKey() + ' · today\'s best ' + Math.max(db, score).toLocaleString('en-US') + (score > db ? ' (NEW!)' : '');
  } else $('dailyRes').textContent = '';
  const nb = score > S.best && score > 0;
  if (nb) { S.best = score; localStorage.setItem('canyon.best', String(score)); }
  if (S.dist > S.bestDist) { S.bestDist = S.dist; localStorage.setItem('canyon.bestDist', String(Math.floor(S.dist))); }
  $('cCombo').textContent = 'x' + comboMult(S.maxCombo).toFixed(1);
  $('cCause').textContent = S.crashCause || 'HULL BREACH'; $('cScr').textContent = S.scrapes || 0;
  const life = (+localStorage.getItem('canyon.totalKm') || 0) + S.dist / 1000;
  localStorage.setItem('canyon.totalKm', life.toFixed(3));
  $('cTime').textContent = fmtTime(S.time);
  $('cTop').textContent = Math.round(S.topKmh).toLocaleString('en-US') + ' km/h · ' + (S.topKmh / 3.6).toFixed(1) + ' m/s';
  const avg = S.time > 0 ? Math.min(S.dist / S.time, S.topKmh / 3.6) : 0;
  $('cAvg').textContent = Math.round(avg * 3.6).toLocaleString('en-US') + ' km/h · ' + avg.toFixed(1) + ' m/s';
  $('cNear').textContent = S.nearMisses;
  $('cLife').textContent = life.toFixed(1) + ' km';
  $('lifeStart').textContent = 'Lifetime: ' + life.toFixed(1) + ' km flown';
  refreshSkinUI();
  $('cScore').textContent = score.toLocaleString();
  $('cDist').textContent = (S.dist / 1000).toFixed(2) + ' km';
  if (S.autopilot) setAutopilot(false, true);
  $('cBest').textContent = S.best.toLocaleString();
  $('newBest').classList.toggle('hidden', !nb);
  setTimeout(() => { if (S.mode === 'crashed') { $('crash').classList.remove('hidden'); $('hud').classList.add('hidden'); } }, 1000);
}

// ---------- simulation ----------
const _sunV = new THREE.Vector3(), _fwd = new THREE.Vector3(), _v = new THREE.Vector3(), _w = new THREE.Vector3(), _probe = new THREE.Vector3();

// ---------- trajectory prediction (shared by autopilot & safe mode) ----------
const nearObs = [];
function gatherObstacles() {
  nearObs.length = 0;
  const cur = Math.floor(-S.pos.z / CHUNK_L);
  for (let i = cur - 1; i <= cur + 6; i++) {
    const ch = chunks.get(i); if (!ch) continue;
    for (const o of ch.objs) {
      if (o.dead) continue;
      if (RX.ice && (o.type === 'tree' || o.type === 'jtree')) continue; // Ice Age: no vegetation
      if (o.type === 'boulder' && o.r < 3) continue;
      if (Math.abs(o.x - S.pos.x) > 900) continue;
      nearObs.push(o);
    }
  }
}
// simulate the flight model forward; returns time of first predicted impact (or Infinity) + end state
const PR = { hit: Infinity, x: 0, y: 0, z: 0, minClr: 0 };
function predict(steer, pitchIn, T, steps, margin = 3.5) {
  let x = S.pos.x, y = S.pos.y, z = S.pos.z, h = S.heading, st = S.steerS, pt = S.pitch;
  const dt = T / steps, spdN = spdNf(S.speed), sp = S.speed;
  PR.hit = Infinity; PR.minClr = 1e9; SIM.ab = RX.above; RX.lastSimRoof = false; RX.inSim = true;
  for (let i = 1; i <= steps; i++) {
    st += (steer - st) * (1 - Math.exp(-9 * dt));
    h -= (0.62 + 0.9 * spdN) * st * dt; h = clamp(h, -1.15, 1.15);
    pt += (pitchIn * 0.3 - pt) * (1 - Math.exp(-5 * dt));
    const vy = clamp(Math.sin(pt) * sp, -130, 130);
    const pz = z, py = y, px = x;
    x += -Math.sin(h) * Math.cos(pt) * sp * dt; z += -Math.cos(h) * Math.cos(pt) * sp * dt; y = rxSimY(Math.min(y + vy * dt, CEILING), z, pz, py, x, px);
    if (SIM.hit) RX.lastSimRoof = true;
    const clr = y - world.surface(x, z);
    if (clr < PR.minClr) PR.minClr = clr;
    let hit = clr < margin || SIM.hit;
    if (!hit) for (const o of nearObs) {
      if (o.dead) continue;
      if (o.type === 'boulder') { const dx = x - o.x, dz = z - o.z, dy = o.falling ? 0 : y - o.y; if (dx * dx + dz * dz + dy * dy < (o.r + 8) * (o.r + 8)) { hit = true; break; } continue; }
      const r = radiusAt(o, y - 1.5); if (r < 0) continue;
      const dx = x - o.x, dz = z - o.z, rr = r + 8.5;
      if (dx * dx + dz * dz < rr * rr) { hit = true; break; }
    }
    if (hit) { PR.hit = i * dt; break; }
  }
  RX.inSim = false;
  PR.x = x; PR.y = y; PR.z = z;
  return PR;
}
// ---------- AUTOPILOT: sampling planner ----------
// Every frame: bucket all obstacles within the look-ahead into a 2D grid, then simulate a fan of
// 13 steer x 7 pitch candidates (incl. an altitude-hold profile) over a speed-scaled horizon (2.4-3.8 s),
// checking terrain under the nose AND both wingtips (roll-aware) plus every obstacle's real profile.
// Candidates are scored by clearance / altitude / smoothness; if nothing is safe the throttle is cut.
const AP = { cell: 40, grid: new Map(), thrCap: 1, steer: 0, pitch: 0, stats: { saves: 0, noSafe: 0, frames: 0, minClr: 1e9, minObs: 1e9, minTer: 1e9, lastSave: null } };
const AP_HALF = 7.6, AP_LOW = 2.6, AP_TOP = 1.4;
const AP_STEERS = [-1, -0.75, -0.5, -0.3, -0.12, 0, 0.12, 0.3, 0.5, 0.75, 1];
const AP_PITCHES = [null, -0.5, 0, 0.45, 1];
const AP_STEERS_LITE = [-0.6, -0.3, 0, 0.3, 0.6], AP_PITCHES_LITE = [null];
function obsBound(o) {
  if (o.type === 'spire') return [o.r * 0.92, o.y + o.h];
  if (o.type === 'tree') return [o.r * 0.9 + 0.3, o.y + o.h];
  if (o.type === 'jtree') return [o.r * 0.8 + 0.6, o.y + o.h];
  if (o.type === 'boulder') return [o.r * 1.15, o.y + o.r * 1.0];
  return [o.r * 1.25, o.y + o.h];
}
const apKey = (ix, iz) => (ix + 2048) * 4194304 + (iz + 2097152);
function buildApGrid(L) {
  const g = AP.grid, C = AP.cell; g.clear();
  const cur = Math.floor(-S.pos.z / CHUNK_L), last = cur + Math.ceil(L / CHUNK_L) + 1;
  for (let i = cur - 1; i <= last; i++) {
    const ch = chunks.get(i); if (!ch) continue;
    for (const o of ch.objs) {
      if (o.dead) continue;
      if (o.z > S.pos.z + 120 || o.z < S.pos.z - L - 150 || Math.abs(o.x - S.pos.x) > L * 0.9 + 150) continue;
      const b = obsBound(o); o._rb = b[0]; o._top = b[1];
      const R = b[0] + AP_HALF + 14 + 24; // +24: segment queries use the midpoint cell
      const x0 = Math.floor((o.x - R) / C), x1 = Math.floor((o.x + R) / C), z0 = Math.floor((o.z - R) / C), z1 = Math.floor((o.z + R) / C);
      for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) { const k = apKey(ix, iz); let a = g.get(k); if (!a) g.set(k, a = []); a.push(o); }
    }
  }
}
// clearance (m) from the ship's hit-box (wings, fins, canopy) to obstacles & terrain at a pose
const APC = { obs: 0, ter: 0 };
function apClearance(x, y, z, h, roll, px = x, pz = z) {
  const sr = Math.abs(Math.sin(roll)), lo = y - AP_LOW - AP_HALF * sr, hi = y + AP_TOP + AP_HALF * sr;
  // terrain: nose/belly + both wingtips (lateral = perpendicular to heading)
  const lx = Math.cos(h) * AP_HALF, lz = -Math.sin(h) * AP_HALF, tipDy = AP_HALF * Math.sin(roll);
  const tc = Math.min(y - AP_LOW - world.surface(x, z), y - tipDy - AP_LOW - world.surface(x + lx, z + lz), y + tipDy - AP_LOW - world.surface(x - lx, z - lz));
  let oc = 1e9;
  // obstacles: exact closest approach along the segment travelled since the previous sample (no gaps between samples)
  const sx = x - px, sz = z - pz, sl = sx * sx + sz * sz;
  const a = AP.grid.get(apKey(Math.floor((x + px) * 0.5 / AP.cell), Math.floor((z + pz) * 0.5 / AP.cell)));
  if (a) for (const o of a) {
    let u = sl > 0 ? ((o.x - px) * sx + (o.z - pz) * sz) / sl : 1; u = u < 0 ? 0 : u > 1 ? 1 : u;
    const dx = px + sx * u - o.x, dz = pz + sz * u - o.z, d = Math.sqrt(dx * dx + dz * dz);
    const hc = d - o._rb - AP_HALF;
    if (hc > oc) continue;
    let c;
    if (lo > o._top && o._top < CEILING - 25) c = Math.max(hc, lo - o._top); // tops near the ceiling must be flown around, never over
    else if (o.type === 'boulder') c = hc;
    else {
      // widest part of the obstacle across the ship's vertical extent
      let r = Math.max(radiusAt(o, Math.max(lo, o.y + 0.01)), radiusAt(o, Math.min(hi, o._top - 0.01)), radiusAt(o, clamp(y, o.y + 0.01, o._top - 0.01)));
      if (o.type === 'jtree') r = Math.max(r, radiusAt(o, o.y + o.h * 0.72));
      c = d - Math.max(r, 0.5) - AP_HALF;
      if (hi < o.y) c = Math.max(c, o.y - hi);
    }
    if (c < oc) { oc = c; APC.o = o; }
  }
  for (const g of RX.geysers) { const dx = x - g.x, dz = z - g.z, c = Math.sqrt(dx * dx + dz * dz) - 48 - AP_HALF; if (y < g.yg + g.top && c < oc) { oc = c; APC.o = null; } }
  APC.obs = oc; APC.ter = tc;
  return Math.min(oc, tc);
}
const APR = { hit: Infinity, minClr: 0, devA: 0, x: 0, y: 0, z: 0 };
function apSim(steer, pitchIn, T, n, agl, margin) {
  let x = S.pos.x, y = S.pos.y, z = S.pos.z, h = S.heading, st = S.steerS, pt = S.pitch, roll = S.roll;
  const dt = T / n, spdN = spdNf(S.speed), sp = S.speed;
  APR.hit = Infinity; APR.minClr = 1e9; APR.devA = 0; SIM.ab = RX.above; RX.inSim = true;
  const ks = 1 - Math.exp(-9 * dt), kp = 1 - Math.exp(-5 * dt), kr = 1 - Math.exp(-7 * dt);
  let ap = AP.steer, apP = AP.pitch; const ka = 1 - Math.exp(-(AP.tight ? 30 : 10) * dt);
  for (let i = 1; i <= n; i++) {
    ap += (steer - ap) * ka; st += (ap - st) * ks;
    h -= (0.62 + 0.9 * spdN) * st * dt; h = clamp(h, -1.15, 1.15);
    roll += (-st * 1.05 - roll) * kr;
    let pin = pitchIn;
    if (pin === null) { // altitude-hold profile: aim for agl above the highest ground ~1.2 s ahead
      const L = sp * 1.2, g2 = Math.max(world.surface(x, z), world.surface(x - Math.sin(h) * L * 0.5, z - Math.cos(h) * L * 0.5), world.surface(x - Math.sin(h) * L, z - Math.cos(h) * L));
      pin = clamp((g2 + agl - y) * 0.05, -0.8, 1);
    }
    apP += (pin - apP) * ka; pt += (apP * 0.3 - pt) * kp;
    const vy = clamp(Math.sin(pt) * sp, -130, 130);
    const px = x, pz = z, py = y;
    x += -Math.sin(h) * Math.cos(pt) * sp * dt; z += -Math.cos(h) * Math.cos(pt) * sp * dt; y = rxSimY(Math.min(y + vy * dt, CEILING), z, pz, py, x, px);
    const c = SIM.hit ? -10 : apClearance(x, y, z, h, roll, px, pz);
    if (c < APR.minClr) APR.minClr = c;
    APR.devA += Math.abs(y - world.surface(x, z) - agl);
    if (c < margin && APR.hit === Infinity) APR.hit = i * dt;
  }
  RX.inSim = false;
  APR.devA /= n; APR.x = x; APR.y = y; APR.z = z;
  return APR;
}
function autopilotInput(dt = 1 / 60) {
  const agl = +params.get('alt') || 20;
  const sp = S.speed;
  // horizon: >= 2.4 s, but distance-capped to the generated world (1.5-2.6 km at hypersonic speed)
  const T = Math.min(clamp(3.6 * sp / 622, 2.4, 3.8), Math.max(Math.max(2600, (AHEAD - 1) * CHUNK_L - 1200) / Math.max(sp, 1), 0.6)), L = sp * T + 60;
  buildApGrid(L);
  const margin = Math.min(5 + sp * 0.006, sp > 2600 ? 26 : 14); // on top of the wing hit-box
  const n = clamp(Math.ceil(L / 40), 12, sp > 2600 ? 72 : 48);
  const now = apClearance(S.pos.x, S.pos.y, S.pos.z, S.heading, S.roll);
  const st = AP.stats; st.frames++;
  if (now < st.minClr) st.minAt = { clr: +now.toFixed(2), type: APC.obs < APC.ter && APC.o ? APC.o.type : 'terrain', r: APC.o ? +APC.o.r.toFixed(1) : 0, kmh: Math.round(sp * 3.6), biome: E.main, agl: Math.round(S.agl), steer: +S.steerS.toFixed(2) };
  st.minClr = Math.min(st.minClr, now); st.minObs = Math.min(st.minObs, APC.obs); st.minTer = Math.min(st.minTer, APC.ter);
  if (params.has('hug')) { // legacy terrain-hugging test mode (screenshots)
    const pitch = clamp((world.surface(S.pos.x, S.pos.z) + agl - S.pos.y) * 0.15 - S.vel.y * 0.02, -0.7, 1);
    AP.steer = damp(AP.steer, 0, 5, dt); return { steer: AP.steer, pitch };
  }
  AP.acc = (AP.acc || 0) + dt;
  if (AP.best && AP.acc < 1 / 60 && !AP.tight) return { steer: AP.steer = damp(AP.steer, AP.best[0], 10, dt), pitch: AP.pitch };
  AP.acc = 0;
  let best = null, bestCost = Infinity, bestHit = Infinity, bestClr = 0;
  // full 13x7 fan when anything is close (or every 4th frame); otherwise a lighter 7x4 fan to save CPU
  const full = AP.tight || (st.frames & 1) === 0;
  const PS = full ? AP_PITCHES : AP_PITCHES_LITE, SS = full ? AP_STEERS : AP_STEERS_LITE;
  for (const pi of PS) for (const s of SS) {
    const r = apSim(s, pi, T, n, agl, margin);
    const cx = world.pathX(r.z);
    const pv = pi === null ? 0.15 : pi;
    let cost = r.hit < Infinity ? 1e5 + (T - r.hit) * 1e4 - r.minClr : 0;
    const off = Math.abs(r.x - cx);
    cost += -Math.min(r.minClr, margin * 2) * 3 + r.devA * 1.4 + off * 0.03 + Math.max(0, off - 120) * 0.4 + Math.max(0, r.y - (CEILING - 90)) * 1.5 + Math.max(0, r.y - (CEILING - 40)) * 4
      + Math.abs(s - AP.steer) * 4 + Math.abs(pv - AP.pitch) * 3 + Math.abs(s) * 0.8 + (pi === null ? 0 : pi > 0 ? 40 + pi * 120 : 15); // fly low: climbing is the last resort
    if (cost < bestCost) { bestCost = cost; best = [s, pi]; bestHit = r.hit; bestClr = r.minClr; }
    if (r.hit === Infinity && pi === null && Math.abs(s) < 0.01 && r.minClr > margin * 3 && !AP.tight) break; // early-out: straight & level is wide open
  }
  AP.tight = bestHit < Infinity || bestClr < margin * 4;
  // throttle governor: no safe candidate (or thin margins) -> bleed speed; recover slowly when clear
  if (bestHit < Infinity) { AP.thrCap = Math.max(0, AP.thrCap - 3 * dt); st.noSafe++; }
  else if (bestClr < margin * 1.6) AP.thrCap = Math.max(0.15, AP.thrCap - 0.4 * dt);
  else AP.thrCap = Math.min(1, AP.thrCap + (0.12 - 0.07 * AP.thrCap) * dt * MAX_KMH / TOP_KMH);
  if (TEST && window.__apNoGov) AP.thrCap = 1; // stress-test hook: autopilot at full throttle // ULTRA: earn speed back slower // slower recovery near top speed
  AP.best = best;
  let pitch = best[1];
  if (pitch === null) { const L2 = sp * 1.2, h = S.heading, g2 = Math.max(world.surface(S.pos.x, S.pos.z), world.surface(S.pos.x - Math.sin(h) * L2 * 0.5, S.pos.z - Math.cos(h) * L2 * 0.5), world.surface(S.pos.x - Math.sin(h) * L2, S.pos.z - Math.cos(h) * L2)); pitch = clamp((g2 + agl - S.pos.y) * 0.05, -0.8, 1); }
  // emergency: imminent terrain contact -> full climb regardless of plan
  if (APC.ter < margin * 0.6) pitch = 1;
  const urgent = bestHit < Infinity || bestClr < margin * 1.5;
  { const want = damp(AP.steer, best[0], urgent ? 30 : 8, dt), mx = (urgent ? 6 : 2.2) * dt; AP.steer = AP.steer + clamp(want - AP.steer, -mx, mx); }
  AP.pitch = damp(AP.pitch, pitch, urgent ? 30 : 12, dt);
  return { steer: AP.steer, pitch: AP.pitch };
}
// SAFE MODE: predict 1.5-2.5 s ahead; if an impact is coming, blend in the nearest safe input
function safeAssist(steer, pitchIn, dt) {
  const T = clamp(1.5 + S.speed / 622, 1.5, 2.5);
  const r = predict(steer, pitchIn, T, 14, 4);
  let target = 0, es = steer, ep = pitchIn;
  S.safeHit = r.hit;
  if (r.hit < Infinity) {
    let bestCost = Infinity;
    for (const st of [-1, -0.5, 0, 0.5, 1]) for (const pi of [pitchIn, 0.5, 1]) {
      const q = predict(st, pi, T, 10, 4);
      const cost = (q.hit < Infinity ? 100 * (T - q.hit) : 0) + Math.abs(st - steer) + Math.abs(pi - pitchIn) * 0.6;
      if (cost < bestCost) { bestCost = cost; es = st; ep = pi; }
    }
    target = clamp(1.4 - r.hit / T, 0.5, 1);
    S.safeEs = es; S.safeEp = ep;
    if (S.t - (S.safeWarnT || -9) > 1.2) { S.safeWarnT = S.t; audio.warn(); const el = $('safeInd'); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  }
  S.assist = damp(S.assist || 0, target, target > (S.assist || 0) ? 14 : 3, dt);
  const k = S.assist;
  return { steer: lerp(steer, S.safeEs ?? steer, k), pitch: lerp(pitchIn, S.safeEp ?? pitchIn, k) };
}
function holdTargetY(T, sp, dx, dz, px = S.pos.x, pz = S.pos.z) {
  const fl = Math.max(world.height0(world.pathX(pz), pz), 0); const now = S.t || 0, fdt = clamp(now - (S.floorT ?? now), 0, 0.5); S.floorT = now; S.floorRef = S.floorRef === undefined || Math.abs(S.floorRef - fl) > 2000 ? fl : S.floorRef + (fl - S.floorRef) * (1 - Math.exp(-fdt * 0.25)); // very slow, smooth
  let gA = world.surface(px, pz); for (const t of [0.1, 0.25, 0.5, 0.8, 1.2, 1.8, 2.5]) { const d = Math.min(sp * t, 5000); gA = Math.max(gA, world.surface(px + dx * d, pz + dz * d) - t * 6); } // early, gentle climbs over what's ahead
  if (controls.terrainFollow || T >= SAFE_AGL - 5) { S.tfOn = !(T >= SAFE_AGL - 5) || !!controls.terrainFollow; let g2 = -1e9; for (const t of [0.035, 0.07, 0.12]) { const d = Math.max(sp * t, 25); g2 = Math.max(g2, world.surface(px + dx * d, pz + dz * d)); } return g2 + T; }
  let y = S.floorRef + T; const clr = Math.min(25, T + 4);
  if (gA + clr > y) { y = gA + clr; S.tfOn = true; } // only to avoid the ground
  const gU = world.surface(px, pz); if (y > gU + MAX_AGL - 4) y = gU + MAX_AGL - 4; // 500 m cap, approached smoothly
  return y;
}
function dbgUpdate() { if (!RX.debug) return; const c = controls, el = $('dbg'); if ((RX.dbgT = (RX.dbgT || 0) + 1) % 8) return; const f = (v, n = 2) => (v === undefined || v === null ? '-' : (+v).toFixed(n));
  const dv = c.drags ? [...c.drags.values()].map((q) => q.kind).join(',') : '';
  el.textContent = ['STEER cmd ' + f(S.steerIn) + '  smoothed ' + f(S.steerS) + '  src ' + S.cmdSrc, 'input: swipe ' + f(c.swS && c.swS[0]) + ' tilt ' + f(c.tiltSteer) + ' (' + (c.tiltOn ? 'ON' : 'off') + (c.hasTilt ? ', sensor live' : ', no sensor') + ') keys ' + f(c._kx) + ' touch ' + f(c.touchSteer),
    'drags [' + dv + ']  fingerT ' + f(c.fingerT, 0) + '  altTarget ' + f(c.altTarget, 0) + ' m  fingerH ' + (c.fingerHeight ? 'on' : 'off'),
    'PITCH cmd ' + f(S.pitchIn) + '  pitch ' + f(S.pitch, 3) + '  vy ' + f(S.vel && S.vel.y, 0) + '  vyT ' + f(S.vyT, 0) + '  hold ' + (S.holdDirect ? 'direct' : 'assist/AP') + '  ' + (S.tfOn ? 'TERRAIN FOLLOW' : 'level hold'),
    'AGL ' + f(S.agl, 0) + '  floorRef ' + f(S.floorRef, 0) + '  heading ' + f(S.heading, 4) + '  roll ' + f(S.roll, 3),
    'AP ' + (S.autopilot ? 'ON' : 'off') + '  SAFE ' + (safeMode ? 'ON' : 'off') + '  SMART ' + (RX.smart ? 'ON' : 'off') + '  FORCES ' + (RX.forces ? 'ON' : 'off') + ' jolt ' + f(RX.jolt) + '  AI ' + (RX.scanner ? 'ON' : 'off') + '  assist ' + f(S.assistT)].join('\n'); }
function inSafeBand() { return !RX.above && S.agl >= SAFE_AGL && S.mode === 'playing' && !RX.inCave; } // no SAFE band under the cavern: stalactites hang into it
function altHoldInput() { // PD hold toward the slider's terrain-relative target
  const T = controls.altTarget ?? 30, vy = S.vel ? S.vel.y : 0;
  return clamp((T - S.agl) / 45 - vy / 70, -1, 1);
}
function aileronRoll(dir) { // arc gesture: full 360 deg roll about the forward axis, heading untouched
  if (S.mode !== 'playing' || S.rollT > 0) return;
  S.rollT = S.rollDur = 1.0; S.rollDir = -dir; S.aileronRolls = (S.aileronRolls || 0) + 1; audio.whoosh(); pop(dir > 0 ? 'AILERON ROLL ▶' : '◀ AILERON ROLL', 'banked');
}
controls.onArc = (dir) => aileronRoll(dir);
function barrelRoll() {
  if (S.mode !== 'playing' || S.rollT > 0) return;
  S.rollT = S.rollDur = 0.75; S.rollDir = S.steerS > 0.1 ? -1 : 1;
  audio.whoosh();
  if (S.agl < 40) addCombo('BARREL ROLL', 120, 'close'); else pop('BARREL ROLL', 'banked');
  if (S.agl < 20) unlock('roll');
}
{
  let lastTap = 0, lx = 0, ly = 0;
  addEventListener('pointerdown', (e) => {
    if (isUI(e.target) || S.mode !== 'playing' || controls.onSlider(e.clientX)) return;
    const now = performance.now();
    if (localStorage.getItem('canyon.dtap') === '1' && now - lastTap < 300 && Math.hypot(e.clientX - lx, e.clientY - ly) < 50) { barrelRoll(); lastTap = 0; return; }
    lastTap = now; lx = e.clientX; ly = e.clientY;
  });
  addEventListener('keydown', (e) => { if (e.code === 'KeyR') barrelRoll(); });
}
// ---------- achievements ----------
const ACH = [
  ['mach1', 'Sound Barrier', 'Break Mach 1'], ['max', 'Full Burner', 'Hit 2,240 km/h'], ['k10', 'Long Haul', '10 km in one run'],
  ['k100', 'Marathon', '100 km in one run'], ['razor', 'Thread the Needle', 'RAZOR near-miss'], ['combo5', 'Combo King', 'Reach a x3.5 combo'],
  ['storm', 'Storm Chaser', 'Survive a whole thunderstorm'], ['water', 'Wave Skimmer', 'Skim 10 s over water'], ['roll', 'Show-off', 'Barrel roll below 20 m'],
  ['globe', 'Globetrotter', 'Visit all 6 biomes'],
];
const achGot = new Set(JSON.parse(localStorage.getItem('canyon.ach') || '[]'));
const biomesSeen = new Set(JSON.parse(localStorage.getItem('canyon.biomes') || '[]'));
function unlock(id) {
  if (achGot.has(id) || S.mode !== 'playing' || S.autopilot) return;
  achGot.add(id); localStorage.setItem('canyon.ach', JSON.stringify([...achGot]));
  const a = ACH.find((x) => x[0] === id);
  pop('🏆 ' + a[1].toUpperCase(), 'unlock'); pulse('big'); audio.chime();
  refreshAchUI();
}
function refreshAchUI() {
  const names = ACH.filter((a) => achGot.has(a[0])).map((a) => a[1]);
  $('achStart').textContent = '🏆 Achievements ' + achGot.size + '/' + ACH.length + (names.length ? ' · ' + names.join(', ') : ' · ' + ACH.slice(0, 3).map((a) => a[2]).join(' · '));
}
function checkAchievements(dt) {
  const kmh = S.speed * 3.6;
  if (kmh >= MACH_KMH) unlock('mach1');
  if (kmh >= MAX_KMH - 5) unlock('max');
  if (S.dist >= 10000) unlock('k10');
  if (S.dist >= 100000) unlock('k100');
  if (S.combo >= 5) unlock('combo5');
  if (hud.skim.classList.contains('on') && world.gridHeight(S.pos.x, S.pos.z) < 0) { S.waterSkim = (S.waterSkim || 0) + dt; if (S.waterSkim > 10) unlock('water'); }
  if (!biomesSeen.has(E.main)) { biomesSeen.add(E.main); localStorage.setItem('canyon.biomes', JSON.stringify([...biomesSeen])); }
  if (biomesSeen.size >= 6) unlock('globe');
}
function setAutopilot(on, quiet) {
  S.autopilot = on; $('apBtn').classList.toggle('on', on); $('apInd').classList.toggle('hidden', !on);
  if (!quiet) pop(on ? 'AUTOPILOT ENGAGED' : 'AUTOPILOT OFF', 'banked');
}
let safeMode = localStorage.getItem('canyon.safe47') === '1'; // v47: SAFE assist defaults OFF
function setSafe(on) {
  safeMode = on; localStorage.setItem('canyon.safe47', on ? '1' : '0');
  $('safeBtn').classList.toggle('on', on); $('safeChip').textContent = 'Safe mode: ' + (on ? 'ON' : 'off');
  $('safeInd').classList.toggle('hidden', !on);
}

function updateFlight(dt) {
  if (rxFlightOverride(dt)) return { thr: 0, spdN: spdNf(S.speed) };
  if (S.car && S.mode === 'playing' && carFlight(dt)) return { thr: controls.throttle, spdN: spdNf(S.speed) };
  if (RX.blast && S.mode === 'playing') {
    S.speed = BLAST_KMH / 3.6; headingFrame(S.heading); (S.prevPos || (S.prevPos = new THREE.Vector3())).copy(S.pos);
    S.pos.addScaledVector(_rf, S.speed * dt); const g = world.surface(S.pos.x, S.pos.z); S.pos.y = Math.max(damp(S.pos.y, Math.min(g + 260, CEILING - 40), 3, dt), g + 60);
    S.agl = S.pos.y - g; S.roll = damp(S.roll, 0, 6, dt); S.pitch = damp(S.pitch, 0, 6, dt); ship.position.copy(S.pos); ship.rotation.set(S.pitch, S.heading, S.roll);
    S.dist = Math.max(S.dist, -S.pos.z); S.topKmh = Math.max(S.topKmh, BLAST_KMH);
    if (!S.boom100) { S.boom100 = true; S.boom100N = (S.boom100N || 0) + 1; megaBoom(); }
    return { thr: 1, spdN: 1 };
  }
  if (S.engineFail && S.mode === 'playing') { // 7th hit: unpowered falling crash
    S.fallV = (S.fallV || 0) + 9.81 * 3 * dt; S.speed = Math.max(S.speed - 120 * dt, 60);
    headingFrame(S.heading); S.pos.addScaledVector(_rf, S.speed * dt); S.pos.y -= S.fallV * dt; S.roll += dt * 2.5; S.pitch = damp(S.pitch, -0.6, 2, dt);
    ship.position.copy(S.pos); ship.rotation.set(S.pitch, S.heading, S.roll);
    if (Math.random() < 0.8) dust.spawn(S.pos.x, S.pos.y, S.pos.z, 0, 3, 0, 2, 3, 12, 0.7, 0.1, 0.09, 0.09, 1, 1);
    const g = world.surface(S.pos.x, S.pos.z); S.agl = S.pos.y - g; S.dist = Math.max(S.dist, -S.pos.z);
    if (S.agl < 2) { if (!S.fallSeq) S.crashCause = 'ENGINE FAILURE · 7 HITS'; crash(); }
    return { thr: 0, spdN: spdNf(S.speed) };
  }
  let steer = controls.steer, pitchIn = altHoldInput(); S.holdDirect = S.mode === 'playing' && !S.autopilot && !rxForceAP(); // altitude comes from the left slider target (0-500 m AGL)
  gatherObstacles();
  if (S.mode === 'playing' && S.autopilot && !TEST && !S.apManual) { S.apOverT = (Math.abs(controls.steer) > 0.85 || Math.abs(controls.pitch) > 0.85) ? (S.apOverT || 0) + dt : 0; if (S.apOverT > 0.5) setAutopilot(false); }
  S.apManual = S.mode === 'playing' && S.autopilot && safeMode && !rxForceAP();
  if (S.apManual) { autopilotInput(S.apDt || dt); const a = safeAssist(steer, pitchIn, dt); steer = a.steer; pitchIn = a.pitch; }
  else if (S.mode === 'attract' || S.autopilot || rxForceAP()) { const a = S.apSub ? S.apLast : autopilotInput(S.apDt || dt); S.apLast = a; steer = a.steer; pitchIn = a.pitch; }
  else if (S.mode === 'playing' && (safeMode || RX.smart)) { const a = safeAssist(steer, pitchIn, dt); const act = (S.safeHit ?? Infinity) < 1.5 && (Math.abs(a.steer - steer) > 0.04 || Math.abs(a.pitch - pitchIn) > 0.04); if (act) { S.holdDirect = false; steer = a.steer; pitchIn = a.pitch; S.assistT = 0.4; } } // assist only takes over pitch when it is actively avoiding
  const thr = S.mode === 'attract' ? Math.min(0.38, AP.thrCap) : (S.autopilot || rxForceAP()) ? Math.min(controls.throttle, AP.thrCap) : controls.throttle;
  if (RX.forces && S.hp && S.mode === 'playing') steer += ((100 - S.hp.R) - (100 - S.hp.L)) * 0.0012; // REALISTIC FORCES only: subtle damage pull
  if (RX.forces) steer += RX.jolt * 0.5; // turbulence / lightning jolts only with REALISTIC FORCES
  S.steerIn = steer; S.pitchIn = pitchIn;
  S.cmdSrc = (S.autopilot || rxForceAP()) ? 'AUTOPILOT' : (S.assistT > 0 ? 'SAFE/SMART ASSIST' : (Math.abs(controls.steer) > 0.001 ? 'PLAYER' : 'NONE')) + (RX.forces && Math.abs(RX.jolt) > 0.001 ? ' + FORCES' : '');
  { const tf = $('tfInd'); if (tf) { const on = !!S.tfOn && S.mode === 'playing' && !S.autopilot; if (tf._on !== on) { tf._on = on; tf.classList.toggle('hidden', !on); } } }
  S.assistT = Math.max(0, (S.assistT || 0) - dt); { const ai = $('assistInd'); if (ai) { const on = S.assistT > 0 && S.mode === 'playing' && !S.autopilot; if (ai._on !== on) { ai._on = on; ai.classList.toggle('hidden', !on); } } }
  S.steerS = damp(S.steerS, steer, 9, dt);
  // speed
  let target = thrKmh(thr) / 3.6 * (RX.ultra ? 1 : 1 - 0.2 * (S.snowK || 0)); // ULTRA always holds its full 124,700 km/h
  if (S.boost > 0) { S.boost -= dt; target = Math.min(target + 320 / 3.6, TOP_KMH / 3.6); }
  const kmhNow = S.speed * 3.6; // accel/brake authority scales with speed (8700 km/h airframe); autopilot governor brakes hard
  const rate = RX.blast && target > S.speed ? 9000 : (target > S.speed ? (S.boost > 0 ? 700 : 360) + kmhNow * 0.12 : (300 + kmhNow * 0.3) * (S.autopilot && AP.thrCap < 0.9 ? 2.5 : 1)) / 3.6 * (RX.blast ? 1 : 1);
  S.prevSpeed = S.speed;
  S.speed += clamp(target - S.speed, -rate * dt, rate * dt);
  const spdN = spdNf(S.speed);
  // heading
  const turn = (0.62 + 0.9 * spdN) * S.steerS;
  S.heading -= turn * dt;
  const HMAX = 1.15;
  if (Math.abs(S.heading) > HMAX) S.heading = Math.sign(S.heading) * HMAX;
  // pitch
  let ptarget = pitchIn * 0.30, prate = 5, vmax = 130;
  S.tfOn = false;
  if (S.holdDirect) { // v50: altitude target = smoothed route floor + target (passive); terrain-follow only to avoid ground (or always when TERRAIN FOLLOW is on)
    const sp = Math.max(S.speed, 20), T = controls.altTarget ?? 30, dx = -Math.sin(S.heading), dz = -Math.cos(S.heading);
    vmax = clamp(90 + sp * 0.6, 90, 9000); const FOL = controls.terrainFollow || T >= SAFE_AGL - 5;
    const yT = holdTargetY(T, sp, dx, dz);
    let vyT = clamp((yT - S.pos.y) * (FOL ? 6 : 1.2), -vmax, vmax); S.vyT = vyT;
    if (!FOL) { const aM = (S.agl < 60 || vyT > S.vel.y + 200 ? 220 : 30) + sp * 0.02; S.vyCmd = (S.vyCmd ?? S.vel.y) + clamp(vyT - (S.vyCmd ?? S.vel.y), -aM * dt, aM * dt); vyT = S.vyCmd; } else S.vyCmd = S.vel.y; // vertical accel limit: smooth level hold
    ptarget = Math.asin(clamp(vyT / sp, -0.6, 0.6)); prate = FOL ? (sp > 2000 ? 45 : 10) : 30; }
  S.pitch = damp(S.pitch, ptarget, prate, dt);
  _fwd.set(-Math.sin(S.heading) * Math.cos(S.pitch), Math.sin(S.pitch), -Math.cos(S.heading) * Math.cos(S.pitch));
  S.vel.copy(_fwd).multiplyScalar(S.speed);
  if (Math.abs(S.vel.y) > vmax) S.vel.y = Math.sign(S.vel.y) * vmax;
  (S.prevPos || (S.prevPos = new THREE.Vector3())).copy(S.pos);
  if (S.holdDirect && (controls.terrainFollow || (controls.altTarget ?? 30) >= SAFE_AGL - 5) && S.speed > 2500 && !RX.blast) { // v49 high-speed terrain envelope: sub-stepped vertical tracking along the frame's path (1 frame = 150+ m)
    const T = controls.altTarget ?? 30, n = Math.min(24, Math.ceil(S.speed * dt / 40)), sdt = dt / n, vm = vmax, y0 = S.pos.y; let y = y0;
    const hx = S.vel.x * sdt, hz = S.vel.z * sdt; let px = S.pos.x, pz = S.pos.z;
    for (let i = 0; i < n; i++) { px += hx; pz += hz; const yT = true ? Math.max(world.surface(px, pz), world.surface(px + hx * 2, pz + hz * 2) - 15) + T : holdTargetY(T, S.speed, hx / Math.hypot(hx, hz), hz / Math.hypot(hx, hz), px, pz); y += clamp(yT - y, -vm * sdt * (controls.terrainFollow ? 1 : 0.15), vm * sdt * (controls.terrainFollow ? 1 : 0.6)); }
    S.pos.x = px; S.pos.z = pz; S.pos.y = y; S.vel.y = (y - y0) / dt; S.pitch = damp(S.pitch, Math.asin(clamp(S.vel.y / S.speed, -0.5, 0.5)), 10, dt);
  } else S.pos.addScaledVector(S.vel, dt);
  geyserForces(dt);
  { const gC = world.surface(S.pos.x, S.pos.z); if (!RX.above && S.pos.y > gC + MAX_AGL) { const ov = S.pos.y - gC - MAX_AGL; S.pos.y -= ov > 80 ? ov - 80 : Math.min(ov, ov * dt * 2 + 0.5); S.pitch = Math.min(S.pitch, 0.02); } } // hard cap: 500 m above the ground
  rxLayer();
  const ground = world.surface(S.pos.x, S.pos.z);
  S.agl = S.pos.y - ground;
  if ((S.mode === 'attract' || S.noCollide) && S.agl < 6) S.pos.y = ground + 6;
  S.roll = damp(S.roll, -S.steerS * 1.05 - (controls.touchSteer ? 0 : 0), 7, dt);
  ship.position.copy(S.pos);
  let rollAnim = 0;
  if (S.rollT > 0) { S.rollT -= dt; const u = 1 - Math.max(S.rollT, 0) / (S.rollDur || 0.75); rollAnim = S.rollDir * Math.PI * 2 * (u * u * (3 - 2 * u)); }
  S.gRoll = damp(S.gRoll || 0, controls.rollCmd || 0, 8, dt); // gesture roll: attitude only, heading is untouched (never a U-turn)
  ship.rotation.set(S.pitch + (S.speed - S.prevSpeed) / dt * -0.0006, S.heading + S.steerS * 0.06, S.roll + rollAnim + S.gRoll);
  S.dist = Math.max(S.dist, -S.pos.z);
  if (S.mode === 'playing' && !S.boom100 && S.speed * 3.6 >= 100000) { S.boom100 = true; S.boom100N = (S.boom100N || 0) + 1; megaBoom(); }
  if (S.mode === 'playing') { const kk = S.speed * 3.6, m = kk >= 37000 ? 3 : kk >= 5200 ? 2 : kk >= 1200 ? 1 : 0; if (m > (S.machStep || 0)) { S.machStep = m; audio.boom(); shock.spawn(S.pos.clone(), _v.copy(S.vel).normalize().clone(), 60 + m * 30, 0.6, new THREE.Color(1.2, 1.1, 1), 0.6); } else if (m < (S.machStep || 0)) S.machStep = m; }
  if (S.mode === 'playing') { S.time += dt; S.topKmh = Math.max(S.topKmh, S.speed * 3.6); }
  return { thr, spdN };
}

// ---------- damage model ----------
// returns contacts [{zone, p, n, pen}] : probe point, outward surface normal, penetration depth
const _cn = new THREE.Vector3();
function findContacts() {
  ship.updateMatrixWorld(true);
  const pts = SHIP_PROBES.map((p) => _probe.set(p[0], p[1], p[2]).applyMatrix4(ship.matrixWorld).add(RO).clone());
  const out = [];
  pts.forEach((p, k) => {
    const g = world.surface(p.x, p.z);
    if (p.y < g + 0.3) {
      const e = 2, gx = world.surface(p.x + e, p.z) - world.surface(p.x - e, p.z), gz = world.surface(p.x, p.z + e) - world.surface(p.x, p.z - e);
      out.push({ zone: PROBE_ZONE[k], p, n: new THREE.Vector3(-gx / (2 * e), 1, -gz / (2 * e)).normalize(), pen: g + 0.3 - p.y });
    }
  });
  if (RX.ghost) return out;
  const cur = Math.floor(-S.pos.z / CHUNK_L);
  for (let i = cur - 1; i <= cur + 1; i++) {
    const ch = chunks.get(i); if (!ch) continue;
    for (const o of ch.objs) {
      if (o.dead) continue;
      const dx0 = o.x - S.pos.x, dz0 = o.z - S.pos.z;
      const reach = (o.type === 'boulder' ? o.r * 1.3 : o.r * 1.5) + 10;
      if (dx0 * dx0 + dz0 * dz0 > reach * reach) continue;
      pts.forEach((p, k) => {
        if (o.type === 'boulder') {
          const cy = o.y + o.r * 0.35, dx = p.x - o.x, dy = p.y - cy, dz = p.z - o.z, R2 = o.r * o.r * 1.1, d2 = dx * dx + dy * dy * 1.6 + dz * dz;
          if (d2 < R2) out.push({ zone: PROBE_ZONE[k], p, n: new THREE.Vector3(dx, dy * 1.6, dz).normalize(), pen: Math.sqrt(R2) - Math.sqrt(d2), o });
        } else {
          const r = radiusAt(o, p.y); if (r <= 0) return;
          const dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz);
          if (d < r) {
            const zone = PROBE_ZONE[k];
            let n = new THREE.Vector3(dx / (d || 1), 0.05, dz / (d || 1)).normalize();
            // a wing clipping the side of a pillar is a glancing blow: use the lateral (sideways) normal
            if (zone === 'L' || zone === 'R') { const fx = -Math.sin(S.heading), fz = -Math.cos(S.heading), lx = -fz, lz = fx, sg = Math.sign(dx * lx + dz * lz) || 1; n.set(lx * sg, 0.05, lz * sg).normalize(); }
            out.push({ zone, p, n, pen: r - d, o });
          }
        }
      });
    }
  }
  return out;
}
const ZONE_NAME = { L: 'LEFT WING', R: 'RIGHT WING', B: 'HULL', N: 'NOSE' };
function resolveCollisions(dt) {
  if (RX.blast) return false; // BLAST shield
  if (S.car && S.car.k > 0.5) return carCollide();
  if (RX.super && S.mode === 'playing') for (const o of nearObs) { // BLACKHAWK SUPERSAFE: cut a channel through anything in the way
    if (o.dead) continue; const dx = o.x - S.pos.x, dz = o.z - S.pos.z, R = targetRadius(o) + 10;
    if (dx * dx + dz * dz < R * R && S.pos.y < (o.y || 0) + (o.h || o.r * 2) + 8) { _v.set(o.x, S.pos.y, o.z); destroyTarget(o, _v); S.superCuts = (S.superCuts || 0) + 1; }
  }
  if (S.mode === 'playing' && stalCheck()) return true;
  if (RX.god && S.mode === 'playing') return godPlow(dt);
  if (S.land) return false;
  if (rxSlabCheck()) return true;
  if (inSafeBand()) { S.safeFrames = (S.safeFrames || 0) + 1; return false; } // SAFE ALTITUDE: above every obstacle
  const hp = S.hp;
  S.noContactT += dt;
  // swept test: sub-step along this frame's motion so thin obstacles can't tunnel at low fps / high speed
  const end = S.pos.clone(), steps = Math.min(12, Math.ceil(S.prevPos.distanceTo(end) / 2.5));
  let cs = [];
  for (let i = 1; i <= steps; i++) {
    S.pos.lerpVectors(S.prevPos, end, i / steps); ship.position.copy(S.pos);
    cs = findContacts(); if (cs.length) break;
  }
  if (!cs.length) { S.pos.copy(end); ship.position.copy(end); return false; }
  _fwd.copy(S.vel).normalize();
  // deepest contact drives the response
  let c = cs[0]; for (const x of cs) if (x.pen > c.pen) c = x;
  if (S.autopilot || rxForceAP()) { // failsafe: autopilot is immune; shove the ship clear instead of damaging/crashing (logged)
    for (const x of cs) S.pos.addScaledVector(x.n, x.pen + 1.5);
    ship.position.copy(S.pos);
    AP.stats.saves++; (AP.stats.log || (AP.stats.log = [])).length < 40 && AP.stats.log.push([Math.round(-S.pos.z), Math.round(S.speed * 3.6), c.zone, E.main]); AP.stats.lastSave = { zone: c.zone, pen: +c.pen.toFixed(2), x: Math.round(S.pos.x), y: Math.round(S.pos.y), z: Math.round(S.pos.z), kmh: Math.round(S.speed * 3.6), biome: E.main };
    return false;
  }
  const impact = Math.max(0, -_fwd.dot(c.n)); // 0 = glancing, 1 = head-on
  const sp = S.speed, vn = sp * impact;
  S.lastHit = { zone: c.zone, impact: +impact.toFixed(2), pen: +c.pen.toFixed(2), n: c.n.toArray().map((v) => +v.toFixed(2)), y: +c.p.y.toFixed(1), g: +world.surface(c.p.x, c.p.z).toFixed(1) };
  const hard = (c.zone === 'N' && impact > 0.3 && sp > 60) || (c.zone === 'B' && impact > 0.42) || (impact > 0.62 && sp > 90) || c.pen > 6;
  if (hard && !safeMode) { S.crashCause = (ZONE_NAME[c.zone] || 'HULL') + ' IMPACT'; return true; }
  // scrape: damage the zone, deflect away from the surface, sparks + screech
  if (c.o) rockDamage(c.o, c.zone, impact, c.p);
  const zone = c.zone === 'N' ? 'B' : c.zone;
  const dmg = (hard ? 34 : 5 + vn * 0.22 + c.pen * 6) * (S.scrapeCool > 0 ? 0.35 : 1);
  hp[zone] = Math.max(0, hp[zone] - dmg);
  S.noContactT = 0;
  if (hard) pop('SAFE MODE · IMPACT ABSORBED', 'close');
  // push out along the normal and reflect the velocity (with energy loss)
  S.pos.addScaledVector(c.n, c.pen + 0.6); ship.position.copy(S.pos);
  const dot = _fwd.dot(c.n);
  if (dot < 0) {
    _fwd.addScaledVector(c.n, -dot * 1.35).normalize();
    S.heading = clamp(Math.atan2(-_fwd.x, -_fwd.z), -1.15, 1.15);
    S.pitch = clamp(Math.asin(clamp(_fwd.y, -1, 1)), -0.3, 0.45);
  }
  S.speed *= 1 - clamp(0.04 + impact * 0.5, 0, 0.35);
  // yaw kick away from the side that hit
  S.steerS += (zone === 'L' ? 0.9 : zone === 'R' ? -0.9 : 0);
  S.shake = Math.max(S.shake, 0.6 + impact * 1.6);
  S.combo = 0; S.comboT = 0;
  if (S.scrapeCool <= 0) {
    audio.scrape(clamp(0.6 + impact * 2, 0.6, 1.4)); flash(0.18 + impact * 0.3); pulse('big');
    pop('SCRAPE! ' + ZONE_NAME[zone] + ' ' + Math.round(hp[zone]) + '%', 'close');
    S.scrapes++;
  }
  S.scrapeCool = 0.25;
  // sparks
  const tx = S.vel.x, tz = S.vel.z;
  glow.spawn(c.p.x, c.p.y, c.p.z, S.vel.x * 0.8, 0, S.vel.z * 0.8, 0.22, 7, 2, 1, 2.6, 2.0, 1.3, 0.5, 0);
  for (const x of cs) for (let i = 0; i < 60; i++) {
    const r = Math.random();
    glow.spawn(x.p.x, x.p.y, x.p.z, tx * 0.6 + x.n.x * 30 * r + (Math.random() - 0.5) * 40, x.n.y * 25 * r + Math.random() * 18, tz * 0.6 + x.n.z * 30 * r + (Math.random() - 0.5) * 40,
      0.35 + Math.random() * 0.6, 1.2 + Math.random() * 1.4, 0.2, 1, 3.2, 2.2 + Math.random() * 0.8, 0.8 + Math.random() * 0.5, 1.2, -25); // HDR so sparks bloom past the raised threshold
  }
  for (let i = 0; i < 6; i++) dust.spawn(c.p.x, c.p.y, c.p.z, S.vel.x * 0.5, 4, S.vel.z * 0.5, 1.2, 2, 9, 0.45, 0.25, 0.23, 0.22, 1.5, 1);
  if (hp.L <= 0 || hp.R <= 0 || hp.B <= 0) { S.crashCause = (hp.B <= 0 ? 'HULL' : hp.L <= 0 ? 'LEFT WING' : 'RIGHT WING') + ' FAILURE'; return true; }
  return false;
}
function updateDamage(dt) {
  const hp = S.hp;
  S.scrapeCool -= dt;
  // regen after 10 s without contact
  if (S.noContactT > 10 && S.mode === 'playing') for (const k of ['L', 'R', 'B']) hp[k] = Math.min(100, hp[k] + 7 * dt);
  const dm = ship.userData.dmgMats;
  dm.L.opacity = clamp((100 - hp.L) / 70, 0, 1); dm.R.opacity = clamp((100 - hp.R) / 70, 0, 1);
  // heavy damage: smoke trail
  if (S.mode !== 'crashed') for (const [k, sx] of [['L', -4.8], ['R', 4.8], ['B', 0]]) {
    if (hp[k] > 45) continue;
    const sev = 1 - hp[k] / 45;
    S.smokeAcc = (S.smokeAcc || 0) + dt * (40 + 80 * sev) * quality.particles;
    while (S.smokeAcc > 1) {
      S.smokeAcc--;
      _w.set(sx + (Math.random() - 0.5), 0.2, k === 'B' ? 3 : 2.5).applyMatrix4(ship.matrixWorld).add(RO);
      const g = 0.07 + Math.random() * 0.07, back = Math.random() * dt * 0.65; // spread along this frame's path so the trail is continuous at any fps
      _w.x -= S.vel.x * back; _w.y -= S.vel.y * back; _w.z -= S.vel.z * back;
      dust.spawn(_w.x, _w.y, _w.z, S.vel.x * 0.8, S.vel.y * 0.8 + 2 + Math.random() * 3, S.vel.z * 0.8, 1.8 + Math.random() * 1.2, 3.0, 12 + 14 * sev, 0.62 + 0.3 * sev, g, g * 0.97, g * 0.95, 0.7, 2); // starts near ship speed so the plume streams off the wing instead of vanishing behind
      if (Math.random() < 0.3 * sev) glow.spawn(_w.x, _w.y, _w.z, S.vel.x * 0.5, 1, S.vel.z * 0.5, 0.25, 0.7, 0.2, 0.9, 1, 0.5, 0.15, 1, 0);
    }
  }
  const el = hud.hp; if (!el) return;
  for (const k of ['L', 'B', 'R']) {
    const v = hp[k], b = el[k];
    b.style.transform = `scaleX(${(v / 100).toFixed(3)})`;
    b.style.background = v > 60 ? '#7ee08a' : v > 30 ? '#ffc04a' : '#ff5a3c';
  }
  el.box.classList.toggle('regen', S.noContactT > 10 && (hp.L < 100 || hp.R < 100 || hp.B < 100));
}

function nearMisses() {
  const cur = Math.floor(-S.pos.z / CHUNK_L);
  const fx = -Math.sin(S.heading), fz = -Math.cos(S.heading);
  for (let i = cur - 1; i <= cur + 1; i++) {
    const ch = chunks.get(i); if (!ch) continue;
    for (const o of ch.objs) {
      if (o.dead) continue;
      if (o.type === 'boulder' || o.done) continue;
      const dx = o.x - S.pos.x, dz = o.z - S.pos.z;
      const along = dx * fx + dz * fz;
      const lat = Math.abs(dx * fz - dz * fx);
      const r = radiusAt(o, S.pos.y);
      if (r < 0) continue;
      if (Math.abs(along) < 60 && lat < r + 16) { o.near = true; o.minLat = Math.min(o.minLat ?? 99, lat - r); }
      if (along < -5) {
        o.done = true;
        if (o.near && S.mode === 'playing') { if (o.minLat < 7) addCombo('RAZOR', 250, 'razor'); else addCombo('CLOSE CALL', 100, 'close'); audio.whoosh(); }
      }
    }
  }
}

// ---------- scoring: distance x speed x combo, near-miss & skim combos ----------
const COMBO_TIME = 4;
const comboMult = (c = S.combo) => 1 + Math.min(c, 14) * 0.5;
const SKINS = [
  { name: 'Obsidian', km: 0, c: [0x1f1f23, 0x2b2b31, 0x141417] },
  { name: 'Dune Raider', km: 5, c: [0x6b5236, 0x7d6648, 0x2a2018] },
  { name: 'Crimson Wraith', km: 12, c: [0x5a1410, 0x2a2a2e, 0x140808] },
  { name: 'Glacier', km: 25, c: [0xa8b2bb, 0xd2d8de, 0x2a3036] },
  { name: 'Royal Gold', km: 40, c: [0x9a7628, 0x2c2822, 0x16120a] },
  { name: 'Void', km: 60, c: [0x09090b, 0x111116, 0x040405] },
];
let skinIdx = +(localStorage.getItem('canyon.skin') || 0);
const unlocked = (i) => S.bestDist / 1000 >= SKINS[i].km;
function applySkin(i) {
  if (!unlocked(i)) i = 0;
  skinIdx = i; localStorage.setItem('canyon.skin', String(i));
  ship.userData.hullMats.forEach((m, k) => m.color.setHex(SKINS[i].c[k]));
}
function refreshSkinUI() {
  const next = SKINS.find((k, i) => !unlocked(i));
  const txt = 'Ship: ' + SKINS[skinIdx].name + ' ▸';
  for (const id of ['skinBtn', 'skinBtn2']) $(id).textContent = txt;
  const nt = next ? 'Next skin: ' + next.name + ' at ' + next.km + ' km (best ' + (S.bestDist / 1000).toFixed(1) + ' km)' : 'All ship skins unlocked!';
  for (const id of ['skinNext', 'skinNext2']) $(id).textContent = nt;
}
for (const id of ['skinBtn', 'skinBtn2']) $(id).addEventListener('click', (e) => {
  e.stopPropagation();
  let i = skinIdx; do { i = (i + 1) % SKINS.length; } while (!unlocked(i) && i !== 0);
  applySkin(i); refreshSkinUI();
});
function pulse(cls) {
  const el = $('pulse'); el.className = ''; void el.offsetWidth; el.className = cls;
  if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) try { navigator.vibrate(cls === 'big' ? 40 : 12); } catch (e) { /* ignore */ }
}
function addCombo(kind, base, cls) {
  if (S.autopilot) return;
  if (cls === 'razor' || cls === 'close') S.nearMisses++;
  if (cls === 'razor') setTimeout(() => unlock('razor'), 400);
  S.combo = Math.min(S.combo + 1, 30); S.comboT = COMBO_TIME; S.maxCombo = Math.max(S.maxCombo, S.combo);
  const pts = Math.round(base * comboMult());
  S.score += pts;
  pop(kind + ' +' + pts, cls);
  pulse(cls === 'razor' ? 'razor' : 'combo');
  S.boost = Math.max(S.boost, 0.5);
  const el = $('combo'); el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
}
function updateScore(dt) {
  if (S.mode !== 'playing') return;
  checkAchievements(dt);
  const kmh = S.speed * 3.6;
  const dd = S.dist - (S.lastDist || 0); S.lastDist = S.dist;
  const speedMult = 0.5 + 1.5 * Math.pow(kmh / MAX_KMH, 1.2);
  // skimming: low over the ground or hugging a canyon wall at speed
  const sx = Math.cos(S.heading) * 20, sz = -Math.sin(S.heading) * 20;
  const wall = world.surface(S.pos.x + sx, S.pos.z + sz) > S.pos.y - 3 || world.surface(S.pos.x - sx, S.pos.z - sz) > S.pos.y - 3;
  const skimming = (S.agl < 14 || wall) && kmh > 650;
  if (skimming) {
    S.skimT += dt; S.skimAcc += dt;
    if (S.skimAcc > 1.4) { S.skimAcc = 0; addCombo(wall && S.agl >= 14 ? 'WALL SKIM' : 'SKIM', 60, 'skim'); }
  } else { S.skimT = 0; S.skimAcc = Math.max(0, S.skimAcc - dt * 2); }
  hud.skim.classList.toggle('on', skimming);
  S.score += dd * speedMult * comboMult() * (skimming ? 1.5 : 1) * (1 + 0.5 * (S.wx ? S.wx.anyK : 0)) * (S.autopilot ? 0.25 : safeMode ? 0.6 : 1) * (RX.ghost ? 0.3 : 1) * (RX.god ? 0.3 : 1);
  if (S.combo > 0) {
    S.comboT -= dt;
    if (S.comboT <= 0) { if (S.combo >= 3) pop('COMBO x' + comboMult().toFixed(1) + ' BANKED', 'banked'); S.combo = 0; }
  }
  // celebrate beating the best score mid-run
  if (!S.bestBeaten && S.best > 0 && S.score > S.best) {
    S.bestBeaten = true; pop('NEW BEST!', 'mach'); pulse('big'); flash(0.35); audio.chime();
  }
  // skin unlocks by distance milestones
  for (let i = 1; i < SKINS.length; i++) {
    const m = SKINS[i].km * 1000;
    if (S.dist >= m && S.bestDist < m) { S.bestDist = m; localStorage.setItem('canyon.bestDist', String(m)); pop('SKIN UNLOCKED: ' + SKINS[i].name.toUpperCase(), 'unlock'); pulse('big'); audio.chime(); }
  }
}

// ---------- weather: rare distance-based events (~5% of distance) ----------
const WX = {
  dust:    { name: 'DUST STORM',   near: 4,  far: 360, col: [0.62, 0.33, 0.15], sun: 0.35, hemi: 0.75, sky: 0.88, tint: [1, 1, 1],          rough: 0.95, rain: 0, hail: 0, bolt: 0 },
  fog:     { name: 'FOG BANK',     near: 2,  far: 220, col: [0.78, 0.63, 0.50], sun: 0.45, hemi: 0.95, sky: 0.94, tint: [1, 1, 1],          rough: 0.9,  rain: 0, hail: 0, bolt: 0 },
  rain:    { name: 'RAINSTORM',    near: 15, far: 700, col: [0.30, 0.34, 0.42], sun: 0.2,  hemi: 0.6,  sky: 0.9,  tint: [0.5, 0.52, 0.56],  rough: 0.28, rain: 1, hail: 0, bolt: 0 },
  hail:    { name: 'ICE STORM',    near: 15, far: 650, col: [0.55, 0.60, 0.68], sun: 0.4,  hemi: 0.85, sky: 0.86, tint: [1.25, 1.32, 1.5], rough: 0.6,  rain: 0, hail: 1, bolt: 0 },
  snow:    { name: 'SNOWSTORM',    near: 2,  far: 170, col: [0.66, 0.72, 0.80], sun: 0.3,  hemi: 1.05, sky: 0.97, tint: [1.35, 1.42, 1.55], rough: 0.5,  rain: 0, hail: 0, bolt: 0, snow: 1 },
  thunder: { name: 'THUNDERSTORM', near: 20, far: 700, col: [0.15, 0.17, 0.22], sun: 0.12, hemi: 0.45, sky: 0.94, tint: [0.45, 0.46, 0.5],  rough: 0.28,  rain: 1.2, hail: 0, bolt: 1 },
};
const WX_TYPES = Object.keys(WX).filter((k) => k !== 'snow');
const EV_LEN = 5000, EV_FADE = 500, EV_WARN = 1500;
function makeSchedule(rnd) {
  const ev = []; let d = 20000 + rnd() * 10000, last = null;
  while (d < 3e6) {
    let t; do { t = WX_TYPES[(rnd() * WX_TYPES.length) | 0]; } while (t === last);
    ev.push({ start: d, end: d + EV_LEN, type: t, warned: false, entered: false });
    last = t; d += EV_LEN + 60000 + rnd() * 70000;
  }
  // snowstorms: every 20 km segment has a 25% chance of one 2 km blizzard (skipped if it would overlap another event)
  for (let seg = 20000; seg < 3e6; seg += 20000) {
    if (rnd() >= 0.25) continue;
    const st = seg + 1500 + rnd() * 16000, en = st + 2000;
    if (ev.some((e) => st < e.end + 1500 && en > e.start - 1500)) continue;
    ev.push({ start: st, end: en, type: 'snow', warned: false, entered: false });
  }
  ev.sort((a, b) => a.start - b.start);
  const forced = params.get('wx');
  if (forced && WX[forced]) { const L0 = forced === 'snow' ? 2000 : EV_LEN; while (ev.length && ev[0].start < L0 + 1500) ev.shift(); ev.unshift({ start: -EV_FADE, end: L0, type: forced, warned: true, entered: true }); }
  return ev;
}
const TERRAIN_BASE = terrainMat.color.clone(), ROCK_BASE = rockMat.color.clone(), BOULDER_BASE = boulderMat.color.clone();
const rain = new Precip(2200), hail = new Precip(500), snow = new Precip(3200);
scene.add(rain.mesh, hail.mesh, snow.mesh);
const SNOW_COL = new THREE.Color(1.5, 1.55, 1.65);
const RAIN_COL = new THREE.Color(1.1, 1.15, 1.3), HAIL_COL = new THREE.Color(0.9, 0.95, 1.0);
const _wc = new THREE.Color(), _tint = new THREE.Color();
// lightning bolt ribbon
const boltMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.85, 0.9, 1.0).multiplyScalar(3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, fog: false });
const bolt = new THREE.Mesh(new THREE.BufferGeometry(), boltMat);
bolt.frustumCulled = false; bolt.visible = false; bolt.renderOrder = 21; scene.add(bolt);
function strikeBolt() {
  const W = S.wx;
  let d = 350 + Math.random() * 700, ang = S.heading + (Math.random() - 0.5) * 1.3;
  if (S.mode === 'playing' && Math.random() < (params.has('boltnear') ? 1 : 0.3)) { d = 150 + Math.random() * 120; ang = S.heading + (Math.random() - 0.5) * 0.6; }
  const x0 = S.pos.x - Math.sin(ang) * d, z0 = S.pos.z - Math.cos(ang) * d;
  const gy = world.surface(x0, z0);
  boltNear(x0, z0);
  const pts = []; let x = x0 + (Math.random() - 0.5) * 120, y = gy + 650, z = z0 + (Math.random() - 0.5) * 120;
  const segs = 22;
  for (let i = 0; i <= segs; i++) { const t = i / segs; pts.push(new THREE.Vector3(x, lerp(gy + 650, gy, t), z)); x += (Math.random() - 0.5) * 50 + (x0 - x) * 0.15; z += (Math.random() - 0.5) * 50 + (z0 - z) * 0.15; }
  // branch
  const bi = 6 + ((Math.random() * 8) | 0), bpts = [pts[bi].clone()];
  for (let i = 0; i < 8; i++) { const q = bpts[i]; bpts.push(new THREE.Vector3(q.x + (Math.random() - 0.3) * 40, q.y - 25, q.z + (Math.random() - 0.5) * 40)); }
  const pos = [];
  const ribbon = (arr, w) => {
    for (let i = 0; i < arr.length - 1; i++) {
      const a = arr[i], b = arr[i + 1];
      const dir = _v.subVectors(b, a); const view = _w.subVectors(a, camera.position);
      const side = new THREE.Vector3().crossVectors(dir, view).normalize().multiplyScalar(w);
      pos.push(a.x + side.x, a.y + side.y, a.z + side.z, a.x - side.x, a.y - side.y, a.z - side.z, b.x + side.x, b.y + side.y, b.z + side.z,
        a.x - side.x, a.y - side.y, a.z - side.z, b.x - side.x, b.y - side.y, b.z - side.z, b.x + side.x, b.y + side.y, b.z + side.z);
    }
  };
  ribbon(pts, 2.2); ribbon(bpts, 1.1);
  bolt.geometry.dispose();
  bolt.geometry = new THREE.BufferGeometry();
  bolt.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  W.boltT = 0.28; W.flash = 1;
  for (let i = 0; i < 20; i++) glow.spawn(x0, gy + 2, z0, (Math.random() - 0.5) * 30, Math.random() * 25, (Math.random() - 0.5) * 30, 0.5, 6, 20, 0.9, 0.8, 0.85, 1.0, 2, -5);
  audio.thunder(clamp(d / 340, 0.4, 3), 1);
}
function hailHit() {
  const el = document.createElement('div'); el.className = 'hit';
  el.style.left = (10 + Math.random() * 80) + '%'; el.style.top = (10 + Math.random() * 75) + '%';
  const sz = 10 + Math.random() * 22; el.style.width = el.style.height = sz + 'px';
  $('hits').appendChild(el); setTimeout(() => el.remove(), 600);
}

const _sg = new THREE.Color();
function updateWeather(dt) {
  const W = S.wx;
  let cur = null, k = 0;
  if (S.mode !== 'attract') {
    while (W.events.length && W.events[0].end < S.dist) { const ev = W.events.shift(); if (ev.type === 'thunder' && ev.start > 0 && S.mode === 'playing') unlock('storm'); }
    const e = W.events[0];
    if (e && S.mode === 'playing') {
      const warnD = Math.max(EV_WARN, S.speed * 3.5);
      if (!e.warned && S.dist > e.start - warnD) { e.warned = true; pop(WX[e.type].name + ' AHEAD', 'close'); }
      if (S.dist > e.start - warnD) cur = e;
      k = clamp((S.dist - e.start) / EV_FADE, 0, 1) * clamp((e.end - S.dist) / EV_FADE, 0, 1);
      k = k * k * (3 - 2 * k);
    } else if (e && S.mode === 'crashed') { k = W.k; cur = W.cur; }
  }
  if (cur) W.type = cur.type;
  W.cur = cur; W.k = damp(W.k, k, 4, dt);
  k = W.k;
  const wx = WX[W.type || 'dust'];
  const banner = $('storm');
  if (cur && S.mode === 'playing') { banner.textContent = (S.dist < cur.start ? wx.name + ' AHEAD' : '⚠ ' + wx.name); banner.classList.add('on'); }
  else banner.classList.remove('on');
  // lightning
  W.flash = Math.max(0, (W.flash || 0) - dt * 5);
  if (W.boltT > 0) { W.boltT -= dt; bolt.visible = W.boltT > 0 && (W.boltT > 0.18 || W.boltT % 0.08 > 0.04); } else bolt.visible = false;
  if (wx.bolt && k > 0.5 && S.mode === 'playing') {
    W.nextBolt -= dt;
    if (W.nextBolt <= 0) {
      W.nextBolt = 2 + Math.random() * 4.5;
      if (Math.random() < 0.55) strikeBolt();
      else { W.flash = 0.7; audio.thunder(1 + Math.random() * 2, 0.7); } // sheet lightning in the clouds
    }
  }
  const fl = W.flash * (W.flash > 0.5 || Math.sin(S.t * 90) > 0 ? 1 : 0.4);
  // blend environment
  scene.fog.near = lerp(150, wx.near, k);
  scene.fog.far = lerp(E.far, wx.far, k) + fl * 300;
  _wc.setRGB(wx.col[0], wx.col[1], wx.col[2], LIN);
  scene.fog.color.copy(FOG_BASE).lerp(_wc, k);
  if (wx.rain || wx.hail) scene.fog.color.lerp(_sg.setRGB(0.24, 0.29, 0.37, LIN), k * 0.9);
  if (wx.snow) scene.fog.color.lerp(_sg.setRGB(0.62, 0.68, 0.76, LIN), k * 0.95);
  { const zc = zoneAt(S.dist); RX.inCave = !!(zc && !RX.above && S.pos.y < zc.b); RX.caveK = damp(RX.caveK || 0, RX.inCave ? 1 : 0, 1.5, dt);
    if (RX.caveK > 0.01) { const c = RX.ice ? _sg.setRGB(0.5, 0.6, 0.72, LIN) : _sg.setRGB(0.62, 0.34, 0.15, LIN); scene.fog.color.lerp(c, RX.caveK * 0.75); scene.fog.near = lerp(scene.fog.near, 60, RX.caveK); scene.fog.far = lerp(scene.fog.far, Math.min(scene.fog.far, 2200), RX.caveK); } }
  scene.fog.color.r += fl * 0.35; scene.fog.color.g += fl * 0.38; scene.fog.color.b += fl * 0.5;
  scene.background.copy(scene.fog.color);
  fogU.fogColor.value.copy(scene.fog.color); fogU.fogNear.value = scene.fog.near; fogU.fogFar.value = scene.fog.far;
  skyMat.uniforms.storm.value = k * wx.sky;
  if (wx.rain || wx.hail || wx.snow) { // storms: grey-blue sky, neutral light, no warm sun haze
    const g = k * 0.9, su = skyMat.uniforms;
    su.horC.value.lerp(_sg.setRGB(0.3, 0.36, 0.45, LIN), g); su.midC.value.lerp(_sg.setRGB(0.22, 0.27, 0.36, LIN), g); su.zenC.value.lerp(_sg.setRGB(0.16, 0.19, 0.25, LIN), g);
    sunLight.color.lerp(_sg.setRGB(0.75, 0.8, 0.9, LIN), g); hemi.color.lerp(_sg.setRGB(0.55, 0.6, 0.7, LIN), g); hemi.groundColor.lerp(_sg.setRGB(0.18, 0.18, 0.2, LIN), g);
    hazeU.hazeCol.value.lerp(_sg.setRGB(0.32, 0.37, 0.45, LIN), g); hazeU.hazeK.value *= 1 - 0.6 * g;
    waterMat.uniforms.sunCol.value.copy(sunLight.color);
  }
  skyMat.uniforms.flash.value = fl;
  sunLight.intensity = E.sunI * lerp(1, wx.sun, k);
  waterMat.uniforms.glint.value = lerp(1, wx.sun, k);
  hemi.intensity = E.hemiI * lerp(1, wx.hemi, k) + fl * 5;
  _tint.setRGB(lerp(1, wx.tint[0], k), lerp(1, wx.tint[1], k), lerp(1, wx.tint[2], k)); _tint.multiply(RX.iceTint);
  terrainMat.color.copy(TERRAIN_BASE).multiply(_tint); rockMat.color.copy(ROCK_BASE).multiply(_tint); boulderMat.color.copy(BOULDER_BASE).multiply(_tint);
  terrainMat.roughness = lerp(0.95, wx.rough, k);
  S.storm.k = W.type === 'dust' ? k : 0;
  W.rainK = k * wx.rain; W.hailK = k * wx.hail; W.fogK = W.type === 'fog' ? k : 0; W.snowK = wx.snow ? k : 0; S.snowK = W.snowK;
  W.anyK = k;
  // precipitation: streak length scales with relative speed
  const cam = camera.position;
  rain.update(dt, cam, S.vel, { fall: 60, wind: 8, lenK: 0.06, width: 0.055, alpha: Math.min(W.rainK, 1) * 0.95, tail: 0, color: RAIN_COL, count: W.rainK });
  hail.update(dt, cam, S.vel, { fall: 32, wind: 14, lenK: 0.012, width: 0.09, alpha: W.hailK * 0.9, tail: 0.15, color: HAIL_COL, count: W.hailK });
  // blizzard: dense wind-driven snow streaks (length scales with speed)
  snow.update(dt, cam, S.vel, { fall: 9, wind: 55, lenK: 0.02 + 0.03 * Math.min(S.speed / 700, 1), width: 0.13, alpha: W.snowK * 0.95, tail: 0.3, color: SNOW_COL, count: W.snowK });
  // frost builds on the airframe inside, sublimates over ~10 s after
  S.frost = clamp((S.frost || 0) + (W.snowK > 0.3 ? dt * 0.09 * W.snowK : -dt * 0.1), 0, 1);
  FROST.value = S.frost; $('frostV').style.opacity = (Math.max(S.frost * 0.95, W.snowK * 0.35)).toFixed(3);
  audio.blizzard && audio.blizzard(W.snowK);
  if (W.hailK > 0.3 && S.mode === 'playing' && Math.random() < dt * 4 * W.hailK) { hailHit(); if (Math.random() < 0.5) audio.tick(); }
}

const SPRAY = [1.55, 1.6, 1.65];
const sm = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// low-lying cloud layers: patches along ~25% of the distance, 10-55 m above ground/water
const CLOUDC = new Map();
function cloudStretch(cp) { let c = CLOUDC.get(cp); if (c === undefined) { const r = makeRng(((S.seed || 1) ^ (cp * 2654435761)) >>> 0); const st = cp * 200000 + 5000 + r() * 185000; c = [st, st + 10000]; CLOUDC.set(cp, c); if (CLOUDC.size > 64) CLOUDC.delete(CLOUDC.keys().next().value); } return c; }
const lowCloudK = (z) => { if (params.has('clouds')) return 1; const d = -z, c = cloudStretch(Math.floor(d / 200000)); return sm(c[0] - 800, c[0] + 800, d) * (1 - sm(c[1] - 800, c[1] + 800, d)); }; // ~10 km cloud stretch every 200 km
const cloudDens = (x, z) => { const k = Math.min(lowCloudK(z), 1); return k <= 0 ? 0 : k * sm(0.38, 0.66, world.noise(x * 0.0035 + 9.1, z * 0.003)); };
const CLOUD_COL = [1.45, 1.43, 1.4];
const dcol = (x, z) => (world.gridHeight(x, z) < 0 ? SPRAY : E.dust);
function spawnDust(dt, thr, spdN) {
  const q = quality.particles;
  const p = S.pos, v = S.vel;
  const low = clamp(1 - S.agl / 70, 0, 1);
  const A = S.spawnAcc;
  // ground kick-up: puffs bloom under the ship, initially dragged along, then fall behind
  if (low > 0 && S.mode !== 'crashed') {
    const gk = (E.main === 'grass' || RX.above ? 0.3 : 1) * (1 - 0.75 * Math.min((S.wx.rainK || 0) + (S.wx.hailK || 0), 1));
    A.kick += dt * q * gk * Math.pow(low, 1.1) * (150 + 380 * spdN);
    A.billow = (A.billow || 0) + dt * q * gk * low * (25 + 45 * spdN);
    const hx = Math.cos(S.heading), hz = -Math.sin(S.heading);
    const fx = -Math.sin(S.heading), fz = -Math.cos(S.heading);
    while (A.kick > 1) {
      A.kick--;
      const along = -14 + Math.random() * 30, lat = (Math.random() - 0.5) * 22;
      const x = p.x + fx * along + hx * lat, z = p.z + fz * along + hz * lat;
      const gy = world.surface(x, z);
      const side = Math.sign(lat) * (0.4 + Math.random() * 0.6);
      const sp = 15 + 45 * spdN;
      const keep = 0.72 + Math.random() * 0.18;
      const sh = 0.78 + Math.random() * 0.22;
      const c = dcol(x, z), wet = c === SPRAY;
      if (wet && Math.random() < 0.6) continue;
      dust.spawn(x, gy + (wet ? 1.5 : 4), z, v.x * keep + hx * side * sp, (wet ? 12 : 5) + Math.random() * 14 * low, v.z * keep + hz * side * sp,
        wet ? 1.0 + Math.random() : 1.6 + Math.random() * 1.8, 4 + Math.random() * 4, (wet ? 12 : 18) + Math.random() * 26 * (0.6 + spdN), (wet ? 0.12 : 0.55) * low + (wet ? 0.05 : 0.3),
        c[0] * sh, c[1] * sh, c[2] * sh, 1.6, wet ? -9 : -1.0);
    }
  }
  // downwash eruption: dust (or spray / grass clippings) bursts radially outward from the ground point beneath the ship
  if (low > 0 && S.mode !== 'crashed') {
    const gy0 = world.surface(p.x, p.z), wet0 = world.gridHeight(p.x, p.z) < 0, grassy = (E.main === 'grass' || RX.above) && !wet0;
    const k = Math.pow(low, 1.5) * (0.25 + 0.75 * spdN);
    A.erupt = (A.erupt || 0) + dt * q * k * (grassy ? 120 : wet0 ? 45 : 260);
    const R0 = 4 + S.agl * 0.4;
    // GPU fine dust / spray: one burst every ~1/90 s
    A.gpu = (A.gpu || 0) + dt * 90;
    while (A.gpu > 1) {
      A.gpu--;
      const kind = wet0 ? 1 : grassy ? 2 : 0;
      const c = wet0 ? [1.2, 1.25, 1.3] : grassy ? [0.42, 0.5, 0.26] : [E.dust[0] * 0.62, E.dust[1] * 0.6, E.dust[2] * 0.58];
      const gpx = p.x - v.x * Math.random() * 0.012, gpz = p.z - v.z * Math.random() * 0.012;
      gdust.emit(S.t, gpx, world.surface(gpx, gpz) + (wet0 ? 0.3 : 0.4), gpz, v.x, 0, v.z, clamp(k * 1.3, 0.05, 1), c[0], c[1], c[2], kind,
        R0 * 1.1, 14 + 75 * k, wet0 ? 6 + 26 * k : grassy ? 2 + 4 * k : 3 + 9 * k, wet0 ? 1.7 : grassy ? 2.0 : 3.2);
    }
    while (A.erupt > 1) {
      A.erupt--;
      const a = Math.random() * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const r = R0 * (0.3 + Math.random() * 0.9);
      const x = p.x + ca * r - v.x * 0.03, z = p.z + sa * r - v.z * 0.03;
      const out = (18 + 70 * k) * (0.6 + Math.random() * 0.6);
      const sh = 0.8 + Math.random() * 0.25;
      if (wet0) dust.spawn(x, gy0 + 0.8, z, ca * out + v.x * 0.35, 9 + Math.random() * 22 * k, sa * out + v.z * 0.35, 0.9 + Math.random() * 0.8, 1.2, 7 + Math.random() * 10, 0.3 * k + 0.1, SPRAY[0] * sh, SPRAY[1] * sh, SPRAY[2] * sh, 1.8, -14);
      else if (grassy) dust.spawn(x, gy0 + 1.2, z, ca * out * 0.8 + v.x * 0.3, 3 + Math.random() * 8 * k, sa * out * 0.8 + v.z * 0.3, 1.2 + Math.random() * 1.2, 1.0, 7 + Math.random() * 10, 0.28 * k + 0.12, 0.62 * sh, 0.7 * sh, 0.42 * sh, 2.0, -1.5);
      else dust.spawn(x, gy0 + 1.5, z, ca * out + v.x * 0.3, 2 + Math.random() * 9 * k, sa * out + v.z * 0.3, 2.0 + Math.random() * 2.0, 3, 20 + Math.random() * 30 * (0.5 + k), 0.5 * k + 0.25, E.dust[0] * sh, E.dust[1] * sh, E.dust[2] * sh, 1.4, -0.4);
    }
  }
  // big billowing clouds rolling out behind the ship
  if (low > 0 && S.mode !== 'crashed') {
    const fx = -Math.sin(S.heading), fz = -Math.cos(S.heading), hx = Math.cos(S.heading), hz = -Math.sin(S.heading);
    while (A.billow > 1) {
      A.billow--;
      const along = -10 + Math.random() * 25, lat = (Math.random() - 0.5) * 30;
      const x = p.x + fx * along + hx * lat, z = p.z + fz * along + hz * lat;
      const gy = world.surface(x, z);
      const keep = 0.8 + Math.random() * 0.12, sh = 0.7 + Math.random() * 0.3;
      dust.spawn(x, gy + 6, z, v.x * keep + hx * lat * 1.5, 6 + Math.random() * 10, v.z * keep + hz * lat * 1.5,
        2.6 + Math.random() * 2, 10, 45 + Math.random() * 45, (0.35 + 0.35 * low) * (dcol(x, z) === SPRAY ? 0.0 : 1), dcol(x, z)[0] * sh * 0.93, dcol(x, z)[1] * sh * 0.9, dcol(x, z)[2] * sh * 0.85, 1.3, -0.5);
    }
  }
  // engine dust/heat trail
  if (S.mode !== 'crashed') {
    A.trail += dt * q * (18 + 40 * thr) * (0.35 + low);
    ship.updateMatrixWorld();
    while (A.trail > 1) {
      A.trail--;
      const s = Math.random() < 0.5 ? -1 : 1;
      _w.set(s * 1.78, -0.2, 7 + Math.random() * 4).applyMatrix4(ship.matrixWorld).add(RO);
      const sh = 0.8 + Math.random() * 0.2;
      dust.spawn(_w.x, _w.y, _w.z, v.x * 0.55, v.y * 0.5 + 1, v.z * 0.55, 0.9 + Math.random() * 0.8, 1.5, 9 + 10 * thr, 0.22 + 0.25 * low, E.dust[0] * 0.7 * sh, E.dust[1] * 0.75 * sh, E.dust[2] * 0.85 * sh, 2.5, 0);
    }
    // embers from afterburner
    A.ember += dt * q * thr * thr * 50;
    while (A.ember > 1) {
      A.ember--;
      const s = Math.random() < 0.5 ? -1 : 1;
      _w.set(s * 1.78 + (Math.random() - 0.5) * 0.6, -0.15 + (Math.random() - 0.5) * 0.6, 7 + Math.random() * 6).applyMatrix4(ship.matrixWorld).add(RO);
      glow.spawn(_w.x, _w.y, _w.z, v.x * 0.7 + (Math.random() - 0.5) * 6, v.y * 0.7 + (Math.random() - 0.5) * 6, v.z * 0.7, 0.25 + Math.random() * 0.3, 0.5, 0.15, 0.9, 1, 0.55, 0.2, 1, 0);
    }
  }
  // humid jungle mist drifting between the trees / over the river
  if ((S.jungleK || 0) > 0.05) {
    A.mist = (A.mist || 0) + dt * q * 5 * S.jungleK;
    while (A.mist > 1) {
      A.mist--;
      const d = 80 + Math.random() * 900, ang = S.heading + (Math.random() - 0.5) * 1.6;
      const x = p.x - Math.sin(ang) * d, z = p.z - Math.cos(ang) * d, gy = world.surface(x, z);
      dust.spawn(x, gy + 8 + Math.random() * 22, z, 3 + Math.random() * 3, 0.5, (Math.random() - 0.5) * 2, 8 + Math.random() * 6, 40, 70 + Math.random() * 50, 0.16 * S.jungleK, 1.1, 1.2, 1.12, 0.05, 0);
    }
  }
  // big ambient dust clouds rolling along the valley floor ahead
  A.amb += dt * q * (5 + 6 * S.storm.k);
  while (A.amb > 1) {
    A.amb--;
    const d = 250 + Math.random() * 1100;
    const ang = S.heading + (Math.random() - 0.5) * 1.2;
    const x = p.x - Math.sin(ang) * d, z = p.z - Math.cos(ang) * d;
    const gy = world.surface(x, z);
    if (gy > 60) continue;
    const sh = 0.85 + Math.random() * 0.15;
    dust.spawn(x, gy + 6 + Math.random() * 10, z, 8 + Math.random() * 8, 1 + Math.random() * 2, (Math.random() - 0.5) * 6, 7 + Math.random() * 6, 50, 110 + Math.random() * 90, 0.32, dcol(x, z)[0] * sh * 0.9, dcol(x, z)[1] * sh * 0.86, dcol(x, z)[2] * sh * 0.83, 0.05, 0);
  }
  // low cloud layers ahead
  const kAhead = Math.max(lowCloudK(p.z), lowCloudK(p.z - 1500));
  if (kAhead > 0.02) {
    A.cloud = (A.cloud || 0) + dt * q * 70 * Math.min(kAhead, 1);
    while (A.cloud > 1) {
      A.cloud--;
      const d = 60 + Math.random() * 1500, ang = S.heading + (Math.random() - 0.5) * 1.3;
      const x = p.x - Math.sin(ang) * d, z = p.z - Math.cos(ang) * d;
      const dn = cloudDens(x, z); if (dn < 0.12) continue;
      const y = world.surface(x, z) + 12 + Math.random() * 36;
      const sh = 0.9 + Math.random() * 0.1;
      dust.spawn(x, y, z, 4 + Math.random() * 4, 0, (Math.random() - 0.5) * 3, 9 + Math.random() * 6, 60, 120 + Math.random() * 80, 0.55 * dn, CLOUD_COL[0] * sh, CLOUD_COL[1] * sh, CLOUD_COL[2] * sh, 0.05, 0);
    }
  }
  // inside a cloud: white-out + wisps streaming past
  {
    const dn = cloudDens(p.x, p.z), band = sm(3, 12, S.agl) * sm(62, 48, S.agl);
    const prev = S.cloudIn || 0;
    S.cloudIn = damp(prev, S.mode === 'crashed' ? 0 : dn * band, 6, dt);
    if (prev < 0.3 && S.cloudIn >= 0.3 && S.mode === 'playing') { audio.whoosh(); pulse('combo'); }
    const near = Math.max(S.cloudIn, cloudDens(p.x - Math.sin(S.heading) * 300, p.z - Math.cos(S.heading) * 300) * band);
    A.wisp = (A.wisp || 0) + dt * q * 90 * near;
    const fx = -Math.sin(S.heading), fz = -Math.cos(S.heading), hx = Math.cos(S.heading), hz = -Math.sin(S.heading);
    while (A.wisp > 1) {
      A.wisp--;
      const al = 30 + Math.random() * 140, lt = (Math.random() - 0.5) * 60;
      dust.spawn(p.x + fx * al + hx * lt, p.y + (Math.random() - 0.5) * 16, p.z + fz * al + hz * lt, 0, 0, 0, 0.9, 10, 26, 0.45, 1.5, 1.5, 1.48, 0, 0);
    }
    $('whiteout').style.opacity = (S.cloudIn * 0.82).toFixed(3);
  }
  // waterfall mist
  {
    const cur = Math.floor(-p.z / CHUNK_L);
    for (let i = cur; i <= cur + 6; i++) {
      const ch = chunks.get(i); if (!ch || !ch.falls) continue;
      for (const f of ch.falls) {
        f.acc = (f.acc || 0) + dt * q * 14;
        while (f.acc > 1) { f.acc--; dust.spawn(f.xb + (Math.random() - 0.5) * f.w, f.hb + 3, f.z + (Math.random() - 0.5) * f.w, (Math.random() - 0.5) * 10, 5 + Math.random() * 8, (Math.random() - 0.5) * 10, 3 + Math.random() * 2, 15, 50, 0.4, 1.45, 1.5, 1.5, 0.6, 0); }
      }
    }
  }
  // fog bank: big pale low cloud puffs drifting through the canyon
  if (S.wx && S.wx.fogK > 0.05) {
    A.fog = (A.fog || 0) + dt * q * 35 * S.wx.fogK;
    while (A.fog > 1) {
      A.fog--;
      const d = 40 + Math.random() * 260, ang = S.heading + (Math.random() - 0.5) * 1.4;
      const x = p.x - Math.sin(ang) * d, z = p.z - Math.cos(ang) * d;
      const gy = world.surface(x, z);
      dust.spawn(x, Math.max(gy + 5, p.y + (Math.random() - 0.6) * 40), z, 6, 0, 0, 4 + Math.random() * 3, 40, 90, 0.45 * S.wx.fogK, 0.95, 0.85, 0.74, 0.1, 0);
    }
  }
  // storm puffs streaming past the camera
  if (S.storm.k > 0.05) {
    A.storm += dt * q * 70 * S.storm.k;
    while (A.storm > 1) {
      A.storm--;
      const d = 20 + Math.random() * 200;
      const ang = S.heading + (Math.random() - 0.5) * 1.6;
      const x = p.x - Math.sin(ang) * d, z = p.z - Math.cos(ang) * d;
      const sh = 0.7 + Math.random() * 0.2;
      dust.spawn(x - 40, p.y + (Math.random() - 0.4) * 60, z, 60 + Math.random() * 40, (Math.random() - 0.5) * 5, (Math.random() - 0.5) * 20, 2.5 + Math.random() * 2, 25, 70, 0.4 * S.storm.k, 0.85 * sh, 0.52 * sh, 0.28 * sh, 0.1, 0);
    }
  }
}

function updateSpecks(dt) {
  const c = camera.position, H = 80;
  const wind = 6 + 50 * S.storm.k;
  for (let i = 0; i < SPECKS; i++) {
    let x = speckPos[i * 3] + wind * dt, y = speckPos[i * 3 + 1] + Math.sin(S.t + i) * dt, z = speckPos[i * 3 + 2];
    x = c.x + ((((x - c.x) + H) % (2 * H)) + 2 * H) % (2 * H) - H;
    y = c.y + ((((y - c.y) + H * 0.5) % H) + H) % H - H * 0.5;
    z = c.z + ((((z - c.z) + H) % (2 * H)) + 2 * H) % (2 * H) - H;
    speckPos[i * 3] = x; speckPos[i * 3 + 1] = y; speckPos[i * 3 + 2] = z;
  }
  speckGeo.attributes.position.needsUpdate = true;
  speckMat.opacity = 0.55 + 0.35 * S.storm.k;
}

function updateShipFx(thr, spdN, dt) {
  const boostK = S.boost > 0 ? 1 : 0;
  S.boostFx = damp(S.boostFx || 0, boostK, 6, dt);
  const len = 3.2 + thr * 11.5 + S.boostFx * 3;
  for (const f of ship.userData.flames) {
    const fl = (1 + 0.08 * Math.sin(S.t * 71 + f.grp.position.x) + 0.05 * Math.sin(S.t * 133)) * (1 - (S.snowK || 0) * (0.25 * Math.random() + 0.12 * Math.sin(S.t * 37)));
    f.outer.scale.set(1 + thr * 0.15, 1 + thr * 0.15, len * fl);
    f.inner.scale.set(1, 1, len * 0.55 * fl);
    f.outer.material.uniforms.time.value = S.t; f.inner.material.uniforms.time.value = S.t;
    f.outer.material.uniforms.intensity.value = 0.55 + 0.6 * thr + 0.3 * S.boostFx;
    f.inner.material.uniforms.intensity.value = 0.7 + 0.5 * thr;
  }
  engineGlows.forEach((g, i) => {
    const big = i % 2 === 1;
    const s = (big ? 4.2 : 1.7) * (0.8 + 0.5 * thr + 0.2 * S.boostFx) * (1 + 0.06 * Math.sin(S.t * 50 + i));
    g.scale.set(s, s, 1);
  });
  engineLight.intensity = 15 + 55 * thr + 30 * S.boostFx;
  const kmh = S.speed * 3.6;
  const vk = clamp(1 - Math.abs(kmh - 1245) / 110, 0, 1);
  vaporMat.uniforms.k.value = vk; vaporMat.uniforms.time.value = S.t;
  vapor.visible = vk > 0.01 && ship.visible;
}

let hudT = 0;
const hud = { hp: { box: $('hpBox'), L: $('hpL'), R: $('hpR'), B: $('hpB') }, ms: $('ms'), time: $('ftime'), top: $('top'), biome: $('biome'), speed: $('speed'), mach: $('mach'), agl: $('agl'), score: $('score'), dist: $('dist'), best: $('best'), combo: $('combo'), comboBar: $('comboBar'), skim: $('skim'), fill: $('thrFill'), pct: $('thrPct'), machMark: $('thrMach'), alt: { bar: $('altBar'), fill: $('altFill'), knob: $('altKnob'), pct: $('altPct') } };
hud.machMark.style.bottom = (Math.pow((MACH_KMH - MIN_KMH) / (TOP_KMH - MIN_KMH), 1 / 2.2) * 100) + '%';
function updateHUD(dt) {
  hud.fill.style.height = (controls.throttle * 100).toFixed(1) + '%';
  { // left altitude slider: knob = target (0 m bottom .. 500 m top), fill = actual height, top band 450-500 m = SAFE ALTITUDE
    const A = hud.alt, T = controls.altTarget ?? 30, H = A.bar.clientHeight;
    A.knob.style.transform = `translateY(${((0.5 - T / MAX_AGL) * H * 0.92).toFixed(1)}px)`;
    A.fill.style.height = (clamp(S.agl / MAX_AGL, 0, 1) * 100).toFixed(1) + '%'; A.fill.style.marginTop = '0px'; A.fill.classList.remove('dn');
    const on = [...(controls.drags || new Map()).values()].some((d) => d.kind === 'alt');
    A.bar.classList.toggle('active', on);
    const safe = inSafeBand(); A.bar.classList.toggle('safe', safe);
    const txt = safe ? 'SAFE' : Math.round(T) + ' m';
    if (A.pct.textContent !== txt) A.pct.textContent = txt;
    const sb = $('safeAlt'); if (sb) { const cav = RX.inCave && S.agl >= SAFE_AGL - 30 && S.mode === 'playing'; sb.classList.toggle('hidden', !safe && !cav); const tx = cav ? 'CAVERN · NO SAFE BAND' : 'SAFE ALTITUDE'; if (sb.textContent !== tx) sb.textContent = tx; }
  }
  hud.comboBar.style.transform = 'scaleX(' + (S.combo > 0 ? S.comboT / COMBO_TIME : 0).toFixed(3) + ')';
  hudT -= dt; if (hudT > 0) return; hudT = 1 / 15;
  const kmh = Math.round(S.speed * 3.6);
  hud.speed.textContent = kmh.toLocaleString('en-US');
  hud.speed.classList.toggle('super', kmh >= MACH_KMH);
  hud.mach.textContent = 'M ' + (kmh / MACH_KMH).toFixed(2);
  hud.ms.textContent = (S.speed).toFixed(1) + ' m/s';
  hud.time.textContent = fmtTime(S.time);
  hud.top.textContent = 'TOP ' + Math.round(S.topKmh).toLocaleString('en-US');
  hud.biome.textContent = E.name;
  hud.agl.textContent = 'ALT ' + Math.max(0, Math.round(S.agl)) + ' m';
  hud.score.textContent = Math.floor(S.score).toLocaleString('en-US');
  hud.dist.textContent = (S.dist >= 1e6 ? Math.round(S.dist / 1000).toLocaleString() : (S.dist / 1000).toFixed(S.dist >= 1e5 ? 1 : 2)) + ' km';
  hud.best.textContent = Math.max(S.best, Math.floor(S.score)).toLocaleString('en-US');
  hud.pct.textContent = Math.round(controls.throttle * 100) + '%';
  hud.combo.textContent = 'x' + comboMult().toFixed(1);
  hud.combo.parentElement.classList.toggle('live', S.combo > 0);
  const now = performance.now();
  if (S.tut && S.tut.length && S.time >= S.tut[0][0]) { $('hint').textContent = S.tut.shift()[1]; S.hintUntil = now + 4000; if (!S.tut.length) localStorage.setItem('canyon.tut', '1'); }
  // hint: real-time 4 s, and never while a weather banner is up
  const showHint = now < (S.hintUntil || 0) && !$('storm').classList.contains('on');
  $('hint').style.opacity = showHint ? 1 : 0;
  $('rotate').classList.toggle('hidden', !(innerHeight > innerWidth && S.mode === 'playing' && S.t % 20 < 4));
}

function updateCamera(dt, spdN) {
  const crashed = S.mode === 'crashed';
  const accel = (S.speed - S.prevSpeed) / Math.max(dt, 1e-3);
  S.camYaw = damp(S.camYaw, S.heading, 4.5, dt);
  S.camPitch = damp(S.camPitch, S.pitch * 0.35, 4, dt);
  S.camY = damp(S.camY, S.pos.y, 6, dt); S.camY = clamp(S.camY, S.pos.y - 4, S.pos.y + 4); // tall 0-500 m climbs: never let the camera fall below the jet
  S.dolly = damp(S.dolly || 0, clamp(accel * 0.012, -2, 4), 3, dt);
  const portrait = camera.aspect < 1;
  const ck = S.car ? S.car.k : 0, back = ((portrait ? 25 : 16) + S.dolly + spdN * 2.5) * (1 - 0.05 * ck), up = (portrait ? 6.5 : 5.5) * (1 - 0.15 * ck);
  const cy = Math.cos(S.camYaw), sy = Math.sin(S.camYaw);
  if (!crashed) {
    camera.position.set(S.pos.x + sy * back, S.camY + up + Math.sin(S.camPitch) * -back * 0.4, S.pos.z + cy * back);
  } else {
    S.crashT += dt;
    camera.position.y += dt * 4;
  }
  const g = world.surface(camera.position.x, camera.position.z) + 2.5;
  if (camera.position.y < g) camera.position.y = g;
  const look = _v.set(S.pos.x - sy * 32, S.pos.y - 1.5 + Math.sin(S.camPitch) * 32, S.pos.z - cy * 32);
  if (crashed) look.copy(S.pos);
  camera.lookAt(look);
  camera.rotateZ(S.roll * 0.22 + (S.gRoll || 0) * 0.15); // gesture roll: controlled, partial camera follow
  // shake
  const kmh = S.speed * 3.6;
  const low = clamp(1 - S.agl / 40, 0, 1);
  S.shake = Math.max(0, S.shake - dt * 2.2);
  const amp = (crashed ? 0 : 0.02 + 0.22 * spdN * spdN + 0.12 * low * spdN + (kmh > 1180 && kmh < 1300 ? 0.15 : 0)) + S.shake * 0.8;
  const t = S.t;
  camera.position.x += (Math.sin(t * 37.1) * 0.6 + Math.sin(t * 61.7) * 0.4) * amp;
  camera.position.y += (Math.sin(t * 43.3) * 0.6 + Math.sin(t * 71.9) * 0.4) * amp;
  camera.rotation.z += Math.sin(t * 29.3) * amp * 0.004;
  // FOV: horizontal-fov driven so landscape & portrait both feel right
  const hfov = 92 + 22 * spdN * spdN + 8 * (S.boostFx || 0);
  let vfov = 2 * Math.atan(Math.tan(hfov * Math.PI / 360) / camera.aspect) * 180 / Math.PI;
  vfov = clamp(vfov, 45, portrait ? 92 : 80);
  S.fov = damp(S.fov, vfov, 3, dt);
  camera.fov = S.fov; camera.updateProjectionMatrix();
  if (window.__camAt) { const c = window.__camAt; camera.position.set(c[0], c[1], c[2]); camera.lookAt(c[3], c[4], c[5]); camera.fov = 60; camera.updateProjectionMatrix(); return; } // test/screenshot hook
  if (params.has('shipview') || window.__shipview) { // close-up beauty camera for screenshots
    const a = S.heading + (window.__shipA ?? 2.35), d = window.__shipD ?? 17;
    camera.position.set(S.pos.x - Math.sin(a) * d, S.pos.y + (window.__shipH ?? 4.5), S.pos.z - Math.cos(a) * d);
    camera.lookAt(S.pos); camera.fov = 40; camera.updateProjectionMatrix();
  }
}


// ---------- MISSILES: on-screen FIRE, auto-lock in a forward cone, homing, destructible obstacles ----------
const MS = { ammo: 6, max: 6, regenT: 0, REGEN: 1.6, cool: 0, list: [], lock: null, cands: [], scanT: 0, pylon: 1, fired: 0, kills: 0, debris: [] };
const misGeo = new THREE.CylinderGeometry(0.17, 0.22, 2.4, 8).rotateX(Math.PI / 2);
const misMat = new THREE.MeshStandardMaterial({ color: 0x8d9198, metalness: 0.55, roughness: 0.45, emissive: new THREE.Color(0.25, 0.08, 0.02) });
const misPool = [];
for (let i = 0; i < 14; i++) {
  const m = new THREE.Mesh(misGeo, misMat); m.visible = false; scene.add(m);
  const g = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(1.0, 0.55, 0.2), blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, transparent: true, opacity: 0.95 }));
  g.scale.set(3.2, 3.2, 1); g.position.z = 1.4; m.add(g);
  misPool.push({ m, on: false, p: new THREE.Vector3(), v: new THREE.Vector3(), t: 0, tgt: null, trail: 0 });
}
const chunkGeo = new THREE.DodecahedronGeometry(1, 0);
for (let i = 0; i < 48; i++) {
  const m = new THREE.Mesh(chunkGeo, new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, flatShading: true }));
  m.visible = false; m.castShadow = true; scene.add(m);
  MS.debris.push({ m, v: new THREE.Vector3(), w: new THREE.Vector3(), t: 0 });
}
const TARGET_NAME = { spire: 'SPIRE', mesa: 'MESA', boulder: 'ROCK', tree: 'TREE', jtree: 'TREE', jet: 'HOSTILE' };
const _mt = new THREE.Vector3(), _md = new THREE.Vector3(), _mf = new THREE.Vector3(), _mx = new THREE.Vector3(), _mv = new THREE.Vector3(), _ma = new THREE.Vector3();
function aimPoint(o, out) {
  if (o.jet) return out.copy(o.p);
  const top = o._top ?? (o.type === 'boulder' ? o.y + o.r : o.y + o.h);
  const y = o.type === 'boulder' ? o.y + o.r * 0.45 : clamp(S.pos.y, o.y + (top - o.y) * 0.25, o.y + (top - o.y) * (o.type === 'jtree' ? 0.75 : 0.7));
  return out.set(o.x, y, o.z);
}
function targetRadius(o) { return o.jet ? 9 : o.type === 'boulder' ? o.r * 1.15 : o.type === 'jtree' ? o.r * 0.6 : o.type === 'mesa' ? o.r * 1.1 : o.r; }
// THREAT-BASED TARGETING: integrate the flight model forward ~3.5 s with the pilot's current steer/pitch input
// (heading, bank/turn-rate, pitch), then rank obstacles by time-to-impact along that predicted path
// (hit-box + 4 m). Rescanned every 80 ms, so the lock follows the player's steering. Falls back to the
// nearest obstacle in a 20-degree cone when nothing is on a collision course.
const MPATH = []; for (let i = 0; i <= 44; i++) MPATH.push(new THREE.Vector3());
function predictPath() {
  let x = S.pos.x, y = S.pos.y, z = S.pos.z, h = S.heading, st = S.steerS, pt = S.pitch;
  const sp = S.speed, spdN = spdNf(sp), T = Math.min(clamp(3.5 * Math.max(sp, 150) / 400, 2.5, 4), 3200 / Math.max(sp, 1)), n = 44, dt = T / n;
  const steer = S.steerIn ?? 0, pin = S.pitchIn ?? 0;
  MPATH[0].set(x, y, z);
  for (let i = 1; i <= n; i++) {
    st += (steer - st) * (1 - Math.exp(-9 * dt));
    h -= (0.62 + 0.9 * spdN) * st * dt; h = clamp(h, -1.15, 1.15);
    pt += (pin * 0.3 - pt) * (1 - Math.exp(-5 * dt));
    x += -Math.sin(h) * Math.cos(pt) * sp * dt; z += -Math.cos(h) * Math.cos(pt) * sp * dt;
    y = Math.min(y + clamp(Math.sin(pt) * sp, -130, 130) * dt, CEILING);
    MPATH[i].set(x, y, z);
  }
  return dt;
}
function scanTargets() {
  const cs = MS.cands; cs.length = 0;
  const dtp = predictPath();
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (const q of MPATH) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); z0 = Math.min(z0, q.z); z1 = Math.max(z1, q.z); }
  const PADH = AP_HALF + 4, cur = Math.floor(-S.pos.z / CHUNK_L), last = Math.floor(-z0 / CHUNK_L) + 1;
  _mf.copy(S.vel).normalize();
  const cosMax = Math.cos(20 * Math.PI / 180);
  let cone = null, coneScore = Infinity;
  for (let i = cur; i <= last; i++) {
    const ch = chunks.get(i); if (!ch) continue;
    for (const o of ch.objs) {
      if (o.dead || (o.type === 'boulder' && (o.r < 9 || o.r * 2 < 14))) continue; // floor rocks/boulders the ship flies over are ignored
      const R = targetRadius(o) + PADH + 40;
      if (o.x < x0 - R || o.x > x1 + R || o.z < z0 - R || o.z > z1 + R) {
        continue;
      }
      const top = o.type === 'boulder' ? o.y + o.r : o.y + o.h;
      let tti = Infinity;
      for (let k = 1; k < MPATH.length; k++) { // swept segment test against the obstacle's real profile
        const a = MPATH[k - 1], b = MPATH[k];
        const sx = b.x - a.x, sz = b.z - a.z, sl = sx * sx + sz * sz;
        let u = sl > 0 ? ((o.x - a.x) * sx + (o.z - a.z) * sz) / sl : 0; u = clamp(u, 0, 1);
        const cy = a.y + (b.y - a.y) * u;
        if (cy - AP_LOW > top + 2 || cy + AP_TOP < o.y) continue;
        const r = o.type === 'boulder' ? o.r * 1.15 : Math.max(radiusAt(o, clamp(cy - AP_LOW, o.y + 0.01, top - 0.01)), radiusAt(o, clamp(cy, o.y + 0.01, top - 0.01)), 0.6);
        const dx = a.x + sx * u - o.x, dz = a.z + sz * u - o.z;
        if (dx * dx + dz * dz < (r + PADH) * (r + PADH)) { tti = (k - 1 + u) * dtp; break; }
      }
      if (tti < Infinity && tti > 0.12) cs.push({ o, tti, d: Math.hypot(o.x - S.pos.x, o.z - S.pos.z) });
      else if (!cs.length) { // cone fallback candidate
        aimPoint(o, _mt); _md.subVectors(_mt, S.pos);
        const d = _md.length(); if (d < 60 || d > 1500) continue;
        const c = _md.dot(_mf) / d; if (c < cosMax) continue;
        const sc = d * (1 + (1 - c) * 40); if (sc < coneScore) { coneScore = sc; cone = { o, tti: Infinity, d }; }
      }
    }
  }
  cs.sort((a, b) => a.tti - b.tti);
  if (cs.length > 12) cs.length = 12;
  MS.threat = cs.length > 0;
  { let bj = null, bd = 2600; _mf.copy(S.vel).normalize(); for (const e of RX.enemies) { if (e.dead) continue; _md.subVectors(e.p, S.pos); const d = _md.length(); if (d < bd && _md.dot(_mf) > d * 0.45) { bd = d; bj = e; } } if (bj && (!cs.length || cs[0].tti > 1.2)) cs.unshift({ o: bj, tti: Infinity, d: bd }); }
  if (!cs.length && cone) cs.push(cone);
  MS.lock = cs.length ? cs[0].o : null;
  MS.lockTti = cs.length ? cs[0].tti : Infinity;
}
function incoming(o) { let n = 0; for (const m of misPool) if (m.on && m.tgt === o) n++; return n; }
function needed(o) { return o.jet ? Math.max(o.hp, 1) : o.type === 'mesa' || targetRadius(o) > 28 ? 2 : 1; }
function fireMissile(opt = {}) {
  if (S.mode !== 'playing') return false;
  const btn = $('fireBtn');
  if (!opt.free && (MS.ammo < 1 || MS.cool > 0)) { if (MS.ammo < 1) { btn.classList.remove('empty'); void btn.offsetWidth; btn.classList.add('empty'); } return false; }
  const m = misPool.find((x) => !x.on); if (!m) return false;
  if (!opt.free) scanTargets();
  // salvo logic: each missile takes the best target that is not yet covered, so rapid taps spread across targets
  let tgt = null; for (const c of MS.cands) if (incoming(c.o) < needed(c.o)) { tgt = c.o; break; }
  if (!tgt && MS.cands.length) tgt = MS.cands[0].o;
  if (opt.tgt) tgt = opt.tgt; if (opt.ride) tgt = null;
  if (!opt.free) { MS.ammo--; MS.cool = 0.1; MS.fired++; }
  MS.pylon = -MS.pylon;
  ship.updateMatrixWorld(true);
  if (opt.from) { m.p.copy(opt.from); m.p.y -= 1.2; } else m.p.set(MS.pylon * 3.4, -1.1, 0.6).applyMatrix4(ship.matrixWorld).add(RO);
  m.ride = !!opt.ride; m.freeze = (!opt.free || opt.g47Freeze) && (RX.warhead === 'freeze' || RX.freezeAmmo > 0 || RX.fzBonus > 0 || !!opt.g47Freeze); // effect fixed at launch time if (m.freeze && RX.warhead !== 'freeze' && !(RX.fzBonus > 0) && !opt.g47Freeze) RX.freezeAmmo--;
  m.m.children[0].material.color.setRGB(m.freeze ? 0.45 : 1.0, m.freeze ? 0.85 : 0.55, m.freeze ? 1.3 : 0.2);
  _mf.copy(S.vel).normalize();
  m.ref = Math.max(S.speed, 60); m.g47 = !!opt.g47; m.v0 = m.ref * (m.g47 ? 1.7 : 1.2); m.v.copy(_mf).multiplyScalar(m.v0); m.v.y -= 6; // launch at 1.2x ship speed
  m.t = 0; m.tgt = tgt; m.on = true; m.trail = 0; m.m.visible = true; m.m.position.copy(m.p);
  audio.missile && audio.missile();
  if (!opt.free) { btn.classList.remove('shot'); void btn.offsetWidth; btn.classList.add('shot'); }
  return m;
}
function destroyTarget(o, p) {
  o.dead = true; rebuildInstances();
  const R = targetRadius(o), big = clamp(R / 12, 0.6, 3.5);
  const isTree = o.type === 'tree' || o.type === 'jtree';
  // fireball + sparks (additive, HDR so it blooms)
  for (let i = 0; i < 50 * Math.min(big, 2); i++) {
    const a = Math.random() * 6.283, e = Math.random() * 1.4 - 0.3, sp = 20 + Math.random() * 60 * big;
    glow.spawn(p.x, p.y, p.z, Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + 10, Math.sin(a) * Math.cos(e) * sp, 0.5 + Math.random() * 0.9, 4 * big, 14 * big, 1, 3.2, 1.5 + Math.random() * 0.6, 0.35, 1.6, -6);
  }
  for (let i = 0; i < 24; i++) glow.spawn(p.x, p.y, p.z, (Math.random() - 0.5) * 220, Math.random() * 120, (Math.random() - 0.5) * 220, 0.6 + Math.random() * 0.8, 0.8, 0.3, 1, 3.5, 2.6, 1.2, 1.0, -40);
  // smoke / dust / leaf burst
  const dc = isTree ? [0.25, 0.4, 0.15] : E.dust;
  for (let i = 0; i < 26 * Math.min(big, 2); i++) {
    const a = Math.random() * 6.283, sp = 10 + Math.random() * 35 * big, k = Math.random();
    const col = k < 0.5 ? [0.12, 0.11, 0.1] : [dc[0] * 0.6, dc[1] * 0.6, dc[2] * 0.6];
    dust.spawn(p.x, p.y, p.z, Math.cos(a) * sp, 4 + Math.random() * 18, Math.sin(a) * sp, 2.5 + Math.random() * 2.5, 6 * big, 30 * big, 0.75, col[0], col[1], col[2], 1.1, 1.5);
  }
  const g0 = world.surface(o.x, o.z);
  shock.spawn(new THREE.Vector3(p.x, Math.max(p.y, g0 + 1), p.z), new THREE.Vector3(0, 1, 0), 40 + R * 3, 0.9, new THREE.Color(1, 0.75, 0.45), 0.8);
  shock.spawn(p.clone(), _mf.clone().negate(), 25 + R * 2, 0.5, new THREE.Color(1, 0.9, 0.7), 0.6);
  // debris chunks of the target's own material colour
  const base = isTree ? [0.3, 0.22, 0.14] : [o.col[0] * 0.55, o.col[1] * 0.42, o.col[2] * 0.33];
  let n = 0;
  for (const d of MS.debris) {
    if (d.t > 0) continue;
    if (n++ >= 10 + 6 * Math.min(big, 2)) break;
    const sc = (0.6 + Math.random() * 1.6) * Math.min(big, 2.2) * (isTree ? 0.6 : 1);
    d.m.scale.set(sc, sc * (0.6 + Math.random() * 0.6), sc); d.m.material.color.setRGB(base[0], base[1], base[2], LIN);
    d.m.position.set(p.x + (Math.random() - 0.5) * R, p.y + (Math.random() - 0.3) * R, p.z + (Math.random() - 0.5) * R);
    const a = Math.random() * 6.283, sp = 25 + Math.random() * 55;
    d.v.set(Math.cos(a) * sp, 15 + Math.random() * 45, Math.sin(a) * sp); d.w.set(Math.random() * 8, Math.random() * 8, Math.random() * 8);
    d.t = 4 + Math.random() * 2; d.m.visible = true;
  }
  audio.explode();
  const dist = p.distanceTo(S.pos);
  flash(clamp(0.35 - dist / 2500, 0.05, 0.3)); S.shake = Math.max(S.shake, clamp(1.4 - dist / 500, 0.2, 1.2));
  const pts = Math.round((150 + R * 10) * (o.type === 'mesa' ? 2 : 1) / 10) * 10;
  S.score += pts; MS.kills++; S.kills = (S.kills || 0) + 1;
  pop('💥 ' + TARGET_NAME[o.type] + ' DESTROYED +' + pts, 'close');
}
function airburst(p) {
  for (let i = 0; i < 18; i++) glow.spawn(p.x, p.y, p.z, (Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60, 0.5, 3, 9, 1, 3, 1.6, 0.4, 1.5, 0);
  for (let i = 0; i < 8; i++) dust.spawn(p.x, p.y, p.z, (Math.random() - 0.5) * 20, 3, (Math.random() - 0.5) * 20, 2, 4, 14, 0.6, 0.14, 0.13, 0.12, 1, 0);
}
function updateMissiles(dt) {
  if (S.mode === 'playing') {
    MS.cool -= dt;
    if (MS.ammo < MS.max) { MS.regenT += dt; if (MS.regenT >= MS.REGEN) { MS.regenT = 0; MS.ammo++; } } else MS.regenT = 0;
    MS.scanT -= dt; if (MS.scanT <= 0) { MS.scanT = 0.08; scanTargets(); }
  } else MS.lock = null;
  for (const m of misPool) {
    if (!m.on) continue;
    m.t += dt;
    if (m.tgt && m.tgt.dead) { // target already destroyed by a salvo partner: pick the next one in the cone
      m.tgt = null; for (const c of MS.cands) if (!c.o.dead) { m.tgt = c.o; break; }
    }
    // speed profile: launch 1.2x ship speed -> 1.8x by t=1 s -> keep accelerating to 3700 km/h max, never below 1.2x ship
    const ref = m.ref || Math.max(S.speed, 60), lm = m.g47 ? 1.7 : 1.2, VMAX = Math.max(ref * (m.g47 ? 2.8 : 2.2), 3700 / 3.6);
    let sp = ref * lm + (VMAX - ref * lm) * Math.min(m.t / 2, 1);
    sp = Math.max(sp, S.speed * 1.05);
    if (m.ride) sp = MPOV_KMH / 3.6;
    m.spd = sp;
    _mf.copy(m.v).normalize();
    if (m.ride) steerRide(m, dt);
    else if (m.tgt && m.t > 0.08) {
      // proportional navigation (N=4): a = N * (LOS-rate x Vm); target is static so Vrel = -Vm
      aimPoint(m.tgt, _mt); _md.subVectors(_mt, m.p);
      const r2 = Math.max(_md.lengthSq(), 1);
      _mx.copy(_md).cross(m.tgt.jet ? _mv.copy(m.tgt.v).sub(m.v) : _mv.copy(m.v).negate()).divideScalar(r2);          // LOS angular rate
      _ma.copy(_mx).cross(m.v).multiplyScalar(4);                             // a = N * (Omega x Vm), N = 4
      if (r2 < 220 * 220 || _md.dot(m.v) < 0) { _md.normalize(); _mf.lerp(_md, Math.min(1, 10 * dt)); } // terminal pursuit blend
      m.v.copy(_mf).multiplyScalar(sp).addScaledVector(_ma, dt);
      m.v.setLength(sp);
    } else m.v.copy(_mf).multiplyScalar(sp);
    const px = m.p.x, py = m.p.y, pz = m.p.z;
    m.p.addScaledVector(m.v, dt);
    m.m.position.copy(m.p); m.m.lookAt(m.p.x - m.v.x, m.p.y - m.v.y, m.p.z - m.v.z);
    // smoke trail + motor glow, interpolated along the step so it is continuous at any fps
    if (m.t > 0.05) {
      const nTr = Math.ceil(Math.hypot(m.p.x - px, m.p.z - pz) / 6);
      for (let i = 0; i < nTr && i < 30; i++) {
        const u = Math.random();
        dust.spawn(px + (m.p.x - px) * u, py + (m.p.y - py) * u, pz + (m.p.z - pz) * u, (Math.random() - 0.5) * 3, 1 + Math.random() * 2, (Math.random() - 0.5) * 3, 1.4 + Math.random() * 0.8, 1.2, 6 + Math.random() * 4, 0.42, 0.75, 0.74, 0.72, 1.5, 0.6);
      }
      if (Math.random() < 0.7) glow.spawn(m.p.x, m.p.y, m.p.z, 0, 0, 0, 0.12, 2.6, 0.6, 1, 3.0, 1.6, 0.5, 0, 0);
    }
    // impact: swept closest approach to the target's aim point (no tunnelling at 1000+ m/s)
    let hit = false;
    if (m.ride) { const o = rideHits(m, px, py, pz); if (o) { hit = true; if (o.jet) damageJet(o, 3, m.p); else if (m.freeze) freezeHit(o, m.p); else destroyTarget(o, m.p); } }
    else if (m.tgt) {
      aimPoint(m.tgt, _mt);
      const sx = m.p.x - px, sy = m.p.y - py, sz = m.p.z - pz, sl = sx * sx + sy * sy + sz * sz;
      let u = sl > 0 ? ((_mt.x - px) * sx + (_mt.y - py) * sy + (_mt.z - pz) * sz) / sl : 1; u = clamp(u, 0, 1);
      const cx = px + sx * u, cy = py + sy * u, cz = pz + sz * u;
      const hd = Math.hypot(cx - _mt.x, cz - _mt.z), vd = Math.abs(cy - _mt.y);
      const R = targetRadius(m.tgt);
      if (hd < R + 4 && vd < Math.max(R, 10)) { m.p.set(cx, cy, cz); hit = true; if (m.tgt.jet) damageJet(m.tgt, 1, m.p); else if (m.freeze) freezeHit(m.tgt, m.p); else destroyTarget(m.tgt, m.p); }
    }
    if (!hit && (m.p.y < world.surface(m.p.x, m.p.z) + 0.5 || m.t > (m.ride ? 9 : 6))) { hit = true; if (m.freeze) freezeHit(null, m.p); else airburst(m.p); }
    if (hit) { m.on = false; m.m.visible = false; }
  }
  for (const d of MS.debris) {
    if (d.t <= 0) continue;
    d.t -= dt; d.v.y -= 30 * dt; d.m.position.addScaledVector(d.v, dt);
    d.m.rotation.x += d.w.x * dt; d.m.rotation.y += d.w.y * dt;
    const g = world.surface(d.m.position.x, d.m.position.z);
    if (d.m.position.y < g) { d.m.position.y = g; d.v.multiplyScalar(0.45); d.v.y = Math.abs(d.v.y) * 0.4; d.w.multiplyScalar(0.6); }
    if (Math.random() < dt * 8) dust.spawn(d.m.position.x, d.m.position.y, d.m.position.z, 0, 2, 0, 1.2, 1, 5, 0.35, 0.13, 0.12, 0.11, 1, 0);
    if (d.t <= 0) d.m.visible = false;
  }
  // HUD: lock reticle + ammo pips
  const ret = $('lockRet');
  if (MS.lock && S.mode === 'playing') {
    aimPoint(MS.lock, _mt).sub(RO).project(camera);
    if (_mt.z < 1 && Math.abs(_mt.x) < 1.1 && Math.abs(_mt.y) < 1.1) {
      const x = (_mt.x * 0.5 + 0.5) * innerWidth, y = (-_mt.y * 0.5 + 0.5) * innerHeight;
      ret.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      ret.style.opacity = '1';
      if (MS._lockO !== MS.lock) { MS._lockO = MS.lock; ret.classList.remove('new'); void ret.offsetWidth; ret.classList.add('new'); }
      const dd = Math.round(Math.hypot(MS.lock.x - S.pos.x, MS.lock.z - S.pos.z));
      const tt = MS.lockTti < 99 ? ' · ' + MS.lockTti.toFixed(1) + ' s' : '';
      const lbl = TARGET_NAME[MS.lock.type] + ' ' + dd + ' m' + tt;
      if (MS._lockL !== lbl) { MS._lockL = lbl; ret.querySelector('span').textContent = lbl; }
      ret.classList.toggle('threat', !!MS.threat);
    } else ret.style.opacity = '0';
  } else ret.style.opacity = '0';
  { // missile speed readout (fastest missile in flight) next to the reticle
    let v = 0; for (const m of misPool) if (m.on) v = Math.max(v, m.spd || 0);
    const el = $('misSpd'), txt = v > 0 ? 'MSL ' + Math.round(v * 3.6).toLocaleString('en-US') + ' km/h' : '';
    if (el.textContent !== txt) el.textContent = txt;
  }
  if (MS._ammoShown !== MS.ammo) {
    MS._ammoShown = MS.ammo;
    const pips = $('ammoPips').children; for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('on', i < MS.ammo);
    $('fireBtn').classList.toggle('dry', MS.ammo < 1);
  }
}
function resetMissiles() {
  AP.thrCap = 0.5 * MAX_KMH / TOP_KMH; AP.best = null;
  MS.ammo = MS.max; MS.cool = 0; MS.lock = null; MS.kills = 0; MS.fired = 0;
  for (const m of misPool) { m.on = false; m.m.visible = false; }
  for (const d of MS.debris) { d.t = 0; d.m.visible = false; }
}
{
  const fb = $('fireBtn');
  fb.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); audio.resume(); fireMissile(); });
  fb.addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('keydown', (e) => { if ((e.code === 'Space' || e.code === 'KeyF') && !e.repeat) fireMissile(); });
}

// =====================================================================================
// REMIX FEATURES: upper world (sky deck), wingmen + freeze shockwave, missile camera,
// ULTRA / BLAST + Ice Age portal, hostile airspace, hazards, ghost mode, AI scanner,
// voice callouts, real G-force meter (all built on our own flight model & art)
// =====================================================================================
const RX = {
  ghost: false, wing: 0, warhead: 'he', ultra: false, scanner: localStorage.getItem('canyon.ai') === '1', forces: localStorage.getItem('canyon.forces') === '1',
  voice: localStorage.getItem('canyon.voice') !== '0', gfx: localStorage.getItem('canyon.gfx') !== '0',
  timeScale: 1, jolt: 0, joltT: 0, joltDir: 0, above: false, zones: [], nearZones: [], noPatch: false,
  ice: false, iceK: 0, iceTint: new THREE.Color(1, 1, 1), freezeAmmo: 0, freezeCool: 0, wave: null, frozen: [],
  ride: null, blast: null, blastCool: 0, land: null, g: 1, gMax: 1, blk: 0, red: 0, ph: 0, pvy: 0,
  phase: 0, smartM: true, g47h: true, g3far: false, cam: 'chase', camT: 1, super: false, xsurv: false, smart: false, mute: false, cig: false, gsupCool: 0,
  enemies: [], air: [], shots: [], rocks: [], geysers: [], nextRock: 0, nextGey: 0, hudT: 0, scanT: 0, scanTxt: '',
};
const ROOF_THICK = 24, ROOF_CLR = 5, DECK_HALF = 1100;
const ICE_TINT = new THREE.Color(1.55, 1.65, 1.9);
const spdNf = (sp) => Math.min(sp / (MAX_KMH / 3.6), 1);

// ---------- 1) UPPER WORLD: sky-deck zones with escape holes ----------
// military base pad: a levelled corridor along the whole 100 km so the base layout is never skipped
const BASE_HALF = 420;
function baseSide(A) { return (A.seed & 1) ? 1 : -1; }
function baseLevel(z) { const zz = Math.floor(z / 2000) * 2000, u = (z - zz) / 2000, a = world.gridHeight0(world.pathX(zz), zz), b = world.gridHeight0(world.pathX(zz + 2000), zz + 2000), k = u * u * (3 - 2 * u); return Math.max(a + (b - a) * k, 2) + 1; }
function baseCX(A, z) { return world.pathX(z) + baseSide(A) * 180; }
function baseFlatK(x, z) {
  const air = RX.air; if (!air || !air.length || !world || !world.gridHeight0) return null; const d = -z;
  for (const A of air) { if (d < A.start - 1500 || d > A.end + 1500) continue;
    const ends = Math.min((d - A.start + 1500) / 1500, (A.end + 1500 - d) / 1500, 1), off = Math.abs(x - baseCX(A, z));
    if (off > BASE_HALF + 250) return null; const k = Math.min(1, (BASE_HALF + 250 - off) / 250) * ends; const kk = k * k * (3 - 2 * k);
    return kk > 0 ? [kk, baseLevel(z)] : null; }
  return null;
}
function capObj(o) { // nothing on the map rises more than 450 m above the base ground (valley floor of the route)
  if (o.type !== 'spire' && o.type !== 'mesa' && o.type !== 'tree' && o.type !== 'jtree') return;
  const floor = Math.max(world.gridHeight0(world.pathX(o.z), o.z), 0), extra = o.type === 'spire' || o.type === 'mesa' ? 4 : 0;
  const maxH = floor + OBJ_CAP - 2 - o.y - extra; if (o.h > maxH) { o.h = maxH; if (o.h < 6) o.dead = true; }
}
function rxPatchWorld(w) {
  const g0 = w.gridHeight.bind(w); w.gridHeight0 = g0;
  w.gridHeight = (x, z) => { let h = g0(x, z); const bf = baseFlatK(x, z); if (bf) h = h + (bf[1] - h) * bf[0]; if (!(RX.inSim ? SIM.ab : RX.above) || RX.noPatch) return h; const r = roofAt(z); return r ? Math.max(h, r.t) : h; };
}
function rxGenZones(seed) {
  const rnd = makeRng((seed ^ 0x2545f491) >>> 0), Z = [];
  let d = params.has('roof') ? 700 : 6500 + rnd() * 5000;
  while (d < 3e6) {
    const len = 7000 + rnd() * 5000, holes = [];
    for (let h = d + 1100 + rnd() * 500; h < d + len - 500; h += 1500 + rnd() * 1300) { const w = 380 + rnd() * 80; if (params.has('holes')) holes.push([h, h + w]); } // skyholes disabled: deck is sealed visually and physically
    Z.push({ start: d, end: d + len, holes, b: null, t: null, mesh: null });
    d += len + 24000 + rnd() * 22000;
  }
  return Z;
}
function zoneReady(zn) {
  if (zn.b !== null) return zn.b > -1;
  let f = 0;
  let lo = 1e9;
  for (let d = zn.start - 300; d <= zn.end + 300; d += 80) { const z = -d, cx = world.pathX(z); for (const o of [-150, -100, -50, 0, 50, 100, 150]) { const h = Math.max(world.gridHeight0(cx + o, z), 0); f = Math.max(f, h); lo = Math.min(lo, h); } }
  zn.b = f + MAX_AGL + 25; zn.t = zn.b + ROOF_THICK; // deck underside sits above the 500 m cap so the SAFE ALTITUDE band is clear
  // only over open valley floors / sea with headroom above: rugged ground would form dead-end pockets under the deck
  if (zn.t > CEILING - 80 || f - lo > 130) { zn.b = -9; zn.t = -9; return false; }
  return true;
}
function zoneAt(d) { for (const zn of RX.nearZones) if (d >= zn.start && d <= zn.end && zn.b > -1) return zn; return null; }
function inHole(zn, d) { for (const h of zn.holes) if (d >= h[0] && d <= h[1]) return h; return null; }
function roofAt(z, x) { const d = -z, zn = zoneAt(d); return zn && !inHole(zn, d) && !(x !== undefined && mtn(zn, x, z)) ? zn : null; }
function mtn(zn, x, z) { return world.gridHeight0(x, z) > zn.b - 16; } // terrain pokes through the deck here: no ceiling, solid rock instead
function inSlab(y, zn) { return y + AP_TOP > zn.b && y - AP_LOW < zn.t; }
function buildDeck(zn) {
  const P = [], N = [], C = [], I = [];
  const quad = (a, b, c, d, n, col) => { const i = P.length / 3; for (const v of [a, b, c, d]) { P.push(v[0], v[1], v[2]); N.push(n[0], n[1], n[2]); C.push(col[0], col[1], col[2]); } I.push(i, i + 1, i + 2, i, i + 2, i + 3); };
  const SL = 60, NX = 22, b = zn.b, t = zn.t;
  const cut = [[zn.start, zn.end]];
  // spans of solid deck between holes
  const spans = []; let s = zn.start; for (const h of zn.holes) { spans.push([s, h[0]]); s = h[1]; } spans.push([s, zn.end]);
  const ICEDK = RX.ice; zn.iceBuilt = ICEDK; const rimC = ICEDK ? [0.62, 0.72, 0.82] : [0.32, 0.25, 0.17], botC = ICEDK ? [0.45, 0.55, 0.66] : [0.17, 0.13, 0.1];
  for (const [d0, d1] of spans) {
    for (let d = d0; d < d1 - 0.01; d += SL) {
      const e = Math.min(d + SL, d1), z0 = -d, z1 = -e, cx = world.pathX(-(d + e) / 2);
      const x0 = cx - DECK_HALF, x1 = cx + DECK_HALF, dx = (x1 - x0) / NX;
      for (let i = 0; i < NX; i++) {
        const xa = x0 + i * dx, xb = xa + dx;
        const n = world.noise(xa * 0.004 + 3.1, d * 0.004), m = world.noise(xa * 0.02, d * 0.02);
        const col = ICEDK ? [0.7 + 0.1 * n, 0.78 + 0.1 * n, 0.88 + 0.06 * m] : [0.13 + 0.09 * n + 0.04 * m, 0.2 + 0.1 * n, 0.07 + 0.04 * m];
        quad([xa, t, z0], [xb, t, z0], [xb, t, z1], [xa, t, z1], [0, 1, 0], col);
      }
      for (let i = 0; i < NX; i++) { const xa = x0 + i * dx, xb = xa + dx, n = world.noise(xa * 0.006 + 9.1, d * 0.006), st = 0.5 + 0.5 * Math.sin(d * 0.03 + n * 4);
        const cc = ICEDK ? [0.5 + 0.1 * n, 0.6 + 0.1 * n, 0.72 + 0.08 * st] : [0.36 + 0.12 * st + 0.06 * n, 0.19 + 0.07 * st, 0.09 + 0.04 * n]; quad([xa, b, z1], [xb, b, z1], [xb, b, z0], [xa, b, z0], [0, -1, 0], cc); }
    }
    // faces at the ends of each solid span (hole edges / zone ends)
    for (const [d, sg] of [[d0, 1], [d1, -1]]) {
      const z = -d, cx = world.pathX(z), x0 = cx - DECK_HALF, x1 = cx + DECK_HALF;
      if (sg > 0) quad([x0, b, z], [x1, b, z], [x1, t, z], [x0, t, z], [0, 0, 1], rimC);
      else quad([x1, b, z], [x0, b, z], [x0, t, z], [x1, t, z], [0, 0, -1], rimC);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); g.setIndex(I);
  const m = new THREE.Mesh(g, terrainMat); m.receiveShadow = true; m.castShadow = false; m.frustumCulled = false;
  scene.add(m); zn.mesh = m;
}
// ---------- v50: CAVERN — hanging sandstone stalactites under the sky deck, pillars + jungle below ----------
const STAL = (() => {
  const mk = (seed, sides, rings, jag) => { // unit stalactite: top at y=0, tip at y=-1, radius 1 at the top; layered faceted strata
    const r = makeRng(seed), P = [], C = [], I = [];
    for (let j = 0; j <= rings; j++) { const u = j / rings, y = -u, base = Math.pow(1 - u, 0.9) * (j === rings ? 0 : 1);
      const ledge = (j % 2 ? 1 + jag * (0.4 + r() * 0.6) : 1 - jag * 0.3 * r()); const tw = r() * 0.6;
      const band = (j % 3 === 0 ? 0.62 : 0.9) + 0.32 * r(); // strata band brightness (layered sandstone)
      for (let i = 0; i < sides; i++) { const a = (i / sides) * 6.2832 + tw + j * 0.3, rr = base * ledge * (0.85 + r() * 0.3);
        P.push(Math.cos(a) * rr, y, Math.sin(a) * rr); C.push(band, band * (0.92 + r() * 0.08), band * (0.9 + r() * 0.1)); } }
    for (let j = 0; j < rings; j++) for (let i = 0; i < sides; i++) { const a = j * sides + i, b = j * sides + (i + 1) % sides, c = a + sides, d = b + sides; I.push(a, c, b, b, c, d); }
    let g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); g.setIndex(I);
    g = g.toNonIndexed(); g.computeVertexNormals(); return g; // flat facets
  };
  const geos = [mk(11, 8, 14, 0.18), mk(29, 7, 11, 0.28), mk(47, 9, 18, 0.12)], lo = [mk(5, 5, 5, 0.15)];
  const sand = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0, color: 0xe0955a, emissive: 0x3a1a08 });
  const ice = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.15, metalness: 0.1, color: 0xa8d8ff, emissive: 0x0a2030, transparent: true, opacity: 0.88 });
  patchRockMaterial && false;
  return { geos, lo, sand, ice };
})();
function stalGen(zn) { // deterministic hanging spires for one deck zone; dead flags persist on the zone object
  if (zn.stal) return zn.stal; const r = makeRng(((zn.start | 0) ^ 0x51ed27) >>> 0), L = [];
  for (let d = zn.start + 60; d < zn.end - 60; d += 12 + r() * 14) {
    const z = -d, cx = world.pathX(z), n = 3 + ((r() * 4) | 0);
    for (let k = 0; k < n; k++) { const off = (r() * 2 - 1) * DECK_HALF * 0.95; if (Math.abs(off) < 220 && r() < 0.82) continue; // keep the corridor flyable but not empty
      const x = cx + off, floor = Math.max(world.gridHeight0(x, z), 0), head = zn.b - floor; if (head < 120) continue;
      const big = r(); const len = Math.min(head - 40, big < 0.55 ? 40 + r() * 140 : big < 0.9 ? 160 + r() * 180 : 300 + r() * 160), rad = clamp(len * (0.07 + r() * 0.07), 5, 46);
      L.push({ x, z, d, r: rad, L: len, v: (r() * 3) | 0, rot: r() * 6.28, dead: false }); } }
  zn.stal = L; return L;
}
function buildStal(zn) {
  const L = stalGen(zn), ice = RX.ice, grp = new THREE.Group(), BLK = 1000;
  for (let b0 = zn.start; b0 < zn.end; b0 += BLK) { const sub = L.filter((q) => q.d >= b0 && q.d < b0 + BLK && !q.dead); if (!sub.length) continue;
    for (let v = 0; v < 3; v++) { const vs = sub.filter((q) => q.v === v); if (!vs.length) continue;
      const m = new THREE.InstancedMesh(STAL.geos[v], ice ? STAL.ice : STAL.sand, vs.length); m.castShadow = false; m.receiveShadow = true;
      vs.forEach((q, i) => { _bp.set(q.x, zn.b + 6, q.z); _be.set(0, q.rot, 0); _bq.setFromEuler(_be); _bs.set(q.r * (ice ? 0.6 : 1), q.L + 6, q.r * (ice ? 0.6 : 1)); _bm.compose(_bp, _bq, _bs); m.setMatrixAt(i, _bm);
        const t = ice ? 1 : 0.8 + ((q.rot * 7) % 1) * 0.4; m.setColorAt(i, _sg.setRGB(t, t * (ice ? 1 : 0.93), t * (ice ? 1 : 0.85))); q.im = m; q.ii = i; });
      m.computeBoundingSphere(); grp.add(m); } }
  zn.stalIce = ice; scene.add(grp); zn.stalG = grp;
}
function stalBreak(q, zn, y) { q.dead = true; if (q.im) { q.im.setMatrixAt(q.ii, _bm.makeScale(0, 0, 0)); q.im.instanceMatrix.needsUpdate = true; }
  _v.set(q.x, y, q.z); airburst(_v.clone()); for (let i = 0; i < 40; i++) dust.spawn(q.x + (Math.random() - 0.5) * q.r * 2, y + (Math.random() - 0.5) * 30, q.z + (Math.random() - 0.5) * q.r * 2, (Math.random() - 0.5) * 40, -20 - Math.random() * 40, (Math.random() - 0.5) * 40, 2 + Math.random() * 2, 4, 18, 0.6, ...(RX.ice ? [0.8, 0.9, 1.0] : [0.62, 0.36, 0.18]), 1, 0.5);
  S.stalKills = (S.stalKills || 0) + 1; S.shake = Math.max(S.shake, 0.5); audio.explode && audio.explode(); }
function stalCheck() { // hanging spires are solid: crash unless GOD / PHASE / SUPERSAFE / GHOST (then they shatter); autopilot also shatters them (it can't see them)
  const zn = zoneAt(S.dist); if (!zn || !zn.stal || RX.above || S.pos.y > zn.b) return false;
  const L = zn.stal, d0 = Math.min(S.dist, -S.prevPos.z) - 60, d1 = Math.max(S.dist, -S.prevPos.z) + 60; let lo = 0, hi = L.length; while (lo < hi) { const m = (lo + hi) >> 1; if (L[m].d < d0) lo = m + 1; else hi = m; }
  const ax = S.prevPos.x, az = S.prevPos.z, bx = S.pos.x - ax, bz = S.pos.z - az, bb = bx * bx + bz * bz || 1;
  for (let i = lo; i < L.length && L[i].d <= d1; i++) { const q = L[i]; if (q.dead) continue;
    const t = clamp(((q.x - ax) * bx + (q.z - az) * bz) / bb, 0, 1), px = ax + bx * t, pz = az + bz * t, py = S.prevPos.y + (S.pos.y - S.prevPos.y) * t;
    const u = (zn.b + 6 - py) / (q.L + 6); if (u < 0 || u > 1) continue; const rad = q.r * (RX.ice ? 0.6 : 1) * Math.pow(1 - u, 0.9) * 1.05 + 2.5;
    const dx = q.x - px, dz = q.z - pz; if (dx * dx + dz * dz > rad * rad) continue;
    if (RX.god || RX.super || RX.ghost || RX.phase > 0 || S.autopilot || rxForceAP()) { stalBreak(q, zn, py); continue; }
    S.crashCause = 'STALACTITE'; return true; }
  return false;
}
function rxDeckObjs(idx, objs) { // trees & rocks on the deck top are real obstacles (collisions, autopilot, missiles)
  for (const zn of RX.zones) {
    const d0 = idx * CHUNK_L, d1 = d0 + CHUNK_L;
    if (zn.start > d1) break; if (zn.end < d0 || !zoneReady(zn)) continue;
    const rng = makeRng((idx * 7919 + 13) >>> 0);
    for (let k = 0; k < 26; k++) { // v50 cavern floor: standing sandstone pillars + rounded jungle trees + boulders
      const d = d0 + rng() * CHUNK_L, z = -d, side = rng() < 0.5 ? -1 : 1, x = world.pathX(z) + side * (60 + rng() * 900), ty = rng(); if (d < zn.start || d > zn.end) continue;
      const gy = world.gridHeight(x, z); if (gy < 0.5) continue;
      if (ty < 0.35) objs.push({ type: 'spire', x, y: gy - 4, z, r: 5 + rng() * 9, h: 40 + rng() * 140, valley: false, rot: rng() * 6.28, variant: (rng() * 4) | 0, col: [0.95, 0.55, 0.3], near: false, done: false });
      else if (ty < 0.85) { const r = 4 + rng() * 4; objs.push({ type: 'tree', x, y: gy - 0.5, z, r, h: r * (3 + rng() * 2), valley: false, rot: rng() * 6.28, variant: (rng() * 4) | 0, col: [0.55 + rng() * 0.3, 0.85 + rng() * 0.3, 0.45 + rng() * 0.2], near: false, done: false }); }
      else { const r = 3 + rng() * 5; objs.push({ type: 'boulder', x, y: gy - r * 0.35, z, r, h: 0, valley: false, rot: rng() * 6.28, variant: (rng() * 4) | 0, col: [0.95, 0.6, 0.38], near: false, done: false }); }
    }
    for (let k = 0; k < 16; k++) {
      const d = d0 + rng() * CHUNK_L; if (d < zn.start || d > zn.end || inHole(zn, d)) { rng(); rng(); continue; }
      const z = -d, side = rng() < 0.5 ? -1 : 1, x = world.pathX(z) + side * (170 + rng() * 820);
      if (rng() < 0.8) { const r = 3 + rng() * 3.5; objs.push({ type: 'tree', x, y: zn.t - 0.4, z, r, h: r * (3.2 + rng() * 1.6), valley: false, rot: rng() * 6.28, variant: (rng() * 4) | 0, col: [0.7 + rng() * 0.3, 0.8 + rng() * 0.3, 0.6 + rng() * 0.3], near: false, done: false, deck: true }); }
      else { const r = 2 + rng() * 2.5; objs.push({ type: 'boulder', x, y: zn.t - 0.3, z, r, h: 0, valley: false, rot: rng() * 6.28, variant: (rng() * 4) | 0, col: [0.8, 0.75, 0.7], near: false, done: false, deck: true }); }
    }
  }
}
function rxUpdateZones() {
  const d = S.dist; RX.nearZones.length = 0;
  for (const zn of RX.zones) {
    if (zn.start > d + 14000) break;
    if (zn.end < d - 1500) { if (zn.mesh) { scene.remove(zn.mesh); zn.mesh.geometry.dispose(); zn.mesh = null; } if (zn.stalG) { scene.remove(zn.stalG); zn.stalG = null; } continue; }
    if (!zoneReady(zn)) continue;
    RX.nearZones.push(zn);
    if (zn.mesh && zn.iceBuilt !== RX.ice) { scene.remove(zn.mesh); zn.mesh.geometry.dispose(); zn.mesh = null; }
    if (!zn.mesh && zn.start < d + 9000) buildDeck(zn);
    if (zn.stalG && zn.stalIce !== RX.ice) { scene.remove(zn.stalG); zn.stalG = null; }
    if (!zn.stalG && zn.start < d + 9000) buildStal(zn);
  }
}
// layer logic for the real ship (called every sub-step after moving)
function rxLayer() {
  if (!RX.nearZones.length) { RX.above = false; return; }
  const p = S.pos, d = -p.z, zn = zoneAt(d);
  if (!zn) { if (RX.above) RX.above = false; return; }
  if (RX.ghost) { RX.above = p.y > (zn.b + zn.t) / 2; return; }
  const hole = inHole(zn, d) || mtn(zn, p.x, p.z);
  if (RX.above) { if (p.y < zn.b - 2) RX.above = false; return; }
  if (hole) { if (p.y - AP_LOW > zn.t + 0.5) { RX.above = true; rxEnteredTop(); } return; }
  const pd = -S.prevPos.z, pzn = zoneAt(pd), covered = pzn && !inHole(pzn, pd) && !mtn(pzn, S.prevPos.x, S.prevPos.z) && !inSlab(S.prevPos.y, pzn);
  if (covered && S.prevPos.y < zn.b) { if (p.y > zn.b - ROOF_CLR) { p.y = zn.b - ROOF_CLR; S.pitch = Math.min(S.pitch, 0); if (S.vel.y > 0) S.vel.y = 0; } return; }
  if (p.y - AP_LOW > zn.t) { RX.above = true; rxEnteredTop(); }
}
function rxEnteredTop() { if (S.mode !== 'playing') return; pop('UPPER WORLD', 'unlock'); rxSay('Upper world. Landing available.', 'top'); S.score += 500; }
// predictive version for the autopilot / safe-mode sims
const SIM = { ab: false, hit: false };
function rxSimY(y, z, pz, py, x, px) {
  SIM.hit = false;
  if (!RX.nearZones.length || RX.ghost) return y;
  const d = -z, zn = zoneAt(d); if (!zn) { SIM.ab = false; return y; }
  const hole = inHole(zn, d) || mtn(zn, x, z);
  if (SIM.ab) { if (y < zn.b - 2) SIM.ab = false; return y; }
  if (hole) { if (y - AP_LOW > zn.t + 0.5) SIM.ab = true; return y; }
  const pzn = zoneAt(-pz), covered = pzn && !inHole(pzn, -pz) && !mtn(pzn, px, pz) && !inSlab(py, pzn);
  if (covered && py < zn.b) return Math.min(y, zn.b - ROOF_CLR);
  if (y - AP_LOW > zn.t) { SIM.ab = true; return y; }
  if (y + AP_TOP > zn.b) SIM.hit = true;
  return y;
}
// slab impact for the real ship (front faces / hole far edges)
function rxSlabCheck() {
  if (RX.ghost || !RX.nearZones.length) return false;
  const p = S.pos, zn = roofAt(p.z, p.x); if (!zn || !inSlab(p.y, zn)) return false;
  const up = p.y > (zn.b + zn.t) / 2;
  if (S.autopilot || rxForceAP() || S.noCollide) { p.y = up ? zn.t + AP_LOW + 1.5 : zn.b - ROOF_CLR; RX.above = up; AP.stats.saves++; AP.stats.lastSave = { zone: 'ROOF', kmh: Math.round(S.speed * 3.6) }; ship.position.copy(p); return false; }
  if (safeMode) { p.y = up ? zn.t + AP_LOW + 1.5 : zn.b - ROOF_CLR; RX.above = up; S.hp.B = Math.max(0, S.hp.B - 30); S.noContactT = 0; pop('SAFE MODE · DECK IMPACT ABSORBED', 'close'); flash(0.3); S.shake = 1.5; audio.scrape(1.2); ship.position.copy(p); if (S.hp.B <= 0) { S.crashCause = 'DECK IMPACT'; return true; } return false; }
  S.crashCause = 'SKY DECK IMPACT'; return true;
}
// ---- landing & rest on the deck ----
function rxCanLand() {
  if (!RX.above || S.mode !== 'playing' || RX.blast || RX.ride) return false;
  const d = S.dist, zn = zoneAt(d); if (!zn) return false;
  const need = S.speed / 1.6 + 500;
  if (zn.end < d + need) return false;
  for (const h of zn.holes) if (h[1] > d && h[0] < d + need) return false;
  return true;
}
function rxLandToggle() {
  if (S.land) { if (S.land.ph === 'rest' || S.land.ph === 'down') { S.land.ph = 'up'; S.land.t = 0; pop('TAKE OFF', 'banked'); rxSay('Taking off.', 'land'); } return; }
  if (!rxCanLand()) { pop(RX.above ? 'NO ROOM TO LAND HERE' : 'CLIMB TO THE UPPER WORLD TO LAND', 'close'); return; }
  if (S.autopilot) setAutopilot(false, true);
  S.land = { ph: 'down', t: 0 }; pop('LANDING', 'banked'); rxSay('Landing on the deck.', 'land');
}
function rxFlightOverride(dt) {
  const L = S.land; if (!L) return false;
  if (!RX.above || S.mode !== 'playing') { S.land = null; return false; }
  L.t += dt;
  const g = world.surface(S.pos.x, S.pos.z);
  (S.prevPos || (S.prevPos = new THREE.Vector3())).copy(S.pos); S.prevSpeed = S.speed;
  if (L.ph === 'down') {
    S.speed = Math.max(0, S.speed - (S.speed * 1.6 + 40) * dt);
    S.pos.y = damp(S.pos.y, g + 2.9, 2.2, dt); if (S.pos.y < g + 2.9) S.pos.y = g + 2.9;
    if (S.speed < 2) { L.ph = 'rest'; pop('LANDED · REPAIRING', 'unlock'); audio.chime(); }
  } else if (L.ph === 'rest') {
    S.speed = 0; S.pos.y = g + 2.9;
    for (const k of ['L', 'R', 'B']) S.hp[k] = Math.min(100, S.hp[k] + 22 * dt);
    if (controls.throttle > 0.85 && L.t > 1.5) { L.ph = 'up'; L.t = 0; }
  } else { // take-off roll + climb
    S.speed = Math.min(S.speed + 220 * dt, (MIN_KMH + controls.throttle * (TOP_KMH - MIN_KMH)) / 3.6);
    S.pos.y = Math.max(S.pos.y + clamp(S.speed * 0.05, 0, 25) * dt, g + 2.9);
    if (S.pos.y > g + 12 && S.speed > MIN_KMH / 3.6) { S.land = null; S.pitch = 0.05; }
  }
  S.heading = damp(S.heading, 0, 0.8, dt); S.pitch = damp(S.pitch, 0, 4, dt); S.roll = damp(S.roll, 0, 4, dt); S.steerS = damp(S.steerS, 0, 4, dt);
  S.vel.set(-Math.sin(S.heading) * S.speed, 0, -Math.cos(S.heading) * S.speed);
  S.pos.addScaledVector(S.vel, dt);
  S.agl = S.pos.y - world.surface(S.pos.x, S.pos.z);
  ship.position.copy(S.pos); ship.rotation.set(S.pitch, S.heading, S.roll);
  S.dist = Math.max(S.dist, -S.pos.z); S.time += dt;
  return true;
}

// ---------- shared jet meshes (wingmen / hostiles) built from our own ship ----------
function makeJet(tint, accent) {
  const g = ship.userData.body.clone(true);
  const kill = []; const hm = new Map();
  g.traverse((o) => {
    if (o.isLight || o === vapor || o.material === vaporMat) kill.push(o);
    if (!o.isMesh || !o.material) return;
    if (Object.values(ship.userData.dmgMats || {}).includes(o.material)) { kill.push(o); return; }
    if (ship.userData.hullMats.includes(o.material)) {
      if (!hm.has(o.material)) { const m = o.material.clone(); m.color.copy(o.material === ship.userData.hullMats[2] ? accent : tint); hm.set(o.material, m); }
      o.material = hm.get(o.material);
    }
  });
  for (const o of kill) o.parent && o.parent.remove(o);
  const root = new THREE.Group(); root.add(g); root.rotation.order = 'YXZ'; root.visible = false; scene.add(root);
  return root;
}
const _rq = new THREE.Vector3(), _rr = new THREE.Vector3(), _rf = new THREE.Vector3();
function headingFrame(h) { _rf.set(-Math.sin(h), 0, -Math.cos(h)); _rr.set(Math.cos(h), 0, -Math.sin(h)); }
function safeAlt(x, y, z, pad) { // lift a free-flying jet above terrain and nearby obstacles
  let m = world.surface(x, z) + pad;
  const ch = chunks.get(Math.floor(-z / CHUNK_L));
  if (ch) for (const o of ch.objs) { if (o.dead) continue; const dx = o.x - x, dz = o.z - z, rr = o.r * 1.4 + 9; if (dx * dx + dz * dz < rr * rr) m = Math.max(m, (o.type === 'boulder' ? o.y + o.r : o.y + o.h) + pad * 0.6); }
  const zn = roofAt(z); if (zn && !RX.above && y < zn.b) return Math.min(Math.max(y, m), zn.b - 8);
  return Math.max(y, m);
}

// ---------- 2) WINGMEN SQUAD + FREEZE SHOCKWAVE ----------
const WING_NAMES = ['Gs OFF', 'Gs · ESCORT', 'Gs · INTERCEPT'];
let wingmen = null;
function ensureWingmen() {
  if (wingmen) return;
  wingmen = [-1, 1].map((side, i) => ({ side, mesh: (() => { const m = makeJet(new THREE.Color(0x3d4a5a), new THREE.Color(0x1b2633)); m.scale.setScalar(0.4); return m; })(), p: new THREE.Vector3().copy(S.pos), v: new THREE.Vector3(), fireT: 0.6 + i * 0.5, roll: 0 }));
}
function setWing(m) { RX.wing = m; ensureWingmen(); if (m) for (const w of wingmen) w.p.copy(S.pos).addScaledVector(_rr, w.side * 30); pop(WING_NAMES[m], 'banked'); rxMenuSync(); }
function updateWingmen(dt) {
  if (!wingmen) return;
  const on = RX.wing > 0 && S.mode !== 'crashed';
  headingFrame(S.heading);
  for (const w of wingmen) {
    w.mesh.visible = on; if (!on) continue;
    if (S.land) { // park beside the player
      _rq.copy(S.pos).addScaledVector(_rr, w.side * 26).addScaledVector(_rf, -10); _rq.y = world.surface(_rq.x, _rq.z) + 2.9;
    } else if (RX.wing === 1) {
      _rq.copy(S.pos).addScaledVector(_rr, w.side * 24).addScaledVector(_rf, -16 - 4 * (w.side + 1)); _rq.y += 3 + w.side;
    } else {
      const k = clamp(Math.round(MPATH.length * 0.35), 4, MPATH.length - 1); const q = MPATH[k];
      _rq.copy(q).addScaledVector(_rr, w.side * 38); _rq.y += 8;
    }
    _rq.y = safeAlt(_rq.x, _rq.y, _rq.z, S.land ? 2.9 : 10);
    const px = w.p.x, pz = w.p.z;
    w.p.lerp(_rq, 1 - Math.exp(-(RX.wing === 2 ? 3.5 : 6) * dt));
    w.p.y = safeAlt(w.p.x, w.p.y, w.p.z, S.land ? 2.9 : 8);
    const lat = ((w.p.x - px) * _rr.x + (w.p.z - pz) * _rr.z) / Math.max(dt, 1e-3) - S.vel.x * _rr.x - S.vel.z * _rr.z;
    w.roll = damp(w.roll, clamp(-lat * 0.02, -0.9, 0.9) + S.roll * 0.6, 5, dt);
    w.mesh.position.copy(w.p); w.mesh.rotation.set(S.pitch, S.heading, w.roll);
    // point mode: fire at threats ahead on the player's path (does not cost the player's ammo)
    if (RX.wing === 2 && S.mode === 'playing' && !S.land) {
      w.fireT -= dt;
      if (w.fireT <= 0) {
        let tgt = null; for (const c of MS.cands) if (!c.o.dead && incoming(c.o) < needed(c.o) && (c.tti < 3.2 || c.o.jet)) { tgt = c.o; break; }
        if (tgt && fireMissile({ from: w.p, free: true, tgt })) w.fireT = 1.1; else w.fireT = 0.25;
      }
    }
  }
}
const waveMat = new THREE.ShaderMaterial({
  uniforms: { k: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  vertexShader: 'varying float vF; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vec3 n = normalize(normalMatrix*normal); vF = 1.0 - abs(dot(n, normalize(-mv.xyz))); gl_Position = projectionMatrix * mv; }',
  fragmentShader: 'uniform float k; varying float vF; void main(){ gl_FragColor = vec4(vec3(0.55,0.85,1.25) * (pow(vF,3.0)*1.4 + 0.04), k * (pow(vF,2.5) + 0.05)); }',
});
const waveMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 20), waveMat); waveMesh.visible = false; waveMesh.frustumCulled = false; waveMesh.renderOrder = 14; scene.add(waveMesh);
function freezeWave() {
  if (S.mode !== 'playing') return;
  if (RX.freezeCool > 0) { pop('SHOCKWAVE RECHARGING ' + RX.freezeCool.toFixed(1) + ' s', 'close'); return; }
  RX.freezeCool = 7; RX.wave = { t: 0, p: S.pos.clone(), R: 0, n: 0 };
  audio.boom(); flash(0.25); S.shake = Math.max(S.shake, 0.8); pop('❄ FREEZE SHOCKWAVE', 'unlock'); rxSay('Freeze shockwave.', 'wave');
  shock.spawn(S.pos.clone(), new THREE.Vector3(0, 1, 0), 160, 0.8, new THREE.Color(0.6, 0.9, 1.3), 0.9);
}
const ICE_COL = [0.75, 0.95, 1.35];
const ICE_CRACK_COL = [0.55, 0.68, 0.85];
function freezeObj(o, delay) {
  if (o.dead || o.frozen != null || o.jet) return false;
  o.col0 = o.col; o.col = ICE_COL; o.frozen = delay; RX.frozen.push(o); RX.instDirty = true; return true;
}
function shatterIce(o) {
  if (o.dead) return;
  aimPoint(o, _rq);
  o.dead = true; RX.instDirty = true;
  const R = targetRadius(o), big = clamp(R / 12, 0.6, 2.5);
  for (let i = 0; i < 26 * big; i++) { const a = Math.random() * 6.283, e = Math.random() * 1.2 - 0.2, sp = 15 + Math.random() * 45 * big; glow.spawn(_rq.x, _rq.y, _rq.z, Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp + 8, Math.sin(a) * Math.cos(e) * sp, 0.4 + Math.random() * 0.6, 2.5 * big, 7 * big, 0.9, 1.5, 2.2, 3.0, 1.6, -18); }
  for (let i = 0; i < 12 * big; i++) dust.spawn(_rq.x, _rq.y, _rq.z, (Math.random() - 0.5) * 40, 4 + Math.random() * 14, (Math.random() - 0.5) * 40, 2 + Math.random() * 2, 5 * big, 22 * big, 0.55, 1.4, 1.5, 1.6, 1.0, 1.2);
  let n = 0;
  for (const d of MS.debris) { if (d.t > 0) continue; if (n++ >= 7) break; const sc = (0.5 + Math.random() * 1.3) * Math.min(big, 2); d.m.scale.set(sc, sc * 0.7, sc); d.m.material.color.setRGB(0.7, 0.88, 1.1, LIN); d.m.position.set(_rq.x + (Math.random() - 0.5) * R, _rq.y, _rq.z + (Math.random() - 0.5) * R); const a = Math.random() * 6.283, sp = 20 + Math.random() * 40; d.v.set(Math.cos(a) * sp, 12 + Math.random() * 35, Math.sin(a) * sp); d.w.set(Math.random() * 8, Math.random() * 8, Math.random() * 8); d.t = 3 + Math.random() * 2; d.m.visible = true; }
  if ((RX.shatterSnd = (RX.shatterSnd || 0) + 1) % 3 === 1) audio.explode();
  S.score += 60; MS.kills++;
}
function updateFreeze(dt) {
  RX.freezeCool = Math.max(0, RX.freezeCool - dt);
  const W = RX.wave;
  if (W) {
    W.t += dt; W.R = 1150 * (1 - Math.exp(-W.t * 2.3));
    waveMesh.visible = true; waveMesh.position.copy(W.p).addScaledVector(S.vel, W.t * 0.6); waveMesh.scale.setScalar(Math.max(W.R, 1)); waveMat.uniforms.k.value = clamp(1.2 - W.t * 0.6, 0, 1);
    const cur = Math.floor(-W.p.z / CHUNK_L);
    for (let i = cur - 1; i <= cur + 6 && W.n < 60; i++) {
      const ch = chunks.get(i); if (!ch) continue;
      for (const o of ch.objs) {
        if (o.dead || o.frozen != null || (o.type === 'boulder' && o.r < 3)) continue;
        const dx = o.x - waveMesh.position.x, dz = o.z - waveMesh.position.z;
        if (dx * dx + dz * dz < W.R * W.R && freezeObj(o, 0.8 + Math.random() * 0.4)) W.n++;
      }
    }
    for (const e of RX.enemies) if (!e.dead && e.p.distanceTo(waveMesh.position) < W.R) { if (!e.waved) { e.waved = true; damageJet(e, 2, e.p); } }
    if (W.t > 2) { RX.wave = null; waveMesh.visible = false; for (const e of RX.enemies) e.waved = false; }
  }
  let shat = 0;
  for (let i = RX.frozen.length - 1; i >= 0; i--) {
    const o = RX.frozen[i]; o.frozen -= dt;
    if (!o.cracked && o.frozen < 0.4 && !o.dead) { o.cracked = true; o.col = ICE_CRACK_COL; RX.instDirty = true; aimPoint(o, _rq); const R0 = targetRadius(o); for (let k = 0; k < 16; k++) { const a = Math.random() * 6.283; glow.spawn(_rq.x + Math.cos(a) * R0 * 0.8, _rq.y + (Math.random() - 0.5) * R0, _rq.z + Math.sin(a) * R0 * 0.8, 0, 0, 0, 0.35, 0.8, 2.5, 1, 2.6, 2.8, 3.0, 0, 0); } if ((RX.crk = (RX.crk || 0) + 1) % 4 === 1) audio.scrape(0.5); } // crack stage before fragmentation
    if (o.frozen <= 0 && shat < 4) { shat++; shatterIce(o); RX.frozen.splice(i, 1); }
    else if (o.dead) RX.frozen.splice(i, 1);
  }
}

// ---------- 3) MISSILE CAMERA (ride a missile in slow motion) + freeze warheads ----------
function rideToggle(fromG47) {
  if (RX.ride) { endRide(); return; }
  if (S.mode !== 'playing' || S.land) return;
  if (fromG47 && !RX.carrier) setCarrier(true);
  const m = fromG47 && carrier ? fireMissile({ ride: true, free: true, from: carrier.p, g47: true, g47Freeze: RX.g47fz }) : fireMissile({ ride: true }); if (!m) { pop('NO MISSILES', 'close'); return; }
  m.spd = MPOV_KMH / 3.6; m.v.setLength(m.spd); RX.ride = m; $('rxExit').classList.remove('hidden'); pop('MISSILE CAM · STEER WITH TILT / DRAG', 'unlock'); rxSay('Missile camera.', 'ride');
}
function endRide() { if (RX.ride) { RX.ride.ride = false; } RX.ride = null; $('rxExit').classList.add('hidden'); }
function steerRide(m, dt) {
  const st = clamp(controls.steer, -1, 1), pt = clamp(controls.pitch, -1, 1);
  _rq.copy(m.v).normalize();
  _rq.applyAxisAngle(_v.set(0, 1, 0), -st * 1.9 * dt);
  _rr.crossVectors(_rq, _v.set(0, 1, 0)).normalize();
  _rq.applyAxisAngle(_rr, pt * 1.5 * dt);
  _rq.y = clamp(_rq.y, -0.8, 0.8); _rq.normalize();
  m.v.copy(_rq).multiplyScalar(m.spd || m.v.length());
}
function rideHits(m, px, py, pz) { // free-flying ride missile: swept test against everything near its path
  const cur = Math.floor(-m.p.z / CHUNK_L);
  const sx = m.p.x - px, sz = m.p.z - pz, sl = sx * sx + sz * sz;
  for (let i = cur - 1; i <= cur + 1; i++) {
    const ch = chunks.get(i); if (!ch) continue;
    for (const o of ch.objs) {
      if (o.dead) continue;
      let u = sl > 0 ? ((o.x - px) * sx + (o.z - pz) * sz) / sl : 1; u = clamp(u, 0, 1);
      const cx = px + sx * u, cz = pz + sz * u, cy = py + (m.p.y - py) * u;
      const top = o.type === 'boulder' ? o.y + o.r * 1.6 : o.y + o.h;
      if (cy < o.y - 1 || cy > top + 1) continue;
      const r = o.type === 'boulder' ? o.r * 1.15 : Math.max(radiusAt(o, clamp(cy, o.y + 0.01, top - 0.01)), 0.8);
      if (Math.hypot(cx - o.x, cz - o.z) < r + 2.5) { m.p.set(cx, cy, cz); return o; }
    }
  }
  for (const e of RX.enemies) if (!e.dead && e.p.distanceTo(m.p) < 14) return e;
  return null;
}
function freezeHit(o, p) { // freeze warhead: target + neighbours within 80 m flash-freeze, then shatter
  for (let i = 0; i < 30; i++) glow.spawn(p.x, p.y, p.z, (Math.random() - 0.5) * 90, Math.random() * 60, (Math.random() - 0.5) * 90, 0.6, 3, 10, 1, 1.2, 2.2, 3.2, 1.4, 0);
  shock.spawn(p.clone(), new THREE.Vector3(0, 1, 0), 90, 0.7, new THREE.Color(0.6, 0.9, 1.3), 0.9);
  audio.boom();
  const cur = Math.floor(-p.z / CHUNK_L); let n = 0;
  if (o && !o.jet) { freezeObj(o, 0.45); n++; }
  for (let i = cur - 1; i <= cur + 1; i++) { const ch = chunks.get(i); if (!ch) continue; for (const q of ch.objs) { if (q.dead || q === o) continue; const dx = q.x - p.x, dz = q.z - p.z; if (dx * dx + dz * dz < 80 * 80 && freezeObj(q, 0.5 + Math.random() * 0.5)) n++; } }
  pop('❄ FREEZE HIT · ' + n + ' FROZEN', 'unlock');
}

// ---------- 4) ULTRA speed + BLAST boost into the Ice Age portal ----------
function megaBoom() { // one-shot destructive 100,000 km/h boom: destroys every obstacle within 27 km (later chunks too); detailed debris only for the nearest
  flash(1); S.shake = 3; audio.boom(); audio.explode();
  shock.spawn(S.pos.clone(), new THREE.Vector3(0, 1, 0), 1500, 1.4, new THREE.Color(1.4, 1.2, 1.0), 1);
  S.boomZone = { x: S.pos.x, z: S.pos.z, r: 27000 }; let n = 0;
  for (const ch of chunks.values()) for (const o of ch.objs) if (!o.dead && Math.hypot(o.x - S.pos.x, o.z - S.pos.z) < 27000) { o.dead = true; n++; if (n < 40) airburst(_v.set(o.x, o.y + (o.h || 0) * 0.5, o.z)); }
  RX.instDirty = true; pop('100,000 KM/H · HYPERSONIC BOOM · ' + n + ' DESTROYED', 'unlock'); rxSay('Hypersonic boom.', 'boom');
}
function setUltra(on) {
  RX.ultra = on; TOP_KMH = on ? ULTRA_KMH : NORMAL_KMH;
  hud.machMark.style.bottom = (Math.pow((MACH_KMH - MIN_KMH) / (TOP_KMH - MIN_KMH), 1 / 2.2) * 100) + '%';
  pop(on ? 'ULTRA · TOP SPEED 124,700 KM/H' : 'ULTRA OFF · 35,620 KM/H', 'mach'); rxSay(on ? 'Ultra speed unlocked.' : 'Ultra off.', 'ultra'); rxMenuSync();
}
const portalMat = new THREE.ShaderMaterial({
  uniforms: { time: { value: 0 }, k: { value: 0 }, ice: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform float time; uniform float k; uniform float ice; varying vec2 vUv;
    void main(){ vec2 p = vUv * 2.0 - 1.0; float r = length(p), a = atan(p.y, p.x);
      float ring = smoothstep(0.08, 0.0, abs(r - 0.92)) * 2.2;
      float sw = 0.5 + 0.5 * sin(a * 7.0 + r * 16.0 - time * 9.0);
      float disc = smoothstep(0.95, 0.2, r) * (0.25 + 0.55 * sw * smoothstep(0.0, 0.7, r)) * (0.05 + 0.95 * smoothstep(0.15, 0.8, r)) * 0.8; // v44: darker centre, less white bloom
      vec3 cA = mix(vec3(0.5, 0.85, 1.4), vec3(1.4, 0.75, 0.35), ice), cB = mix(vec3(0.7, 0.85, 1.2), vec3(1.1, 0.85, 0.6), ice);
      gl_FragColor = vec4(mix(cA, cB, sw) * (ring + disc), (ring + disc) * k * step(r, 1.05)); }`,
});
const portal = new THREE.Mesh(new THREE.PlaneGeometry(220, 220), portalMat); portal.visible = false; portal.frustumCulled = false; portal.renderOrder = 15; scene.add(portal);
// GPU-particle portal: fragments stream in from all around and converge into the ring; count adapts to the device
const PFX = (() => {
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent), cores = navigator.hardwareConcurrency || 4;
  const max = TEST ? 120000 : mobile ? (cores >= 8 ? 600000 : 250000) : cores >= 8 ? 2000000 : 800000;
  const g = new THREE.BufferGeometry(), a = new Float32Array(max * 4);
  for (let i = 0; i < a.length; i++) a[i] = Math.random();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 3), 3)); g.setAttribute('aR', new THREE.BufferAttribute(a, 4));
  const mat = new THREE.ShaderMaterial({ uniforms: { k: { value: 0 }, time: { value: 0 }, flash: { value: 0 }, ice: { value: 0 }, px: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `uniform float k; uniform float time; uniform float flash; uniform float px; attribute vec4 aR; varying float vA; varying float vH;
      void main(){
        float u = clamp(k * 1.25 - aR.w * 0.25, 0.0, 1.0); float e = u * u * (3.0 - 2.0 * u);
        float th = aR.x * 6.2832, ph = acos(aR.y * 2.0 - 1.0), R0 = 700.0 + aR.z * 1400.0;
        vec3 st = vec3(sin(ph) * cos(th), sin(ph) * sin(th) * 0.8, -abs(cos(ph)) - 0.15) * R0; // fragments come from beyond the ring
        float ang = th + e * 3.5 * (aR.z - 0.3) + time * (0.6 + aR.w);
        float rr = 92.0 + (aR.z - 0.5) * 30.0 * (1.0 - e * 0.6);
        vec3 ring = vec3(cos(ang) * rr, sin(ang) * rr, (aR.w - 0.5) * 12.0);
        vec3 p = mix(st, ring, e);
        p += normalize(p + 0.001) * flash * 260.0 * aR.z;
        vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(px * (1.0 + 2.0 * aR.w) * 700.0 / -mv.z, 1.0, 3.2);
        vA = (0.04 + 0.2 * e) * step(0.001, k) * (1.0 + flash * 2.0) * clamp(1.0 - flash * 0.8, 0.0, 1.0) + flash * 0.4 * (1.0 - flash * 0.6); vH = aR.y; }`,
    fragmentShader: `uniform float ice; varying float vA; varying float vH;
      void main(){ vec2 c = gl_PointCoord - 0.5; float d = dot(c, c); if (d > 0.25) discard; vec3 col = mix(mix(vec3(0.9, 0.3, 1.6), vec3(0.2, 0.8, 1.8), vH), vec3(0.7, 1.3, 2.0), ice); gl_FragColor = vec4(col * 0.17 * (1.0 - d * 3.0), vA * 0.6); }` });
  const pts = new THREE.Points(g, mat); pts.frustumCulled = false; pts.renderOrder = 16; portal.add(pts);
  return { pts, mat, max, n: max, slowT: 0 };
})();
function blastGo() {
  if (S.car) { if (S.car.dir > 0) xform(); S.blastAfter = true; pop('TRANSFORMING TO FLIGHT FOR BLAST', 'banked'); return; }
  if (S.mode !== 'playing' || RX.blast || S.land) return;
  if (RX.blastCool > 0) { pop('BLAST RECHARGING ' + Math.ceil(RX.blastCool) + ' s', 'close'); return; }
  endRide(); RX.blast = { t: 0, portal: null, passed: false };
  audio.boom(); flash(0.5); S.shake = 2; pop('BLAST · 470,000 KM/H · SHIELD UP', 'mach'); rxSay(RX.ice ? 'Blast. Portal home opening.' : 'Blast. Portal opening.', 'blast');
}
function blastExit() { // drop out of BLAST at the normal top speed; squad comes through the portal with you
  S.speed = Math.min(S.speed, TOP_KMH / 3.6 * 0.5); S.prevSpeed = S.speed; streamChunks(S.pos.z, true); AP.best = null;
  headingFrame(S.heading); for (const w of (wingmen || [])) w.p.copy(S.pos).addScaledVector(_rr, w.side * 30);
  if (typeof carrier !== 'undefined' && carrier) { carrier.p.copy(S.pos).addScaledVector(_rf, 400).y += 80; for (const h of carrier.helpers) h.p.copy(carrier.p); }
  if (typeof drone !== 'undefined' && drone) drone.p.copy(S.pos).addScaledVector(_rf, 900);
}
function updateBlast(dt) {
  RX.blastCool = Math.max(0, RX.blastCool - dt);
  portalMat.uniforms.time.value = S.t;
  const B = RX.blast; if (!B) { portal.visible = false; return; }
  B.t += dt;
  if (B.t > 0.01 && !B.portal) { // open the portal 2.5 km ahead on the current track
    headingFrame(S.heading);
    B.portal = { p: S.pos.clone().addScaledVector(_rf, S.speed * (1.0 - B.t)), h: S.heading };
    B.portal.p.y = Math.max(S.pos.y, world.surface(B.portal.p.x, B.portal.p.z) + 40);
  }
  if (B.portal) {
    const P = B.portal; headingFrame(P.h); P.p.copy(S.pos).addScaledVector(_rf, 60 + 1900 * Math.pow(1 - clamp(B.t / 0.95, 0, 1), 1.3)); P.p.y -= 70 * (1 - clamp(B.t / 0.95, 0, 1)); // at 470,000 km/h the ring is held in view and closes in over the transition
    portal.visible = !B.passed; portal.position.copy(P.p); portal.rotation.set(0, P.h, 0);
    PFX.mat.uniforms.k.value = clamp(B.t / 0.9, 0, 1); PFX.mat.uniforms.time.value = S.t; PFX.mat.uniforms.ice.value = RX.ice ? 1 : 0; PFX.mat.uniforms.flash.value = Math.max(0, (B.t - 0.85) * 4);
    if (window.__game && window.__game.fps && window.__game.fps < 30 && !TEST && (PFX.slowT += 1 / 60) > 0.3 && PFX.n > 50000) { PFX.n = Math.floor(PFX.n * 0.6); PFX.pts.geometry.setDrawRange(0, PFX.n); PFX.slowT = 0; } // adaptive count
    portalMat.uniforms.k.value = clamp(B.t / 1.0, 0, 1); portal.scale.setScalar(Math.max(1, S.pos.distanceTo(P.p) / 1800)); portalMat.uniforms.ice.value = RX.ice ? 1 : 0;
    if (!B.passed) { // steer the ship into the ring; pass when its plane is crossed
      P.p.y = damp(P.p.y, S.pos.y, 3, dt);
      headingFrame(P.h); const along = (S.pos.x - P.p.x) * _rf.x + (S.pos.z - P.p.z) * _rf.z;
      if (along > 0 || B.t > 0.95) { B.passed = true; B.endT = B.t; enterIceAge(!RX.ice); }
    }
  }
  if (B.passed) { RX.blast = null; RX.blastCool = 15; portal.visible = false; blastExit(); }
  if (RX.blast && B.t > 3) { RX.blast = null; RX.blastCool = 10; portal.visible = false; blastExit(); }
}
function enterIceAge(on) {
  RX.ice = on; flash(1); S.shake = 2.5; audio.boom();
  shock.spawn(S.pos.clone(), _v.copy(S.vel).normalize().clone(), 200, 1.0, on ? new THREE.Color(0.7, 0.95, 1.4) : new THREE.Color(1.3, 0.9, 0.5), 1);
  pop(on ? 'ICE AGE · SAME WORLD, FROZEN' : 'BACK TO THE PRESENT', 'unlock'); rxSay(on ? 'Welcome to the ice age.' : 'Back to the present.', 'ice');
  if (on && S.wx) { // the climate turns: upcoming weather becomes ice storms & blizzards, and one hits soon
    let flip = false;
    for (const e of S.wx.events) { if (e.type === 'snow') continue; e.type = (flip = !flip) ? 'hail' : 'thunder'; e.ice = true; }
    const r = makeRng(((S.seed || 1) ^ 0x1ce1ce) >>> 0), ev = S.wx.events;
    for (let cp = Math.ceil(S.dist / 100000) * 100000; cp < S.dist + 3e6; cp += 100000) {
      if (r() < 0.1) { const a = cp + r() * 40000; if (!ev.some((e) => a < e.end && a + 50000 > e.start)) ev.push({ start: a, end: a + 50000, type: 'snow', warned: false, entered: false, ice: true, heavy: true }); } // heavy snow: 50 km corridor
      if (r() < 0.1) { const a = cp + r() * 85000; if (!ev.some((e) => a < e.end && a + 10000 > e.start)) ev.push({ start: a, end: a + 10000, type: 'thunder', warned: false, entered: false, ice: true }); } // ice thunderstorm ~10 km
    }
    ev.sort((a, b) => a.start - b.start);
    const st = S.dist + 3000; if (!S.wx.events.some((e) => e.start < st + 6000)) S.wx.events.unshift({ start: st, end: st + 3500, type: 'hail', warned: false, entered: false, ice: true });
  }
}
const ICE_ENV = { fog: [0.70, 0.78, 0.86], hor: [0.86, 0.92, 0.98], mid: [0.55, 0.68, 0.85], zen: [0.18, 0.30, 0.50], sun: [0.95, 0.97, 1.0], hs: [0.75, 0.85, 1.0], hg: [0.55, 0.6, 0.68], water: [0.32, 0.45, 0.55], dust: [1.5, 1.55, 1.65] };
function rxIceEnv(dt) {
  RX.iceK = damp(RX.iceK, RX.ice ? 1 : 0, 2.5, dt);
  const k = RX.iceK; RX.iceTint.setRGB(1, 1, 1).lerp(ICE_TINT, k);
  treeMat.color.setRGB(1, 1, 1).lerp(_c.setRGB(1.4, 1.5, 1.7), k * 0.8); jungleMat.color.copy(treeMat.color);
  const iceOn = RX.iceK > 0.5; for (const m of trees.meshes) m.visible = !iceOn; for (const m of jtrees.meshes) m.visible = !iceOn;
  waterMat.uniforms.frozen && (waterMat.uniforms.frozen.value = RX.iceK);
  if (k < 0.002) return;
  const L = (arr, out) => out.lerp(_c.setRGB(arr[0], arr[1], arr[2], LIN), k);
  L(ICE_ENV.fog, FOG_BASE); L(ICE_ENV.hor, skyMat.uniforms.horC.value); L(ICE_ENV.mid, skyMat.uniforms.midC.value); L(ICE_ENV.zen, skyMat.uniforms.zenC.value);
  L(ICE_ENV.sun, sunLight.color); L(ICE_ENV.hs, hemi.color); L(ICE_ENV.hg, hemi.groundColor); L(ICE_ENV.water, waterMat.uniforms.waterCol.value);
  for (let i = 0; i < 3; i++) E.dust[i] = lerp(E.dust[i], ICE_ENV.dust[i], k);
  waterMat.uniforms.swell.value *= 1 - k; // frozen sea: no swell waterMat.uniforms.sunCol.value.copy(sunLight.color);
  hazeU.hazeCol.value.lerp(_c.setRGB(0.8, 0.88, 1.0), k);
  if (k > 0.5) E.name = 'ICE AGE · ' + BIOME_NAMES[E.main];
}

// ---------- 5) HOSTILE AIRSPACE + enemy jets ----------
function rxGenAir(seed) {
  const rnd = makeRng((seed ^ 0x68e31da4) >>> 0), A = [];
  const mk = (st) => { const r2 = makeRng((seed ^ (st * 2654435761)) >>> 0), n = 20 + Math.floor(r2() * 11), L = []; for (let i = 0; i < n; i++) L.push(st + 2000 + r2() * 96000); L.sort((a, b) => a - b); const bomb = []; for (let d2 = st + 5000; d2 < st + 100000; d2 += 6000) if (r2() < 0.3) bomb.push(d2); return { base: true, start: st, end: st + 100000, spawned: 0, warned: false, det: false, nextT: 0, entered: false, launches: L, bombs: bomb, li: 0, bi: 0, seed: r2() * 1e9 >>> 0 }; };
  if (params.has('hostile')) A.push(mk(1500));
  for (let cp = 400000; cp < 3e6; cp += 400000) if (rnd() < 0.2) { const st = cp + rnd() * 250000; if (!A.length || st > A[A.length - 1].end + 5000) A.push(mk(Math.round(st))); } // each 400 km checkpoint: deterministic 20% chance
  return A;
}
const shotPool = []; for (let i = 0; i < 24; i++) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(1.6, 0.35, 0.25), blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, transparent: true })); s.scale.set(5, 5, 1); s.visible = false; scene.add(s); shotPool.push({ s, on: false, p: new THREE.Vector3(), v: new THREE.Vector3(), t: 0 }); }
let jetMeshes = [];
function spawnJet(zone) {
  let mesh = jetMeshes.find((m) => !m.userData.used);
  if (!mesh) { mesh = makeJet(new THREE.Color(0x7a1712), new THREE.Color(0xd9d4cc)); jetMeshes.push(mesh); }
  mesh.userData.used = true; mesh.visible = true;
  headingFrame(S.heading);
  const e = { jet: true, type: 'jet', mesh, hp: 3, dead: false, r: 7, h: 6, col: [1, 1, 1], p: new THREE.Vector3().copy(S.pos).addScaledVector(_rf, 1800).addScaledVector(_rr, (Math.random() - 0.5) * 500), v: new THREE.Vector3(), ahead: 520 + Math.random() * 380, lat: (Math.random() - 0.5) * 260, up: 25 + Math.random() * 45, ph: Math.random() * 6, fireT: 2.5 + Math.random() * 2, roll: 0, x: 0, y: 0, z: 0 };
  e.p.y = S.pos.y + 80; RX.enemies.push(e); zone.spawned++;
  if (zone.spawned === 1) { pop('⚠ HOSTILE JETS · LOCK & FIRE', 'close'); rxSay('Hostile jets inbound.', 'jets'); }
}
function damageJet(e, n, p) {
  if (e.dead) return;
  e.hp -= n; flash(0.08);
  for (let i = 0; i < 14; i++) glow.spawn(e.p.x, e.p.y, e.p.z, e.v.x + (Math.random() - 0.5) * 60, e.v.y + Math.random() * 30, e.v.z + (Math.random() - 0.5) * 60, 0.4, 2.5, 7, 1, 3, 1.5, 0.4, 1.3, 0);
  if (e.hp > 0) { pop('HOSTILE HIT · ' + e.hp + ' LEFT', 'close'); audio.explode(); return; }
  e.dead = true; e.fall = 2.5; MS.kills++;
  if (e.icehawk) { e.fall = 4; if (e.zone) e.zone.icehawkDone = true; RX.fzBonus = 20; pop('❄ WHITE RAIDER ICEHAWK DOWN · 20 s FREEZE BONUS', 'unlock'); rxSay('Icehawk down. Freeze bonus.', 'ih'); S.icehawkKills = (S.icehawkKills || 0) + 1; }
  for (let i = 0; i < 60; i++) { const v = _rq.randomDirection().multiplyScalar(20 + Math.random() * 70); glow.spawn(e.p.x, e.p.y, e.p.z, e.v.x + v.x, e.v.y + v.y, e.v.z + v.z, 0.6 + Math.random() * 0.8, 4, 16, 1, 3.2, 1.5, 0.35, 1.5, -5); }
  shock.spawn(e.p.clone(), new THREE.Vector3(0, 1, 0), 80, 0.8, new THREE.Color(1, 0.7, 0.4), 0.8);
  audio.explode(); S.score += 800; RX.freezeAmmo += 4; S.jetKills = (S.jetKills || 0) + 1;
  pop('✈ HOSTILE DOWN +800 · ❄ FREEZE AMMO +4', 'unlock'); rxSay('Hostile down. Freeze ammo loaded.', 'kill'); pulse('big');
}
function updateHostiles(dt) {
  const d = S.dist;
  while (RX.air.length && RX.air[0].end < d - 3000) RX.air.shift();
  const A = RX.air[0], inside = A && d >= A.start && d <= A.end;
  if (A && S.mode === 'playing') {
    if (!A.det && d > A.start - 200000) { A.det = true; pop('⚠ MILITARY AIRSPACE DETECTED — ' + Math.round((A.start - d) / 1000) + ' KM', 'close'); rxSay('Military airspace detected.', 'air'); }
    if (!A.warned && d > A.start - 4000) { A.warned = true; pop('⚠ MILITARY BASE · 100 KM · ENTERING', 'close'); }
    if (inside) baseThreats(A, d);
    if (inside && RX.ice && !A.icehawkDone && !A.icehawkUp) spawnIcehawk(A);
    if (inside) { A.nextT -= dt; const alive = RX.enemies.filter((e) => !e.dead).length; if (A.nextT <= 0 && alive < 2 && A.spawned < 40) { spawnJet(A); A.nextT = 3 + Math.random() * 2; } }
  }
  RX.airTxt = !A || S.mode !== 'playing' ? '' : inside ? '⚠ MILITARY BASE · ' + ((A.end - d) / 1000).toFixed(1) + ' KM LEFT · DOWNED ' + (S.jetKills || 0) + ' · HITS ' + (S.misHits || 0) + '/7' : d > A.start - 200000 ? 'MILITARY AIRSPACE DETECTED — ' + ((A.start - d) / 1000).toFixed(1) + ' KM' : '';
  headingFrame(S.heading);
  for (let i = RX.enemies.length - 1; i >= 0; i--) {
    const e = RX.enemies[i]; const px = e.p.x, py = e.p.y, pz = e.p.z;
    if (e.dead) { // burning wreck falls away
      e.fall -= dt; e.v.y -= 40 * dt; e.p.addScaledVector(e.v, dt); e.mesh.rotation.z += dt * 4; e.mesh.position.copy(e.p);
      if (Math.random() < 0.7) dust.spawn(e.p.x, e.p.y, e.p.z, 0, 3, 0, 2, 3, 12, 0.7, 0.1, 0.09, 0.09, 1, 1);
      if (e.icehawk && Math.random() < 0.8) glow.spawn(e.p.x, e.p.y, e.p.z, 0, 4, 0, 0.5, 3, 7, 1, 3, 1.2, 0.3, 1, 0); // fire
      if (e.fall <= 0 || e.p.y < world.surface(e.p.x, e.p.z)) { if (e.p.y < world.surface(e.p.x, e.p.z) + 5) airburst(e.p); if (e.icehawk) for (let k = 0; k < 60; k++) glow.spawn(e.p.x, e.p.y + 2, e.p.z, (Math.random() - 0.5) * 70, Math.random() * 50, (Math.random() - 0.5) * 70, 0.8, 3, 7, 0.9, 1.5, 2.2, 3, 1.6, -18); e.mesh.visible = false; e.mesh.userData.used = false; RX.enemies.splice(i, 1); }
      continue;
    }
    if (e.iceT > 0) { e.iceT -= dt; e.mesh.position.copy(e.p); if (e.iceT <= 0) { e.hp = 1; damageJet(e, 1, e.p); for (let k = 0; k < 40; k++) glow.spawn(e.p.x, e.p.y, e.p.z, (Math.random() - 0.5) * 80, Math.random() * 40, (Math.random() - 0.5) * 80, 0.6, 3, 8, 0.9, 1.5, 2.2, 3, 1.6, -18); } continue; } // frozen mid-air, then shatters
    e.ph += dt;
    const leaving = !inside || S.mode !== 'playing';
    _rq.copy(S.pos).addScaledVector(_rf, leaving ? e.ahead + 900 : e.ahead + Math.sin(e.ph * 0.7) * 120).addScaledVector(_rr, e.lat + Math.sin(e.ph * 1.3) * (e.icehawk ? 200 : 90));
    _rq.y = S.pos.y + e.up + Math.sin(e.ph * 0.9) * 18 + (leaving ? 200 : 0);
    _rq.y = safeAlt(_rq.x, _rq.y, _rq.z, 30);
    e.p.lerp(_rq, 1 - Math.exp(-1.6 * dt)); e.p.y = safeAlt(e.p.x, e.p.y, e.p.z, 22);
    e.v.set((e.p.x - px) / Math.max(dt, 1e-4), (e.p.y - py) / Math.max(dt, 1e-4), (e.p.z - pz) / Math.max(dt, 1e-4));
    const lat = (e.v.x - S.vel.x) * _rr.x + (e.v.z - S.vel.z) * _rr.z;
    e.roll = damp(e.roll, clamp(-lat * 0.012, -1, 1), 4, dt);
    e.mesh.position.copy(e.p); e.mesh.rotation.set(0, S.heading, e.roll); e.x = e.p.x; e.y = e.p.y; e.z = e.p.z;
    if (leaving && e.p.distanceTo(S.pos) > 2200) { if (e.icehawk && e.zone) e.zone.icehawkUp = false; e.mesh.visible = false; e.mesh.userData.used = false; RX.enemies.splice(i, 1); continue; }
    if (!leaving && !S.land) { e.fireT -= dt; if (e.fireT <= 0) { e.fireT = 2.6 + Math.random() * 2.2; enemyShoot(e); } }
  }
  for (const s of shotPool) { // enemy cannon bursts: closing at ~420 m/s relative, dodge by turning
    if (!s.on) continue; s.t += dt;
    if (RX.wing > 0 && wingmen && S.mode === 'playing') {
      if (s.icpt === undefined) { s.icpt = Math.random() < (s.sam ? 0.8 : 0.7); s.by = wingmen[(RX.gsK = (RX.gsK || 0) + 1) & 1]; } // Gs stop many shots, not all
      if (s.icpt && s.p.distanceTo(S.pos) < 650) {
        for (let i = 0; i <= 10; i++) { const u = i / 10; glow.spawn(s.by.p.x + (s.p.x - s.by.p.x) * u, s.by.p.y + (s.p.y - s.by.p.y) * u, s.by.p.z + (s.p.z - s.by.p.z) * u, 0, 0, 0, 0.25, 1.6, 0.6, 1, 0.6, 1.4, 2.4, 0, 0); }
        for (let i = 0; i < 18; i++) glow.spawn(s.p.x, s.p.y, s.p.z, (Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60, (Math.random() - 0.5) * 60, 0.5, 2.5, 6, 1, 3, 1.5, 0.4, 1, 0);
        s.on = false; s.s.visible = false; s.icpt = undefined; S.gsIntercepts = (S.gsIntercepts || 0) + 1; pop('Gs INTERCEPT · ' + S.gsIntercepts, 'banked'); continue;
      }
    }
    const ox = s.p.x, oz = s.p.z, oy = s.p.y; s.p.addScaledVector(s.v, dt); s.s.position.copy(s.p);
    if (s.sam) { for (let k = 0; k < 3; k++) { const u = Math.random(); dust.spawn(ox + (s.p.x - ox) * u, oy + (s.p.y - oy) * u, oz + (s.p.z - oz) * u, 0, 1, 0, 2.2, 2, 9, 0.6, 0.85, 0.85, 0.85, 1.2, 0.6); } } // readable SAM smoke trail
    const sx = s.p.x - ox, sy = s.p.y - oy, sz = s.p.z - oz, sl = sx * sx + sy * sy + sz * sz;
    let u = sl > 0 ? ((S.pos.x - ox) * sx + (S.pos.y - oy) * sy + (S.pos.z - oz) * sz) / sl : 0; u = clamp(u, 0, 1);
    const dd = Math.hypot(ox + sx * u - S.pos.x, oy + sy * u - S.pos.y, oz + sz * u - S.pos.z);
    if (dd < 7 && S.mode === 'playing' && !RX.ghost && !inSafeBand() && RX.god) { s.on = false; s.s.visible = false; airburst(s.p.clone()); S.godKills = (S.godKills || 0) + 1; continue; }
    if (dd < 7 && S.mode === 'playing' && !RX.ghost && !inSafeBand()) {
      s.on = false; s.s.visible = false;
      const floor = (S.autopilot || rxForceAP() || safeMode) ? 15 : 0;
      S.hp.B = Math.max(floor, S.hp.B - 9); S.noContactT = 0; flash(0.22); S.shake = Math.max(S.shake, 0.9); audio.scrape(0.8);
      S.misHits = (S.misHits || 0) + 1;
      pop('HIT BY HOSTILE FIRE ' + S.misHits + '/7 · HULL ' + Math.round(S.hp.B) + '%', 'close');
      if (S.misHits >= 7 && !S.engineFail) { S.engineFail = true; pop('ENGINE FAILURE · GOING DOWN', 'close'); rxSay('Engine failure.', 'eng'); continue; }
      if (S.hp.B <= 0) { S.crashCause = 'SHOT DOWN'; crash(); }
      continue;
    }
    if (s.t > (s.sam ? 6 : 3) || (s.p.y < world.surface(s.p.x, s.p.z) && s.t > 0.3)) { s.on = false; s.s.visible = false; s.icpt = undefined; s.sam = false; }
  }
}
function enemyShoot(e) {
  const s = shotPool.find((q) => !q.on); if (!s) return;
  s.on = true; s.t = 0; s.p.copy(e.p); s.s.visible = true;
  const dist = e.p.distanceTo(S.pos);
  _rq.copy(S.pos).sub(e.p).normalize();
  s.v.copy(S.vel).addScaledVector(_rq, Math.max(dist / 1.4, 250)); // closes on where you are now: keep turning and it misses
  audio.tick && audio.tick();
}

// ---------- 6) HAZARDS: falling rocks, geysers, lightning ----------
const ROCK_BIOMES = { desert: 1, gorge: 1, volcanic: 1, fjord: 1, coast: 1, jungle: 1, grass: 1 }, GEY_BIOMES = { volcanic: 1, fjord: 1, gorge: 1, grass: 1 };
function updateHazards(dt) {
  if (S.mode !== 'playing') return;
  const d = S.dist;
  // falling rocks: ~every 3-6 km, dropped from the canyon rim onto your line ~2-3 s ahead
  if (!RX.nextRock) RX.nextRock = d + (params.has('rocks') ? 600 : 1000);
  if (d > RX.nextRock && !RX.above) {
    const cp = Math.floor(d / 40000), rr = makeRng(((S.seed || 1) ^ (cp * 0x9E3779B1)) >>> 0), on = rr() < 0.1, st = cp * 40000 + rr() * 34000;
    const inStretch = params.has('rocks') || (on && d > st && d < st + 5000);
    RX.nextRock = d + (params.has('rocks') ? 900 : inStretch ? 700 + Math.random() * 600 : 1000);
    if (inStretch) {
    const ahead = clamp(S.speed * 2.4, 700, (AHEAD - 2) * CHUNK_L), zd = d + ahead, z = -zd;
    if (ROCK_BIOMES[world.biomeMain(z)] && world.gridHeight0(world.pathX(z), z) > 0) {
      const ch = chunks.get(Math.floor(zd / CHUNK_L));
      if (ch) {
        const x = S.pos.x + (world.pathX(z) - S.pos.x) * 0.5 + (Math.random() - 0.5) * 80, yg = world.gridHeight0(x, z), r = 9 + Math.random() * 6;
        const zn = zoneAt(zd), y0 = zn ? zn.b - r - 3 : yg + 170 + Math.random() * 60;
        const T = clamp(ahead / Math.max(S.speed, 50) * 0.75, 0.9, 2.2);
        const o = { type: 'boulder', x, y: y0, z, r, h: 0, valley: true, rot: Math.random() * 6.28, variant: (Math.random() * 4) | 0, col: [0.9, 0.82, 0.74], near: false, done: false, falling: { y0, yg: Math.max(yg, 0) - r * 0.25, t: 0, T } };
        ch.objs.push(o); RX.rocks.push(o); RX.instDirty = true;
        pop('⚠ FALLING ROCK AHEAD', 'close'); rxSay('Rock fall ahead.', 'rock'); audio.warn();
      }
    }
    }
  }
  for (let i = RX.rocks.length - 1; i >= 0; i--) {
    const o = RX.rocks[i], F = o.falling;
    if (o.dead) { RX.rocks.splice(i, 1); continue; }
    F.t += dt; const u = Math.min(F.t / F.T, 1); o.y = lerp(F.y0, F.yg, u * u); o.rot += dt * 2; RX.instDirty = true;
    if (Math.random() < 0.6) dust.spawn(o.x, o.y + o.r, o.z, 0, 8, 0, 2, 4, 14, 0.4, E.dust[0] * 0.6, E.dust[1] * 0.6, E.dust[2] * 0.6, 0.5, 0);
    if (u >= 1) {
      o.falling = null; RX.rocks.splice(i, 1);
      shock.spawn(new THREE.Vector3(o.x, o.y + 1, o.z), new THREE.Vector3(0, 1, 0), 60, 0.8, new THREE.Color(1, 0.8, 0.55), 0.7);
      for (let k = 0; k < 40; k++) { const a = Math.random() * 6.283, sp = 15 + Math.random() * 40; dust.spawn(o.x, o.y + 2, o.z, Math.cos(a) * sp, 4 + Math.random() * 12, Math.sin(a) * sp, 3 + Math.random() * 3, 8, 40, 0.6, E.dust[0] * 0.8, E.dust[1] * 0.75, E.dust[2] * 0.7, 1, -0.5); }
      if (Math.hypot(o.x - S.pos.x, o.z - S.pos.z) < 1500) { audio.explode(); S.shake = Math.max(S.shake, 0.7); }
    }
  }
  // geysers in volcanic / fjord / gorge / meadow country
  if (!RX.nextGey) RX.nextGey = d + (params.has('geyser') ? 500 : 1500);
  if (d > RX.nextGey) {
    RX.nextGey = d + (params.has('geyser') ? 900 : 1000);
    const zi = Math.floor((d + 3000) / 1000); if (!params.has('geyser') && makeRng(((S.seed || 1) ^ (zi * 0x7f4a7c15)) >>> 0)() >= 0.03) { /* ~3% of zones */ } else {
    const zd = d + clamp(S.speed * 3, 1200, (AHEAD - 2) * CHUNK_L), z = -zd;
    if ((GEY_BIOMES[world.biomeMain(z)] || params.has('geyser')) && world.gridHeight0(world.pathX(z), z) > -0.5) {
      const x = world.pathX(z) + (Math.random() - 0.5) * 70;
      RX.geysers.push({ x, z, yg: world.gridHeight0(x, z), ph: Math.random() * 3, top: 160 + Math.random() * 140, k: 0, per: 3 + Math.random() * 5, dur: 1.5 + Math.random() * 2.5 });
    }
    }
  }
  RX.inGeyser = 0;
  for (let i = RX.geysers.length - 1; i >= 0; i--) {
    const g = RX.geysers[i];
    if (g.z > S.pos.z + 400) { RX.geysers.splice(i, 1); continue; }
    g.ph += dt; if (g.ph > g.per + g.dur) { g.ph = 0; g.per = 2 + Math.random() * 7; g.dur = 1.2 + Math.random() * 3; } const c = g.ph - g.per; g.k = c > 0 ? sm(0, 0.5, c) * sm(g.dur, g.dur - 0.7, c) * (0.8 + 0.2 * Math.sin(S.t * 13 + g.x)) : 0; // irregular eruptions
    const near = Math.abs(g.z - S.pos.z) < 2500;
    if (near && g.k > 0.05) { // steam column
      g.acc = (g.acc || 0) + dt * 70 * g.k * quality.particles;
      while (g.acc > 1) { g.acc--; const h = Math.random(); dust.spawn(g.x + (Math.random() - 0.5) * 10, g.yg + 2, g.z + (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 12, 70 + Math.random() * 60 * g.k, (Math.random() - 0.5) * 12, 4 + h * 4, 22, 60, 0.42 * g.k, 1.45, 1.48, 1.5, -0.25, 0.6); }
    }
    const hd = Math.hypot(S.pos.x - g.x, S.pos.z - g.z);
    if (hd < 45 && S.pos.y < g.yg + g.top && g.k > 0.05) RX.inGeyser = Math.max(RX.inGeyser, g.k * (1 - hd / 45));
  }
}
function geyserForces(dt) { // updraft + turbulence while inside a plume
  const k = RX.inGeyser || 0; if (k <= 0 || !RX.forces) return;
  S.pos.y += 55 * k * dt;
  const ap = S.autopilot || rxForceAP() ? 0.25 : 1;
  RX.jolt += (Math.sin(S.t * 23) + Math.sin(S.t * 37 + 1)) * 0.22 * k * ap;
  S.shake = Math.max(S.shake, 0.5 * k);
  if (!RX.geyPop || S.t - RX.geyPop > 2) { RX.geyPop = S.t; pop('GEYSER UPDRAFT · TURBULENCE', 'close'); }
}
function boltNear(x0, z0) { // lightning that strikes near the ship jolts the controls
  if (S.mode !== 'playing') return;
  if (Math.hypot(x0 - S.pos.x, z0 - S.pos.z) > 320 || RX.phase > 0) return;
  if (RX.god || !RX.forces) { flash(0.4); return; } // GOD MODE / no REALISTIC FORCES: no control loss
  RX.joltT = 2 + Math.random() * 2; RX.joltDir = Math.random() < 0.5 ? -1 : 1; S.shake = Math.max(S.shake, 1.6); flash(0.6);
  const floor = (S.autopilot || rxForceAP() || safeMode) ? 20 : 1; S.hp.B = Math.max(floor, S.hp.B - 6); S.noContactT = 0;
  pop('⚡ LIGHTNING STRIKE · CONTROLS JOLTED', 'close'); rxSay('Lightning strike.', 'bolt');
  $('rxStatic').classList.remove('on'); void $('rxStatic').offsetWidth; $('rxStatic').classList.add('on');
}

// ---------- 7) GHOST / PHASE, AI scanner, voice ----------
const ghostMats = [];
function setGhost(on) {
  RX.ghost = on;
  if (!ghostMats.length) ship.traverse((o) => { if (o.isMesh && o.material && o.material.type !== 'ShaderMaterial' && !ghostMats.includes(o.material)) ghostMats.push(o.material); });
  for (const m of ghostMats) {
    if (m.userData.g0 === undefined) m.userData.g0 = { t: m.transparent, o: m.opacity, dw: m.depthWrite, e: m.emissive ? m.emissive.clone() : null };
    const g = m.userData.g0;
    m.transparent = on || g.t; m.opacity = on ? Math.min(g.o, 0.38) : g.o; m.depthWrite = on ? false : g.dw;
    if (m.emissive) { if (on) m.emissive.setRGB(0.05, 0.35, 0.5); else m.emissive.copy(g.e); }
    m.needsUpdate = true;
  }
  pop(on ? 'GHOST MODE · PASS THROUGH ROCKS · SCORE ×0.3' : 'GHOST MODE OFF', 'unlock'); rxMenuSync();
}
function rxScanner() {
  if (!RX.scanner || S.mode !== 'playing') return '';
  return aiAnalysis();
  let what = null, tti = Infinity;
  if (MS.threat && MS.cands.length) { what = (TARGET_NAME[MS.cands[0].o.type] || 'OBSTACLE'); tti = MS.cands[0].tti; }
  const r = predict(S.steerIn || 0, S.pitchIn || 0, 3, 14, 3.5); // full model: terrain, rocks, deck, hazards
  if (r.hit < tti) { tti = r.hit; what = RX.lastSimRoof ? 'SKY DECK' : (what || 'TERRAIN'); }
  for (const o of RX.rocks) if (!o.dead && Math.abs(o.z - S.pos.z) < S.speed * 3.2) { what = 'FALLING ROCK'; tti = Math.min(tti, (S.pos.z - o.z) / Math.max(S.speed, 1)); }
  if (tti === Infinity) return '<b class="ok">AI SCAN · 3.0 s · PATH CLEAR</b>';
  const opts = [[-0.9, 0, '◀ BREAK LEFT'], [0.9, 0, 'BREAK RIGHT ▶'], [0, 1, '▲ CLIMB'], [0, -0.6, '▼ DIVE']];
  let best = null, bh = tti;
  for (const [s, p, lbl] of opts) { const q = predict(s, p, 3, 12, 3.5); if (q.hit > bh) { bh = q.hit; best = lbl; } }
  return '<b class="bad">AI SCAN · ' + what + ' ' + tti.toFixed(1) + ' s' + (best ? ' · ' + best : '') + '</b>';
}
const voiceLast = {}; let voiceGlobal = 0;
function rxSay(text, key) {
  if (!RX.voice || TEST || !window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') return;
  const now = performance.now(); if (now - (voiceLast[key] || -1e9) < 6000 || now - voiceGlobal < 1200) return;
  voiceLast[key] = now; voiceGlobal = now;
  try { const ss = window.speechSynthesis; if (ss.pending) ss.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 1.12; u.pitch = 0.9; u.volume = clamp(settings.vol, 0, 1); ss.speak(u); } catch (e) { /* ignore */ }
}
function setVoice(on) { RX.voice = on; localStorage.setItem('canyon.voice', on ? '1' : '0'); rxMenuSync(); if (on) { voiceLast.v = 0; rxSay('Voice callouts on.', 'v'); } else if (window.speechSynthesis) window.speechSynthesis.cancel(); }

// ---------- 8) G-FORCE (real load factor from our flight model) ----------
function updateG(dt) {
  if (S.mode !== 'playing' || dt <= 0) { RX.g = damp(RX.g, 1, 4, dt); return; }
  const om = (S.heading - RX.ph) / dt, ay = (S.vel.y - RX.pvy) / dt; RX.ph = S.heading; RX.pvy = S.vel.y;
  if (S.scrapeCool > 0.15 || S.land) { return; } // collision deflections are impulses, not sustained load
  const lat = S.speed * om, vert = 9.81 + ay;
  let n = Math.hypot(lat, vert) / 9.81 * (vert < 0 ? -1 : 1);
  n = clamp(n, -15, 80);
  RX.g = damp(RX.g, n, 4, dt); if (RX.g > RX.gMax) RX.gMax = RX.g;
  // G-LOC model: tolerance ~9 G (G-suit), onset proportional to excess; negative G > 3 pushes blood to the head
  if (S.autopilot || rxForceAP()) { RX.blk = Math.max(0, RX.blk - 0.6 * dt); RX.red = Math.max(0, RX.red - 0.6 * dt); return; } // the flight computer flies; pilot is strapped in & relaxed
  if (RX.g > 9) RX.blk = Math.min(1, RX.blk + (RX.g - 9) / 60 * dt); else RX.blk = Math.max(0, RX.blk - (RX.g < 5 ? 0.6 : 0.3) * dt);
  if (RX.g < -3) RX.red = Math.min(1, RX.red + (-3 - RX.g) / 7 * dt); else RX.red = Math.max(0, RX.red - 0.6 * dt);
  if (RX.blk > 0.6) rxSay('G limit.', 'g');
}
let gvLast = '';
function drawG() {
  const el = $('gMeter'); const g = RX.g;
  const t = 'G ' + (g >= 0 ? '+' : '') + (Math.abs(g) < 10 ? g.toFixed(1) : Math.round(g));
  if (el.textContent !== t) el.textContent = t;
  el.className = g > 9 ? 'hi' : g < -3 ? 'neg' : g > 5 ? 'mid' : '';
  const b = RX.gfx ? Math.min(RX.blk, 1) * 0.9 : 0, r = RX.gfx ? Math.min(RX.red, 1) * 0.75 : 0;
  const key = b.toFixed(2) + r.toFixed(2);
  if (key === gvLast) return; gvLast = key;
  const gv = $('rxGv');
  if (b < 0.01 && r < 0.01) { gv.style.opacity = 0; return; }
  const inner = Math.round(lerp(70, 6, Math.max(b, r))), col = r > b ? `rgba(150,0,0,${(0.55 + 0.4 * r).toFixed(2)})` : `rgba(0,0,0,${(0.7 + 0.3 * b).toFixed(2)})`;
  gv.style.background = `radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) ${inner}%, ${col} ${Math.min(inner + 28, 100)}%)`;
  gv.style.opacity = 1;
}

// ---------- shared hooks ----------
function rxForceAP() { return !!(RX.ride || RX.blast); }
function rxReset() {
  if (RX.strikeOffer) strikeCard(false); RX.strikeCool = 40;
  RX.nearZones.length = 0; RX.above = false; RX.air = rxGenAir(S.seed);
  for (const e of RX.enemies) { e.mesh.visible = false; e.mesh.userData.used = false; } RX.enemies.length = 0;
  for (const s of shotPool) { s.on = false; s.s.visible = false; s.sam = false; s.icpt = undefined; }
  RX.rocks.length = 0; RX.geysers.length = 0; RX.frozen.length = 0; RX.nextRock = 0; RX.nextGey = 0; RX.wave = null; waveMesh.visible = false;
  RX.blast = null; RX.blastCool = 0; portal.visible = false; endRide(); S.land = null; RX.freezeCool = 0; RX.g = 1; RX.gMax = 1; RX.blk = 0; RX.red = 0; RX.ph = S.heading; RX.pvy = 0;
  RX.gsupCool = 0; S.gsIntercepts = 0; if (S.car) { S.car = null; if (carRig) carRig.g.visible = false; ship.userData.body.scale.set(1, 1, 1); ship.userData.body.position.y = 0; } S.blastAfter = false; RX.freezeAmmo = params.has('freezeammo') ? 6 : 0; S.jetKills = 0; S.misHits = 0; S.engineFail = false; S.fallSeq = false; RX.fzBonus = 0; S.fallV = 0; S.boom100 = false; S.machStep = 0; S.boomZone = null;
  if (RX.ice && !params.has('ice')) { RX.ice = false; } if (params.has('ice')) RX.ice = true;
}
function rxClearDeckMeshes() { for (const zn of RX.zones) if (zn.mesh) { scene.remove(zn.mesh); zn.mesh.geometry.dispose(); zn.mesh = null; } }
function rxUpdate(dt, rdt) { // dt = game (possibly slow-mo) time, rdt = real time
  RX.timeScale = damp(RX.timeScale, RX.ride ? 0.3 : 1, 6, rdt);
  RX.joltT = Math.max(0, RX.joltT - dt);
  RX.jolt = RX.joltT > 0 ? RX.joltDir * 0.6 * Math.min(RX.joltT / 0.7, 1) * (S.autopilot || rxForceAP() ? 0.2 : 1) + Math.sin(S.t * 60) * 0.15 * RX.joltT : 0;
  RX.gsupCool = Math.max(0, RX.gsupCool - dt);
  if (RX.fzBonus > 0) { RX.fzBonus = Math.max(0, RX.fzBonus - rdt); const el = $('fzBonus'); el.classList.toggle('hidden', !(RX.fzBonus > 0)); el.textContent = '❄ FREEZE BONUS ' + RX.fzBonus.toFixed(1) + ' s'; } // real time: slow-mo does not extend it
  if (RX.god) { S.hp.L = S.hp.R = S.hp.B = 100; S.misHits = 0; S.engineFail = false; RX.joltT = 0; }
  updateBase(); updateBirdsFossils(dt); updatePebbles(); grass.U.tallK.value = damp(grass.U.tallK.value, RX.iceK > 0.5 ? 0 : tallGrassK(S.dist), 2, dt);
  updateHazards(dt); updateWingmen(dt); updateEscorts(dt); updateFreeze(dt); updateBlast(dt); updateHostiles(dt); updateG(dt);
  if (RX.instDirty) { RX.instDirty = false; rebuildInstances(); }
  RX.hudT -= rdt;
  if (RX.hudT <= 0 && S.mode === 'playing') {
    RX.hudT = 0.12;
    let hole = '';
    const d = S.dist, zn = zoneAt(d), next = RX.nearZones.find((z) => z.start > d);
    if (zn) {
      if (RX.above) hole = '▲ UPPER WORLD · ' + (S.land ? (S.land.ph === 'rest' ? 'RESTING · THROTTLE UP TO TAKE OFF' : S.land.ph === 'down' ? 'LANDING…' : 'TAKING OFF…') : rxCanLand() ? 'LAND READY [L]' : 'DECK ENDS IN ' + ((zn.end - d) / 1000).toFixed(1) + ' KM');
      else {
        const h = inHole(zn, d), nh = zn.holes.find((q) => q[0] > d);
        if (h) hole = '<b class="ok">ESCAPE HOLE OPEN · CLIMB ↑ · ' + ((h[1] - d) / Math.max(S.speed, 1)).toFixed(1) + ' s</b>';
        else hole = 'UNDER THE SKY DECK · ' + (nh ? 'ESCAPE HOLE IN ' + ((nh[0] - d) / 1000).toFixed(1) + ' KM · ' + ((nh[0] - d) / Math.max(S.speed, 1)).toFixed(1) + ' s' : 'DECK ENDS IN ' + ((zn.end - d) / 1000).toFixed(1) + ' KM');
        if (h && !h.said) { h.said = true; rxSay('Escape hole open. Climb.', 'hole'); }
      }
    } else if (next && next.start - d < 5000) { hole = 'SKY DECK AHEAD · ' + ((next.start - d) / 1000).toFixed(1) + ' KM · STAY LOW OR CLIMB ABOVE ' + Math.round(next.t - world.surface(S.pos.x, S.pos.z)) + ' m'; if (!next.said) { next.said = true; rxSay('Sky deck ahead.', 'deck'); } }
    const lines = [hole, RX.airTxt || '', (RX.rocks.length ? '<b class="bad">⚠ FALLING ROCK</b>' : '')].filter(Boolean);
    const txt = lines.join('<br>');
    if (txt !== RX._holeTxt) { RX._holeTxt = txt; $('rxHole').innerHTML = txt; }
    RX.scanT -= 0.12; if (RX.scanT <= 0) { RX.scanT = 0.24; const s = rxScanner(); if (s !== RX.scanTxt) { RX.scanTxt = s; $('rxScan').innerHTML = s; } }
    const q = $('rxWaveBtn'); const qt = RX.freezeCool > 0 ? '❄ ' + Math.ceil(RX.freezeCool) : '❄ WAVE'; if (q.textContent !== qt) q.textContent = qt;
    $('rxLandBtn').classList.toggle('hidden', !(RX.above || S.land)); $('rxLandBtn').textContent = S.land ? 'TAKE OFF' : 'LAND';
    const ammo = RX.freezeAmmo > 0 ? '❄' + RX.freezeAmmo : RX.warhead === 'freeze' ? '❄' : '';
    if ($('rxAmmo').textContent !== ammo) $('rxAmmo').textContent = ammo;
  }
  drawG();
}
function rxCamera(dt) {
  const m = RX.ride;
  if (!(m && m.on)) viewCamera(dt); else if (cockpit && cockpit.g.visible) { cockpit.g.visible = false; ship.visible = true; } // missile cam never shows the cockpit shell
  if (m && m.on) {
    _rq.copy(m.v).normalize();
    camera.position.copy(m.p).addScaledVector(_rq, -10); camera.position.y += 2.4;
    const g = world.surface(camera.position.x, camera.position.z) + 1.5; if (camera.position.y < g) camera.position.y = g;
    camera.lookAt(_rr.copy(m.p).addScaledVector(_rq, 40));
    camera.fov = damp(camera.fov, 68, 4, dt); camera.updateProjectionMatrix();
  } else if (m && !m.on) endRide();
  // never let the chase camera poke into the deck from below
  const zn = roofAt(camera.position.z, camera.position.x);
  if (zn && !RX.above && camera.position.y > zn.b - 0.8 && S.pos.y < zn.b) camera.position.y = zn.b - 0.8;
  if (zn && RX.above && camera.position.y < zn.t + 1) camera.position.y = zn.t + 1;
}

// ---------- UI: pull-tab drawer + quick buttons + keyboard ----------
function rxMenuSync() {
  const set = (id, txt, on) => { const b = $(id); if (!b) return; b.textContent = txt; b.classList.toggle('on', !!on); };
  set('mxWing', WING_NAMES[RX.wing], RX.wing > 0);
  set('mxWar', RX.warhead === 'freeze' ? 'FREEZE MISSILE · ON' : 'FREEZE MISSILE · OFF', RX.warhead === 'freeze');
  set('mxUltra', RX.ultra ? 'ULTRA · 124,700 ON' : 'ULTRA · OFF', RX.ultra);
  set('mxGhost', RX.ghost ? 'GHOST · ON' : 'GHOST · OFF', RX.ghost);
  set('mxForces', RX.forces ? 'REALISTIC FORCES · ON' : 'REALISTIC FORCES · OFF', RX.forces);
  set('mxTF', controls.terrainFollow ? 'TERRAIN FOLLOW · ON' : 'TERRAIN FOLLOW · OFF', controls.terrainFollow);
  set('mxDebug', RX.debug ? 'DEBUG OVERLAY · ON' : 'DEBUG OVERLAY · OFF', RX.debug);
  set('mxTilt', controls.tiltOn ? 'TILT STEER · ON' : 'TILT STEER · OFF', controls.tiltOn);
  set('mxScan', RX.scanner ? 'AI ANALYSIS · ON' : 'AI ANALYSIS · OFF', RX.scanner);
  set('mxVoice', RX.voice ? 'CALLOUTS · ON' : 'CALLOUTS · OFF', RX.voice);
  set('mxG', RX.gfx ? 'G-EFFECTS · ON' : 'G-EFFECTS · OFF', RX.gfx);
  set('mxCarrier', RX.carrier ? 'G47 · ON STATION' : 'CALL G47', RX.carrier);
  set('mxDrone', RX.drone ? 'G3 · ON' : 'G3 · OFF', RX.drone);
  set('mxG3far', RX.g3far ? 'G3 · FAR' : 'G3 · NEAR', RX.g3far);
  set('mxHelp', RX.g47h ? 'G47 HELPERS · ON' : 'G47 HELPERS · OFF', RX.g47h);
  set('mxG47fz', RX.g47fz ? 'G47 FREEZE MSL · ON' : 'G47 FREEZE MSL · OFF', RX.g47fz);
  set('mxSmartM', RX.smartM ? 'SMART MISSILES · ON' : 'SMART MISSILES · OFF', RX.smartM);
  set('rqGod', RX.god ? '⚡ GOD ON' : '⚡ GOD', !!RX.god);
  set('mxGod', RX.god ? 'GOD MODE · ON' : 'GOD MODE · OFF', !!RX.god);
  set('mxFingerH', controls.fingerHeight ? 'FINGER HEIGHT · ON' : 'FINGER HEIGHT · OFF', !!controls.fingerHeight);
  set('mxSuper', RX.super ? 'SUPERSAFE · ON' : 'SUPERSAFE · OFF', RX.super);
  set('mxX', RX.xsurv ? 'X SURVIVAL · ON' : 'X SURVIVAL · OFF', RX.xsurv);
  set('mxPhase', ['PHASE · OFF', 'PHASE · ME ONLY', 'PHASE · ALL FRIENDLY'][RX.phase], RX.phase > 0);
  set('mxSmart', RX.smart ? 'SMART AVOID · ON' : 'SMART AVOID · OFF', RX.smart);
  set('mxSound', RX.mute ? 'SOUND · OFF' : 'SOUND · ON', !RX.mute);
  set('mxCig', RX.cig ? 'CIGARETTE · ON' : 'CIGARETTE · OFF', RX.cig);
  set('mxXform', S.car && S.car.dir > 0 ? '✈ TRANSFORM → FLIGHT' : '🚗 TRANSFORM → CAR', !!(S.car && S.car.dir > 0));
  set('mxCarSup', RX.carSuper ? 'CAR SUPERSAFE · ON' : 'CAR SUPERSAFE · OFF', RX.carSuper);
  set('mxAuto', S.autopilot ? 'AUTOPILOT · ON' : 'AUTOPILOT · OFF', S.autopilot);
  set('mxSafe', safeMode ? 'SAFE · ON' : 'SAFE · OFF', safeMode);
  set('mxGsup', RX.gsupCool > 0 ? 'Gs SUPERMODE · ' + Math.ceil(RX.gsupCool) + ' s' : 'Gs SUPERMODE', false);
  for (const [id, c] of [['mxCchase', 'chase'], ['mxCcock', 'cockpit'], ['mxCg3', 'g3'], ['mxCg47', 'g47']]) { const b = $(id); if (b) b.classList.toggle('on', RX.cam === c); }
  set('mxPip', PIP_NAMES[RX.pip], RX.pip > 0);
  set('mxSwipe', controls.swipeSteer ? 'SWIPE STEER · ON' : 'SWIPE STEER · OFF', controls.swipeSteer);
  const vc = $('voiceChip'); if (vc) vc.textContent = 'Voice callouts: ' + (RX.voice ? 'ON' : 'OFF');
  $('rxScan').classList.toggle('hidden', !RX.scanner); if (!RX.scanner) $('aiBox').classList.add('hidden');
}
function rxMenu(open) { const m = $('rxMenu'); const o = open ?? m.classList.contains('hidden'); m.classList.toggle('hidden', !o); document.body.classList.toggle('tray-open', o); $('rxScrim').classList.toggle('hidden', !o); $('rxTab').classList.toggle('on', o); }
// ---------- optional escorts: command carrier (+2 helpers) and scout drone with live camera feeds ----------
RX.carrier = false; RX.drone = false; RX.pip = 0; RX.strikeCool = 40; RX.strikeOffer = false; RX.strikeFx = 0;
let carrier = null, drone = null;
const PIP_NAMES = ['FEED · OFF', 'FEED · G47 CAM', 'FEED · G3 CAM'];
function ensureCarrier() {
  if (carrier) return;
  const m = makeJet(new THREE.Color(0x15171b), new THREE.Color(0xd9dde2)); m.scale.setScalar(4.2); addNav(m);
  carrier = { mesh: m, p: S.pos.clone(), fireT: 1, roll: 0, helpers: [-1, 1].map((side) => ({ side, mesh: (() => { const h = makeJet(new THREE.Color(0x6b7078), new THREE.Color(0xe8ebee)); h.scale.setScalar(1.4); return h; })(), p: S.pos.clone() })) };
}
function ensureDrone() {
  if (drone) return;
  const m = makeJet(new THREE.Color(0xb9c2cc), new THREE.Color(0x22d3ff)); m.scale.setScalar(0.45);
  drone = { mesh: m, p: S.pos.clone() };
}
function setCarrier(on) { RX.carrier = on; ensureCarrier(); if (on) { headingFrame(S.heading); carrier.p.copy(S.pos).addScaledVector(_rf, -200).add(new THREE.Vector3(0, 60, 0)); for (const h of carrier.helpers) h.p.copy(carrier.p); } else if (RX.pip === 1) RX.pip = 0; pop(on ? 'G47 CALLED · MISSILE SUPPORT' : 'G47 DISMISSED', 'banked'); rxMenuSync(); }
function setDrone(on) { RX.drone = on; ensureDrone(); if (on) drone.p.copy(S.pos); else { if (RX.pip === 2) RX.pip = 0; strikeCard(false); } pop(on ? 'G3 SCOUT · AHEAD' : 'G3 OFF', 'banked'); rxMenuSync(); }
function cyclePip() { let n = RX.pip; for (let i = 0; i < 3; i++) { n = (n + 1) % 3; if (n === 0 || (n === 1 && RX.carrier) || (n === 2 && RX.drone)) break; } RX.pip = n; $('rxPip').classList.add('hidden'); rxMenuSync(); }
function flyTo(o, tgt, k, pad, dt) { o.p.lerp(tgt, 1 - Math.exp(-k * dt)); o.p.y = safeAlt(o.p.x, o.p.y, o.p.z, pad); }
function updateEscorts(dt) {
  const live = S.mode !== 'crashed';
  headingFrame(S.heading);
  if (carrier) {
    const on = RX.carrier && live; carrier.mesh.visible = on;
    for (const h of carrier.helpers) h.mesh.visible = on && RX.g47h;
    if (carrier.mesh.userData.nav) { const b = (S.t % 1.2) < 0.12; for (const n of carrier.mesh.userData.nav) n.visible = on && (n.userData.steady || b); }
    if (on) {
      { const k = clamp(Math.round(MPATH.length * (RX.g3far ? 0.95 : 0.7)), 4, MPATH.length - 1); _rq.copy(MPATH[k]).addScaledVector(_rr, 70); _rq.y = Math.max(_rq.y + 120, S.pos.y + 90); }
      flyTo(carrier, _rq, 2.2, 30, dt); carrier.roll = damp(carrier.roll, S.roll * 0.35, 2, dt);
      carrier.mesh.position.copy(carrier.p); carrier.mesh.rotation.set(S.pitch * 0.5, S.heading, carrier.roll);
      for (const h of carrier.helpers) {
        _rq.copy(carrier.p).addScaledVector(_rr, h.side * 55).addScaledVector(_rf, -25); _rq.y -= 6;
        flyTo(h, _rq, 5, 10, dt); h.mesh.position.copy(h.p); h.mesh.rotation.set(S.pitch, S.heading, S.roll * 0.7);
      }
      if (S.mode === 'playing' && !S.land && RX.smartM) { // smart missile support: picks the most urgent threat nobody is covering yet
        carrier.fireT -= dt;
        if (carrier.fireT <= 0) {
          let tgt = null; for (const c of MS.cands) if (!c.o.dead && incoming(c.o) < needed(c.o) && (c.tti < 4 || c.o.jet)) { tgt = c.o; break; }
          const from = RX.g47h ? carrier.helpers[(carrier.k = (carrier.k || 0) ^ 1)].p : carrier.p;
          carrier.fireT = tgt && fireMissile({ from: tgt.jet ? carrier.p : from, free: true, tgt, g47: true, g47Freeze: RX.g47fz }) ? 0.7 : 0.2;
        }
      }
    }
  }
  if (drone) {
    const on = RX.drone && live; drone.mesh.visible = on;
    if (on) {
      const k = clamp(Math.round(MPATH.length * (RX.g3far ? 0.85 : 0.45)), 4, MPATH.length - 1); _rq.copy(MPATH[k]); _rq.y += RX.g3far ? 55 : 30;
      flyTo(drone, _rq, 2.5, 35, dt); drone.mesh.position.copy(drone.p);
      drone.rollT = (drone.rollT ?? 6) - dt; if (drone.rollT < -0.9) drone.rollT = 7 + Math.random() * 8;
      drone.mesh.rotation.set(0, S.heading, Math.sin(S.t * 1.3) * 0.15 + (drone.rollT < 0 ? (-drone.rollT / 0.9) * Math.PI * 2 : 0));
      RX.strikeCool = Math.max(0, RX.strikeCool - dt);
      if (S.mode === 'playing' && !S.land) { drone.fireT = (drone.fireT ?? 1.5) - dt; if (drone.fireT <= 0) { let tgt = null; for (const c of MS.cands) if (!c.o.dead && incoming(c.o) < needed(c.o) && c.tti < 5) { tgt = c.o; break; } drone.fireT = tgt && fireMissile({ from: drone.p, free: true, tgt }) ? 1.6 : 0.3; } }
    }
  }
  if (RX.strikeFx > 0) { RX.strikeFx -= dt; $('rxFlash').style.opacity = clamp(RX.strikeFx * 1.6, 0, 1).toFixed(2); }
}
function strikeCard(show) { RX.strikeOffer = show; $('rxCard').classList.toggle('hidden', !show); if (show) rxSay('G3 has a strike lined up. Approve?', 'strike'); }
function scoutStrike() {
  strikeCard(false); RX.strikeCool = 120;
  if (S.mode !== 'playing') return;
  audio.boom(); audio.explode(); flash(1); RX.strikeFx = 1.1; S.shake = Math.max(S.shake, 1.6);
  pop('☄ SCOUT STRIKE · ROUTE CLEARED', 'unlock'); rxSay('Strike inbound. Route cleared.', 'strike2');
  const cur = Math.floor(-S.pos.z / CHUNK_L), span = Math.ceil(3500 / CHUNK_L); let n = 0;
  for (let i = cur; i <= cur + span; i++) {
    const ch = chunks.get(i); if (!ch) continue;
    for (const o of ch.objs) {
      if (o.dead || (o.type === 'boulder' && o.r < 3)) continue;
      if (Math.abs(o.x - world.pathX(o.z)) > 320) continue;
      if (n++ % 6 === 0 && n < 120) { aimPoint(o, _rq); shock.spawn(_rq.clone(), new THREE.Vector3(0, 1, 0), 120, 0.9, new THREE.Color(1.6, 0.9, 0.4), 0.8); }
      o.dead = true; S.score += 25; MS.kills++;
    }
  }
  RX.instDirty = true;
  headingFrame(S.heading);
  shock.spawn(S.pos.clone().addScaledVector(_rf, 300), new THREE.Vector3(0, 1, 0), 900, 1.4, new THREE.Color(1.8, 1.2, 0.6), 1);
  for (const e of RX.enemies) if (!e.dead) damageJet(e, 99, e.p);
}
// picture-in-picture feed (low-res corner render after the main frame; skipped when quality drops)
const pipCam = new THREE.PerspectiveCamera(62, 16 / 10, 1, 9000); scene.add(pipCam); // in the scene graph so the floating origin applies
function renderPip() {
  if (!RX.pip || RX.ride) { $('rxPip').classList.add('hidden'); return; }
  const src = RX.pip === 1 ? carrier : drone; if (!src || !src.mesh.visible) { $('rxPip').classList.add('hidden'); return; }
  const el = $('rxPip'); if (el.classList.contains('hidden')) { el.classList.remove('hidden'); $('rxPipL').textContent = RX.pip === 1 ? '● LIVE · CARRIER' : '● LIVE · SCOUT'; }
  if (RX.pipSkip = !RX.pipSkip && quality.pr < quality.maxPR * 0.8) return; // half-rate feed on reduced quality
  headingFrame(S.heading);
  if (RX.pip === 1) { pipCam.position.copy(src.p).addScaledVector(_rf, -20); pipCam.position.y += 14; pipCam.lookAt(_rq.copy(S.pos).addScaledVector(_rf, 120)); }
  else { pipCam.position.copy(src.p).addScaledVector(_rf, 6); pipCam.position.y -= 2; pipCam.lookAt(_rq.copy(src.p).addScaledVector(_rf, 400).setY(src.p.y - 70)); }
  const r = el.getBoundingClientRect(), H = innerHeight;
  pipCam.aspect = r.width / r.height; pipCam.updateProjectionMatrix();
  const auto = renderer.autoClear, tgt = renderer.getRenderTarget();
  renderer.setRenderTarget(null); renderer.setScissorTest(true);
  renderer.setViewport(r.left, H - r.bottom, r.width, r.height); renderer.setScissor(r.left, H - r.bottom, r.width, r.height);
  renderer.autoClear = true; renderer.render(scene, pipCam);
  renderer.setScissorTest(false); renderer.setViewport(0, 0, innerWidth, innerHeight); renderer.autoClear = auto; renderer.setRenderTarget(tgt);
}
const RX_ACT = {
  mxWing: () => setWing((RX.wing + 1) % 3), mxWave: () => freezeWave(), mxCam: () => rideToggle(),
  mxWar: () => { RX.warhead = RX.warhead === 'he' ? 'freeze' : 'he'; pop(RX.warhead === 'freeze' ? '❄ FREEZE WARHEADS' : 'HIGH-EXPLOSIVE WARHEADS', 'banked'); rxMenuSync(); },
  mxUltra: () => setUltra(!RX.ultra), mxBlast: () => blastGo(), mxLand: () => rxLandToggle(), mxGhost: () => setGhost(!RX.ghost),
  mxScan: () => { RX.scanner = !RX.scanner; localStorage.setItem('canyon.ai', RX.scanner ? '1' : '0'); if (!RX.scanner) { $('aiBox').classList.add('hidden'); RX.aiLast = null; } rxMenuSync(); },
  mxForces: () => { RX.forces = !RX.forces; localStorage.setItem('canyon.forces', RX.forces ? '1' : '0'); pop(RX.forces ? 'REALISTIC FORCES ON · WIND / TURBULENCE / DAMAGE PULL' : 'REALISTIC FORCES OFF', 'banked'); rxMenuSync(); },
  mxTF: () => { controls.terrainFollow = !controls.terrainFollow; localStorage.setItem('canyon.tf', controls.terrainFollow ? '1' : '0'); pop('TERRAIN FOLLOW ' + (controls.terrainFollow ? 'ON' : 'OFF · ALTITUDE HELD'), 'banked'); rxMenuSync(); },
  mxDebug: () => { RX.debug = !RX.debug; $('dbg').classList.toggle('hidden', !RX.debug); rxMenuSync(); },
  optBtn: () => rxMenu(),
  mxTilt: () => { controls.tiltOn = !controls.tiltOn; localStorage.setItem('canyon.tilt', controls.tiltOn ? '1' : '0'); if (controls.tiltOn) controls.calibrate(0.1); pop('TILT STEER ' + (controls.tiltOn ? 'ON' : 'OFF'), 'banked'); rxMenuSync(); }, mxVoice: () => setVoice(!RX.voice),
  mxG: () => { RX.gfx = !RX.gfx; localStorage.setItem('canyon.gfx', RX.gfx ? '1' : '0'); rxMenuSync(); },
  mxCarrier: () => setCarrier(!RX.carrier), mxDrone: () => setDrone(!RX.drone), mxPip: () => cyclePip(),
  mxSwipe: () => { controls.swipeSteer = !controls.swipeSteer; localStorage.setItem('canyon.swipe', controls.swipeSteer ? '1' : '0'); pop(controls.swipeSteer ? 'SWIPE STEERING ON · DRAG TO FLY' : 'SWIPE STEERING OFF', 'banked'); rxMenuSync(); },
  mxAuto: () => { setAutopilot(!S.autopilot); rxMenuSync(); }, mxSafe: () => { setSafe(!safeMode); rxMenuSync(); }, mxFire: () => fireMissile(),
  mxGod: () => setGod(!RX.god), rqGod: () => setGod(!RX.god), mxFingerH: () => { controls.fingerHeight = !controls.fingerHeight; localStorage.setItem('canyon.fingerH', controls.fingerHeight ? '1' : '0'); pop('FINGER HEIGHT ' + (controls.fingerHeight ? 'ON' : 'OFF'), 'unlock'); rxMenuSync(); },
  mxSuper: () => { RX.super = !RX.super; pop(RX.super ? 'BLACKHAWK SUPERSAFE · CUTS THROUGH OBSTACLES' : 'SUPERSAFE OFF', 'unlock'); rxMenuSync(); },
  mxX: () => { RX.xsurv = !RX.xsurv; pop(RX.xsurv ? 'X SURVIVAL · WATER & ROCK IMPACTS ABSORBED' : 'X SURVIVAL OFF', 'unlock'); rxMenuSync(); },
  mxPhase: () => setPhase((RX.phase + 1) % 3), mxSmart: () => { RX.smart = !RX.smart; pop(RX.smart ? 'SMART ROCK AVOIDANCE ON' : 'SMART ROCK AVOIDANCE OFF', 'banked'); rxMenuSync(); },
  mxGsup: () => gsSupermode(), mxXform: () => xform(), mxCarSup: () => { RX.carSuper = !RX.carSuper; pop(RX.carSuper ? 'CAR SUPERSAFE · DESTROYS OBSTACLES IN PATH' : 'CAR SUPERSAFE OFF', 'unlock'); rxMenuSync(); }, mxG3far: () => { RX.g3far = !RX.g3far; rxMenuSync(); }, mxHelp: () => { RX.g47h = !RX.g47h; rxMenuSync(); },
  mxG3req: () => { if (!RX.drone) setDrone(true); if (RX.strikeCool > 0) pop('G3 STRIKE RECHARGING ' + Math.ceil(RX.strikeCool) + ' s', 'close'); else strikeCard(true); },
  mxSmartM: () => { RX.smartM = !RX.smartM; rxMenuSync(); }, mxG47pov: () => rideToggle(true), mxG47fz: () => { RX.g47fz = !RX.g47fz; rxMenuSync(); },
  mxCchase: () => setCam('chase'), mxCcock: () => setCam('cockpit'), mxCg3: () => setCam('g3'), mxCg47: () => setCam('g47'),
  mxSound: () => { RX.mute = !RX.mute; audio.setMaster(RX.mute ? 0 : (settings.vol ?? 0.85)); rxMenuSync(); },
  mxCig: () => { RX.cig = !RX.cig; rxMenuSync(); },
  trayTab: () => rxMenu(true),
  rxCardYes: () => scoutStrike(), rxCardNo: () => { strikeCard(false); RX.strikeCool = 45; }, rxMenuX: () => rxMenu(false),
  rxWaveBtn: () => freezeWave(), rxCamBtn: () => rideToggle(), rxExit: () => endRide(), rxLandBtn: () => rxLandToggle(),
};
for (const id in RX_ACT) { const el = $(id); if (!el) continue; const inTray = !!el.closest('#rxMenu') && id !== 'rxMenuX';
  if (inTray) { // tray buttons fire on a clean tap (pointerup without drag) so a sideways swipe scrolls the tray instead of toggling
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); el._tap = { x: e.clientX, y: e.clientY, sl: $('rxMenu').scrollLeft }; });
    el.addEventListener('pointerup', (e) => { const t = el._tap; el._tap = null; e.stopPropagation(); if (!t || Math.abs(e.clientX - t.x) > 12 || Math.abs(e.clientY - t.y) > 12 || Math.abs($('rxMenu').scrollLeft - t.sl) > 6) return; audio.resume(); RX_ACT[id](); });
  } else el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); audio.resume(); RX_ACT[id](); }); el.addEventListener('click', (e) => e.stopPropagation()); }
$('rxTab').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); rxMenu(); });
$('rxTab').addEventListener('click', (e) => e.stopPropagation());
$('rxMenu').addEventListener('pointerdown', (e) => { e.stopPropagation(); RX.mSw = { x: e.clientX, y: e.clientY, lx: e.clientX, sl: $('rxMenu').scrollLeft, v: 0, t: performance.now() }; });
// JS drag-scroll for the tray (iOS Safari: the page blocks native touch scrolling, so the tray scrolls itself) + momentum
addEventListener('pointermove', (e) => { const w = RX.mSw; if (!w) return; const m = $('rxMenu'), dx = e.clientX - w.lx, now = performance.now(); m.scrollLeft -= dx; m.scrollTop -= e.clientY - (w.ly ?? e.clientY); w.ly = e.clientY; w.v = dx / Math.max(1, now - w.t); w.lx = e.clientX; w.t = now; });
addEventListener('pointercancel', () => { RX.mSw = null; });
function trayFling(v) { return; const m = $('rxMenu'); let vv = v * 16; const tick = () => { if (Math.abs(vv) < 0.5 || RX.mSw) return; m.scrollLeft -= vv; vv *= 0.92; requestAnimationFrame(tick); }; requestAnimationFrame(tick); }
function trayPage(dir) { const m = $('rxMenu'); m.scrollTo({ left: m.scrollLeft + dir * m.clientWidth * 0.8, behavior: 'smooth' }); }
function trayDots() { const m = $('rxMenu'), d = $('trayDots'); if (!d) return; const n = Math.max(1, Math.ceil(m.scrollWidth / m.clientWidth)), i = Math.round(m.scrollLeft / Math.max(1, m.scrollWidth - m.clientWidth) * (n - 1));
  if (d.childElementCount !== n) d.innerHTML = '<i></i>'.repeat(n); [...d.children].forEach((c, k) => c.classList.toggle('on', k === i)); $('trayL').classList.toggle('dim', m.scrollLeft < 4); $('trayR').classList.toggle('dim', m.scrollLeft > m.scrollWidth - m.clientWidth - 4); }
$('rxMenu').addEventListener('scroll', trayDots); setInterval(trayDots, 500);
for (const [id, dir] of [['trayL', -1], ['trayR', 1]]) { $(id).addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); trayPage(dir); }); }
$('rxMenu').addEventListener('pointerup', (e) => { const w = RX.mSw; RX.mSw = null; if (w && Math.abs(w.v) > 0.3) trayFling(w.v); if (w && w.y - e.clientY > 60 && w.y - e.clientY > Math.abs(e.clientX - w.x) * 1.5 && $('rxMenu').scrollTop <= 0) rxMenu(false); }); // tray scrolls sideways; swipe down to close
$('rxScrim').addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); rxMenu(false); }); // tap outside closes
$('voiceChip').addEventListener('click', (e) => { e.stopPropagation(); setVoice(!RX.voice); });
addEventListener('keydown', (e) => {
  if (e.repeat || S.mode !== 'playing') return;
  const k = { KeyJ: 'mxWing', KeyQ: 'mxWave', KeyC: 'mxCam', KeyV: 'mxWar', KeyU: 'mxUltra', KeyB: 'mxBlast', KeyL: 'mxLand', KeyP: 'mxGhost', KeyI: 'mxScan', KeyO: 'mxVoice', KeyK: 'mxCarrier', KeyJ: 'mxDrone', KeyN: 'mxPip', KeyH: 'mxSwipe', KeyY: 'rxCardYes', KeyT: 'mxXform', KeyG: 'mxGod', KeyM: null }[e.code];
  if (e.code === 'KeyM') rxMenu(); else if (e.code === 'Escape') { if (RX.ride) endRide(); else rxMenu(false); } else if (k) RX_ACT[k]();
});
rxMenuSync();

// ---------- adaptive quality ----------
const perf = { acc: 0, frames: 0, good: 0, worst: 0 };
function adaptQuality(dt) {
  perf.acc += dt; perf.frames++;
  if (perf.acc < 1) return;
  const fps = perf.frames / perf.acc;
  perf.acc = 0; perf.frames = 0;
  window.__game.fps = fps;
  if (lockQ || document.hidden || S.t < 4) return;
  // emergency fallback only: sustained < 45 fps for 3 s steps quality down one notch
  if (fps < 45) {
    perf.good = 0; perf.bad = (perf.bad || 0) + 1;
    if (perf.bad < 3) return;
    perf.bad = 0;
    if (quality.pr > Math.max(quality.minPR, 1.5) + 0.01) { quality.failPR = quality.pr; quality.pr = Math.max(quality.minPR, quality.pr - 0.25); renderer.setPixelRatio(quality.pr); resize(); }
    else if (quality.blur) quality.blur = false;
    else if (gdust.count > 262144) gdust.setCount(gdust.count / 2);
    else if (grass.level === 'ultra') grass.setLevel('high');
    else if (quality.pr > quality.minPR + 0.01) { quality.pr = Math.max(quality.minPR, quality.pr - 0.25); renderer.setPixelRatio(quality.pr); resize(); }
    else if (sunLight.castShadow) sunLight.castShadow = false;
    else if (post.enabled) post.enabled = false;
    else quality.particles = Math.max(0.4, quality.particles - 0.2);
  } else { perf.bad = 0; }
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  document.body.classList.toggle('portrait', h > w);
  controls.hudTop = (document.getElementById('tc').getBoundingClientRect().bottom || 96) + 4;
}
addEventListener('resize', resize);
resize();

let paused = false;
document.addEventListener('visibilitychange', () => { paused = document.hidden; if (paused) audio.suspend(); else { audio.resume(); last = performance.now(); } });

// ---------- main loop ----------
applySkin(skinIdx); refreshSkinUI(); setSafe(safeMode); refreshAchUI(); refreshModeUI();
const settings = Object.assign({ sens: 1, quality: 'ultra', vol: 0.85, adaptive: true }, JSON.parse(localStorage.getItem('canyon.settings') || '{}'));
if (!localStorage.getItem('canyon.v2')) { settings.quality = 'ultra'; settings.adaptive = true; localStorage.setItem('canyon.v2', '1'); }
if (!['ultra', 'high', 'low'].includes(settings.quality)) settings.quality = 'ultra';
const PRESETS = {
  ultra: { pr: Math.min(DPR, 3), shadows: true, particles: 1, grass: 'ultra', dust: 1048576, post: true, blur: true },
  high: { pr: Math.min(DPR, 2), shadows: true, particles: 1, grass: 'high', dust: 262144, post: true, blur: true },
  low: { pr: Math.min(DPR, 1), shadows: false, particles: 0.6, grass: 'low', dust: 65536, post: false, blur: false },
};
let preset = null;
function applyPreset(name) {
  const P = PRESETS[name]; preset = { name, ...P };
  quality.maxPR = P.pr; quality.pr = P.pr; quality.failPR = 99; quality.particles = P.particles; quality.blur = P.blur; quality.step = 0;
  sunLight.castShadow = P.shadows;
  if (grass.level !== P.grass) grass.setLevel(P.grass);
  if (gdust.count !== P.dust) gdust.setCount(P.dust);
  post.enabled = P.post && post.supported;
  renderer.setPixelRatio(quality.pr); resize();
}
function applySettings() {
  localStorage.setItem('canyon.settings', JSON.stringify(settings));
  controls.sens = settings.sens; audio.volume = settings.vol; audio.setMaster(settings.vol);
  $('sensVal').textContent = settings.sens.toFixed(1) + '×'; $('volVal').textContent = Math.round(settings.vol * 100) + '%';
  $('qualChip').textContent = 'Graphics: ' + settings.quality.toUpperCase();
  $('adaptChip').textContent = 'Emergency auto-downscale: ' + (settings.adaptive ? 'ON' : 'OFF');
  const q = params.get('q'), want = PRESETS[q] ? q : settings.quality;
  if (!preset || preset.name !== want) applyPreset(want);
  lockQ = !settings.adaptive || params.has('lock') || TEST;
}
$('sens').value = settings.sens; $('vol').value = settings.vol;
$('sens').addEventListener('input', (e) => { settings.sens = +e.target.value; applySettings(); });
$('vol').addEventListener('input', (e) => { settings.vol = +e.target.value; applySettings(); });
$('qualChip').addEventListener('click', (e) => { e.stopPropagation(); settings.quality = { ultra: 'high', high: 'low', low: 'ultra' }[settings.quality] || 'ultra'; applySettings(); });
$('adaptChip').addEventListener('click', (e) => { e.stopPropagation(); settings.adaptive = !settings.adaptive; applySettings(); });
$('setBtn').addEventListener('click', (e) => { e.stopPropagation(); $('settings').classList.remove('hidden'); });
$('aboutBtn').addEventListener('click', (e) => { e.stopPropagation(); $('about').classList.remove('hidden'); });
$('aboutClose').addEventListener('click', (e) => { e.stopPropagation(); $('about').classList.add('hidden'); });
$('about').addEventListener('click', (e) => e.stopPropagation());
$('setClose').addEventListener('click', (e) => { e.stopPropagation(); $('settings').classList.add('hidden'); });
$('settings').addEventListener('click', (e) => e.stopPropagation());
$('modeChip').addEventListener('click', (e) => { e.stopPropagation(); daily = !daily; refreshModeUI(); });
applySettings();
$('lifeStart').textContent = 'Lifetime: ' + (+localStorage.getItem('canyon.totalKm') || 0).toFixed(1) + ' km flown';
resetRun('attract');
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000; last = now;
  if (paused) return;
  dt = Math.min(Math.max(dt, 0.0005), 0.05);
  tick(dt, true);
}
function rebaseOrigin() { // keep render-space coordinates within ~4 km of the camera
  if (params.has('noro')) return;
  const c = camera.position;
  if (Math.abs(c.x - RO.x) < 4096 && Math.abs(c.z - RO.z) < 4096) return;
  RO.set(Math.round(c.x / 2048) * 2048, 0, Math.round(c.z / 2048) * 2048);
  scene.position.set(-RO.x, 0, -RO.z); scene.updateMatrixWorld(true); RX.rebases = (RX.rebases || 0) + 1;
}
function tick(dt, draw) {
  const rdt = dt; dt *= RX.timeScale;
  S.t += dt;
  controls.update(rdt);
  rxUpdateZones(); dbgUpdate();
  let thr = controls.throttle, spdN = spdNf(S.speed);
  if (S.mode !== 'crashed') {
    // fixed sub-steps: never move more than ~20 m (8700 km/h) between swept collision tests, at any frame rate
    const nSub = Math.min(40, Math.max(1, Math.ceil(dt / (1 / 120)), Math.ceil(S.speed * dt / 22))), sdt = dt / nSub;
    S.apDt = dt;
    for (let i = 0; i < nSub && S.mode !== 'crashed'; i++) {
      S.apSub = i > 0;
      const r = updateFlight(sdt); thr = r.thr; spdN = r.spdN;
      if (S.mode === 'playing' && !S.noCollide && resolveCollisions(sdt)) { crash(); break; }
    }
    S.apSub = false;
    if (!RX.blast) streamChunks(S.pos.z, false);
    updateDamage(dt);
    nearMisses();
    const kmh = S.speed * 3.6;
    if (S.mode === 'playing') {
      if (kmh >= MACH_KMH && S.boomArmed) {
        S.boomArmed = false; audio.boom(); flash(0.55); S.shake = 1.2; pop('MACH 1', 'mach');
        _v.copy(S.vel).normalize();
        shock.spawn(S.pos.clone().addScaledVector(_v, -4), _v.clone(), 90, 0.9, new THREE.Color(1, 0.95, 0.85), 0.9);
        shock.spawn(S.pos.clone().addScaledVector(_v, -10), _v.clone(), 45, 0.6, new THREE.Color(1, 0.8, 0.55), 0.6);
        for (let i = 0; i < 40; i++) { const a = Math.random() * Math.PI * 2; const vx = Math.cos(a) * 60, vy = Math.sin(a) * 60; dust.spawn(S.pos.x, S.pos.y, S.pos.z + 6, S.vel.x * 0.6 + vx * Math.cos(S.heading), S.vel.y * 0.6 + vy, S.vel.z * 0.6 - vx * Math.sin(S.heading), 1.2, 3, 16, 0.35, 1, 0.92, 0.82, 1.5, 0); }
      }
      if (kmh < MACH_KMH - 60) S.boomArmed = true;
    }
  } else {
    S.speed = damp(S.speed, 0, 2, dt);
    for (const d of debris) if (d.m.visible) {
      d.v.y -= 30 * dt; d.m.position.addScaledVector(d.v, dt);
      d.m.rotation.x += d.w.x * dt; d.m.rotation.y += d.w.y * dt;
      const g = world.surface(d.m.position.x, d.m.position.z);
      if (d.m.position.y < g) { d.m.position.y = g; d.v.multiplyScalar(0.4); d.v.y = Math.abs(d.v.y) * 0.5; }
      if (Math.random() < dt * 20) dust.spawn(d.m.position.x, d.m.position.y, d.m.position.z, 0, 3, 0, 1.5, 1, 6, 0.4, 0.15, 0.12, 0.1, 1, 0);
    }
    debrisMat.emissiveIntensity = Math.max(0, 1 - S.crashT * 0.5);
  }
  updateScore(dt);
  updateBiomeEnv(dt);
  updateWeather(dt);
  updateShipFx(thr, spdN, dt);
  spawnDust(dt, thr, spdN);
  updateMissiles(dt);
  rxUpdate(dt, rdt);
  dust.update(dt); glow.update(dt); shock.update(dt);
  updateCamera(dt, spdN);
  rxCamera(rdt);
  updateSpecks(dt);
  if (RX.above !== RX.grassAbove) { RX.grassAbove = RX.above; grass.over = RX.above ? (x, z) => { const r = roofAt(z); return r ? r.t : null; } : null; grass.reset(); }
  grass.U.sunI.value = sunLight.intensity; grass.U.hemiI.value = hemi.intensity;
  grass.update(dt, S.t, world, camera, S.pos, S.mode === 'crashed' ? 999 : S.agl, spdN, (isGrassNear(camera.position.z) && !RX.above || RX.above) && RX.iceK < 0.5);
  { const wu = waterMat.uniforms; wu.trail.value = grass.trail; wu.wash.value = grass.U.wash.value; wu.washR.value = grass.U.washR.value * 1.2; wu.shipP.value.copy(S.pos); }
  streaks.update(camera.position, S.vel, S.mode === 'crashed' ? 0 : clamp((S.speed * 3.6 - 650) / 1300, 0, 1) + S.storm.k * 0.3);
  // sun light follows ship for a tight shadow frustum
  sunLight.position.copy(S.pos).addScaledVector(SUN, 600);
  sunLight.target.position.copy(S.pos);
  sky.position.copy(camera.position);
  _sunV.copy(SUN).transformDirection(camera.matrixWorldInverse);
  for (const m of ship.userData.hullMats) if (m.userData.sh) m.userData.sh.uniforms.sunDirV.value.copy(_sunV);
  skyMat.uniforms.time.value = S.t;
  fallsMat.uniforms.time.value = S.t * (1 - RX.iceK); fallsMat.uniforms.iceK.value = RX.iceK;
  { // engine load: throttle + boost + blizzard strain; HUD gauge + audio
    const tgt = clamp(0.22 + 0.5 * thr + 0.15 * (S.boostFx || 0) + 0.45 * (S.snowK || 0) + 0.12 * (S.frost || 0), 0, 1);
    S.engLoad = damp(S.engLoad || 0, tgt, tgt > (S.engLoad || 0) ? 0.9 : 0.5, dt);
    audio.strain = S.snowK || 0;
    const el = $('engFill'); el.style.transform = `scaleX(${S.engLoad.toFixed(3)})`; el.style.background = S.engLoad > 0.85 ? '#ff5a3c' : S.engLoad > 0.65 ? '#ffc04a' : '#7ee0ff';
    $('engBox').classList.toggle('hot', S.engLoad > 0.85);
  }
  audio.update(thr, spdN, clamp(1 - S.agl / 40, 0, 1), S.wx.anyK, S.boostFx || 0, S.mode !== 'crashed');
  audio.weather(S.wx.rainK, S.wx.hailK);
  { const B = world.biomeAt(camera.position.z); const jk = (B.a === 'jungle' ? 1 - B.t : 0) + (B.b === 'jungle' ? B.t : 0); audio.jungle(jk, dt); S.jungleK = jk; }
  flashV = Math.max(0, flashV - dt * 2.5);
  $('flash').style.opacity = flashV.toFixed(3);
  if (S.mode === 'playing') updateHUD(dt);
  gdust.update(S.t, renderer.domElement.height, camera.fov);
  post.blur = quality.blur && S.mode !== 'crashed' ? clamp((S.speed * 3.6 - 900) / 1340, 0, 1) * 0.11 + (S.boostFx || 0) * 0.03 : 0;
  post.sat = 1 - 0.5 * Math.min(S.wx.rainK || 0, 1) - 0.25 * (S.wx.fogK || 0);
  { const rk = Math.min(S.wx.rainK || 0, 1); post.tint = post.tint || new THREE.Vector3(1, 1, 1); post.tint.set(1 - 0.17 * rk, 1 - 0.04 * rk, 1 + 0.14 * rk); }
  if (draw) { rebaseOrigin(); post.render(scene, camera, S.t); renderPip(); adaptQuality(dt); }
}
requestAnimationFrame(frame);

// ---------- v32: hide/show controls (persistent handle) + voice control OFF/ON ----------
function setUiOff(off) { document.body.classList.toggle('ui-off', off); $('trayHandle').textContent = off ? '›' : '‹'; if (off) rxMenu(false); }
$('trayHandle').addEventListener('click', (e) => { e.stopPropagation(); setUiOff(!document.body.classList.contains('ui-off')); });
const VC = { on: false, rec: null };
function setVoiceCtl(on) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (on && !SR) { pop('VOICE CONTROL UNAVAILABLE · USE THE ‹ HANDLE', 'close'); on = false; }
  VC.on = on; $('mxVc').textContent = '🎙 VOICE CONTROL · ' + (on ? 'ON' : 'OFF'); $('mxVc').classList.toggle('on', on);
  if (VC.rec) { try { VC.rec.onend = null; VC.rec.stop(); } catch (e) {} VC.rec = null; }
  if (!on) return;
  const r = new SR(); r.continuous = true; r.interimResults = false; r.lang = 'en-US';
  r.onresult = (ev) => { const t = ev.results[ev.results.length - 1][0].transcript.trim().toLowerCase(); if (/\boff\b/.test(t)) setUiOff(true); else if (/\bon\b/.test(t)) setUiOff(false); };
  r.onerror = (ev) => { if (ev.error === 'not-allowed') { pop('MICROPHONE BLOCKED · USE THE ‹ HANDLE', 'close'); setVoiceCtl(false); } };
  r.onend = () => { if (VC.on) try { r.start(); } catch (e) {} };
  try { r.start(); VC.rec = r; pop('SAY "OFF" / "ON" TO HIDE / SHOW CONTROLS', 'banked'); } catch (e) { setVoiceCtl(false); }
}
$('mxVc').addEventListener('click', () => setVoiceCtl(!VC.on));
window.__game.ui = { setUiOff, setVoiceCtl, megaBoom };



// ---------- v35: localized rock damage ----------
function rockDamage(o, zone, impact, p) {
  if (o.dead || o.jet) return;
  const central = zone === 'B' || zone === 'N';
  const take = central ? 0.22 + impact * 0.3 : 0.08; // wing glance chips a small piece; a centre hit fractures a big chunk
  if (o.frozen != null || o.col === ICE_COL) { shatterIce(o); return; } // ice fractures shatter instead of chipping
  const r0 = o.r; o.r = Math.max(0.6, o.r * (1 - take)); CHIPPED.set(o.uid, o.r); RX.instDirty = true;
  if (o.r < 1.2) { o.dead = true; }
  let n = 0; const big = clamp((r0 - o.r) / 2, 0.4, 2.5);
  for (const d of MS.debris) { if (d.t > 0) continue; if (n++ >= (central ? 7 : 3)) break; const sc = (0.4 + Math.random()) * big; d.m.scale.set(sc, sc * 0.7, sc); d.m.material.color.setRGB(0.32, 0.22, 0.15, LIN); d.m.position.copy(p); const a = Math.random() * 6.283, sp = 8 + Math.random() * 25; d.v.set(Math.cos(a) * sp + S.vel.x * 0.3, 6 + Math.random() * 18, Math.sin(a) * sp + S.vel.z * 0.3); d.w.set(Math.random() * 9, Math.random() * 9, Math.random() * 9); d.t = 2.5 + Math.random() * 2; d.m.visible = true; }
}
// ---------- v35: military base contents (instanced, streamed along the full 100 km) ----------
const BASE = (() => {
  const mk = (geo, mat, cap) => { const m = new THREE.InstancedMesh(geo, mat, cap); m.count = 0; m.frustumCulled = false; m.receiveShadow = true; m.castShadow = cap < 100; scene.add(m); return m; };
  const asphalt = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.92 }), paint = new THREE.MeshStandardMaterial({ color: 0xe8e8e0, roughness: 0.7 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x5a5f58, metalness: 0.5, roughness: 0.55 }), olive = new THREE.MeshStandardMaterial({ color: 0x3d4630, roughness: 0.8 });
  const conc = new THREE.MeshStandardMaterial({ color: 0x8a867c, roughness: 0.9 }), lightM = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.7, 0.6), toneMapped: false }), dishM = new THREE.MeshStandardMaterial({ color: 0xd0d2d4, metalness: 0.3, roughness: 0.4, side: THREE.DoubleSide });
  return {
    tile: mk(new THREE.BoxGeometry(60, 0.4, 100), asphalt, 400), dash: mk(new THREE.BoxGeometry(1.4, 0.45, 18), paint, 400), edge: mk(new THREE.BoxGeometry(0.6, 0.6, 0.6), lightM, 900),
    hangar: mk(new THREE.CylinderGeometry(18, 18, 46, 16, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateY(Math.PI / 2), metal, 160), hangarBase: mk(new THREE.BoxGeometry(36, 4, 46), conc, 160),
    radarMast: mk(new THREE.CylinderGeometry(0.7, 1, 14, 8), metal, 80), radarDish: mk(new THREE.SphereGeometry(7, 16, 8, 0, Math.PI * 2, 0, Math.PI / 3), dishM, 80),
    samBase: mk(new THREE.BoxGeometry(6, 2.2, 9), olive, 200), samTube: mk(new THREE.BoxGeometry(4.2, 1.6, 8).translate(0, 0, -1), olive, 200),
    truck: mk(new THREE.BoxGeometry(3, 3, 9), olive, 300), tank: mk(new THREE.CylinderGeometry(1.3, 1.3, 6, 10).rotateX(Math.PI / 2), metal, 80),
    jetBody: mk(new THREE.BoxGeometry(2.2, 1.8, 16), metal, 300), jetWing: mk(new THREE.BoxGeometry(12, 0.3, 4), metal, 300),
    bldg: mk(new THREE.BoxGeometry(22, 9, 16), conc, 120), gen: mk(new THREE.BoxGeometry(5, 3, 4), olive, 120),
    twy: mk(new THREE.BoxGeometry(24, 0.35, 100), new THREE.MeshStandardMaterial({ color: 0x2a2b2c, roughness: 0.95 }), 200), fence: mk(new THREE.BoxGeometry(0.3, 3, 500), new THREE.MeshStandardMaterial({ color: 0x7c8086, metalness: 0.6, roughness: 0.5, transparent: true, opacity: 0.55 }), 80),
    pole: mk(new THREE.CylinderGeometry(0.2, 0.25, 12, 6), metal, 300), poleLamp: mk(new THREE.BoxGeometry(1.2, 0.4, 0.8), lightM, 300),
    heliBody: mk(new THREE.CapsuleGeometry(1.5, 5, 4, 8).rotateX(Math.PI / 2), olive, 80), heliRotor: mk(new THREE.BoxGeometry(14, 0.12, 0.5), metal, 160),
    segs: new Map(),
  };
})();
const _bm = new THREE.Matrix4(), _bp = new THREE.Vector3(), _bq = new THREE.Quaternion(), _bs = new THREE.Vector3(1, 1, 1), _be = new THREE.Euler();
function bPut(m, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0) { if (m.count >= m.instanceMatrix.count) return; _bp.set(x, y, z); _be.set(rx, ry, 0); _bq.setFromEuler(_be); _bs.set(sx, sy, sz); _bm.compose(_bp, _bq, _bs); m.setMatrixAt(m.count++, _bm); }
const BASE_DEAD = new Set(); // destroyed base props persist across streaming
const BASE_R = { hangar: 26, bldg: 14, radar: 8, sam: 7, truck: 6, fuel: 6, jet: 18, gen: 4, heli: 9, pole: 2 }, BASE_H = { hangar: 22, bldg: 10, radar: 22, sam: 5, truck: 4, fuel: 6, jet: 8, gen: 4, heli: 6, pole: 13 };
function baseSeg(A, k) { // deterministic, dense layout for one 500 m segment of the levelled base pad
  const key = A.start * 1000 + k; let sg = BASE.segs.get(key); if (sg) return sg;
  const r = makeRng((A.seed ^ (k * 2246822519)) >>> 0), d0 = A.start + k * 500, sd = baseSide(A), items = [];
  const at = (dz, off) => { const z = -(d0 + dz); return [baseCX(A, z) + sd * off, z]; };
  for (let j = 0; j < 5; j++) { const [x, z] = at(j * 100 + 50, 60); items.push(['rw', x, z]); const [tx, tz] = at(j * 100 + 50, 150); items.push(['twy', tx, tz]); }
  for (let j = 0; j < 3; j++) { const [x, z] = at(40 + j * 160 + r() * 30, 250); items.push([r() < 0.8 ? 'hangar' : 'bldg', x, z, Math.PI / 2 * sd]); }
  for (let j = 0; j < 4; j++) { const [x, z] = at(r() * 500, 170 + r() * 20); items.push([r() < 0.7 ? 'jet' : 'heli', x, z, Math.PI / 2 * sd + (r() - 0.5) * 0.3]); }
  for (let j = 0; j < 2; j++) { const [x, z] = at(r() * 500, 330 + r() * 50); items.push(['bldg', x, z, r() * 0.3]); }
  if (r() < 0.6) { const [x, z] = at(r() * 500, 370); items.push(['radar', x, z, r() * 6]); }
  if (r() < 0.25) { const [x, z] = at(r() * 500, -120); items.push(['radar', x, z, r() * 6]); }
  for (let j = 0; j < 2; j++) { const [x, z] = at(r() * 500, r() < 0.5 ? -60 - r() * 60 : 300 + r() * 80); items.push(['sam', x, z, r() * 6.28]); if (r() < 0.6) items.push(['sam', x + 12, z + 8, r() * 6.28]); }
  for (let j = 0; j < 3; j++) { const [x, z] = at(r() * 500, 120 + r() * 40); items.push(['truck', x, z, r() * 6.28]); }
  for (let j = 0; j < 2; j++) { const [x, z] = at(r() * 500, 200 + r() * 150); items.push([r() < 0.5 ? 'fuel' : 'gen', x, z, r() * 6.28]); }
  for (const off of [-170, BASE_HALF - 20]) { const [x, z] = at(250, off); items.push(['fence', x, z]); }
  for (let j = 0; j < 5; j++) { const [x, z] = at(j * 100, 210); items.push(['pole', x, z]); }
  items.forEach((it, i) => { it.uid = key + ':' + i; if (BASE_DEAD.has(it.uid)) it.dead = true; });
  sg = { items }; BASE.segs.set(key, sg); if (BASE.segs.size > 600) BASE.segs.delete(BASE.segs.keys().next().value); return sg;
}
function updateBase() {
  for (const k in BASE) if (BASE[k].isInstancedMesh) BASE[k].count = 0;
  const d = S.dist, A = RX.air.find((a) => d > a.start - 3000 && d < a.end + 1000);
  if (A && S.mode !== 'attract') {
    const k0 = Math.max(0, Math.floor((d - A.start - 1000) / 500)), k1 = Math.min(199, Math.floor((d - A.start + 5000) / 500));
    const t = S.t;
    const smash = (RX.god || RX.super) && S.mode === 'playing';
    for (let k = k0; k <= k1; k++) for (const it of baseSeg(A, k).items) {
      if (it.dead) continue;
      const [ty, x, z, ry = 0] = it, y = world.surface(x, z);
      if (smash && BASE_R[ty]) { const zz = ty === 'truck' ? z + ((t * 14 + ry * 50) % 300) - 150 : z, dx = x - S.pos.x, dz = zz - S.pos.z, rr = BASE_R[ty] + 8;
        if (dx * dx + dz * dz < rr * rr && S.pos.y < y + BASE_H[ty] + 8) { it.dead = true; BASE_DEAD.add(it.uid); S.godKills = (S.godKills || 0) + 1; S.baseKills = (S.baseKills || 0) + 1; airburst(_v.set(x, y + BASE_H[ty] * 0.5, zz).clone()); S.shake = Math.max(S.shake, 0.4); continue; } }
      if (ty === 'rw') { const ang = 0; bPut(BASE.tile, x, y + 0.2, z, ang); bPut(BASE.dash, x, y + 0.45, z, ang); bPut(BASE.dash, x, y + 0.45, z + 50, ang); for (const s2 of [-1, 1]) for (let q = 0; q < 4; q++) bPut(BASE.edge, x + s2 * 31, y + 0.6, z - 50 + q * 25); }
      else if (ty === 'hangar') { bPut(BASE.hangarBase, x, y + 2, z, ry); bPut(BASE.hangar, x, y + 4, z, ry); }
      else if (ty === 'radar') { bPut(BASE.radarMast, x, y + 7, z); bPut(BASE.radarDish, x, y + 15, z, t * 1.4 + ry, 1, 1, 1, -1.1); }
      else if (ty === 'sam') { bPut(BASE.samBase, x, y + 1.1, z, ry); bPut(BASE.samTube, x, y + 3, z, ry, 1, 1, 1, -0.5); }
      else if (ty === 'truck') { const dz = ((t * 14 + ry * 50) % 300) - 150; bPut(BASE.truck, x, y + world.surface(x, z + dz) - y + 1.5, z + dz, 0); } // moving machinery
      else if (ty === 'fuel') { bPut(BASE.truck, x, y + 1.5, z, ry); bPut(BASE.tank, x, y + 3.6, z, ry); }
      else if (ty === 'jet') { bPut(BASE.jetBody, x, y + 3.4, z, ry, 2.1, 2.1, 2.1); bPut(BASE.jetWing, x, y + 3.4, z, ry, 2.1, 2.1, 2.1); } // parked jets: 2.1x so they read from the air
      else if (ty === 'bldg') bPut(BASE.bldg, x, y + 4.5, z, ry);
      else if (ty === 'gen') bPut(BASE.gen, x, y + 1.5, z, ry);
      else if (ty === 'twy') bPut(BASE.twy, x, y + 0.18, z);
      else if (ty === 'fence') bPut(BASE.fence, x, y + 1.5, z);
      else if (ty === 'pole') { bPut(BASE.pole, x, y + 6, z); bPut(BASE.poleLamp, x, y + 12, z); }
      else if (ty === 'heli') { bPut(BASE.heliBody, x, y + 2, z, ry); bPut(BASE.heliRotor, x, y + 3.8, z, ry + t * 0.3); bPut(BASE.heliRotor, x, y + 3.8, z, ry + t * 0.3 + 1.57); }
    }
  }
  for (const k in BASE) if (BASE[k].isInstancedMesh) BASE[k].instanceMatrix.needsUpdate = true;
}
function baseThreats(A, d) {
  while (A.li < A.launches.length && A.launches[A.li] < d) { // distributed SAM launches: fire from a battery ahead toward the predicted intercept
    A.li++; const s = shotPool.find((q) => !q.on); if (!s) continue;
    headingFrame(S.heading); const ah = Math.min(Math.max(1800, S.speed * 2.2), 9000), side = Math.random() < 0.5 ? -1 : 1;
    s.p.copy(S.pos).addScaledVector(_rf, ah).addScaledVector(_rr, side * (120 + Math.random() * 200)); s.p.y = world.surface(s.p.x, s.p.z) + 3;
    const tt = clamp(ah / Math.max(S.speed + 900, 1), 0.8, 4.5); _rq.copy(S.pos).addScaledVector(S.vel, tt);
    s.v.subVectors(_rq, s.p).divideScalar(tt); s.on = true; s.t = 0; s.sam = true; s.s.visible = true; s.icpt = undefined;
    S.samLaunches = (S.samLaunches || 0) + 1; if (S.samLaunches % 4 === 1) pop('⚠ SAM LAUNCH', 'close');
  }
  while (A.bi < A.bombs.length && A.bombs[A.bi] < d + 2500) { // occasional bombing run: a stick of bombs walks along the route ahead
    const at = A.bombs[A.bi++]; headingFrame(S.heading); RX.bombs = RX.bombs || [];
    for (let k = 0; k < 6; k++) { const z = -(at + k * 70), x = world.pathX(z) + (Math.random() - 0.5) * 80; RX.bombs.push({ x, z, t: (at + k * 70 - S.dist) / Math.max(S.speed, 1) - 0.3 }); }
    pop('⚠ BOMBING RUN AHEAD', 'close');
  }
  if (RX.bombs) for (let i = RX.bombs.length - 1; i >= 0; i--) { const b = RX.bombs[i]; b.t -= 1 / 60; if (b.t > 0) continue; RX.bombs.splice(i, 1); const y = world.surface(b.x, b.z); airburst(_v.set(b.x, y + 3, b.z)); if (Math.hypot(b.x - S.pos.x, b.z - S.pos.z) < 40 && S.pos.y - y < 40 && !RX.ghost && !inSafeBand() && !RX.god && S.mode === 'playing') { S.hp.B = Math.max(0, S.hp.B - 12); flash(0.3); pop('BOMB BLAST · HULL ' + Math.round(S.hp.B) + '%', 'close'); } }
}
// ---------- v35: WHITE RAIDER ICEHAWK ----------
let icehawkMesh = null;
function spawnIcehawk(A) {
  if (!icehawkMesh) { icehawkMesh = makeJet(new THREE.Color(0xf4f6f8), new THREE.Color(0x8fd8ff)); icehawkMesh.scale.multiplyScalar(1.65);
    for (const x of [-1.2, 1.2]) { const g = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(0.4, 1.2, 2.6), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false })); g.position.set(x, 0, 4.5); g.scale.setScalar(2.4); icehawkMesh.add(g); } }
  A.icehawkUp = true; headingFrame(S.heading);
  const e = { jet: true, type: 'jet', icehawk: true, zone: A, mesh: icehawkMesh, hp: 3, dead: false, r: 11, h: 9, col: [1, 1, 1], p: new THREE.Vector3().copy(S.pos).addScaledVector(_rf, 1500), v: new THREE.Vector3(), ahead: 600, lat: 0, up: 40, ph: 0, fireT: 3, roll: 0, x: 0, y: 0, z: 0 };
  e.p.y = S.pos.y + 90; icehawkMesh.visible = true; RX.enemies.push(e);
  pop('❄ WHITE RAIDER ICEHAWK · 3 HITS TO DOWN', 'close'); rxSay('Warning. White raider Icehawk.', 'ih0');
}

// ---------- v36: birds (shown below ~1,200 km/h) + Ice Age fossils ----------
const birdGeo = (() => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.3, -1.1, 0.25, 0.25, 0, 0, 0.35, 0, 0, -0.3, 0, 0, 0.35, 1.1, 0.25, 0.25], 3)); g.computeVertexNormals(); return g; })();
const birds = new THREE.InstancedMesh(birdGeo, new THREE.MeshStandardMaterial({ color: 0x1c1a18, roughness: 0.9, side: THREE.DoubleSide }), 60); birds.count = 0; birds.frustumCulled = false; scene.add(birds);
const BIRDS = { flocks: [], next: 0 };
const fossilGeo = new THREE.TorusGeometry(3.2, 0.28, 6, 14, Math.PI);
const fossils = new THREE.InstancedMesh(fossilGeo, new THREE.MeshStandardMaterial({ color: 0xd9d2c3, roughness: 0.85 }), 400); fossils.count = 0; fossils.frustumCulled = false; scene.add(fossils);
function updateBirdsFossils(dt) {
  if (S.dist < (BIRDS.last || 0) - 50) { BIRDS.next = 0; BIRDS.flocks.length = 0; CLOUDC.clear(); } BIRDS.last = S.dist; // new run
  const kmh = S.speed * 3.6; birds.count = 0;
  if (S.mode !== 'crashed' && !RX.blast) {
    if (S.dist > BIRDS.next && kmh < 1200 && !RX.ice) { BIRDS.next = S.dist + 1500 + Math.random() * 2500; headingFrame(S.heading); const c = S.pos.clone().addScaledVector(_rf, 500 + Math.random() * 500).addScaledVector(_rr, (Math.random() - 0.5) * 200); c.y = world.surface(c.x, c.z) + 25 + Math.random() * 40; BIRDS.flocks.push({ c, h: Math.random() * 6.28, n: 12 + (Math.random() * 18 | 0), t: 0 }); if (BIRDS.flocks.length > 3) BIRDS.flocks.shift(); }
    if (kmh < 1200) for (const f of BIRDS.flocks) { // ~70 km/h flock
      f.t += dt; f.h += Math.sin(f.t * 0.3) * 0.2 * dt; f.c.x += -Math.sin(f.h) * 19.4 * dt; f.c.z += -Math.cos(f.h) * 19.4 * dt;
      for (let i = 0; i < f.n && birds.count < 60; i++) { const a = i * 2.39996, r = 3 + Math.sqrt(i) * 3.5, fl = Math.sin(f.t * 9 + i) * 0.8;
        _bp.set(f.c.x + Math.cos(a) * r, f.c.y + Math.sin(i * 1.7) * 3, f.c.z + Math.sin(a) * r); _be.set(0, f.h, 0); _bq.setFromEuler(_be); _bs.set(1.4, 1.4 * (0.4 + 0.6 * Math.abs(fl)) * Math.sign(fl || 1), 1.4); _bm.compose(_bp, _bq, _bs); birds.setMatrixAt(birds.count++, _bm); }
    }
  }
  birds.instanceMatrix.needsUpdate = true;
  fossils.count = 0;
  if (RX.iceK > 0.5) { // fossils (not living creatures): each 100 km checkpoint has a 5% chance of a fossil field
    for (let cp = Math.floor((S.dist - 1000) / 100000); cp <= Math.floor((S.dist + 6000) / 100000); cp++) {
      const r = makeRng(((S.seed || 1) ^ (cp * 0x51ed27)) >>> 0); if (!(r() < 0.05) && !params.has('fossils')) continue;
      const st = params.has('fossils') ? 300 : cp * 100000 + r() * 90000;
      for (let k = 0; k < 8; k++) { const d = st + k * 600 + r() * 300; if (d < S.dist - 800 || d > S.dist + 6000) continue; const z = -d, x = world.pathX(z) + (r() - 0.5) * 220, y = world.surface(x, z), ry = r() * 6.28;
        for (let rib = 0; rib < 11; rib++) { const off = (rib - 5) * 1.6, sc = 1 - Math.abs(rib - 5) * 0.07; _bp.set(x + Math.sin(ry) * off, y - 0.6, z + Math.cos(ry) * off); _be.set(0, ry + Math.PI / 2, 0); _bq.setFromEuler(_be); _bs.set(sc, sc, sc); _bm.compose(_bp, _bq, _bs); if (fossils.count < 400) fossils.setMatrixAt(fossils.count++, _bm); } }
    }
  }
  fossils.instanceMatrix.needsUpdate = true;
}

// ---------- v39: tall jungle grass stretches + dense instanced pebbles ----------
function tallGrassK(d) { // 5 km checkpoints, 70% chance, stretches 2-10 km
  let k = 0; for (let cp = Math.floor(d / 5000) - 2; cp <= Math.floor(d / 5000); cp++) { if (cp < 0) continue; const r = makeRng(((S.seed || 1) ^ (cp * 0x3243f6a9)) >>> 0); if (r() >= 0.7) continue; const st = cp * 5000, en = st + 2000 + r() * 8000; if (d > st && d < en) k = Math.max(k, Math.min(1, (d - st) / 300, (en - d) / 300)); }
  return k;
}
const PEB_N = 120, PEB_SP = 1.6;
const pebbles = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.16, 0), new THREE.MeshStandardMaterial({ color: 0x8a8279, roughness: 0.9, flatShading: true }), PEB_N * PEB_N);
pebbles.frustumCulled = false; pebbles.receiveShadow = true; pebbles.count = PEB_N * PEB_N; scene.add(pebbles);
const pebCell = new Int32Array(PEB_N * PEB_N * 2).fill(-2147483647); { const hide = new THREE.Matrix4().makeScale(0, 0, 0); for (let i = 0; i < PEB_N * PEB_N; i++) pebbles.setMatrixAt(i, hide); }
function updatePebbles() {
  const on = S.agl < 80 && S.speed * 3.6 < 4000 && !RX.blast && S.mode !== 'attract' && !RX.above;
  pebbles.visible = on; if (!on) return;
  const ax = Math.floor(camera.position.x / PEB_SP) - PEB_N / 2, az = Math.floor(camera.position.z / PEB_SP) - PEB_N / 2;
  let budget = 3500, dirty = false;
  for (let j = 0; j < PEB_N; j++) { const cz = az + j, mj = ((cz % PEB_N) + PEB_N) % PEB_N;
    for (let i = 0; i < PEB_N; i++) { const cx = ax + i, mi = ((cx % PEB_N) + PEB_N) % PEB_N, id = mj * PEB_N + mi;
      if (pebCell[id * 2] === cx && pebCell[id * 2 + 1] === cz) continue; if (budget-- <= 0) break;
      pebCell[id * 2] = cx; pebCell[id * 2 + 1] = cz;
      const h1 = Math.sin(cx * 127.1 + cz * 311.7) * 43758.5453 % 1, h2 = Math.sin(cx * 269.5 + cz * 183.3) * 43758.5453 % 1, x = (cx + Math.abs(h1)) * PEB_SP, z = (cz + Math.abs(h2)) * PEB_SP, y = world.surface(x, z);
      const sc = (0.5 + Math.abs(h1 * 3 % 1) * 1.6) * (world.gridHeight(x, z) < 0.2 ? 0 : 1);
      _bp.set(x, y + 0.03, z); _be.set(h1 * 6, h2 * 6, 0); _bq.setFromEuler(_be); _bs.set(sc * 1.3, sc * 0.6, sc); _bm.compose(_bp, _bq, _bs); pebbles.setMatrixAt(id, _bm); dirty = true; }
    if (budget <= 0) break; }
  if (dirty) pebbles.instanceMatrix.needsUpdate = true;
}

// ---------- v43: GOD MODE ----------
function godPlow(dt) { // everything the jet touches shatters; terrain bumps push the jet up smoothly; no damage, no death
  S.hp.L = S.hp.R = S.hp.B = 100; S.misHits = 0; S.engineFail = false; RX.joltT = 0;
  for (const o of nearObs) {
    if (o.dead) continue; const dx = o.x - S.pos.x, dz = o.z - S.pos.z, R = targetRadius(o) + 9;
    if (dx * dx + dz * dz > R * R) continue;
    const top = (o.y || 0) + (o.type === 'boulder' ? o.r * 1.6 : (o.h || o.r * 2) + 4); if (S.pos.y > top + 6) continue;
    _v.set(o.x, clamp(S.pos.y, o.y || 0, top), o.z);
    if (RX.ice) shatterIce(o); else destroyTarget(o, _v); // ice fracture in the Ice Age; persistence via DESTROYED on chunk unload
    o.dead = true; S.godKills = (S.godKills || 0) + 1; S.shake = Math.max(S.shake, 0.35);
  }
  for (const e of RX.enemies) if (!e.dead && e.p.distanceTo(S.pos) < 22) { e.hp = 1; damageJet(e, 99); S.godKills = (S.godKills || 0) + 1; }
  const g = world.surface(S.pos.x, S.pos.z) + 3.5; // plough over terrain: soft push instead of a crash
  if (S.pos.y < g) { S.pos.y += (g - S.pos.y) * Math.min(1, dt * 18); if (S.pos.y < g - 2) S.pos.y = g - 2; S.pitch = Math.max(S.pitch, 0.05); ship.position.copy(S.pos); if (Math.random() < 0.5) dust.spawn(S.pos.x, g, S.pos.z, S.vel.x * 0.3, 6, S.vel.z * 0.3, 1.5, 3, 14, 0.5, ...E.dust, 1, 0.5); }
  return false;
}
function setGod(on) { RX.god = on; pop(on ? 'GOD MODE · INVULNERABLE · SCORE ×0.3' : 'GOD MODE OFF', 'unlock'); $('godBadge').classList.toggle('hidden', !on); rxMenuSync(); }
// ---------- v34: TRANSFORM · Blackhawk <-> armored ground vehicle ----------
let carRig = null;
function buildCarRig() {
  const g = new THREE.Group(); ship.add(g);
  const armor = new THREE.MeshStandardMaterial({ color: 0x0d0e10, metalness: 0.7, roughness: 0.38, envMap: hdrEnv, envMapIntensity: 0.15 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 0.9 }), rim = new THREE.MeshStandardMaterial({ color: 0x3a3d42, metalness: 0.9, roughness: 0.3 });
  const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.25, 0.1), toneMapped: false });
  const panels = [];
  for (const s of [-1, 1]) { // armor side skirts slide down and out
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.9, 6.5), armor); p.userData = { from: new THREE.Vector3(s * 1.1, 0.2, 0.4), to: new THREE.Vector3(s * 2.0, -0.55, 0.4) }; g.add(p); panels.push(p);
  }
  const nose = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.45, 2.2), armor); nose.userData = { from: new THREE.Vector3(0, 0.1, -2.5), to: new THREE.Vector3(0, -0.5, -3.6) }; nose.rotation.x = 0.18; g.add(nose); panels.push(nose);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.3, 0.6), lamp); tail.userData = { from: new THREE.Vector3(0, 0.3, 3.2), to: new THREE.Vector3(0, -0.15, 3.6) }; g.add(tail); panels.push(tail);
  const wheels = [];
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const pivot = new THREE.Group(); pivot.userData = { x: x * 2.05, z: z * 2.5, front: z < 0 }; g.add(pivot);
    const w = new THREE.Group(); pivot.add(w);
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.7, 24).rotateZ(Math.PI / 2), tyre); w.add(t);
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.72, 10).rotateZ(Math.PI / 2), rim); w.add(r);
    wheels.push({ pivot, w });
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.scale.setScalar(1.6); g.visible = false;
  return { g, panels, wheels, spin: 0 };
}
function xform() {
  if (S.mode !== 'playing' || RX.blast) return;
  if (!carRig) carRig = buildCarRig();
  if (!S.car) S.car = { k: 0, dir: 1, susp: 0, suspV: 0, steer: 0 };
  else S.car.dir = -S.car.dir;
  audio.whoosh(); pop(S.car.dir > 0 ? 'TRANSFORM · GROUND VEHICLE' : 'TRANSFORM · FLIGHT', 'unlock'); rxSay(S.car.dir > 0 ? 'Ground mode.' : 'Flight mode.', 'xf'); rxMenuSync();
}
const sm01 = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
function carAnim(dt) {
  const C = S.car; if (!C || !carRig) return;
  C.k = clamp(C.k + C.dir * dt / 1.4, 0, 1);
  const k = C.k, body = ship.userData.body;
  // wings fold in, airframe lowers & narrows, thrusters swing to rear exhaust; panels slide; wheels deploy then suspension settles
  body.scale.set(1 - 0.55 * sm01(k * 1.6), 1 - 0.25 * sm01(k), 1 - 0.1 * sm01(k)); body.position.y = -0.2 * sm01(k);
  carRig.g.visible = k > 0.02;
  for (const p of carRig.panels) { p.position.lerpVectors(p.userData.from, p.userData.to, sm01((k - 0.15) / 0.6)); p.scale.setScalar(Math.max(0.01, sm01(k / 0.3))); }
  const wk = sm01((k - 0.35) / 0.5);
  for (const w of carRig.wheels) {
    const u = w.pivot.userData; w.pivot.position.set(u.x * (0.4 + 0.6 * wk), -0.2 - 0.9 * wk + (k >= 1 ? -C.susp : 0), u.z);
    w.w.scale.setScalar(Math.max(0.01, wk)); w.pivot.rotation.y = u.front ? -C.steer * 0.5 : 0; w.w.rotation.x = carRig.spin;
  }
  if (C.k <= 0 && C.dir < 0) { // back to flight
    carRig.g.visible = false; body.scale.set(1, 1, 1); body.position.y = 0; S.car = null; rxMenuSync();
    if (S.blastAfter) { S.blastAfter = false; blastGo(); }
  }
}
function carFlight(dt) { // returns true when the vehicle model owns the motion
  const C = S.car; carAnim(dt);
  if (!S.car) return false;
  const g = world.surface(S.pos.x, S.pos.z), water = world.gridHeight(S.pos.x, S.pos.z) < 0 && !RX.above, floor = water && RX.xsurv ? Math.max(g, 0) : g;
  if (C.k < 1 && C.dir > 0) { // descend to the ground while transforming, bleeding speed to vehicle range
    S.pos.y = damp(S.pos.y, floor + 1.35, 3 + 6 * C.k, dt); S.speed = damp(S.speed, Math.min(S.speed, 700 / 3.6), 1.5, dt);
    headingFrame(S.heading); S.pos.addScaledVector(_rf, S.speed * dt); S.pitch = damp(S.pitch, 0, 5, dt);
  } else if (C.dir < 0) { // lift-off
    S.pos.y += (6 + 20 * (1 - C.k)) * dt; headingFrame(S.heading); S.pos.addScaledVector(_rf, S.speed * dt);
  } else {
    // ground handling: throttle 0..900 km/h, bicycle steering, sprung suspension, grip-limited yaw
    let st = controls.steer; if (S.autopilot || S.mode === 'attract') { const a = autopilotInput(dt); st = a.steer; }
    const target = (40 + Math.pow(controls.throttle, 1.5) * 860) / 3.6;
    S.speed += clamp(target - S.speed, -60 * dt, 25 * dt);
    C.steer = damp(C.steer, st, 8, dt);
    const yaw = C.steer * Math.min(1.6, 9 / Math.max(S.speed, 5)) * Math.min(S.speed / 8, 1);
    S.heading -= yaw * dt * 2.2; if (Math.abs(S.heading) > 1.15) S.heading = Math.sign(S.heading) * 1.15;
    headingFrame(S.heading); S.prevPos.copy(S.pos); S.pos.addScaledVector(_rf, S.speed * dt);
    const g2 = world.surface(S.pos.x, S.pos.z), w2 = world.gridHeight(S.pos.x, S.pos.z) < 0 && !RX.above, f2 = w2 && RX.xsurv ? Math.max(g2, 0) : g2;
    C.wall = f2 - (S.pos.y - 1.35) > 6; // step too high to climb = wall impact
    C.drown = w2 && !RX.xsurv;
    const ahead = world.surface(S.pos.x + _rf.x * 3, S.pos.z + _rf.z * 3);
    S.pitch = damp(S.pitch, Math.atan2(ahead - f2, 3), 10, dt);
    C.suspV += (-(C.susp) * 120 - C.suspV * 14) * dt + (f2 + 1.35 - S.pos.y) * 0.5; C.susp += C.suspV * dt; C.susp = clamp(C.susp, -0.35, 0.35);
    S.pos.y = Math.max(f2 + 1.35, S.pos.y - 9.81 * dt * 2); if (S.pos.y < f2 + 1.4) S.pos.y = f2 + 1.35;
    carRig.spin -= S.speed * dt / 0.75;
    if (S.speed > 15 && Math.random() < 0.9) dust.spawn(S.pos.x - _rf.x * 3, f2 + 0.5, S.pos.z - _rf.z * 3, (Math.random() - 0.5) * 4, 1 + Math.random() * 2, (Math.random() - 0.5) * 4, 1.2, 1.5, 6, 0.5, ...(w2 ? [1.4, 1.5, 1.6] : E.dust), 1, 0.4);
    S.roll = damp(S.roll, -C.steer * 0.08, 6, dt);
  }
  S.agl = S.pos.y - world.surface(S.pos.x, S.pos.z);
  ship.position.copy(S.pos); ship.rotation.set(S.pitch, S.heading, S.roll);
  S.dist = Math.max(S.dist, -S.pos.z);
  if (S.mode === 'playing') { S.time += dt; S.topKmh = Math.max(S.topKmh, S.speed * 3.6); }
  return true;
}
function carCollide() {
  const C = S.car;
  for (const o of nearObs) {
    if (o.dead || (RX.ice && (o.type === 'tree' || o.type === 'jtree')) || (o.type === 'boulder' && o.r < 1.2)) continue;
    const dx = o.x - S.pos.x, dz = o.z - S.pos.z, R = targetRadius(o) + 2.2; if (dx * dx + dz * dz > R * R) continue;
    if (RX.carSuper || RX.super) { _v.set(o.x, S.pos.y, o.z); destroyTarget(o, _v); S.superCuts = (S.superCuts || 0) + 1; continue; } // CAR SUPERSAFE: plough through
    if (RX.ghost) continue;
    S.crashCause = 'VEHICLE IMPACT'; return true;
  }
  if (C.wall && !RX.ghost) { if (RX.carSuper || RX.super) { S.pos.y += 4; C.wall = false; } else { S.crashCause = 'HIT A WALL'; return true; } }
  if (C.drown && !RX.ghost) { S.crashCause = 'DROVE INTO WATER'; return true; }
  return false;
}
// ---------- v33: cameras + 3D cockpit ----------
function addNav(m) { // subtle nav lights on G47: red/green steady wingtips + white strobe
  m.updateMatrixWorld(true); const bb = new THREE.Box3().setFromObject(m), sx = (bb.max.x - bb.min.x) / 2 / m.scale.x;
  m.userData.nav = [];
  for (const [x, col, steady] of [[-sx, 0xff2a2a, 1], [sx, 0x2aff5a, 1], [0, 0xffffff, 0]]) { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: col, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); sp.position.set(x, 0.3, 0); sp.scale.setScalar(0.9); sp.userData.steady = !!steady; m.add(sp); m.userData.nav.push(sp); }
}
const _cq = new THREE.Quaternion(), _cp = new THREE.Vector3(), _cq0 = new THREE.Quaternion(), _cp0 = new THREE.Vector3(), _cm = new THREE.Matrix4();
const CAM_NAMES = { chase: 'CHASE CAM', cockpit: 'COCKPIT', g3: 'G3 POV', g47: 'G47 POV' };
function setCam(c) {
  if (c === 'g3' && !RX.drone) setDrone(true);
  if (c === 'g47' && !RX.carrier) setCarrier(true);
  _cp0.copy(camera.position).sub(S.pos); _cq0.copy(camera.quaternion); RX.camT = 0; /* blend start stored ship-relative so fast flight does not lag */ RX.cam = c; pop(CAM_NAMES[c], 'banked'); rxMenuSync();
}
let cockpit = null;
function buildCockpit() {
  const g = new THREE.Group();
  // carbon-weave texture for panels
  const cw = document.createElement('canvas'); cw.width = cw.height = 64; const wc = cw.getContext('2d');
  for (let y = 0; y < 64; y += 8) for (let x = 0; x < 64; x += 8) { const o = ((x + y) / 8) % 2; const gr = wc.createLinearGradient(x, y, o ? x + 8 : x, o ? y : y + 8); gr.addColorStop(0, '#26292f'); gr.addColorStop(0.5, '#3a3e46'); gr.addColorStop(1, '#1d1f24'); wc.fillStyle = gr; wc.fillRect(x, y, 8, 8); }
  const carbonTex = new THREE.CanvasTexture(cw); carbonTex.wrapS = carbonTex.wrapT = THREE.RepeatWrapping; carbonTex.repeat.set(6, 3); carbonTex.colorSpace = THREE.SRGBColorSpace;
  const carbon = new THREE.MeshStandardMaterial({ map: carbonTex, color: 0xb0b4bc, metalness: 0.35, roughness: 0.38, envMap: hdrEnv, envMapIntensity: 0.9 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x6d737c, metalness: 0.85, roughness: 0.28, envMap: hdrEnv, envMapIntensity: 1.1 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.75, envMap: hdrEnv, envMapIntensity: 0.4 });
  const edge = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 0.75, 1.0), toneMapped: false }); // thin edge-light strips
  const skin = new THREE.MeshPhysicalMaterial({ color: 0x4f575d, roughness: 0.6, metalness: 0, sheen: 0.25, sheenColor: new THREE.Color(0.55, 0.62, 0.66), clearcoat: 0.08, clearcoatRoughness: 0.6, envMap: hdrEnv, envMapIntensity: 0.6 });
  const add = (geo, m, x, y, z, rx = 0, ry = 0, rz = 0, par = g) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.rotation.set(rx, ry, rz); par.add(o); return o; };
  const rbox = (w, h, d, r = 0.02) => { const sh = new THREE.Shape(); const x = -w / 2, y = -h / 2; sh.moveTo(x + r, y); sh.lineTo(x + w - r, y); sh.quadraticCurveTo(x + w, y, x + w, y + r); sh.lineTo(x + w, y + h - r); sh.quadraticCurveTo(x + w, y + h, x + w - r, y + h); sh.lineTo(x + r, y + h); sh.quadraticCurveTo(x, y + h, x, y + h - r); sh.lineTo(x, y + r); sh.quadraticCurveTo(x, y, x + r, y); const geo = new THREE.ExtrudeGeometry(sh, { depth: d, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 2, curveSegments: 4 }); geo.translate(0, 0, -d / 2); return geo; };
  // cockpit lighting: sun-ish key + cool fill, local only
  const key = new THREE.PointLight(0xffe2c0, 1.3, 4, 1.5); key.position.set(0.6, 0.9, -0.6); g.add(key);
  const fill = new THREE.PointLight(0x7fb8ff, 0.9, 3.5, 1.5); fill.position.set(-0.8, -0.2, -0.3); g.add(fill);
  const disp = new THREE.PointLight(0x4fdcff, 0.35, 1.0, 2); disp.position.set(0, -0.3, -0.75); g.add(disp);
  // dash: sculpted shroud (low, keeps the forward view clear)
  add(rbox(2.3, 0.26, 0.75, 0.08), carbon, 0, -0.66, -0.98, -0.28);
  add(new THREE.BoxGeometry(2.1, 0.012, 0.012), edge, 0, -0.52, -0.66, 0); // dash edge light
  // canopy frame with depth: curved bow + tapered pillars
  const bow = new THREE.TorusGeometry(1.25, 0.035, 8, 40, Math.PI * 0.62); bow.rotateZ(Math.PI * 0.19);
  for (const sx of [-1, 1]) { add(rbox(0.07, 1.25, 0.09, 0.02), metal, sx * 1.02, 0.02, -1.0, 0.1, 0, sx * -0.34); add(new THREE.BoxGeometry(0.01, 1.2, 0.01), edge, sx * 0.985, 0.02, -0.95, 0.1, 0, sx * -0.34); }
  add(rbox(2.3, 0.05, 0.14, 0.02), metal, 0, 0.62, -1.05);
  // side consoles with panel lines + buttons
  for (const sx of [-1, 1]) {
    add(rbox(0.46, 0.5, 1.5, 0.05), carbon, sx * 1.18, -0.86, -0.35);
    add(new THREE.BoxGeometry(0.4, 0.008, 1.4), edge, sx * 1.18, -0.6, -0.35).material = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.12, 0.22, 0.3), toneMapped: false });
    for (let i = 0; i < 6; i++) add(new THREE.CylinderGeometry(0.018, 0.018, 0.02, 10), new THREE.MeshBasicMaterial({ color: new THREE.Color(...(i % 3 ? [0.2, 1.2, 1.4] : [1.6, 0.6, 0.1])), toneMapped: false }), sx * (1.1 + (i % 2) * 0.12), -0.6, -0.75 + (i >> 1) * 0.12);
  }
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 1.3), new THREE.MeshPhysicalMaterial({ color: 0xbfe6ff, transparent: true, opacity: 0.04, roughness: 0.05, envMap: hdrEnv, envMapIntensity: 0.5, depthWrite: false })); glass.position.set(0, 0.0, -1.08); g.add(glass);
  // instruments: one glowing glass panel with 4 round gauges (speed / alt / G / hull)
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128; const cx = cv.getContext('2d'); const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.92, 0.23), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })); scr.position.set(0, -0.355, -0.9); scr.rotation.x = -0.35; g.add(scr);
  add(rbox(0.98, 0.28, 0.03, 0.02), metal, 0, -0.365, -0.945, -0.35); // bezel
  // compact F1-style yoke: shaped wheel, grips, buttons, centre display
  const yoke = new THREE.Group(); yoke.position.set(0, -0.53, -0.58); g.add(yoke);
  const ysh = new THREE.Shape(); ysh.moveTo(-0.24, -0.06); ysh.lineTo(0.24, -0.06); ysh.quadraticCurveTo(0.29, 0.0, 0.25, 0.08); ysh.lineTo(-0.25, 0.08); ysh.quadraticCurveTo(-0.29, 0.0, -0.24, -0.06);
  const yg = new THREE.ExtrudeGeometry(ysh, { depth: 0.035, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 2 }); yg.translate(0, 0, -0.017);
  add(yg, carbon, 0, 0, 0, 0, 0, 0, yoke);
  for (const sx of [-1, 1]) { add(new THREE.CapsuleGeometry(0.032, 0.12, 4, 10), rubber, sx * 0.27, -0.005, 0.005, 0, 0, sx * 0.15, yoke); for (let i = 0; i < 3; i++) add(new THREE.CylinderGeometry(0.011, 0.011, 0.012, 10).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(...[[1.6, 0.2, 0.1], [0.2, 1.4, 0.4], [0.2, 0.8, 1.6]][i]), toneMapped: false }), sx * (0.17 - i * 0.035), 0.045, 0.022, 0, 0, 0, yoke); }
  const yScr = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.07), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })); yScr.position.set(0, 0.01, 0.022); yoke.add(yScr);
  add(new THREE.CylinderGeometry(0.03, 0.04, 0.3, 12).rotateX(Math.PI / 2 - 0.4), metal, 0, -0.03, -0.16, 0, 0, 0, yoke); // column
  // gray alien hand: palm, 3 long 3-segment fingers with knuckles, thumb, wrist and forearm
  const hand = (parent, x, y, z, curl, side = 1) => { const h = new THREE.Group(); h.position.set(x, y, z); parent.add(h);
    const palm = add(new THREE.SphereGeometry(0.055, 16, 12), skin, 0, 0, 0, 0, 0, 0, h); palm.scale.set(1.05, 0.55, 1.35);
    for (let i = 0; i < 3; i++) { let p = new THREE.Group(); p.position.set((-0.032 + i * 0.032) * side, 0.008, -0.065); p.rotation.set(-curl * 0.55, (i - 1) * 0.12 * side, 0); h.add(p);
      const L = [0.055, 0.045, 0.04]; for (let k = 0; k < 3; k++) { add(new THREE.SphereGeometry(0.0115 - k * 0.0012, 10, 8), skin, 0, 0, 0, 0, 0, 0, p); add(new THREE.CapsuleGeometry(0.0095 - k * 0.0012, L[k], 4, 8).rotateX(Math.PI / 2), skin, 0, 0, -L[k] / 2 - 0.005, 0, 0, 0, p); const n = new THREE.Group(); n.position.set(0, 0, -L[k] - 0.008); n.rotation.x = -curl * 0.5; p.add(n); p = n; }
      add(new THREE.SphereGeometry(0.008, 8, 6), skin, 0, 0, 0, 0, 0, 0, p).scale.set(1, 0.6, 1.4); }
    const th = new THREE.Group(); th.position.set(0.05 * side, -0.005, -0.015); th.rotation.set(-0.3, -0.9 * side, 0); h.add(th);
    add(new THREE.CapsuleGeometry(0.011, 0.05, 4, 8).rotateX(Math.PI / 2), skin, 0, 0, -0.03, 0, 0, 0, th); add(new THREE.SphereGeometry(0.012, 8, 6), skin, 0, 0, -0.06, 0, 0, 0, th);
    add(new THREE.CapsuleGeometry(0.03, 0.36, 4, 12).rotateX(Math.PI / 2 - 0.25), skin, 0, -0.04, 0.24, 0, 0, 0, h);
    add(new THREE.CylinderGeometry(0.038, 0.038, 0.06, 14).rotateX(Math.PI / 2 - 0.25), new THREE.MeshStandardMaterial({ color: 0x2b3038, metalness: 0.6, roughness: 0.4, envMap: hdrEnv }), 0, -0.035, 0.12, 0, 0, 0, h); // suit cuff
    return h; };
  const grip = hand(yoke, -0.27, 0.03, 0.05, 2.3, 1); grip.rotation.set(0.7, 0.25, -0.2); grip.scale.setScalar(1.3);
  const rest = hand(g, 0.78, -0.56, -0.74, 0.6, -1); rest.rotation.set(0.25, 0.35, 0.15); rest.scale.setScalar(1.45); // resting on the right side console
  const cig = new THREE.Group(); cig.position.set(-0.01, 0.02, -0.11); rest.add(cig);
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.09, 8), new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.8 })); stick.rotation.x = Math.PI / 2; cig.add(stick);
  const ember = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(3, 0.8, 0.2), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false })); ember.position.z = -0.048; ember.scale.setScalar(0.03); cig.add(ember);
  g.traverse((o) => { o.frustumCulled = false; o.renderOrder = 20; });
  g.position.set(0, 0.12, -0.9); g.visible = false; camera.add(g);
  return { g, yoke, cig, ember, cx, tex, t: 0 };
}
function drawGauges(x) {
  x.fillStyle = '#03090d'; x.fillRect(0, 0, 512, 128);
  const G = [['SPD', Math.round(S.speed * 3.6).toLocaleString(), 'KM/H', clamp(S.speed * 3.6 / TOP_KMH, 0, 1), '#5fe3ff'], ['ALT', Math.round(S.agl) + '', 'M', clamp(S.agl / 400, 0, 1), '#ffb347'], ['G', ((RX.g >= 0 ? '+' : '') + (RX.g || 0).toFixed(1)), 'G', clamp(Math.abs(RX.g || 0) / 9, 0, 1), '#b6ff6a'], ['HULL', Math.round(Math.min(S.hp.L, S.hp.R, S.hp.B)) + '', '%', Math.min(S.hp.L, S.hp.R, S.hp.B) / 100, Math.min(S.hp.L, S.hp.R, S.hp.B) > 50 ? '#7ee08a' : '#ff5a3c']];
  G.forEach(([lbl, val, unit, k, col], i) => { const cx0 = 64 + i * 128, cy = 64, r = 50;
    x.lineWidth = 8; x.strokeStyle = 'rgba(255,255,255,0.12)'; x.beginPath(); x.arc(cx0, cy, r, Math.PI * 0.75, Math.PI * 2.25); x.stroke();
    x.strokeStyle = col; x.shadowColor = col; x.shadowBlur = 10; x.beginPath(); x.arc(cx0, cy, r, Math.PI * 0.75, Math.PI * (0.75 + 1.5 * k)); x.stroke(); x.shadowBlur = 0;
    x.fillStyle = '#fff'; x.textAlign = 'center'; x.font = 'bold 22px monospace'; x.fillText(val, cx0, cy + 6); x.fillStyle = col; x.font = 'bold 13px monospace'; x.fillText(lbl + ' · ' + unit, cx0, cy + 30); });
  x.textAlign = 'left';
}
function viewCamera(dt) {
  RX.camT = Math.min(1, RX.camT + dt / 0.6);
  const c = RX.cam;
  if (c === 'cockpit' && !cockpit) cockpit = buildCockpit();
  const inCock = c === 'cockpit' && S.mode !== 'crashed';
  if (cockpit) cockpit.g.visible = inCock && RX.camT > 0.5;
  ship.visible = S.mode === 'crashed' ? ship.visible : !(inCock && RX.camT > 0.5);
  const near = inCock ? 0.03 : 0.5; if (camera.near !== near) { camera.near = near; camera.updateProjectionMatrix(); }
  if (c === 'chase' && RX.camT >= 1) return;
  // target pose
  if (c === 'chase') { _cp.copy(camera.position); _cq.copy(camera.quaternion); }
  else if (inCock) { ship.updateMatrixWorld(true); _cq.copy(ship.quaternion); _cp.set(0, 0.95, -1.6).applyQuaternion(_cq).add(S.pos);
    camera.fov = damp(camera.fov, 75, 4, dt); camera.updateProjectionMatrix();
    const y = cockpit.yoke; y.rotation.z = -S.steerS * 0.9; y.rotation.x = (S.pitchIn || 0) * 0.15;
    cockpit.cig.visible = RX.cig; if (RX.cig) { cockpit.ember.material.opacity = 0.7 + 0.3 * Math.sin(S.t * 3.1); if (Math.random() < 0.15) { cockpit.ember.getWorldPosition(_v).add(RO); dust.spawn(_v.x, _v.y + 0.02, _v.z, 0, 0.06, 0, 1.6, 0.02, 0.12, 0.25, 0.8, 0.8, 0.8, 0.3, 0); } }
    if ((cockpit.t -= dt) <= 0) { cockpit.t = 0.15; drawGauges(cockpit.cx); cockpit.tex.needsUpdate = true; }
  } else {
    const o = c === 'g3' ? drone : carrier; if (!o) { RX.cam = 'chase'; return; }
    headingFrame(S.heading); const back = c === 'g3' ? 7 : 45, up = c === 'g3' ? 1.8 : 14;
    _cp.copy(o.p).addScaledVector(_rf, -back); _cp.y += up;
    _cm.lookAt(_cp, _v.copy(o.p).addScaledVector(_rf, 300), camera.up); _cq.setFromRotationMatrix(_cm);
  }
  if (RX.camT < 1) { const k = RX.camT * RX.camT * (3 - 2 * RX.camT); camera.position.copy(_cp0).add(S.pos).lerp(_cp, k); camera.quaternion.slerpQuaternions(_cq0, _cq, k); }
  else { camera.position.copy(_cp); camera.quaternion.copy(_cq); }
}
// ---------- v33: Gs SUPERMODE · 4 km freeze-destruction corridor ----------
function gsSupermode() {
  if (S.mode !== 'playing') return;
  if (RX.wing === 0) setWing(1);
  if (RX.gsupCool > 0) { pop('Gs SUPERMODE RECHARGING ' + Math.ceil(RX.gsupCool) + ' s', 'close'); return; }
  RX.gsupCool = 25; headingFrame(S.heading); let n = 0;
  for (const ch of chunks.values()) for (const o of ch.objs) {
    if (o.dead || o.frozen != null) continue;
    const dx = o.x - S.pos.x, dz = o.z - S.pos.z, along = dx * _rf.x + dz * _rf.z, lat = dx * _rr.x + dz * _rr.z;
    if (along > 0 && along < 4000 && Math.abs(lat) < 220 && freezeObj(o, 1.0 + along / 4000 * 1.2)) n++; // frost front sweeps forward, each target holds ~1 s frozen, then cracks and shatters
  }
  for (const e of RX.enemies) { if (e.dead || e.icehawk) continue; const dx = e.p.x - S.pos.x, dz = e.p.z - S.pos.z, along = dx * _rf.x + dz * _rf.z; if (along > -200 && along < 4000) { e.iceT = 1.2; for (let k = 0; k < 30; k++) glow.spawn(e.p.x + (Math.random() - 0.5) * 14, e.p.y + (Math.random() - 0.5) * 6, e.p.z + (Math.random() - 0.5) * 14, 0, 0, 0, 1.2, 3, 4, 0.9, 1.4, 2.0, 2.8, 0, 0); n++; } }
  RX.gsupFront = { t: 0 }; S.gsupN = n;
  for (let i = 0; i < 400; i++) { const a = Math.random() * 4000, l = (Math.random() - 0.5) * 440; const x = S.pos.x + _rf.x * a + _rr.x * l, z = S.pos.z + _rf.z * a + _rr.z * l; glow.spawn(x, world.surface(x, z) + 2 + Math.random() * 30, z, 0, 4, 0, 0.6 + a / 4000 * 1.2, 4, 10, 0.8, 1.4, 2.0, 2.8, 1.2, 0); }
  flash(0.4); audio.boom(); pop('Gs SUPERMODE · 4 KM FREEZE CORRIDOR · ' + n + ' TARGETS', 'unlock'); rxSay('Supermode. Freeze corridor.', 'gsup'); rxMenuSync();
}
function setPhase(p) { RX.phase = p; if ((p > 0) !== RX.ghost) setGhost(p > 0); pop(['PHASE OFF', 'PHASE · ME ONLY · PASS THROUGH TERRAIN', 'PHASE · ALL FRIENDLY JETS'][p], 'unlock'); rxMenuSync(); }
// ---------- v33: AI ANALYSIS · 10 s horizon over procedural data ----------
function aiChunk(i) { const ch = chunks.get(i); if (ch) return ch.objs; let o = AIC.get(i); if (!o) { if (AIC.size > 300) AIC.delete(AIC.keys().next().value); RX.noPatch = true; o = genChunkContent(world, i).objs; RX.noPatch = false; const dead = DESTROYED.get(i); if (dead) o.forEach((q, k) => { if (dead.has(k)) q.dead = true; }); AIC.set(i, o); } return o; }
function aiAnalysis() {
  const H = 10, kmh = S.speed * 3.6, scanKm = kmh / 360, L = scanKm * 1000; // scanDistanceKm = speedKmH / 360 (= 10 s of travel)
  const vx = S.vel.x, vy = S.vel.y, vz = S.vel.z, sp = Math.max(S.speed, 1);
  let what = null, tti = Infinity;
  const c0 = Math.floor(-S.pos.z / CHUNK_L), c1 = Math.floor((-S.pos.z + L) / CHUNK_L); let gen = 0;
  for (let i = c0; i <= c1; i++) {
    if (!chunks.has(i) && !AIC.has(i)) { if (gen++ > 4) break; } // budget: a few procedural queries per scan
    for (const o of aiChunk(i)) {
      if (o.dead || (RX.ice && (o.type === 'tree' || o.type === 'jtree')) || (o.type === 'boulder' && o.r < 3)) continue;
      const dx = o.x - S.pos.x, dz = o.z - S.pos.z, t = (dx * vx + dz * vz) / (sp * sp); if (t <= 0 || t > H || t >= tti) continue;
      const cx = S.pos.x + vx * t - o.x, cz = S.pos.z + vz * t - o.z, cy = S.pos.y + vy * t;
      if (cx * cx + cz * cz < (targetRadius(o) + 8) ** 2 && cy < (o.y || world.surface(o.x, o.z)) + (o.h || o.r * 2) + 6) { tti = t; what = (TARGET_NAME[o.type] || 'OBSTACLE') + ' COLLISION'; }
    }
  }
  // terrain: the flight model holds altitude over terrain, so a straight-line vy extrapolation cries wolf.
  // Only warn when the full flight-model prediction (current inputs) actually impacts within 4 s.
  if (!S.car && !RX.blast && tti > 0.5) { let near = false; for (let k = 1; k <= 16; k++) { const t = k * 0.25, x = S.pos.x + vx * t, z = S.pos.z + vz * t; if (world.surface(x, z) > S.pos.y - 25) { near = true; break; } }
    if (near) { const q = predict(S.steerS || 0, 0, 4, 16, 1.5); if (q.hit < Math.min(4, tti) && q.y - world.surface(q.x, q.z) < 1.6) { tti = q.hit; what = 'TERRAIN COLLISION'; } } }
  for (const e of RX.enemies) { if (e.dead) continue; const rx = e.p.x - S.pos.x, ry = e.p.y - S.pos.y, rz = e.p.z - S.pos.z, wx = e.v.x - vx, wy = e.v.y - vy, wz = e.v.z - vz, w2 = wx * wx + wy * wy + wz * wz; if (w2 < 1) continue; const t = -(rx * wx + ry * wy + rz * wz) / w2; if (t <= 0 || t > H || t >= tti) continue; const d = Math.hypot(rx + wx * t, ry + wy * t, rz + wz * t); if (d < 40) { tti = t; what = 'HOSTILE CLOSING'; } }
  for (const s of shotPool) { if (!s.on) continue; const rx = s.p.x - S.pos.x, ry = s.p.y - S.pos.y, rz = s.p.z - S.pos.z, wx = s.v.x - vx, wy = s.v.y - vy, wz = s.v.z - vz, w2 = wx * wx + wy * wy + wz * wz; const t = w2 > 1 ? -(rx * wx + ry * wy + rz * wz) / w2 : -1; if (t > 0 && t < tti && Math.hypot(rx + wx * t, ry + wy * t, rz + wz * t) < 25) { tti = t; what = 'MISSILE INBOUND'; } }
  if (inSafeBand() || RX.god) { tti = Infinity; what = null; } // SAFE ALTITUDE: above every obstacle, nothing to predict
  const box = $('aiBox'); box.classList.remove('hidden');
  if (tti === Infinity) { box.className = ''; box.textContent = 'AI ANALYSIS · ' + scanKm.toFixed(1) + ' KM / 10 s · CLEAR'; RX.aiLast = null; return '<b class="ok">AI · ' + scanKm.toFixed(1) + ' KM · PATH CLEAR</b>'; }
  // safest escape: evaluate clearance of each manoeuvre with the full flight model
  const T = clamp(tti, 1.5, 4); let best = 'HOLD', bh = -1;
  for (const [st, p, lbl] of [[-0.9, 0, '◀ LEFT'], [0.9, 0, 'RIGHT ▶'], [0, 1, '▲ CLIMB'], [0, -0.6, '▼ DIVE']]) { const q = predict(st, p, T, 12, 3.5); const sc = (q.hit === Infinity ? T * 10 : q.hit) + Math.min(q.minClr || 0, 30) * 0.05; if (sc > bh) { bh = sc; best = lbl; } }
  RX.aiLast = { what, tti, best };
  box.className = 'bad'; box.textContent = what + ' ' + tti.toFixed(1) + 's · ESCAPE ' + best;
  return '<b class="bad">AI · ' + what + ' ' + tti.toFixed(1) + 's · ' + best + '</b>';
}
window.__game.forceCrash = () => crash();
window.__game.v33 = { setGod, baseSeg: (A, k) => baseSeg(A, k), BASE_DEAD, findContacts: () => findContacts(), PFX, RO, rebaseOrigin, BASE, baseSeg, spawnIcehawk, rockDamage, CHIPPED, xform, get carRig() { return carRig; }, setCam, gsSupermode, setPhase, aiAnalysis, get cockpit() { return cockpit; }, get wingmen() { return wingmen; }, get carrier() { return carrier; }, get drone() { return drone; }, shotPool, misPool, DESTROYED };
window.__game.ready = true;
if (TEST) {
  S.noCollide = !params.has('collide');
  if (!params.has('manual')) setAutopilot(true, true); else S.autopilot = false;
  controls.throttle = +(params.get('thr') || 0.62);
  resetRun('playing'); controls.enabled = true; S.tut = []; S.hintUntil = 0; $('hint').style.opacity = 0;
  $('start').classList.add('hidden'); $('hud').classList.remove('hidden');
}
window.__game.startGame = startGame; window.__game.strikeBolt = strikeBolt; window.__game.fire = fireMissile; window.__game.MS = MS;
// headless stress harness: run the flight/planner/collision loop without rendering (used by tools/apstress.mjs)
window.__game.AP = AP; window.__game.RX = RX; window.__game.step = (sec, dt = 1 / 30) => { for (let t = 0; t < sec; t += dt) { if (S.mode !== 'playing') break; tick(dt, false); } return { km: +(S.dist / 1000).toFixed(2), kmh: Math.round(S.speed * 3.6), mode: S.mode }; }; window.__game.stream = () => streamChunks(S.pos.z, true); window.__game.rx = { zoneReady, setWing, freezeWave, rideToggle, endRide, setUltra, blastGo, rxLandToggle, setGhost, setVoice, spawnJet, enterIceAge, zoneAt, roofAt };
window.__game.simAP = (seconds, dt = 1 / 30) => {
  const t0 = performance.now(); let steps = 0, ms = 0;
  for (let t = 0; t < seconds && S.mode === 'playing'; t += dt) {
    S.t += dt; rxUpdateZones(); updateHazards(dt); if (RX.instDirty) { RX.instDirty = false; rebuildInstances(); }
    const a = performance.now();
    const nSub = Math.min(40, Math.max(1, Math.ceil(dt / (1 / 120)), Math.ceil(S.speed * dt / 22))), sdt = dt / nSub; S.apDt = dt;
    let dead = false;
    for (let j = 0; j < nSub; j++) { S.apSub = j > 0; const b = performance.now(); updateFlight(sdt); if (j === 0) ms += performance.now() - b; if (!S.noCollide && resolveCollisions(sdt)) { crash(); dead = true; break; } }
    S.apSub = false;
    streamChunks(S.pos.z, false);
    if (dead) break;
    updateScore(dt); updateBiomeEnv(dt);
    steps++;
  }
  return { steps, wall: Math.round(performance.now() - t0), msPerPlan: +(ms / Math.max(steps, 1)).toFixed(2), km: +(S.dist / 1000).toFixed(2), kmh: Math.round(S.speed * 3.6), mode: S.mode, biome: E.main, y: Math.round(S.pos.y), agl: Math.round(S.agl), thrCap: +AP.thrCap.toFixed(2), stats: AP.stats };
};
// headless missile harness (tools/missileSim.mjs): step flight + missiles without rendering
window.__game.stepMis = (n, dt = 1 / 30) => {
  const log = [];
  for (let i = 0; i < n; i++) {
    S.t += dt; updateFlight(dt); streamChunks(S.pos.z, false); updateMissiles(dt);
    const act = misPool.filter((m) => m.on);
    if (i % 5 === 0) log.push(act.map((m) => { const t = m.tgt; const d = t ? Math.hypot(t.x - m.p.x, t.z - m.p.z) : -1; return [m.t.toFixed(2), Math.round(m.spd * 3.6), t ? t.type : '-', Math.round(d), Math.round(m.p.y - (t ? t.y : 0)), t ? Math.round(targetRadius(t)) : 0].join(','); }).join(' | '));
  }
  return { kills: MS.kills, log };
};
