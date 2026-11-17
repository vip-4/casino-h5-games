/* ============================================================================
 * engine.js — Casino H5 共用引擎骨架（無依賴，可直接 <script src> 載入）
 * 模組：Ease / ObjectPool / FSM / AudioManager / ParticleSystem / GameLoop / Stage
 * 設計重點：固定步長、物件池（避免 GC）、iOS 音訊解鎖、DPR/RWD、可見性暫停
 * 註：此版用全域命名空間以支援 file:// 直接開啟；正式專案建議改 ES Module + bundler。
 * ==========================================================================*/
(function (global) {
  "use strict";

  /* ---------- Easing ---------- */
  const Ease = {
    linear: t => t,
    inQuad: t => t * t,
    outQuad: t => 1 - (1 - t) * (1 - t),
    outCubic: t => 1 - Math.pow(1 - t, 3),
    outQuint: t => 1 - Math.pow(1 - t, 5),
    inOutCubic: t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
    outBack: t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
    outElastic: t => { const c = (2 * Math.PI) / 3; return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - .75) * c) + 1; }
  };

  /* ---------- 通用物件池 ---------- */
  class ObjectPool {
    constructor(size, factory, reset) {
      this.items = [];
      this.reset = reset || (() => {});
      for (let i = 0; i < size; i++) this.items.push(factory());
    }
    acquire() {
      for (const it of this.items) if (!it.active) { it.active = true; this.reset(it); return it; }
      return null; // 池滿：不新建物件，避免 GC；上層可選擇降載
    }
    release(it) { it.active = false; }
    releaseAll() { for (const it of this.items) it.active = false; }
    get activeCount() { let n = 0; for (const it of this.items) if (it.active) n++; return n; }
    forEach(fn) { for (const it of this.items) if (it.active) fn(it); }
  }

  /* ---------- 有限狀態機 ---------- */
  class FSM {
    constructor(initial, transitions, onChange) {
      this.state = initial;
      this.transitions = transitions; // { IDLE:['SPINNING'], SPINNING:['STOPPING'], ... }
      this.onChange = onChange || (() => {});
    }
    can(next) { return (this.transitions[this.state] || []).includes(next); }
    set(next) {
      if (next === this.state) return false;
      if (!this.can(next)) { console.warn(`[FSM] 非法轉換 ${this.state} → ${next}`); return false; }
      const prev = this.state; this.state = next; this.onChange(prev, next); return true;
    }
    is(s) { return this.state === s; }
    reset(s) { this.state = s; this.onChange(s, s); }
  }

  /* ---------- Web Audio（含 iOS 手勢解鎖） ---------- */
  class AudioManager {
    constructor(volume = .3) {
      this.ctx = null; this.master = null; this.volume = volume; this.defs = {}; this.unlocked = false;
      const unlock = () => {
        if (!this.ctx) {
          const AC = global.AudioContext || global.webkitAudioContext;
          if (!AC) return;
          this.ctx = new AC();
          this.master = this.ctx.createGain();
          this.master.gain.value = this.volume;
          this.master.connect(this.ctx.destination);
        }
        if (this.ctx.state === "suspended") this.ctx.resume();
        this.unlocked = true;
      };
      ["pointerdown", "touchstart", "keydown"].forEach(ev => global.addEventListener(ev, unlock));
    }
    define(name, opts) { this.defs[name] = opts; return this; }
    tone(freq, dur, type = "sine", vol = 1, slideTo = null) {
      if (!this.ctx || !this.unlocked) return;
      const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(.0002, vol), t + .01);
      g.gain.exponentialRampToValueAtTime(.0001, t + dur);
      o.connect(g).connect(this.master); o.start(t); o.stop(t + dur + .02);
    }
    play(name) {
      const d = this.defs[name]; if (!d) return;
      if (d.seq) d.seq.forEach((f, i) => setTimeout(() => this.tone(f, d.dur || .25, d.type || "triangle", d.vol || 1), i * (d.gap || 80)));
      else this.tone(d.freq, d.dur || .2, d.type || "sine", d.vol || 1, d.to || null);
    }
  }

  /* ---------- 粒子系統（物件池 + Canvas 2D） ---------- */
  class ParticleSystem {
    constructor(ctx, max = 400) {
      this.ctx = ctx;
      this.pool = new ObjectPool(max,
        () => ({ active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, r: 4, color: "#fff", gravity: 700, rot: 0, vr: 0, shape: 0 }),
        p => { p.gravity = 700; p.shape = 0; p.rot = 0; }
      );
    }
    burst(x, y, count, opts = {}) {
      const { power = 1, color = "#ffd700", colors = null, life = .8, gravity = 700, shape = 0 } = opts;
      let n = 0;
      // 注意：必須直接遍歷底層陣列；pool.forEach 只會走「已啟用」的物件
      for (const p of this.pool.items) {
        if (p.active || n >= count) continue;
        const a = shape === 0 ? (opts.angle !== undefined ? opts.angle : -Math.PI / 2) + (Math.random() - .5) * (opts.spread || 1.9) : Math.random() * Math.PI * 2;
        const sp = (120 + Math.random() * 300) * power;
        p.x = x; p.y = y; p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
        p.life = p.max = life * (.6 + Math.random() * .8);
        p.r = 2 + Math.random() * 6; p.color = colors ? colors[Math.floor(Math.random() * colors.length)] : color;
        p.active = true;
        p.gravity = gravity; p.rot = Math.random() * 6.28; p.vr = (Math.random() - .5) * 12; p.shape = shape;
        n++;
      }
    }
    update(dt) {
      this.pool.forEach(p => {
        p.vy += p.gravity * dt; p.x += p.vx * dt; p.y += p.vy * dt;
        p.rot += p.vr * dt; p.life -= dt;
        if (p.life <= 0) this.pool.release(p);
      });
    }
    draw() {
      const c = this.ctx;
      this.pool.forEach(p => {
        c.save(); c.globalAlpha = Math.min(1, p.life / (p.max * .4));
        c.translate(p.x, p.y); c.rotate(p.rot); c.fillStyle = p.color;
        c.shadowColor = p.color; c.shadowBlur = 8;
        if (p.shape === 1) c.fillRect(-p.r, -p.r, p.r * 2, p.r * 2);
        else { c.beginPath(); c.arc(0, 0, p.r, 0, 6.283); c.fill(); }
        c.restore();
      });
    }
    get count() { return this.pool.activeCount; }
    clear() { this.pool.releaseAll(); }
  }

  /* ---------- 固定步長 GameLoop ---------- */
  class GameLoop {
    constructor({ update, render, fixedDt = 1 / 60, maxDt = .1, pauseOnHidden = true } = {}) {
      this.update = update || (() => {});
      this.render = render || (() => {});
      this.fixedDt = fixedDt; this.maxDt = maxDt;
      this.acc = 0; this.last = 0; this.running = false; this.fps = 0; this._fpsT = 0; this._frames = 0;
      this._tick = this._tick.bind(this);
      if (pauseOnHidden && typeof document !== "undefined")
        document.addEventListener("visibilitychange", () => document.hidden ? this.stop() : this.start());
    }
    start() {
      if (this.running) return;
      this.running = true; this.last = performance.now(); requestAnimationFrame(this._tick);
    }
    stop() { this.running = false; }
    _tick(ts) {
      if (!this.running) return;
      requestAnimationFrame(this._tick);
      let dt = (ts - this.last) / 1000; this.last = ts;
      if (dt > this.maxDt) dt = this.maxDt; // 防止切分頁回來的「死亡螺旋」
      this.acc += dt;
      while (this.acc >= this.fixedDt) { this.update(this.fixedDt); this.acc -= this.fixedDt; }
      this.render();
      // FPS 統計
      this._frames++; this._fpsT += dt;
      if (this._fpsT >= .5) { this.fps = Math.round(this._frames / this._fpsT); this._frames = 0; this._fpsT = 0; }
    }
  }

  /* ---------- Stage：DPR + RWD ---------- */
  class Stage {
    constructor(canvas, onResize) {
      this.canvas = canvas; this.ctx = canvas.getContext("2d", { alpha: false });
      this.w = 0; this.h = 0; this.dpr = 1; this.onResize = onResize;
      this.resize = this.resize.bind(this);
      global.addEventListener("resize", this.resize); this.resize();
    }
    resize() {
      this.dpr = Math.min(global.devicePixelRatio || 1, 2); // 上限 2，避免 3x 手機填充率爆掉
      const r = this.canvas.getBoundingClientRect();
      this.w = r.width; this.h = r.height;
      this.canvas.width = Math.round(r.width * this.dpr);
      this.canvas.height = Math.round(r.height * this.dpr);
      if (this.onResize) this.onResize(this.w, this.h);
    }
    begin() { this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); return this.ctx; }
  }

  global.Engine = { Ease, ObjectPool, FSM, AudioManager, ParticleSystem, GameLoop, Stage };
})(window);
