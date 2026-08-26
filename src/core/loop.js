/* ============================================================
   loop.js — fixed-timestep simulation with a decoupled render.

   Physics runs at a constant 120 Hz so the swim model behaves
   identically on a 60 Hz phone and a 144 Hz monitor. Rendering
   happens once per animation frame with an interpolation alpha.
   ============================================================ */

const STEP = 1 / 120;
const MAX_FRAME = 0.25;   // never simulate more than a quarter second of catch-up

export class Loop {
  constructor({ update, render }) {
    this.update = update;
    this.render = render;
    this.running = false;
    this.acc = 0;
    this.last = 0;
    this.time = 0;
    this.frame = 0;

    this.fps = 60;
    this._fpsAcc = 0;
    this._fpsFrames = 0;

    this._tick = this._tick.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  _tick(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._tick);

    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > MAX_FRAME) dt = MAX_FRAME;   // tab was backgrounded — don't fast-forward

    this._fpsAcc += dt; this._fpsFrames++;
    if (this._fpsAcc >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAcc;
      this._fpsAcc = 0; this._fpsFrames = 0;
    }

    this.acc += dt;
    let steps = 0;
    while (this.acc >= STEP && steps < 8) {
      this.update(STEP, this.time);
      this.time += STEP;
      this.acc -= STEP;
      steps++;
    }
    if (steps === 8) this.acc = 0;   // gave up catching up; drop the backlog

    this.frame++;
    this.render(dt, this.acc / STEP);
  }
}

export { STEP };
