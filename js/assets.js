// Asset loader with progress bar: Blender-made Draco GLB gunship, baked AO, CC0 PBR textures, CC0 HDRI.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from '../vendor/addons/loaders/DRACOLoader.js';
import { RGBELoader } from '../vendor/addons/loaders/RGBELoader.js';

const LIST = [
  ['ship', 'assets/gunship.glb', 116676], ['ao', 'assets/ship_ao.jpg', 268049], ['hdr', 'assets/sky_1k.hdr', 1435119],
  ['rockD', 'assets/tex/rock_d.jpg', 136514], ['rockN', 'assets/tex/rock_n.jpg', 375313], ['sandD', 'assets/tex/sand_d.jpg', 52561],
  ['sandN', 'assets/tex/sand_n.jpg', 380161], ['grassD', 'assets/tex/grass_d.jpg', 215986],
  ['draco', 'vendor/draco/draco_decoder.wasm', 192420],
];

async function fetchProgress(url, onBytes) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' ' + r.status);
  if (!r.body || !r.body.getReader) { const b = await r.arrayBuffer(); onBytes(b.byteLength); return b; }
  const rd = r.body.getReader(); const chunks = []; let n = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(value); n += value.length; onBytes(value.length); }
  const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

export async function loadAssets() {
  const bar = document.getElementById('loadBar'), txt = document.getElementById('loadTxt');
  const total = LIST.reduce((a, l) => a + l[2], 0); let got = 0;
  const upd = (b) => { got += b; const p = Math.min(got / total, 1); if (bar) bar.style.transform = `scaleX(${p.toFixed(3)})`; if (txt) txt.textContent = `Loading ${Math.round(p * 100)}%`; };
  const bufs = {};
  await Promise.all(LIST.map(async ([k, url]) => { try { bufs[k] = await fetchProgress(url, upd); } catch (e) { console.warn('asset failed', url, e); } }));
  const A = {};
  const tex = async (k, srgb) => {
    if (!bufs[k]) return null;
    const bmp = await createImageBitmap(new Blob([bufs[k]]), { imageOrientation: 'none' }).catch(() => null);
    if (!bmp) return null;
    const t = new THREE.Texture(bmp); t.flipY = false; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.needsUpdate = true; return t;
  };
  [A.rockD, A.rockN, A.sandD, A.sandN, A.grassD, A.ao] = await Promise.all([tex('rockD', true), tex('rockN'), tex('sandD', true), tex('sandN'), tex('grassD', true), tex('ao')]);
  if (A.ao) A.ao.wrapS = A.ao.wrapT = THREE.ClampToEdgeWrapping;
  try { if (bufs.hdr) { const t = new RGBELoader().parse(bufs.hdr); const dt = new THREE.DataTexture(t.data, t.width, t.height, THREE.RGBAFormat, t.type); dt.mapping = THREE.EquirectangularReflectionMapping; dt.colorSpace = THREE.LinearSRGBColorSpace; dt.flipY = true; dt.needsUpdate = true; A.hdr = dt; } } catch (e) { console.warn('hdr failed', e); }
  try {
    if (bufs.ship) {
      const draco = new DRACOLoader(); draco.setDecoderPath('vendor/draco/'); draco.setDecoderConfig({ type: 'wasm' });
      const gl = new GLTFLoader(); gl.setDRACOLoader(draco);
      A.ship = await new Promise((res, rej) => gl.parse(bufs.ship, '', res, rej));
    }
  } catch (e) { console.warn('ship glb failed', e); }
  if (txt) txt.textContent = 'Ready';
  const L = document.getElementById('loading'); if (L) { L.style.opacity = 0; setTimeout(() => L.remove(), 600); }
  return A;
}
