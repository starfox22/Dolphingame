/* ============================================================
   audio.js — the whole soundtrack, synthesised at runtime.

   There are no audio files in this project. Every pad, bell,
   bubble and splash below is built out of oscillators, noise
   buffers and filters, which keeps the download at zero bytes
   and lets the mix react continuously to gameplay.

   Signal flow:

     musicBus ─┐                        ┌─► dry ─┐
     sfxBus  ──┼─► submix ──► wetSend ──┴─► verb ─┴─► waterFilter
                                                        └─► limiter ─► out

   `waterFilter` is the trick that sells the immersion: a lowpass
   that sits at ~700 Hz while submerged and sweeps wide open the
   instant the dolphin breaks the surface.
   ============================================================ */

import { clamp, clamp01, lerp } from './math.js';

/* D minor pentatonic across four octaves — every melodic event in
   the game snaps to this, so nothing can ever sound wrong. */
const SCALE = [0, 3, 5, 7, 10];
const ROOT = 146.83; // D3

function noteHz(degree, octave = 0) {
  const semis = SCALE[((degree % SCALE.length) + SCALE.length) % SCALE.length];
  const oct = octave + Math.floor(degree / SCALE.length);
  return ROOT * Math.pow(2, (semis + oct * 12) / 12);
}

/* Slow harmonic bed. Each entry is a set of scale degrees held for
   `bars` bars. Deliberately unhurried — this is a calm game. */
const PROGRESSION = [
  { degrees: [0, 2, 4, 6],  bars: 2 },   // Dm9-ish
  { degrees: [-1, 1, 3, 5], bars: 2 },   // Cadd9-ish
  { degrees: [-3, -1, 1, 3], bars: 2 },  // Bb maj7-ish
  { degrees: [-2, 0, 2, 4], bars: 2 },   // F maj9-ish
];

const BPM = 62;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;

export class AudioEngine {
  constructor() {
    this.ready = false;
    this.enabled = true;
    this.musicVol = 0.65;
    this.sfxVol = 0.85;

    this._submerged = 1;      // 0 = fully above water, 1 = underwater
    this._targetSub = 1;
    this._intensity = 0;      // 0 calm .. 1 urgent, drives filter + layers
    this._targetInt = 0;

    this._schedTimer = null;
    this._nextNoteTime = 0;
    this._step = 0;
  }

  /* ---------------------------------------------------------- */
  /* Setup                                                       */
  /* ---------------------------------------------------------- */

