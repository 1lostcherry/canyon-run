// Tilt (DeviceOrientation) + touch throttle + keyboard/mouse fallback
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

// One-euro filter: heavy smoothing when the phone is still (kills jitter),
// light smoothing when it moves fast (no perceptible lag).
class OneEuro {
  constructor(minCutoff = 1.4, beta = 0.035, dCutoff = 1.2) { this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff; this.x = null; this.dx = 0; }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  reset(v) { this.x = v; this.dx = 0; }
  filter(v, dt) {
    if (this.x === null) { this.x = v; return v; }
    const d = (v - this.x) / dt;
    this.dx += (d - this.dx) * OneEuro.alpha(this.dCutoff, dt);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += (v - this.x) * OneEuro.alpha(cutoff, dt);
    return this.x;
  }
}

export class Controls {
  constructor() {
    this.steer = 0; this.pitch = 0; this.throttle = 0.35;
    this.hasTilt = false; this.tiltEnabled = false;
    this.rollRaw = 0; this.pitchRaw = 0; this.rollF = 0; this.pitchF = 0;
    this.roll0 = 0; this.pitch0 = 0;
    this.calibT = -1;
    this.fRoll = new OneEuro(1.4, 0.035); this.fPitch = new OneEuro(1.2, 0.03);
    this.pitchMode = +(localStorage.getItem('canyon.pitchMode') ?? 0); // 0 normal, 1 inverted, 2 off
    this.keys = {};
    this.touchSteer = 0; this.touchPitch = 0; this.swT = [0, 0]; this.swipeSteer = localStorage.getItem('canyon.swipe') === '1';
    this.drag = null; this.rollCmd = 0;
    this.enabled = false;
    this.lastOrientEvent = 0;

    addEventListener('keydown', (e) => { this.keys[e.code] = true; if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault(); });
    addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    addEventListener('blur', () => { this.keys = {}; });
    this._onOrient = (e) => this.onOrient(e);
    const recal = () => setTimeout(() => this.calibrate(0.15), 450);
    if (screen.orientation) screen.orientation.addEventListener('change', recal);
    else addEventListener('orientationchange', recal);
  }

