// GPU-driven dust: up to ~1M fine particles simulated analytically in the vertex shader.
// CPU only writes a small ring buffer of emission "bursts" (origin, velocity, colour, strength) each frame.
import * as THREE from 'three';

const BURSTS = 512;
const VS = /* glsl */`
precision highp float;
uniform vec3 uRO; uniform sampler2D bursts; uniform float time; uniform float per; uniform float pxScale; uniform vec3 sunDir; uniform vec3 sunCol;
varying vec4 vC; varying float vSpark;
float h(float n){ return fract(sin(n * 12.9898) * 43758.5453); }
void main(){
  int id = gl_VertexID; int b = id / int(per); float k = float(id - b * int(per));
  vec4 B0 = texelFetch(bursts, ivec2(0, b), 0); // origin.xyz, t0
  vec4 B1 = texelFetch(bursts, ivec2(1, b), 0); // inherited vel.xyz, density
  vec4 B2 = texelFetch(bursts, ivec2(2, b), 0); // colour.rgb, kind
  vec4 B3 = texelFetch(bursts, ivec2(3, b), 0); // radius, out speed, up speed, life
  float s = float(b) * 1.618 + k * 0.0137;
  float h1 = h(s), h2 = h(s + 1.7), h3 = h(s + 3.1), h4 = h(s + 5.3), h5 = h(s + 7.9);
  float age = time - B0.w; float life = B3.w * (0.45 + 0.75 * h3);
  if (age < 0.0 || age > life || h4 > B1.w) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float kind = B2.w; // 0 dust, 1 spray, 2 grass/pollen
  float a = h1 * 6.2832; vec2 dir = vec2(cos(a), sin(a));
  float r0 = B3.x * sqrt(h2);
  vec3 v = vec3(dir.x, 0.0, dir.y) * B3.y * (0.35 + 0.9 * h5) + vec3(0.0, B3.z * (0.2 + h4), 0.0) + B1.xyz * (0.25 + 0.4 * h3);
  float drag = kind == 1.0 ? 1.4 : 2.2;
  float e = (1.0 - exp(-drag * age)) / drag;
  vec3 p = B0.xyz + vec3(dir.x, 0.0, dir.y) * r0 + v * e;
  p.y += kind == 1.0 ? -6.0 * age * age : (kind == 2.0 ? -0.4 * age : 0.9 * age); // spray falls, dust lofts
  // curl-ish roiling turbulence growing with age
  float ta = age * (1.2 + h2);
  vec3 q = p * 0.06;
  p += vec3(sin(q.z * 2.1 + time * 0.9 + h1 * 6.0) + sin(q.y * 3.3 + time * 1.3),
            0.6 * sin(q.x * 2.7 + time * 1.1 + h2 * 6.0),
            sin(q.x * 1.9 - time * 0.8 + h3 * 6.0) + sin(q.y * 2.9 + time)) * ta * (kind == 1.0 ? 0.8 : 2.4);
  p.y = max(p.y, B0.y - 0.3);
  vec4 mv = viewMatrix * vec4(p - uRO, 1.0); // floating origin: sim coords -> render coords
  float u = age / life;
  float fade = smoothstep(0.0, 0.08, u) * (1.0 - u) * (1.0 - u);
  float grit = step(h5, 0.07);
  float size = (kind == 1.0 ? 0.22 : 0.3) * (1.0 + u * 2.5) * (0.6 + h2) * (grit > 0.5 ? 0.45 : 1.0);
  gl_PointSize = clamp(size * pxScale / -mv.z, 1.0, 9.0);
  gl_Position = projectionMatrix * mv;
  // forward (back-lit) scattering toward the sun
  vec3 vd = normalize(p - uRO - cameraPosition);
  float ph = pow(max(dot(vd, sunDir), 0.0), 6.0);
  vec3 c = B2.rgb * (0.75 + 1.4 * ph) + sunCol * ph * 0.25;
  vSpark = grit * (0.6 + 0.4 * sin(time * 40.0 + k)) * (0.4 + ph * 2.5);
  c = mix(c, sunCol * 2.2, vSpark);
  float px = gl_PointSize;
  vC = vec4(c, fade * (kind == 1.0 ? 0.22 : 0.3) * min(1.0, px * px / (size * pxScale / -mv.z * size * pxScale / -mv.z + 0.001)) * (grit > 0.5 ? 1.5 : 1.0));
}`;
const FS = /* glsl */`
precision highp float;
uniform vec3 fogColor; uniform float fogNear; uniform float fogFar;
varying vec4 vC; varying float vSpark;
void main(){
  vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0;
  float a = (1.0 - r); if (a <= 0.0) discard;
  float f = smoothstep(fogNear, fogFar, gl_FragCoord.z / gl_FragCoord.w);
  gl_FragColor = vec4(mix(vC.rgb, fogColor, f), vC.a * a * a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class GpuDust {
  constructor(scene, fogU, sunDir, sunCol, count) {
    this.data = new Float32Array(BURSTS * 4 * 4).fill(0);
    for (let b = 0; b < BURSTS; b++) this.data[b * 16 + 3] = -999;
    this.tex = new THREE.DataTexture(this.data, 4, BURSTS, THREE.RGBAFormat, THREE.FloatType);
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter; this.tex.needsUpdate = true;
    this.U = { uRO: { value: new THREE.Vector3() }, bursts: { value: this.tex }, time: { value: 0 }, per: { value: 1 }, pxScale: { value: 800 }, sunDir: { value: sunDir }, sunCol: { value: sunCol }, ...fogU };
    this.mat = new THREE.ShaderMaterial({ uniforms: this.U, vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false });
    this.scene = scene; this.slot = 0; this.acc = 0;
    this.setCount(count);
  }
  setCount(count) {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
    const per = Math.max(16, Math.round(count / BURSTS));
    this.count = per * BURSTS; this.U.per.value = per;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Uint8Array(this.count * 3), 3)); // unused, sets draw count (ids via gl_VertexID)
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.mesh = new THREE.Points(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 5;
    this.scene.add(this.mesh);
  }
  clear() { for (let b = 0; b < BURSTS; b++) this.data[b * 16 + 3] = -999; this.tex.needsUpdate = true; }
  emit(t, x, y, z, vx, vy, vz, dens, r, g, b, kind, radius, out, up, life) {
    const o = this.slot * 16, d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = t;
    d[o + 4] = vx; d[o + 5] = vy; d[o + 6] = vz; d[o + 7] = dens;
    d[o + 8] = r; d[o + 9] = g; d[o + 10] = b; d[o + 11] = kind;
    d[o + 12] = radius; d[o + 13] = out; d[o + 14] = up; d[o + 15] = life;
    this.slot = (this.slot + 1) % BURSTS; this.dirty = true;
  }
  update(t, viewH, fovDeg) {
    this.U.time.value = t;
    this.U.pxScale.value = viewH / (2 * Math.tan(fovDeg * Math.PI / 360));
    if (this.dirty) { this.tex.needsUpdate = true; this.dirty = false; }
  }
}
