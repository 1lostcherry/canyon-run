// Lightweight HDR post pipeline: MSAA half-float scene target -> dual-Kawase bloom -> composite
// (radial speed blur, bloom, vignette, film grain) -> ACES tone mapping + sRGB via three's output chunks.
import * as THREE from 'three';

const QUAD_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const DOWN = `uniform sampler2D src; uniform vec2 texel; uniform float thresh; varying vec2 vUv;
  vec3 s(vec2 o){ vec3 c = texture2D(src, vUv + o * texel).rgb; if (thresh > 0.0) { float l = max(c.r, max(c.g, c.b)); c *= smoothstep(thresh, thresh * 1.8, l); c = min(c, vec3(40.0)); } return c; }
  void main(){ vec3 c = s(vec2(0.0)) * 4.0 + s(vec2(-1.0, -1.0)) + s(vec2(1.0, -1.0)) + s(vec2(-1.0, 1.0)) + s(vec2(1.0, 1.0)); gl_FragColor = vec4(c / 8.0, 1.0); }`;
const UP = `uniform sampler2D src; uniform vec2 texel; varying vec2 vUv;
  vec3 s(vec2 o){ return texture2D(src, vUv + o * texel).rgb; }
  void main(){ vec3 c = s(vec2(-2.0, 0.0)) + s(vec2(2.0, 0.0)) + s(vec2(0.0, -2.0)) + s(vec2(0.0, 2.0)) + (s(vec2(-1.0, -1.0)) + s(vec2(1.0, -1.0)) + s(vec2(-1.0, 1.0)) + s(vec2(1.0, 1.0))) * 2.0; gl_FragColor = vec4(c / 12.0, 1.0); }`;
const COMP = `uniform sampler2D scene; uniform sampler2D bloom; uniform float bloomK; uniform float blur; uniform vec2 center; uniform float grain; uniform float vig; uniform float time; uniform vec2 res; uniform float sat; uniform vec3 tint; varying vec2 vUv;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main(){
    vec3 c = texture2D(scene, vUv).rgb;
    if (blur > 0.001) {
      vec2 d = (vUv - center); float L = length(d);
      float k = blur * smoothstep(0.08, 0.6, L);
      vec3 acc = c; float j = hash(vUv * res + time) * 0.5;
      for (int i = 1; i < 8; i++) acc += texture2D(scene, vUv - d * k * (float(i) + j) / 8.0).rgb;
      c = acc / 8.0;
    }
    c += texture2D(bloom, vUv).rgb * bloomK;
    c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, sat) * tint;
    vec2 q = vUv - 0.5; c *= 1.0 - vig * smoothstep(0.25, 0.85, length(q * vec2(1.25, 1.0)));
    c *= 1.0 + (hash(vUv * res + fract(time * 7.0) * 91.0) - 0.5) * grain;
    gl_FragColor = vec4(max(c, 0.0), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export class PostFX {
  constructor(renderer) {
    this.r = renderer;
    const gl = renderer.getContext();
    this.supported = renderer.capabilities.isWebGL2 && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
    this.enabled = this.supported; this.bloomOn = true; this.blur = 0; this.bloomK = 0.32; this.grain = 0.045; this.vig = 0.35;
    this.center = new THREE.Vector2(0.5, 0.48);
    const opt = { type: THREE.HalfFloatType, depthBuffer: false };
    this.scene = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
    this.mips = []; for (let i = 0; i < 5; i++) this.mips.push(new THREE.WebGLRenderTarget(4, 4, opt));
    this.ups = []; for (let i = 0; i < 4; i++) this.ups.push(new THREE.WebGLRenderTarget(4, 4, opt));
    const mk = (fs, u) => new THREE.ShaderMaterial({ uniforms: u, vertexShader: QUAD_VS, fragmentShader: fs, depthTest: false, depthWrite: false });
    this.down = mk(DOWN, { src: { value: null }, texel: { value: new THREE.Vector2() }, thresh: { value: 0 } });
    this.up = mk(UP, { src: { value: null }, texel: { value: new THREE.Vector2() } });
    this.addMat = mk(UP, { src: { value: null }, texel: { value: new THREE.Vector2() } });
    this.addMat.blending = THREE.AdditiveBlending; this.addMat.transparent = true;
    this.comp = mk(COMP, { scene: { value: null }, bloom: { value: null }, bloomK: { value: 0.5 }, blur: { value: 0 }, center: { value: this.center }, grain: { value: 0.04 }, vig: { value: 0.35 }, time: { value: 0 }, res: { value: new THREE.Vector2() }, sat: { value: 1 }, tint: { value: new THREE.Vector3(1, 1, 1) } });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.comp); this.quad.frustumCulled = false;
    this.qs = new THREE.Scene(); this.qs.add(this.quad); this.qc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.w = 0; this.h = 0;
  }
  setSize(w, h) {
    if (w === this.w && h === this.h) return; this.w = w; this.h = h;
    this.scene.setSize(w, h);
    let mw = w >> 1, mh = h >> 1;
    for (let i = 0; i < 5; i++) { this.mips[i].setSize(Math.max(mw, 1), Math.max(mh, 1)); if (i < 4) this.ups[i].setSize(Math.max(mw, 1), Math.max(mh, 1)); mw >>= 1; mh >>= 1; }
  }
  pass(mat, target) { this.quad.material = mat; this.r.setRenderTarget(target); this.r.render(this.qs, this.qc); }
  render(scene, camera, t) {
    const r = this.r;
    if (!this.enabled) { r.setRenderTarget(null); r.render(scene, camera); return; }
    const sz = r.getDrawingBufferSize(new THREE.Vector2()); this.setSize(sz.x, sz.y);
    r.setRenderTarget(this.scene); r.render(scene, camera);
    let bloomTex = null;
    if (this.bloomOn) {
      let src = this.scene.texture, sw = sz.x, sh = sz.y;
      for (let i = 0; i < 5; i++) {
        this.down.uniforms.src.value = src; this.down.uniforms.texel.value.set(1 / sw, 1 / sh); this.down.uniforms.thresh.value = i === 0 ? 1.7 : 0;
        this.pass(this.down, this.mips[i]); src = this.mips[i].texture; sw = this.mips[i].width; sh = this.mips[i].height;
      }
      // upsample: ups[i] = up(prev) + mips[i]
      let prev = this.mips[4];
      for (let i = 3; i >= 0; i--) {
        this.up.uniforms.src.value = prev.texture; this.up.uniforms.texel.value.set(1 / prev.width, 1 / prev.height);
        this.pass(this.up, this.ups[i]);
        this.addMat.uniforms.src.value = this.mips[i].texture; this.addMat.uniforms.texel.value.set(0, 0);
        r.autoClear = false; this.pass(this.addMat, this.ups[i]); r.autoClear = true;
        prev = this.ups[i];
      }
      bloomTex = this.ups[0].texture;
    }
    const u = this.comp.uniforms;
    u.scene.value = this.scene.texture; u.bloom.value = bloomTex || this.mips[4].texture; u.bloomK.value = bloomTex ? this.bloomK : 0;
    u.blur.value = this.blur; u.grain.value = this.grain; u.vig.value = this.vig; u.time.value = t; u.sat.value = this.sat ?? 1; if (this.tint) u.tint.value.copy(this.tint); u.res.value.set(sz.x, sz.y);
    this.pass(this.comp, null);
  }
}
