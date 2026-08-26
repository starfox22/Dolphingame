/* ============================================================
   input.js — one normalised input surface for touch, mouse,
   keyboard and gamepad.

   Everything downstream reads exactly three things:
     move  {x, y}  intent vector, magnitude 0..1
     boost boolean
     sonar edge-triggered (consumeSonar())
   ============================================================ */

const STICK_RADIUS = 58;   // px travel for full deflection
const STICK_DEAD   = 0.14; // ignore micro-jitter from resting thumbs

export class Input {
  constructor(canvas, dom) {
    this.canvas = canvas;
    this.dom = dom;

    this.move  = { x: 0, y: 0 };
    this.boost = false;
    this._touchBoost = false;   // held via the on-screen button
    this._padBoost = false;

    this._sonarQueued = false;
    this._pauseQueued = false;
    this._anyQueued   = false;

    this.keys = new Set();
    this.hasTouch = false;       // flips true the first time a finger lands
    this.pointerAim = null;      // {x,y} in canvas px while mouse held

    this._stickId = null;
    this._stickOrigin = { x: 0, y: 0 };
    this._stickVec = { x: 0, y: 0 };

    this._bind();
  }

  /* ---------------------------------------------------------- */

  _bind() {
    const d = this.dom;

    /* ---- keyboard ---- */
    addEventListener('keydown', e => {
      // Don't fight the browser when the user is on a slider etc.
      if (e.target !== document.body && e.target.tagName === 'INPUT') return;

      const k = e.key.toLowerCase();
      if (!this.keys.has(k)) this._onKeyDown(k);
      this.keys.add(k);

      if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
      this._anyQueued = true;
    }, { passive: false });

    addEventListener('keyup', e => this.keys.delete(e.key.toLowerCase()));
    // Losing focus mid-input must not leave anything stuck down.
    addEventListener('blur', () => {
      this.keys.clear();
      this._touchBoost = false;
      this.boost = false;
      this._stickId = null;
      this._stickVec = { x: 0, y: 0 };
      this.dom.btnBoost?.classList.remove('held');
      this.dom.stickBase?.classList.remove('on');
    });

    /* ---- virtual stick: drag anywhere in the left/lower zone ---- */
    const zone = d.stickZone;
    if (zone) {
      zone.addEventListener('pointerdown', e => {
        this.hasTouch = true;
        document.body.classList.remove('desktop');
        this._stickId = e.pointerId;
        this._stickOrigin = { x: e.clientX, y: e.clientY };
        this._stickVec = { x: 0, y: 0 };
        this._placeStick(e.clientX, e.clientY, 0, 0);
        d.stickBase.classList.add('on');
        zone.setPointerCapture(e.pointerId);
        this._anyQueued = true;
        e.preventDefault();
      });

      zone.addEventListener('pointermove', e => {
        if (e.pointerId !== this._stickId) return;
        let dx = e.clientX - this._stickOrigin.x;
        let dy = e.clientY - this._stickOrigin.y;
        const len = Math.hypot(dx, dy);

        // Let the origin trail a long drag so the stick never "runs out".
        if (len > STICK_RADIUS) {
          const over = len - STICK_RADIUS;
          this._stickOrigin.x += (dx / len) * over;
          this._stickOrigin.y += (dy / len) * over;
          dx = (dx / len) * STICK_RADIUS;
          dy = (dy / len) * STICK_RADIUS;
        }
        this._stickVec = { x: dx / STICK_RADIUS, y: dy / STICK_RADIUS };
        this._placeStick(this._stickOrigin.x, this._stickOrigin.y, dx, dy);
        e.preventDefault();
      });

      const endStick = e => {
        if (e.pointerId !== this._stickId) return;
        this._stickId = null;
        this._stickVec = { x: 0, y: 0 };
        d.stickBase.classList.remove('on');
      };
      zone.addEventListener('pointerup', endStick);
      zone.addEventListener('pointercancel', endStick);
    }

    /* ---- action buttons ---- */
    this._holdButton(d.btnBoost, v => { this._touchBoost = v; });
    if (d.btnSonar) {
      d.btnSonar.addEventListener('pointerdown', e => {
        e.preventDefault();
        this.hasTouch = true;
        this._sonarQueued = true;
        this._anyQueued = true;
      });
    }

    /* ---- mouse steering on the canvas (desktop) ---- */
    this.canvas.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') return;
      this.pointerAim = this._toCanvas(e);
      this._anyQueued = true;
    });
    this.canvas.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      this._lastMouse = this._toCanvas(e);
      if (this.pointerAim) this.pointerAim = this._lastMouse;
    });
    addEventListener('pointerup', e => { if (e.pointerType !== 'touch') this.pointerAim = null; });

    this.canvas.addEventListener('contextmenu', e => e.preventDefault());

    /* Detect a real mouse so we can hide the thumb-stick UI. */
    if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
      document.body.classList.add('desktop');
    }
  }

  _holdButton(el, set) {
    if (!el) return;
    const on = e => {
      e.preventDefault();
      this.hasTouch = true;
      set(true); el.classList.add('held');
      this._anyQueued = true;
    };
    const off = e => { e.preventDefault(); set(false); el.classList.remove('held'); };
    el.addEventListener('pointerdown', on);
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('pointerleave', off);
  }

  _placeStick(ox, oy, dx, dy) {
    const b = this.dom.stickBase, k = this.dom.stickKnob;
    if (!b) return;
    b.style.left = ox + 'px';
    b.style.top  = oy + 'px';
    k.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  _toCanvas(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width  * this.canvas.width,
      y: (e.clientY - r.top)  / r.height * this.canvas.height,
    };
  }

  _onKeyDown(k) {
    if (k === ' ' || k === 'e')      this._sonarQueued = true;
    if (k === 'p' || k === 'escape') this._pauseQueued = true;
  }

  /* ---------------------------------------------------------- */

  /** Fold every source into `move` / `boost`. Call once per frame. */
  update(dolphinScreen) {
    let x = 0, y = 0;

    /* keyboard */
    const K = this.keys;
    if (K.has('a') || K.has('arrowleft'))  x -= 1;
    if (K.has('d') || K.has('arrowright')) x += 1;
    if (K.has('w') || K.has('arrowup'))    y -= 1;
    if (K.has('s') || K.has('arrowdown'))  y += 1;
    const keyActive = x !== 0 || y !== 0;
    if (keyActive) {
      const l = Math.hypot(x, y);
      x /= l; y /= l;
    }

    /* virtual stick wins over keyboard when engaged */
    const sv = this._stickVec;
    const stickLen = Math.hypot(sv.x, sv.y);
    if (stickLen > STICK_DEAD) {
      // Rescale past the dead-zone so small pushes still feel responsive.
      const m = Math.min(1, (stickLen - STICK_DEAD) / (1 - STICK_DEAD));
      x = (sv.x / stickLen) * m;
      y = (sv.y / stickLen) * m;
    } else if (!keyActive && this.pointerAim && dolphinScreen) {
      /* mouse-held steering: swim toward the cursor */
      const dx = this.pointerAim.x - dolphinScreen.x;
      const dy = this.pointerAim.y - dolphinScreen.y;
      const l = Math.hypot(dx, dy);
      if (l > 24) {
        const m = Math.min(1, l / 240);
        x = dx / l * m; y = dy / l * m;
      }
    }

    /* gamepad, if one shows up */
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
      if (Math.hypot(ax, ay) > 0.2) { x = ax; y = ay; }
      if (p.buttons[0]?.pressed || p.buttons[7]?.pressed) this._padBoost = true;
      else this._padBoost = false;
      if (p.buttons[2]?.pressed) { if (!this._padSonar) this._sonarQueued = true; this._padSonar = true; }
      else this._padSonar = false;
      break;
    }

    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    this.move.x = x; this.move.y = y;

    // Recomputed from scratch each frame: a latched flag would stick on
    // if a key-up or pointer-up were ever missed (alt-tab, gesture cancel).
    this.boost = this._touchBoost || K.has('shift') || this._padBoost;
    return this.move;
  }

  consumeSonar() { const v = this._sonarQueued; this._sonarQueued = false; return v; }
  consumePause() { const v = this._pauseQueued; this._pauseQueued = false; return v; }
  consumeAny()   { const v = this._anyQueued;   this._anyQueued   = false; return v; }
  isDown(k)      { return this.keys.has(k); }
}