  init() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return null; }

    const ctx = this.ctx = new AC({ latencyHint: 'interactive' });

    // --- master chain -------------------------------------------------
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 12;
    this.limiter.ratio.value = 6;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.22;

    this.master = ctx.createGain();
    this.master.gain.value = 0;   // faded in once the first sound plays

    this.waterFilter = ctx.createBiquadFilter();
    this.waterFilter.type = 'lowpass';
    this.waterFilter.frequency.value = 700;
    this.waterFilter.Q.value = 0.9;

    // Muffling underwater also means losing air; a gentle low shelf
    // boost keeps it warm rather than just dull.
    this.waterShelf = ctx.createBiquadFilter();
    this.waterShelf.type = 'lowshelf';
    this.waterShelf.frequency.value = 220;
    this.waterShelf.gain.value = 4;

    this.waterFilter.connect(this.waterShelf);
    this.waterShelf.connect(this.limiter);
    this.limiter.connect(this.master);
    this.master.connect(ctx.destination);

    // --- reverb -------------------------------------------------------
    this.verb = ctx.createConvolver();
    this.verb.buffer = this._makeIR(3.6, 2.4);
    this.verbGain = ctx.createGain();
    this.verbGain.gain.value = 0.9;
    this.verb.connect(this.verbGain);
    this.verbGain.connect(this.waterFilter);

    this.wetSend = ctx.createGain();
    this.wetSend.gain.value = 0.34;
    this.wetSend.connect(this.verb);

    this.dry = ctx.createGain();
    this.dry.connect(this.waterFilter);

    // --- buses --------------------------------------------------------
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicVol;
    this.musicBus.connect(this.dry);
    this.musicBus.connect(this.wetSend);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.sfxVol;
    this.sfxBus.connect(this.dry);

    // SFX get their own, shorter send so pings stay crisp.
    this.sfxWet = ctx.createGain();
    this.sfxWet.gain.value = 0.28;
    this.sfxBus.connect(this.sfxWet);
    this.sfxWet.connect(this.verb);

    // --- shared noise buffer (used by splashes, boost, bubbles) -------
    this.noiseBuf = this._makeNoise(2.0);

    // --- always-on ocean ambience ------------------------------------
    this._startAmbience();

    this.ready = true;
    return ctx;
  }

  /** Browsers hold the context suspended until a gesture. */
  resume() {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(this.enabled ? 1 : 0, t, 0.4);
  }

  suspend() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(0, t, 0.25);
  }

  setEnabled(on) {
    this.enabled = on;
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.15);
  }

  setMusicVolume(v) {
    this.musicVol = clamp01(v);
    if (this.musicBus) this.musicBus.gain.setTargetAtTime(this.musicVol, this.ctx.currentTime, 0.1);
  }
  setSfxVolume(v) {
    this.sfxVol = clamp01(v);
    if (this.sfxBus) this.sfxBus.gain.setTargetAtTime(this.sfxVol, this.ctx.currentTime, 0.1);
  }

  /* ---------------------------------------------------------- */
  /* Buffer factories                                            */
  /* ---------------------------------------------------------- */

  /** Exponentially decaying stereo noise = a serviceable cathedral. */
  _makeIR(seconds, decay) {
    const ctx = this.ctx;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const env = Math.pow(1 - t, decay);
        // A touch of lowpass on the tail: big water spaces are dark.
        lp += ((Math.random() * 2 - 1) - lp) * 0.35;
        data[i] = lp * env;
      }
      // Soften the very front so the reverb blooms instead of clicking.
      const pre = Math.floor(rate * 0.02);
      for (let i = 0; i < pre; i++) data[i] *= i / pre;
    }
    return buf;
  }

  _makeNoise(seconds) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /* ---------------------------------------------------------- */
  /* Continuous ambience                                         */
  /* ---------------------------------------------------------- */

  _startAmbience() {
    const ctx = this.ctx;

    // Broadband "water body" — noise squeezed into a moving band.
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 420;
    bp.Q.value = 0.55;

    const amb = ctx.createGain();
    amb.gain.value = 0.05;

    // Two slow LFOs on the band keep it from ever sounding static.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 190;
    lfo.connect(lfoAmt); lfoAmt.connect(bp.frequency);

    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.13;
    const lfo2Amt = ctx.createGain();
    lfo2Amt.gain.value = 0.018;
    lfo2.connect(lfo2Amt); lfo2Amt.connect(amb.gain);

    src.connect(bp); bp.connect(amb);
    amb.connect(this.dry); amb.connect(this.wetSend);
    src.start(); lfo.start(); lfo2.start();
    this._ambGain = amb;

    // Deep ocean rumble, felt more than heard.
    const rum = ctx.createOscillator();
    rum.type = 'sine';
    rum.frequency.value = 34;
    const rumG = ctx.createGain();
    rumG.gain.value = 0.055;
    const rumLfo = ctx.createOscillator();
    rumLfo.frequency.value = 0.07;
    const rumLfoAmt = ctx.createGain();
    rumLfoAmt.gain.value = 0.03;
    rumLfo.connect(rumLfoAmt); rumLfoAmt.connect(rumG.gain);
    rum.connect(rumG); rumG.connect(this.dry);
    rum.start(); rumLfo.start();
    this._rumbleGain = rumG;

    // Surface wash — only audible when the dolphin is out of the water.
    const surf = ctx.createBufferSource();
    surf.buffer = this.noiseBuf;
    surf.loop = true;
    const surfHp = ctx.createBiquadFilter();
    surfHp.type = 'highpass';
    surfHp.frequency.value = 900;
    const surfG = ctx.createGain();
    surfG.gain.value = 0;
    const surfLfo = ctx.createOscillator();
    surfLfo.frequency.value = 0.19;
    const surfLfoAmt = ctx.createGain();
    surfLfoAmt.gain.value = 0.5;
    surfLfo.connect(surfLfoAmt);
    surf.connect(surfHp); surfHp.connect(surfG);
    surfG.connect(this.limiter);   // bypasses the water filter by design
    surf.start(); surfLfo.start();
    this._surfGain = surfG;
    this._surfLfoAmt = surfLfoAmt;
  }

  /* ---------------------------------------------------------- */
  /* Generative music                                            */
  /* ---------------------------------------------------------- */

  startMusic() {
    if (!this.ctx || this._schedTimer) return;
    this._nextNoteTime = this.ctx.currentTime + 0.15;
    this._step = 0;
    this._schedTimer = setInterval(() => this._schedule(), 25);
  }

  stopMusic() {
    if (this._schedTimer) { clearInterval(this._schedTimer); this._schedTimer = null; }
  }

  /** Look-ahead scheduler: queue everything due in the next 150 ms. */
  _schedule() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const horizon = this.ctx.currentTime + 0.15;
    while (this._nextNoteTime < horizon) {
      this._emitStep(this._step, this._nextNoteTime);
      this._nextNoteTime += BEAT / 2;   // eighth-note grid
      this._step++;
    }
  }

  _emitStep(step, when) {
    const eighthsPerBar = 8;
    const bar = Math.floor(step / eighthsPerBar);
    const inBar = step % eighthsPerBar;

    // Where are we in the chord loop?
    let acc = 0, chord = PROGRESSION[0];
    const total = PROGRESSION.reduce((s, c) => s + c.bars, 0);
    const barInLoop = bar % total;
    for (const c of PROGRESSION) {
      if (barInLoop < acc + c.bars) { chord = c; break; }
      acc += c.bars;
    }
    const chordStart = (barInLoop === acc) && inBar === 0;

    const intensity = this._intensity;

    /* --- pad: re-voiced at the top of each chord --- */
    if (chordStart) {
      const dur = chord.bars * BAR;
      for (const deg of chord.degrees) {
        this._pad(noteHz(deg, 0), when, dur * 1.15, 0.085);
      }
      this._sub(noteHz(chord.degrees[0], -2), when, dur * 1.1);
    }

    /* --- bells: sparse, more frequent as intensity climbs --- */
    const bellChance = 0.10 + intensity * 0.2;
    if ((inBar === 0 || inBar === 3 || inBar === 6) && Math.random() < bellChance + 0.16) {
      const deg = chord.degrees[(Math.random() * chord.degrees.length) | 0] + (Math.random() < 0.4 ? 5 : 10);
      this._bell(noteHz(deg, 0), when, 0.05 + Math.random() * 0.03);
    }

    /* --- shimmer: high, airy, only in calmer moments --- */
    if (inBar === 4 && Math.random() < 0.3 * (1 - intensity * 0.5)) {
      const deg = chord.degrees[(Math.random() * chord.degrees.length) | 0] + 15;
      this._bell(noteHz(deg, 0), when + BEAT * 0.25, 0.022, 'sine', 3.2);
    }

    /* --- heartbeat pulse: an urgency layer that fades in with danger --- */
    if (intensity > 0.35 && inBar % 4 === 0) {
      this._pulse(when, 0.05 * intensity);
    }

    /* --- distant whale, every eight bars or so --- */
    if (inBar === 0 && bar % 8 === 5 && Math.random() < 0.6) {
      this._whale(when + Math.random() * BAR);
    }
  }

  _pad(freq, when, dur, gain) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);

    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(360, when);
    f.frequency.linearRampToValueAtTime(900, when + dur * 0.4);
    f.frequency.linearRampToValueAtTime(340, when + dur);
    f.Q.value = 1.2;

    // Three slightly detuned voices give the pad its width.
    for (const det of [-6, 0, 7]) {
      const o = ctx.createOscillator();
      o.type = det === 0 ? 'triangle' : 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = det;
      const vg = ctx.createGain();
      vg.gain.value = det === 0 ? 0.6 : 0.26;
      o.connect(vg); vg.connect(f);
      o.start(when); o.stop(when + dur + 0.1);
    }
    f.connect(g);
    g.connect(this.musicBus);
  }

  _sub(freq, when, dur) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.13, when + 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g); g.connect(this.musicBus);
    o.start(when); o.stop(when + dur + 0.1);
  }

  _bell(freq, when, gain, type = 'triangle', decay = 2.2) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;

    // A quiet inharmonic partial is what makes it read as "bell"
    // rather than "beep".
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = freq * 2.76;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + decay);

    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.0001, when);
    g2.gain.exponentialRampToValueAtTime(gain * 0.3, when + 0.008);
    g2.gain.exponentialRampToValueAtTime(0.0001, when + decay * 0.45);

    o.connect(g); o2.connect(g2);
    g.connect(this.musicBus); g2.connect(this.musicBus);
    o.start(when); o.stop(when + decay + 0.1);
    o2.start(when); o2.stop(when + decay * 0.5 + 0.1);
  }

  _pulse(when, gain) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(70, when);
    o.frequency.exponentialRampToValueAtTime(42, when + 0.22);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.4);
    o.connect(g); g.connect(this.musicBus);
    o.start(when); o.stop(when + 0.45);
  }

  _whale(when) {
    const ctx = this.ctx;
    const base = 110 + Math.random() * 90;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(base, when);
    o.frequency.linearRampToValueAtTime(base * 1.6, when + 0.9);
    o.frequency.linearRampToValueAtTime(base * 0.75, when + 2.6);

    // Vibrato — the wobble that makes it sound alive.
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vibAmt = ctx.createGain();
    vibAmt.gain.value = 5;
    vib.connect(vibAmt); vibAmt.connect(o.frequency);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.055, when + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 3.0);

    o.connect(g); g.connect(this.musicBus); g.connect(this.wetSend);
    o.start(when); o.stop(when + 3.1);
    vib.start(when); vib.stop(when + 3.1);
  }

  /* ---------------------------------------------------------- */
  /* Sound effects                                               */
  /* ---------------------------------------------------------- */

  _now() { return this.ctx.currentTime; }

  /** Collect chime — climbs the pentatonic ladder with the combo. */
  collect(comboIndex = 0, big = false) {
    if (!this._ok()) return;
    const t = this._now();
    const deg = 5 + Math.min(comboIndex, 12);
    const f = noteHz(deg, big ? 1 : 0);
    this._bell(f, t, big ? 0.19 : 0.13, 'triangle', big ? 1.6 : 1.0);
    if (big) this._bell(f * 1.5, t + 0.06, 0.09, 'sine', 1.3);

    // A tiny water "plip" underneath sells the physicality.
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(700, t);
    o.frequency.exponentialRampToValueAtTime(1900, t + 0.05);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g); g.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.1);
  }

  /** Rescue fanfare — a warm major triad blooming upward. */
  rescue() {
    if (!this._ok()) return;
    const t = this._now();
    [0, 2, 4, 7].forEach((d, i) => {
      this._bellSfx(noteHz(d + 5, 0), t + i * 0.075, 0.15, 2.6);
    });
    // Rising swell underneath.
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(noteHz(0, -1), t);
    o.frequency.exponentialRampToValueAtTime(noteHz(5, 0), t + 0.9);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.10, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    o.connect(g); g.connect(this.sfxBus); g.connect(this.sfxWet);
    o.start(t); o.stop(t + 1.6);
  }

  _bellSfx(freq, when, gain, decay) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle'; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    o.connect(g); g.connect(this.sfxBus);
    o.start(when); o.stop(when + decay + 0.05);
  }

  /** Echolocation: a click, a downward chirp, then two echoes. */
  sonar() {
    if (!this._ok()) return;
    const t = this._now();
    for (let e = 0; e < 3; e++) {
      const when = t + e * 0.26;
      const amp = 0.16 * Math.pow(0.45, e);
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(2400, when);
      o.frequency.exponentialRampToValueAtTime(620, when + 0.16);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(amp, when + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.2);
      o.connect(g); g.connect(this.sfxBus); g.connect(this.sfxWet);
      o.start(when); o.stop(when + 0.22);
    }
  }

  /** Water entry / exit. `out` = leaving the water. */
  splash(power = 1, out = false) {
    if (!this._ok()) return;
    const t = this._now();
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.5;

    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 0.7;
    if (out) {
      f.frequency.setValueAtTime(400, t);
      f.frequency.exponentialRampToValueAtTime(3400, t + 0.22);
    } else {
      f.frequency.setValueAtTime(2600, t);
      f.frequency.exponentialRampToValueAtTime(320, t + 0.35);
    }

    const g = this.ctx.createGain();
    const amp = clamp(0.10 + power * 0.24, 0.05, 0.4);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + 0.014);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5 + power * 0.25);

    src.connect(f); f.connect(g);
    g.connect(this.sfxBus); g.connect(this.sfxWet);
    src.start(t, Math.random()); src.stop(t + 0.9 + power * 0.3);

    // Low thump on entry gives the splash weight.
    if (!out) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(190, t);
      o.frequency.exponentialRampToValueAtTime(55, t + 0.3);
      const og = this.ctx.createGain();
      og.gain.setValueAtTime(amp * 0.8, t);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(og); og.connect(this.sfxBus);
      o.start(t); o.stop(t + 0.4);
    }
  }

  /** Continuous-ish boost whoosh, retriggered while held. */
  boost() {
    if (!this._ok()) return;
    const t = this._now();
    if (this._lastBoost && t - this._lastBoost < 0.28) return;
    this._lastBoost = t;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2.2;
    f.frequency.setValueAtTime(280, t);
    f.frequency.exponentialRampToValueAtTime(1500, t + 0.3);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.11, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    src.connect(f); f.connect(g); g.connect(this.sfxBus);
    src.start(t, Math.random()); src.stop(t + 0.5);
  }

  bubble() {
    if (!this._ok()) return;
    const t = this._now() + Math.random() * 0.05;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    const f0 = 380 + Math.random() * 700;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 2.4, t + 0.055);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    o.connect(g); g.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.1);
  }

  /** Low-air warning tick. */
  warn(urgency = 0) {
    if (!this._ok()) return;
    const t = this._now();
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150 + urgency * 90, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.18);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.10 + urgency * 0.06, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g); g.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.32);
  }

  /** Bumping a hazard. */
  hurt() {
    if (!this._ok()) return;
    const t = this._now();
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(1400, t);
    f.frequency.exponentialRampToValueAtTime(180, t + 0.3);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.2, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    src.connect(f); f.connect(g); g.connect(this.sfxBus);
    src.start(t, Math.random()); src.stop(t + 0.4);

    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.25);
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.1, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(og); og.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.32);
  }

  /** UI feedback. */
  ui(kind = 'tap') {
    if (!this._ok()) return;
    const t = this._now();
    const f = kind === 'back' ? 420 : 880;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * (kind === 'back' ? 0.7 : 1.35), t + 0.06);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(g); g.connect(this.sfxBus);
    o.start(t); o.stop(t + 0.16);
  }

  /** Zone-transition sting. */
  zone() {
    if (!this._ok()) return;
    const t = this._now();
    [0, 4, 7].forEach((d, i) => this._bellSfx(noteHz(d, 0), t + i * 0.12, 0.1, 3.0));
  }

  _ok() { return this.enabled && this.ctx && this.ctx.state === 'running'; }

  /* ---------------------------------------------------------- */
  /* Per-frame mix updates                                       */
  /* ---------------------------------------------------------- */

  /**
   * @param submerged  0 = airborne, 1 = underwater (fade through the surface)
   * @param depth01    0 at surface, 1 at the abyss — darkens the ambience
   * @param intensity  0 calm .. 1 urgent — thickens the music
   */
  setEnvironment(submerged, depth01, intensity) {
    this._targetSub = clamp01(submerged);
    this._targetInt = clamp01(intensity);
    this._depth = clamp01(depth01);
  }

  update(dt) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;

    // Smooth the wet/dry transition so breaching sweeps rather than snaps.
    const k = 1 - Math.pow(0.001, dt);
    this._submerged += (this._targetSub - this._submerged) * k * 2.2;
    this._intensity += (this._targetInt - this._intensity) * k * 0.9;

    const sub = this._submerged;
    const depth = this._depth || 0;

    // Underwater: heavily filtered. Above: wide open, bright.
    const cutoff = lerp(19000, lerp(900, 420, depth), sub);
    this.waterFilter.frequency.setTargetAtTime(cutoff, t, 0.05);
    this.waterShelf.gain.setTargetAtTime(lerp(0, 5.5, sub), t, 0.1);

    // Reverb grows with depth — caverns and open trenches.
    this.verbGain.gain.setTargetAtTime(lerp(0.45, 1.15, depth) * lerp(0.5, 1, sub), t, 0.3);

    // Ambient beds crossfade around the waterline.
    if (this._ambGain)    this._ambGain.gain.setTargetAtTime(lerp(0.012, 0.05 + depth * 0.03, sub), t, 0.25);
    if (this._rumbleGain) this._rumbleGain.gain.setTargetAtTime(lerp(0.01, 0.045 + depth * 0.08, sub), t, 0.4);
    if (this._surfGain)   this._surfGain.gain.setTargetAtTime(lerp(0.05, 0.004, sub), t, 0.2);
  }
}

export const audio = new AudioEngine();
