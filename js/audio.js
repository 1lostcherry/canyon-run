// Fully synthesized WebAudio: engine, afterburner, wind, sonic boom, explosion, chimes.
export class GameAudio {
  constructor() { this.ctx = null; this.ok = false; }

  init() {
    if (this.ctx) { this.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC({ latencyHint: 'interactive' });
    // iOS unlock
    const ub = ctx.createBuffer(1, 1, 22050); const us = ctx.createBufferSource(); us.buffer = ub; us.connect(ctx.destination); us.start(0);
    this.resume();

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.25;
    comp.connect(ctx.destination);
    this.master = ctx.createGain(); this.master.gain.value = 0.0; this.master.connect(comp);
    this.master.gain.setTargetAtTime(this.volume ?? 0.85, ctx.currentTime, 0.4);

    const sr = ctx.sampleRate, len = sr * 2;
    this.white = ctx.createBuffer(1, len, sr);
    this.brown = ctx.createBuffer(1, len, sr);
    const w = this.white.getChannelData(0), b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const r = Math.random() * 2 - 1; w[i] = r; last = (last + 0.02 * r) / 1.02; b[i] = last * 3.5; }

    const loop = (buf) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0, Math.random() * 1.9); return s; };
    const gain = (v, dest) => { const g = ctx.createGain(); g.gain.value = v; g.connect(dest); return g; };
    const filt = (type, f, q, dest) => { const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; fl.connect(dest); return fl; };

    // engine tone
    this.engGain = gain(0, this.master);
    this.engFilter = filt('lowpass', 400, 3, this.engGain);
    this.osc = [];
    for (const [type, mul, det, g] of [['sawtooth', 1, 0, 0.5], ['sawtooth', 1.005, 7, 0.4], ['square', 0.5, 0, 0.35], ['sine', 2, 0, 0.25]]) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = 50 * mul; o.detune.value = det;
      const og = gain(g, this.engFilter); o.connect(og); o.start(); this.osc.push({ o, mul });
    }
    // turbine whine
    this.whine = ctx.createOscillator(); this.whine.type = 'triangle'; this.whine.frequency.value = 900;
    this.whineGain = gain(0, this.master); this.whine.connect(this.whineGain); this.whine.start();
    // roar
    this.roarGain = gain(0, this.master);
    this.roarFilter = filt('bandpass', 160, 0.7, this.roarGain);
    loop(this.brown).connect(this.roarFilter);
    // afterburner hiss
    this.abGain = gain(0, this.master);
    this.abFilter = filt('bandpass', 1400, 0.5, this.abGain);
    loop(this.white).connect(this.abFilter);
    // wind
    this.windGain = gain(0, this.master);
    this.windFilter = filt('lowpass', 500, 0.9, this.windGain);
    loop(this.white).connect(this.windFilter);
    // ground rumble
    this.rumbleGain = gain(0, this.master);
    this.rumbleFilter = filt('lowpass', 120, 1, this.rumbleGain);
    loop(this.brown).connect(this.rumbleFilter);
    // rain / hail ambience
    this.rainGain = gain(0, this.master);
    this.rainFilter = filt('highpass', 1800, 0.5, this.rainGain);
    loop(this.white).connect(this.rainFilter);
    this.hailGain = gain(0, this.master);
    this.hailFilter = filt('bandpass', 4200, 1.5, this.hailGain);
    loop(this.white).connect(this.hailFilter);
    this.ok = true;
  }

  blizzard(k) { // howling wind: resonant band-passed noise with a slow, wandering pitch
    if (!this.ok) return;
    const ctx = this.ctx, t = ctx.currentTime;
    if (!this.howl) {
      const g = ctx.createGain(); g.gain.value = 0; g.connect(this.master);
      const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.Q.value = 9; f1.frequency.value = 520; f1.connect(g);
      const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.Q.value = 14; f2.frequency.value = 880; f2.connect(g);
      const s1 = ctx.createBufferSource(); s1.buffer = this.white; s1.loop = true; s1.connect(f1); s1.connect(f2); s1.start();
      this.howl = { g, f1, f2, ph: 0 };
    }
    const h = this.howl; h.ph += 0.016;
    h.f1.frequency.setTargetAtTime(420 + 260 * Math.sin(h.ph * 0.9) + 120 * Math.sin(h.ph * 2.3), t, 0.3);
    h.f2.frequency.setTargetAtTime(760 + 300 * Math.sin(h.ph * 0.6 + 1.3), t, 0.3);
    h.g.gain.setTargetAtTime(k * (0.55 + 0.25 * Math.sin(h.ph * 1.7)), t, 0.4);
  }
  weather(rainK, hailK) {
    if (!this.ok) return;
    const t = this.ctx.currentTime;
    this.rainGain.gain.setTargetAtTime(Math.min(rainK, 1.2) * 0.16, t, 0.4);
    this.hailGain.gain.setTargetAtTime(hailK * 0.12, t, 0.4);
  }
  thunder(delay, vol) {
    if (!this.ok) return;
    this._burst(0.25, 5000, 900, 0.35 * vol, 'bandpass', 0.6, delay * 0.1);
    this._burst(3.8, 500, 40, 0.9 * vol, 'lowpass', 0.7, delay, this.brown);
    this._burst(2.2, 900, 60, 0.6 * vol, 'lowpass', 0.5, delay + 0.25);
    this._thump(1.6, 55, 22, 0.7 * vol, delay + 0.05);
  }
  warn() {
    if (!this.ok) return;
    const ctx = this.ctx;
    [0, 0.12].forEach((d) => {
      const t = ctx.currentTime + d, o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 1180;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.1);
    });
  }
  // screeching metal: resonant noise bands + detuned squeal
  scrape(k = 1) {
    if (!this.ok) return;
    const ctx = this.ctx, t = ctx.currentTime;
    this._burst(0.45, 3200, 1400, 0.32 * k, 'bandpass', 9, 0);
    this._burst(0.35, 5200, 2600, 0.22 * k, 'bandpass', 14, 0.02);
    this._burst(0.18, 900, 200, 0.5 * k, 'lowpass', 1, 0, this.brown);
    [1870, 2630].forEach((f, i) => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * (0.72 + i * 0.05), t + 0.4);
      const fl = ctx.createBiquadFilter(); fl.type = 'bandpass'; fl.frequency.value = f; fl.Q.value = 6;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.06 * k, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      o.connect(fl); fl.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.45);
    });
  }
  // jungle ambience: insect drone + random bird calls (k = 0..1 jungle blend)
  jungle(k, dt) {
    if (!this.ok) return;
    const ctx = this.ctx;
    if (!this.jg) {
      const src = ctx.createBufferSource(); src.buffer = this.white; src.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 5200; bp.Q.value = 3;
      const am = ctx.createGain(); const lfo = ctx.createOscillator(); lfo.frequency.value = 23; const lg = ctx.createGain(); lg.gain.value = 0.4; lfo.connect(lg); lg.connect(am.gain); am.gain.value = 0.6;
      this.jg = ctx.createGain(); this.jg.gain.value = 0;
      src.connect(bp); bp.connect(am); am.connect(this.jg); this.jg.connect(this.master); src.start(); lfo.start();
    }
    this.jg.gain.setTargetAtTime(0.05 * k, ctx.currentTime, 0.5);
    if (k > 0.2 && Math.random() < dt * 1.6 * k) {
      const t = ctx.currentTime, f = 1400 + Math.random() * 2200, n = 2 + (Math.random() * 4 | 0);
      for (let i = 0; i < n; i++) {
        const o = ctx.createOscillator(); o.type = 'sine'; const g = ctx.createGain(); const t0 = t + i * (0.09 + Math.random() * 0.05);
        o.frequency.setValueAtTime(f, t0); o.frequency.exponentialRampToValueAtTime(f * (Math.random() < 0.5 ? 1.6 : 0.6), t0 + 0.08);
        g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.03 * k, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
        o.connect(g); g.connect(this.master); o.start(t0); o.stop(t0 + 0.1);
      }
    }
  }
  tick() {
    if (!this.ok) return;
    this._burst(0.05, 6000, 2500, 0.18, 'bandpass', 2, 0);
  }

  resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); }
  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {}); }

  setMaster(v, tc = 0.3) { if (this.ok) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, tc); }

  update(thr, spdN, low, storm, boost, alive) {
    if (!this.ok) return;
    const t = this.ctx.currentTime, tc = 0.08;
    const a = alive ? 1 : 0;
    const st = this.strain || 0, jit = st * (Math.random() - 0.5) * 10; // blizzard: engine strains (pitch + roughness up)
    const f = (34 + thr * 62 + spdN * 26 + boost * 12) * (1 + 0.18 * st) + jit;
    for (const { o, mul } of this.osc) o.frequency.setTargetAtTime(f * mul, t, tc);
    this.engFilter.frequency.setTargetAtTime(220 + thr * 1500 + boost * 600, t, tc);
    this.engGain.gain.setTargetAtTime(a * (0.07 + thr * 0.14), t, tc);
    this.whine.frequency.setTargetAtTime(700 + thr * 1600 + spdN * 400, t, tc);
    this.whineGain.gain.setTargetAtTime(a * (0.006 + thr * 0.014), t, tc);
    this.roarFilter.frequency.setTargetAtTime(110 + thr * 380, t, tc);
    this.roarGain.gain.setTargetAtTime(a * (0.18 + thr * 0.5 + boost * 0.2) * (1 + st * (0.35 + 0.3 * Math.random())), t, tc);
    this.abFilter.frequency.setTargetAtTime(900 + thr * 1500, t, tc);
    this.abGain.gain.setTargetAtTime(a * (thr * thr * 0.09 + boost * 0.06), t, tc);
    this.windFilter.frequency.setTargetAtTime(250 + spdN * 2600 + storm * 600, t, 0.2);
    this.windGain.gain.setTargetAtTime(0.03 + spdN * 0.16 + storm * 0.22, t, 0.2);
    this.rumbleGain.gain.setTargetAtTime(a * low * (0.3 + spdN * 0.6), t, 0.1);
  }

  _burst(dur, f0, f1, vol, type = 'lowpass', q = 0.7, delay = 0, buf = null) {
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const s = ctx.createBufferSource(); s.buffer = buf || this.white;
    const fl = ctx.createBiquadFilter(); fl.type = type; fl.Q.value = q;
    fl.frequency.setValueAtTime(f0, t); fl.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(fl); fl.connect(g); g.connect(this.master);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }
  _thump(dur, f0, f1, vol, delay = 0) {
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }

  boom() {
    if (!this.ok) return;
    // classic N-wave "ba-BOOM": two cracks + low rumble tail
    this._burst(0.9, 2500, 120, 0.9, 'lowpass', 0.8, 0);
    this._thump(0.7, 75, 28, 0.9, 0);
    this._burst(1.3, 1800, 80, 1.0, 'lowpass', 0.8, 0.13);
    this._thump(0.9, 65, 24, 1.0, 0.13);
    this._burst(2.6, 300, 40, 0.5, 'lowpass', 0.5, 0.2, this.brown);
  }
  explode() {
    if (!this.ok) return;
    this._burst(2.8, 3500, 60, 1.0, 'lowpass', 0.6, 0);
    this._burst(0.35, 6000, 800, 0.6, 'bandpass', 0.4, 0);
    this._thump(1.2, 90, 22, 1.0, 0);
    this._burst(3.5, 400, 30, 0.7, 'lowpass', 0.5, 0.1, this.brown);
  }
  chime() {
    if (!this.ok) return;
    const ctx = this.ctx;
    [880, 1318.5, 1760].forEach((f, i) => {
      const t = ctx.currentTime + i * 0.06;
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.7);
    });
    this._burst(0.5, 4000, 600, 0.25, 'bandpass', 0.8, 0);
  }
  missile() {
    if (!this.ok) return;
    // rail clunk + rocket motor hiss sweeping up
    this._thump(0.35, 160, 60, 0.12, 0);
    this._burst(0.55, 900, 4200, 0.55, 'bandpass', 0.9, 0.02);
    this._burst(0.4, 2500, 600, 0.9, 'lowpass', 0.7, 0.05);
  }
  whoosh() {
    if (!this.ok) return;
    this._burst(0.55, 600, 3000, 0.35, 'bandpass', 1.2, 0);
  }
}