  // multi-touch: every pointer gets its own role, so the throttle (right) and climb/dive stick (left) work simultaneously
  barHit(x, id, padIn, padOut) { const b = document.getElementById(id).getBoundingClientRect(); return b.width > 0 && x > b.left - padIn && x < b.right + padOut ? b : null; }
  onSlider(x) { return !!(this.barHit(x, 'thrBar', 50, 40) || this.barHit(x, 'altBar', 40, 50)); }
  attachPointer(el, isUI) {
    this.drags = new Map(); this.altStick = 0;
    el.addEventListener('pointerdown', (e) => {
      if (!this.enabled || isUI(e.target)) return;
      const tb = this.barHit(e.clientX, 'thrBar', 50, 40), ab = !tb && this.barHit(e.clientX, 'altBar', 40, 50);
      if (ab) {
        for (const d of this.drags.values()) if (d.kind === 'alt') return;
        const d = { kind: 'alt', id: e.pointerId, top: ab.top, h: ab.height };
        this.drags.set(e.pointerId, d); this.setAlt(e.clientY, d);
      } else if (tb) {
        for (const d of this.drags.values()) if (d.kind === 'thr' || d.kind === 'swipe') return;
        this.drags.set(e.pointerId, { kind: 'thr', id: e.pointerId, barTop: tb.top, barH: tb.height });
        this.throttle = clamp(1 - (e.clientY - tb.top) / tb.height, 0, 1);
      } else if (this.inRollZone(e.clientY)) { // upper ~30% of the gameplay area: horizontal drag = roll angle
        for (const d of this.drags.values()) if (d.kind === 'roll') return;
        this.drags.set(e.pointerId, { kind: 'roll', id: e.pointerId, x0: e.clientX, y0: e.clientY, r0: this.rollCmd, px: e.clientX, py: e.clientY, pa: null, sweep: 0, len: 0, arcDone: false });
      } else {
        for (const d of this.drags.values()) if (d.kind === 'thr' || d.kind === 'swipe') return;
        this.drags.set(e.pointerId, { kind: 'swipe', id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: this.throttle, px: e.clientX, py: e.clientY, pa: null, sweep: 0, len: 0, arcDone: false });
      }
      this.drag = this.drags.size ? [...this.drags.values()][0] : null;
    });
    el.addEventListener('pointermove', (e) => {
      const d = this.drags.get(e.pointerId); if (!d) return;
      if ((d.kind === 'swipe' || d.kind === 'roll') && this.trackArc(d, e.clientX, e.clientY)) return; // arc gesture wins anywhere
      if (d.arcDone) return;
      if (d.kind === 'roll') { this.rollCmd = clamp(d.r0 + (e.clientX - d.x0) / (innerWidth * 0.35) * Math.PI, -Math.PI, Math.PI); return; }
      if (d.kind === 'alt') this.setAlt(e.clientY, d);
      else if (d.kind === 'thr') this.throttle = clamp(1 - (e.clientY - d.barTop) / d.barH, 0, 1);
      else {
        // gameplay swipe = LEFT/RIGHT steering only (finger right-to-left = steer left), proportional to displacement; no pitch, no throttle
        const R = Math.min(innerWidth, innerHeight) * 0.28, dz = 0.06;
        const v = (e.clientX - d.x0) / R, av = Math.abs(v);
        this.swT[0] = av < dz ? 0 : Math.sign(v) * Math.min((av - dz) / (1 - dz), 1); this.swT[1] = 0;
      }
    });
    const end = (e) => {
      const d = this.drags.get(e.pointerId); if (!d) return;
      this.drags.delete(e.pointerId);
      if (d.kind === 'roll') this.rollCmd = 0; // release: return to level
      if (d.kind === 'alt') this.altStick = 0; // target altitude stays where the slider was left
      if (d.kind === 'swipe') { this.touchSteer = 0; this.swT[0] = this.swT[1] = 0; if (this.swS) this.swS[0] = this.swS[1] = 0; } // spring back to neutral
      this.drag = this.drags.size ? [...this.drags.values()][0] : null;
    };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => { if (this.enabled) this.throttle = clamp(this.throttle - e.deltaY * 0.0008, 0, 1); }, { passive: true });
  }
  // arc / semicircle gesture: accumulate the signed turning of the finger's direction of travel.
  // >150 deg swept over a reasonably long path = 360 aileron roll in that direction (clockwise on screen = roll right).
  trackArc(d, x, y) {
    const dx = x - d.px, dy = y - d.py, l = Math.hypot(dx, dy); if (l < 6) return false;
    const a = Math.atan2(dy, dx);
    if (d.pa !== null) { let da = a - d.pa; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI; if (Math.abs(da) < 1.4) d.sweep += da; }
    d.pa = a; d.px = x; d.py = y; d.len += l;
    if (!d.arcDone && Math.abs(d.sweep) > 150 * Math.PI / 180 && d.len > Math.min(innerWidth, innerHeight) * 0.3) {
      d.arcDone = true; this.swT[0] = 0; this.touchSteer = 0; if (this.swS) this.swS[0] = 0; if (d.kind === 'roll') this.rollCmd = 0;
      if (this.onArc) this.onArc(d.sweep > 0 ? 1 : -1);
      return true;
    }
    return d.arcDone;
  }
  inRollZone(y) { const top = this.hudTop || 96, h = innerHeight - top; return y > top && y < top + h * 0.3; }
  // centre = 0 (level), top = +1 (full climb), bottom = -1 (full dive); small dead-zone around centre
  setAlt(y, d) { // slider position maps bottom = 0 m (ground, terrain-relative) .. top = 500 m
    this.altTarget = clamp(1 - (y - d.top) / d.h, 0, 1) * 500; this.altStick = 0;
  }

  // must be called synchronously inside a user gesture (iOS)
  requestTilt() {
    const start = () => { if (!this.tiltEnabled) { addEventListener('deviceorientation', this._onOrient); this.tiltEnabled = true; } };
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      return DOE.requestPermission().then((r) => { if (r === 'granted') start(); return r; }).catch(() => 'denied');
    }
    if (DOE) start();
    return Promise.resolve(DOE ? 'granted' : 'unsupported');
  }

  screenAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
    if (typeof window.orientation === 'number') return window.orientation;
    return 0;
  }

  onOrient(e) {
    if (e.beta == null || e.gamma == null) return;
    const b = e.beta * D2R, g = e.gamma * D2R;
    // world-up vector expressed in device coords
    const ux = -Math.sin(g) * Math.cos(b), uy = Math.sin(b), uz = Math.cos(g) * Math.cos(b);
    const a = this.screenAngle() * D2R;
    const sx = ux * Math.cos(a) - uy * Math.sin(a);
    const sy = ux * Math.sin(a) + uy * Math.cos(a);
    const sz = uz;
    const roll = Math.atan2(-sx, Math.hypot(sy, sz)) * R2D;
    const pitch = Math.atan2(sz, sy) * R2D;
    if (!this.hasTilt) { this.rollF = roll; this.pitchF = pitch; this.roll0 = 0; this.pitch0 = pitch; this.fRoll.reset(roll); this.fPitch.reset(pitch); }
    this.hasTilt = true;
    this.rollRaw = roll; this.pitchRaw = pitch;
    this.lastOrientEvent = performance.now();
  }

  calibrate(delay = 0) { this.calibT = delay; }

  setPitchMode(m) { this.pitchMode = m; localStorage.setItem('canyon.pitchMode', m); }

  update(dt) {
    if (this.calibT >= 0) {
      this.calibT -= dt;
      if (this.calibT < 0) { this.roll0 = clamp(this.rollF, -25, 25); this.pitch0 = this.pitchF; this.calibT = -1; }
    }
    let steer = 0, pitch = 0;
    if (this.hasTilt) {
      // low-pass filter (time constant ~55 ms) -> responsive but jitter-free
      let pr = this.pitchRaw;
      while (pr - this.pitchF > 180) pr -= 360; while (pr - this.pitchF < -180) pr += 360;
      this.rollF = this.fRoll.filter(this.rollRaw, Math.max(dt, 1e-3));
      this.pitchF = this.fPitch.filter(pr, Math.max(dt, 1e-3));
      const shape = (x, dead, full, expo) => {
        const ax = Math.max(0, Math.abs(x) - dead);
        const n = Math.min(ax / (full - dead), 1);
        return Math.sign(x) * ((1 - expo) * n + expo * n * n * n);
      };
      const sens = this.sens || 1;
      steer = shape(this.rollF - this.roll0, 2.0, 2.0 + 28 / sens, 0.45);
      let dPitch = this.pitchF - this.pitch0; if (dPitch > 180) dPitch -= 360; if (dPitch < -180) dPitch += 360;
      if (this.pitchMode !== 2) pitch = -shape(dPitch, 4.0, 4.0 + 22 / sens, 0.35) * (this.pitchMode === 1 ? -1 : 1);
    }
    // keyboard
    const K = this.keys;
    const kx = (K.ArrowRight || K.KeyD ? 1 : 0) - (K.ArrowLeft || K.KeyA ? 1 : 0);
    const ky = (K.ArrowUp ? 1 : 0) - (K.ArrowDown ? 1 : 0);
    this._kx = (this._kx || 0) + (kx - (this._kx || 0)) * (1 - Math.exp(-dt * 7));
    this._ky = (this._ky || 0) + (ky - (this._ky || 0)) * (1 - Math.exp(-dt * 6));
    if (this.enabled) {
      if (K.KeyW || K.ShiftLeft) this.throttle = clamp(this.throttle + dt * 0.55, 0, 1);
      if (K.KeyS || K.ControlLeft) this.throttle = clamp(this.throttle - dt * 0.55, 0, 1);
    }
    this.tiltSteer = steer; this.tiltPitch = pitch;
    { // smoothed swipe stick (always on): left/right only
      const k = 1 - Math.exp(-dt * 40); this.swS = this.swS || [0, 0];
      this.swS[0] += (this.swT[0] - this.swS[0]) * k; this.swS[1] += (this.swT[1] - this.swS[1]) * k;
      const held = this.drags && [...this.drags.values()].some((q) => q.kind === 'swipe');
      if (held) steer = this.swS[0]; else steer += this.swS[0]; // swipes never pitch
      this.swipeHeld = !!held;
    }
    this.steer = clamp(steer + this._kx + this.touchSteer, -1, 1);
    if (Math.abs(this._ky) > 0.05) this.altTarget = clamp((this.altTarget ?? 30) + this._ky * 160 * dt, 0, 500); // keyboard up/down moves the altitude target
    this.pitch = clamp(pitch, -1, 1);
  }
}
