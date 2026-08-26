# 🐬 ABYSSAL — Ocean Guardian

A mobile-first dolphin game in the spirit of *Ecco the Dolphin*, rebuilt with modern
rendering and a fully generative soundtrack. Dive, sweep plastic off the seabed, cut
trapped animals free, and watch a sick ocean visibly come back to life.

**Zero binary assets.** Every wave, coral, caustic, bubble, pad chord and splash in
this repo is generated in code at runtime. The whole game is HTML, CSS and JavaScript —
no engine, no build step, no downloads.

```
open index.html through any static server — that's the entire install
```

---

## Play

| | |
|---|---|
| **Goal** | Collect ocean trash. More trash, more points. Free trapped animals for big bonuses. |
| **Tension** | Dolphins breathe air. The meter drains while you're under — surface before it empties. |
| **Fail state** | Running out of breath. Nothing else can end a run. |

### Controls

**Touch (phone/tablet)**
- **Drag anywhere on the left half** — a virtual stick appears under your thumb and
  follows it, so long drags never run out of travel
- **⚡** — boost (hold)
- **📡** — echolocate
- Boost straight up to **breach** the surface

**Keyboard + mouse (desktop)**
- **WASD** / **arrow keys** — swim
- **Shift** — boost · **Space** — sonar
- **Hold the mouse** — swim toward the cursor
- **P** / **Esc** — pause · **M** — mute

A gamepad works too if one is connected.

---

## What's in it

### The swim model
Underwater the dolphin is treated as a hydrofoil. Velocity is decomposed into a
component along the body (low drag — it slips) and one across it (high drag — the flank
resists sideslip). That single asymmetry is what turns steering into arcs that scrub
speed honestly, instead of the frictionless drifting you get from isotropic drag.

Thrust is **pulsed by the tail beat** rather than applied continuously, so acceleration
surges the way a real fluke stroke does, and turning radius widens with speed because a
fast body genuinely cannot pivot.

Above the waterline the dolphin becomes a ballistic body with almost no drag, nose
tracking its own trajectory. Push hard on the stick mid-air and it spins instead —
land a full rotation for a **SPIN** bonus, and stack them for quadratic scoring.

### The body
No sprites. A spine is generated analytically every frame: walk backward from the nose
accumulating heading, bending by a travelling undulation wave (small at the head,
large at the fluke) plus the current turn rate, so the body banks into corners. A
radius profile is then swept along that spine to build the silhouette — with a
deliberately thin beak and an abrupt melon, because that step is the one cue that
separates *dolphin* from *generic fish*.

### The look
A layered Canvas2D pipeline:

1. Depth-graded water column with drifting thermocline bands
2. Volumetric god rays that drift, breathe and attenuate with depth
3. World, entities and particles
4. Animated caustics, clipped to the waterline and faded out with depth
5. The surface — a rippling bright ceiling from below, wave crests from above
6. **Bloom** — emissive objects draw a second time into a quarter-resolution buffer
   which is blurred and added back
7. Grade — depth desaturation, transient tints, vignette, and water clinging to the
   lens after a breach

Plus **Snell's window**: look up from underwater and the sky is compressed, dimmed and
tinted by the column above you, so the surface reads as a boundary rather than a hole.

### The sound
There are no audio files. `src/core/audio.js` builds the entire mix from oscillators,
generated noise buffers and filters:

- **Music** — a generative ambient bed on a slow chord loop, everything snapped to a
  D minor pentatonic scale so nothing can land wrong. Detuned pads, inharmonic bells,
  sub bass, and a distant whale every few bars.
- **Reverb** — a convolver fed a procedurally generated impulse response (exponentially
  decaying, lowpassed noise; big water spaces are dark).
- **SFX** — collect chimes that climb the scale with your combo, sonar chirps with
  echoes, splashes built from filtered noise plus a low thump for weight.
- **The underwater filter** — a master lowpass parked around 700 Hz while submerged
  that sweeps wide open the instant you break the surface, and closes again as you
  re-enter. It is the single cheapest thing in the project and does the most for
  immersion.

### The healing
Ocean health rises as you clean. It isn't a number in a corner — it's the art
direction. Bleached coral saturates, algae creeps back onto rocks, encrusting life
reclaims the shipwreck, fish schools regain their colour, suspended filth thins out of
the water, and the sludge plumes pouring from the outfall pipes dry up entirely.

---

## Running it

The game uses ES modules, so it needs to be served over HTTP rather than opened
straight off the filesystem.

```bash
npm start                 # python3 -m http.server 8080
# or
python3 -m http.server 8080
```

Then open <http://localhost:8080>.

To play it on your phone on the same network, serve it and browse to your machine's
LAN address — or push to a branch and let the included GitHub Pages workflow host it.

### Graphics quality

Quality is auto-detected from device memory, core count and pixel count, and can be
overridden in the pause menu. **Low** drops the internal resolution scale, disables
bloom, and thins particles and god rays — enough to hold a smooth frame on older
phones.

---

## Layout

```
index.html               shell, HUD markup, overlays
src/
  styles.css             all UI chrome; safe-area aware, responsive
  main.js                bootstrap, screen flow, settings, persistence
  game.js                state machine, scoring, draw order
  core/
    math.js              vectors, easing, value noise, colour ramps
    rng.js               seeded mulberry32 — deterministic worlds
    input.js             touch / mouse / keyboard / gamepad → one intent vector
    audio.js             the entire soundtrack, synthesised
    loop.js              fixed 120 Hz simulation, decoupled render
  render/
    renderer.js          the layered pipeline described above
    camera.js            follow rig: look-ahead, speed zoom, trauma shake
  world/
    world.js             terrain, biomes, flora, the healing state
  entities/
    dolphin.js           physics and procedural animation
    trash.js             collectibles and trapped animals
    wildlife.js          schools, jellyfish, rays, crabs, the whale
  systems/
    particles.js         one pooled system for every small moving thing
  ui/
    hud.js               guarded DOM writes
```

---

## Notes

- Progress, settings and your personal best are kept in `localStorage`, and the game
  degrades gracefully if storage is unavailable (private browsing).
- Everything is deterministic given a seed — worlds are reproducible, which makes
  visual regressions debuggable.
- Respects `prefers-reduced-motion` for UI animation.
- The simulation runs at a fixed 120 Hz regardless of display refresh, so the swim
  model behaves identically on a 60 Hz phone and a 144 Hz monitor.
