import * as THREE from 'three';
import { makeRng } from './terrain.js?v=42';

function taperBox(w, h, l, frontW = 0.5, frontH = 0.5, taperStart = 0.2, segs = 6) {
  const g = new THREE.BoxGeometry(w, h, l, 1, 1, segs);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    const t = Math.min(Math.max((-z / l + 0.5 - (1 - taperStart - 0.5)) / (1 - (1 - taperStart - 0.5) - 0.5 + 0.5), 0), 1);
    // t: 0 at rear part, 1 at very front
    const f = (-z / l + 0.5); // 0 rear .. 1 front
    const k = Math.min(Math.max((f - (1 - taperStart)) / taperStart, 0), 1);
    const kk = k * k;
    p.setX(i, p.getX(i) * (1 - (1 - frontW) * kk));
    const y = p.getY(i);
    p.setY(i, y * (1 - (1 - frontH) * kk) - (y > 0 ? h * 0.15 * kk : 0));
    void t;
  }
  g.computeVertexNormals();
  return g;
}

function dmgTex() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d');
  const g = x.createRadialGradient(170, 150, 10, 150, 140, 140); g.addColorStop(0, 'rgba(10,8,6,0.95)'); g.addColorStop(0.5, 'rgba(25,18,12,0.6)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 90; i++) {
    const y0 = 30 + Math.random() * 200, x0 = Math.random() * 120 + 50, L = 30 + Math.random() * 120;
    x.strokeStyle = `rgba(${210 + Math.random() * 45},${200 + Math.random() * 45},${185 + Math.random() * 45},${0.55 + Math.random() * 0.45})`;
    x.lineWidth = 1.5 + Math.random() * 3.5; x.beginPath(); x.moveTo(x0, y0); x.lineTo(x0 + L, y0 + (Math.random() - 0.5) * 18); x.stroke();
  }
  for (let i = 0; i < 25; i++) { x.fillStyle = `rgba(255,${120 + Math.random() * 80},40,${Math.random() * 0.5})`; x.fillRect(150 + Math.random() * 100, Math.random() * 256, 2 + Math.random() * 4, 1 + Math.random() * 2); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export const FROST = { value: 0 };
export function buildShip(envMap) {
  const dmgMats = {};
  const ship = new THREE.Group();
  const body = new THREE.Group();
  ship.add(body);

  const std = (c, m, r, extra = {}) => new THREE.MeshStandardMaterial(Object.assign({ color: c, metalness: m, roughness: r, flatShading: true, envMap, envMapIntensity: 0.14 }, extra));
  const rim = (m) => { m.onBeforeCompile = (sh) => {
      sh.uniforms.sunDirV = { value: new THREE.Vector3() }; m.userData.sh = sh; sh.uniforms.frost = FROST;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vFrP; varying vec3 vFrN;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFrP = position; vFrN = normal;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 sunDirV; uniform float frost; varying vec3 vFrP; varying vec3 vFrN;\nfloat frH(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }\nfloat frN(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(mix(frH(i), frH(i+vec3(1,0,0)), f.x), mix(frH(i+vec3(0,1,0)), frH(i+vec3(1,1,0)), f.x), f.y), mix(mix(frH(i+vec3(0,0,1)), frH(i+vec3(1,0,1)), f.x), mix(frH(i+vec3(0,1,1)), frH(i+vec3(1,1,1)), f.x), f.y), f.z); }')
        .replace('#include <opaque_fragment>', `#include <opaque_fragment>
          if (frost > 0.001) { // frost / rime: grows from leading edges & upward faces, crystalline glints
            float n = frN(vFrP * 2.2) * 0.6 + frN(vFrP * 7.0) * 0.4;
            float up = clamp(normalize(vFrN).y * 0.5 + 0.5, 0.0, 1.0);
            float lead = smoothstep(0.0, -4.0, vFrP.z) * 0.25;
            float m = smoothstep(1.0 - frost * 1.15, 1.08 - frost * 1.15, n * 0.75 + up * 0.35 + lead);
            vec3 ice = vec3(0.78, 0.86, 0.95) * (0.45 + 0.55 * max(dot(normal, sunDirV), 0.0)) + vec3(0.12, 0.15, 0.2);
            float gl = step(0.985, frH(floor(vFrP * 40.0))) * frost * 3.0;
            gl_FragColor.rgb = mix(gl_FragColor.rgb, ice, m * 0.9) + vec3(0.9, 0.95, 1.0) * gl * m;
          }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          { vec3 vd = normalize(vViewPosition); float fr = pow(1.0 - abs(dot(normal, -vd)), 3.0);
            float sunFacing = max(dot(normal, sunDirV), 0.0);
            totalEmissiveRadiance += vec3(1.0, 0.55, 0.22) * fr * (0.08 + 0.9 * sunFacing) * 0.15; }`);
    }; return m; };
  const hull = std(0x17171a, 0.35, 0.58);
  const hull2 = std(0x202024, 0.35, 0.62);
  const dark = std(0x141417, 0.6, 0.6);
  const glass = std(0x0d0b0a, 0.9, 0.15, { envMapIntensity: 0.6 });
  const nozzle = std(0x1c1c1f, 0.85, 0.32, { side: THREE.DoubleSide });
  [hull, hull2, dark].forEach(rim);
  const hot = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.42, 0.08).multiplyScalar(1.15), toneMapped: false });
  const hotInner = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.45, 0.12).multiplyScalar(1.6), toneMapped: false, side: THREE.BackSide });
  const navR = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.35, 0.1).multiplyScalar(3), toneMapped: false });

  const add = (geo, mat, x = 0, y = 0, z = 0, parent = body) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };

  // fuselage
  add(taperBox(2.3, 1.5, 11.5, 0.42, 0.45, 0.3), hull, 0, 0, -0.4);
  add(taperBox(1.4, 0.75, 8.5, 0.5, 0.5, 0.35), hull2, 0, 0.95, 0.3);
  add(taperBox(1.05, 0.55, 2.8, 0.35, 0.4, 0.6), glass, 0, 0.95, -3.6);
  add(taperBox(0.6, 0.3, 4, 0.4, 0.4, 0.5), dark, 0, -0.85, -2.5); // chin
  // rear block between engines
  add(new THREE.BoxGeometry(1.5, 1.3, 2.2), dark, 0, 0.05, 4.6);
  add(new THREE.BoxGeometry(1.0, 0.35, 1.6), hull2, 0, 1.4, 3.3);

  // nacelles
  for (const s of [-1, 1]) {
    const nx = s * 1.78;
    const cyl = new THREE.CylinderGeometry(0.98, 0.98, 7.0, 10).rotateX(Math.PI / 2);
    add(cyl, hull, nx, -0.15, 1.6);
    add(new THREE.CylinderGeometry(0.98, 0.6, 1.5, 10).rotateX(Math.PI / 2), hull2, nx, -0.15, -2.65);
    add(new THREE.CylinderGeometry(0.55, 0.55, 0.3, 10).rotateX(Math.PI / 2), dark, nx, -0.15, -3.45);
    // nacelle top plate & side vents
    add(new THREE.BoxGeometry(1.1, 0.25, 5.2), hull2, nx, 0.82, 1.4);
    add(new THREE.BoxGeometry(0.2, 0.6, 2.6), dark, nx + s * 0.95, -0.15, 2.4);
    add(new THREE.TorusGeometry(1.0, 0.09, 6, 18), dark, nx, -0.15, 4.75);
    add(new THREE.TorusGeometry(1.0, 0.07, 6, 18), dark, nx, -0.15, 3.9);
    // nozzle
    add(new THREE.CylinderGeometry(1.06, 0.92, 1.1, 16, 1, true).rotateX(Math.PI / 2), nozzle, nx, -0.15, 5.6);
    add(new THREE.CylinderGeometry(0.82, 0.82, 0.9, 16, 1, true).rotateX(Math.PI / 2), hotInner, nx, -0.15, 5.55);
    const disc = add(new THREE.CircleGeometry(0.82, 20), hot, nx, -0.15, 5.3);
    disc.castShadow = false;

    // wing
    const wing = new THREE.Group();
    wing.position.set(nx + s * 0.6, -0.1, 0);
    wing.rotation.z = -s * 0.075;
    wing.scale.x = s;
    body.add(wing);
    const sh = new THREE.Shape();
    sh.moveTo(0, -1.0); sh.lineTo(5.3, 2.0); sh.lineTo(5.3, 3.5); sh.lineTo(0, 3.6); sh.lineTo(0, -1.0);
    const wg = new THREE.ExtrudeGeometry(sh, { depth: 0.28, bevelEnabled: false });
    wg.rotateX(Math.PI / 2); wg.translate(0, 0.14, 0);
    add(wg, hull, 0, 0, 0, wing);
    // wing panels / greebles
    add(new THREE.BoxGeometry(3.6, 0.1, 0.6), hull2, 2.3, 0.18, 2.7, wing);
    add(new THREE.BoxGeometry(2.2, 0.08, 0.35), dark, 1.6, 0.17, 1.2, wing);
    add(new THREE.BoxGeometry(4.6, 0.12, 0.18), dark, 2.6, 0.0, 3.55, wing);
    // fin at wing tip
    const fs = new THREE.Shape();
    fs.moveTo(1.4, -1.9); fs.lineTo(3.9, -2.2); fs.lineTo(3.9, 0.9); fs.lineTo(2.7, 0.8); fs.lineTo(1.6, 0.2); fs.lineTo(1.4, -1.9);
    const fg = new THREE.ExtrudeGeometry(fs, { depth: 0.24, bevelEnabled: false });
    fg.rotateY(-Math.PI / 2); fg.translate(0.12, 0, 0);
    add(fg, hull2, 5.35, 0.1, 0, wing);
    add(new THREE.BoxGeometry(0.3, 0.12, 0.3), navR, 5.35, -2.1, 3.7, wing);
    // damage overlay (scratches / scorch), opacity driven by wing damage
    const dm = new THREE.MeshStandardMaterial({ map: dmgTex(), transparent: true, opacity: 0, side: THREE.DoubleSide, roughness: 0.45, metalness: 0.2, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const dg = new THREE.ShapeGeometry(sh); dg.rotateX(Math.PI / 2); dg.scale(1, -1, 1);
    const uv = dg.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 5.3, (uv.getY(i) + 1) / 4.6);
    const top = new THREE.Mesh(dg, dm); top.position.y = 0.155; top.renderOrder = 2; wing.add(top);
    dmgMats[s < 0 ? 'L' : 'R'] = dm;
  }

  // greebles on fuselage
  const rng = makeRng(42);
  for (let i = 0; i < 26; i++) {
    const w = 0.15 + rng() * 0.45, h = 0.08 + rng() * 0.15, l = 0.3 + rng() * 1.4;
    const top = rng() < 0.5;
    const z = -3 + rng() * 7;
    if (top) add(new THREE.BoxGeometry(w, h, l), rng() < 0.5 ? dark : hull2, (rng() - 0.5) * 1.2, 1.32 + h / 2, z);
    else { const s = rng() < 0.5 ? -1 : 1; add(new THREE.BoxGeometry(h, w, l), dark, s * (1.15 + h / 2), (rng() - 0.5) * 0.9, z); }
  }
  for (let i = 0; i < 14; i++) {
    const s = rng() < 0.5 ? -1 : 1;
    add(new THREE.BoxGeometry(0.4 + rng() * 0.4, 0.12, 0.4 + rng() * 1.0), rng() < 0.5 ? dark : hull2, s * 1.78 + (rng() - 0.5) * 0.6, 0.98, -1 + rng() * 5);
  }

  // ---- engine flames ----
  const flames = [];
  const flameMat = (core) => new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, intensity: { value: 1 }, core: { value: core } },
    vertexShader: `
      varying float vT; varying float vF;
      void main(){
        vT = position.z;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        vF = abs(dot(n, normalize(-mv.xyz)));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float time; uniform float intensity; uniform float core;
      varying float vT; varying float vF;
      void main(){
        float t = clamp(vT, 0.0, 1.0);
        vec3 cCore = vec3(1.0, 0.74, 0.32);
        vec3 cMid = vec3(1.0, 0.42, 0.07);
        vec3 cTail = vec3(0.8, 0.16, 0.02);
        vec3 c = mix(cCore, cMid, smoothstep(0.0, 0.3 + core * 0.4, t));
        c = mix(c, cTail, smoothstep(0.35, 1.0, t));
        float flick = 0.82 + 0.1 * sin(time * 63.0 + t * 17.0) + 0.08 * sin(time * 97.0 - t * 31.0);
        float diamonds = 0.82 + 0.25 * pow(0.5 + 0.5 * sin(t * 26.0 - time * 8.0), 3.0) * (1.0 - t);
        float a = pow(1.0 - t, 1.1 + core * 0.8) * (0.55 + 0.45 * vF) * intensity * flick * diamonds;
        gl_FragColor = vec4(c * (1.25 + core * 0.55), a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  });
  const cone = (r) => { const g = new THREE.ConeGeometry(r, 1, 18, 6, true); g.rotateX(Math.PI / 2); g.translate(0, 0, 0.5); return g; };
  const outerGeo = cone(0.78), innerGeo = cone(0.4);
  for (const s of [-1, 1]) {
    const grp = new THREE.Group();
    grp.position.set(s * 1.78, -0.15, 5.6);
    body.add(grp);
    const outer = new THREE.Mesh(outerGeo, flameMat(0)); outer.renderOrder = 10; outer.frustumCulled = false;
    const inner = new THREE.Mesh(innerGeo, flameMat(1)); inner.renderOrder = 11; inner.frustumCulled = false;
    grp.add(outer, inner);
    flames.push({ grp, outer, inner });
  }
  ship.userData = { body, flames, hullMats: [hull, hull2, dark], dmgMats };
  return ship;
}

// world-space sample points for collision (local coords)
export const SHIP_PROBES = [
  [0, -0.6, -6.6], [0, -0.9, 2], [7.6, -0.9, 3.0], [-7.6, -0.9, 3.0], [7.6, -2.6, 3.5], [-7.6, -2.6, 3.5], [1.8, -1.1, 5.6], [-1.8, -1.1, 5.6], [0, 1.4, 0],
  [4.6, -0.6, 1.6], [-4.6, -0.6, 1.6], [0, 0.2, -4.2],
];
// hit zone per probe: N = nose, B = body/fuselage, L / R = wings
export const PROBE_ZONE = ['N', 'B', 'R', 'L', 'R', 'L', 'B', 'B', 'B', 'R', 'L', 'N'];

// Swap the procedural hull for the Blender-built GLB (keeps flames, damage decals, skins & rim light)
export function upgradeShip(ship, gltf, ao, env) {
  const { body, hullMats } = ship.userData;
  body.traverse((o) => { if (o.isMesh && !(o.material && o.material.map && o.material.transparent) && !(o.material && o.material.type === 'ShaderMaterial')) o.visible = false; });
  // keep the hot nozzle discs? the GLB has its own emissive cores
  const [hull, hull2, dark] = hullMats;
  for (const m of hullMats) { m.flatShading = false; m.aoMap = ao || null; m.aoMapIntensity = 1.2; m.metalness = 0.45; m.roughness = m === dark ? 0.7 : m === hull ? 0.58 : 0.64; m.envMap = env; m.envMapIntensity = 0.07; m.needsUpdate = true; }
  const map = { hull, panel: hull2, dark };
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    const n = o.material.name;
    if (map[n]) o.material = map[n];
    else {
      const m = o.material; m.envMap = env; m.envMapIntensity = n === 'glass' ? 0.6 : 0.12; if (n === 'nozzle') { m.roughness = 0.5; m.color.multiplyScalar(0.6); }
      if (ao && n !== 'hot' && !n.startsWith('nav')) m.aoMap = ao;
      if (n === 'hot') { m.emissiveIntensity = 7; m.toneMapped = true; }
      if (n.startsWith('nav')) m.emissiveIntensity = 8;
      m.needsUpdate = true;
    }
  });
  body.add(gltf.scene);
  ship.userData.glb = gltf.scene;
  // lift the wing damage decals onto the GLB wing's top surface (raycast down at a few points, take the highest)
  try {
    ship.updateMatrixWorld(true);
    const rc = new THREE.Raycaster(), dn = new THREE.Vector3(0, -1, 0);
    for (const dm of Object.values(ship.userData.dmgMats || {})) {
      let deco = null; body.traverse((o) => { if (o.material === dm) deco = o; });
      if (!deco) continue;
      deco.geometry.computeBoundingBox();
      const bb = deco.geometry.boundingBox, par = deco.parent;
      const hs = [];
      for (const [fx, fz] of [[0.5, 0.5], [0.7, 0.5], [0.85, 0.45], [0.6, 0.3], [0.6, 0.7]]) {
        const lp = new THREE.Vector3(bb.min.x + (bb.max.x - bb.min.x) * fx, 3, bb.min.z + (bb.max.z - bb.min.z) * fz);
        const wp = par.localToWorld(lp.clone());
        rc.set(wp, dn); rc.far = 8;
        const h = rc.intersectObject(gltf.scene, true)[0];
        if (h) hs.push(par.worldToLocal(h.point.clone()).y);
      }
      if (hs.length) deco.position.y = Math.max(...hs) + 0.04; // outer wing only (skips the nacelles), highest hit so it never sinks
      dm.polygonOffsetFactor = -4; dm.polygonOffsetUnits = -4;
    }
  } catch (e) { console.warn('decal lift', e); }
}
