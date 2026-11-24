# Viscosity Playground

A real-time, GPU-accelerated 3D liquid physics sandbox for the browser. Three braided
streams pour onto a platform on a twisted pillar. Turn the viscosity from water to
molten glass and watch the result change: splashes and colour mixing at the low end,
domes and tori in the middle, rope coiling and stacked towers at the top.

The liquid is a live particle simulation. Nothing is prerecorded or animated with CSS.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production build in dist/
npm run preview    # serve the production build
```

The build is fully static (`base: './'`), so `dist/` can be hosted anywhere, including
GitHub Pages. It does not need `SharedArrayBuffer` or any special server headers.

**Requirements:** a WebGL 2 browser with `EXT_color_buffer_float`. That covers current
Chrome, Edge, Firefox and Safari, desktop and mobile. `EXT_float_blend` is used when it
is available; without it, the grid falls back to half-float accumulation.

## What's inside

### Fluid solver (`src/engine/sim`)

The solver is **MLS-MPM** (Moving Least Squares Material Point Method), written entirely
in WebGL 2 shaders. Each sub-step runs these passes:

1. **prep**: per particle, computes stress and the APIC affine matrix.
2. **P2G scatter**: every particle draws 27 one-pixel points into a 3D grid packed as a
   2D atlas. Additive float blending accumulates momentum, mass, volume and pigment.
3. **grid update**: gravity, force fields (stir, whirlpool, attract, repel), solid
   boundaries from signed distance functions with Coulomb friction and moving or rotating
   colliders, and two-way coupled rigid bodies.
4. **G2P (two passes)**: velocity and affine gather, volume fraction, advection,
   adhesion, collision projection, viscoelastic memory, plasticity, temperature and
   colour mixing.

The physical model per particle:

| Effect | Model | Notes |
| --- | --- | --- |
| Pressure | Weakly-compressible Tait EOS on grid volume fraction | "Liquid pressure" sets the speed of sound |
| Viscosity (low–mid) | Exact exponential decay of the strain-rate tensor | Unconditionally stable; rotation preserved |
| Viscosity (high) | Upper-Convected Maxwell element, ν = G·λ/ρ | Stable at any viscosity; gives rope coiling and slow sag |
| Elasticity | Neo-Hookean stress on an isochoric left Cauchy–Green tensor | Jelly, slime |
| Plasticity | Von Mises-style yield on the elastic strain | Toothpaste |
| Surface tension | Tensile pressure floor at the free surface | *approximation* |
| Adhesion | Relative-velocity damping near solids | *approximation* |
| Temperature | Arrhenius-style viscosity, freezing and boiling, Newtonian cooling | *approximation* |
| Colour mixing | Pigment-like (log-absorbance) diffusion through the grid | *approximation* |

The UI labels every simplified model as **approx**.

Particle slots are recycled. A periodic async readback (`PIXEL_PACK_BUFFER` + fence)
finds dead particles, and the same readback drives statistics and game scoring.

### Rendering (`src/engine/render`)

The liquid is drawn with **screen-space fluid rendering**:

- sphere-impostor depth and colour (MRT)
- additive thickness
- bilateral depth smoothing, plus a blurred coverage mask for soft, anti-aliased
  silhouettes
- a composite pass with Fresnel environment reflections from a cube map, refraction of
  the scene behind the liquid, Beer–Lambert absorption, a GGX-ish key light plus rim
  highlights, temperature-driven glow, height fog, and liquid shadows (the particles are
  rendered into the key light's shadow map)

Bloom and ACES tone mapping finish the image.

### App

The UI is React and TypeScript, with zustand for state. Three.js handles the scene and
cannon-es handles rigid bodies.

- **12 material presets**: Water, Honey, Lava, Slime, Melted Chocolate, Paint, Liquid
  Metal, Molten Glass, Toothpaste, Jelly, Rainbow and Custom. Each has its own physics
  and appearance.
- **Tools**: stir, whirlpool, attract, repel, pour-at-cursor, freeze, melt/heat, dye,
  erase, select/move (gizmo) and camera.
- **Objects**: balls and cubes (two-way coupled, with floaty, neutral or heavy density),
  plus ramps, funnels, glass containers and blocks.
- **Game modes**: Free Sandbox, Tower Challenge, Color Mixing, Fill the Container, Chaos,
  Relaxation and Zero Gravity.
- **Extras**: experiments saved to local storage with thumbnails, share links (the scene
  is deflate-compressed into the URL hash), PNG screenshots, WebM/MP4 recording
  (`MediaRecorder`, including sound), educational tooltips, a physics stats panel, a
  random experiment generator and procedural Web Audio sound effects.
- **Adaptive quality**: four tiers (grid 48³ → 96³, 24k → 196k particles), GPU
  detection, an automatic downgrade during the first seconds, and continuous
  render-resolution scaling to hold 60 FPS.

## Controls

| Input | Action |
| --- | --- |
| Left drag / one finger | Use the active tool |
| Right drag / two fingers | Orbit · wheel or pinch to zoom |
| `Space` | Pause (or hold to pour in game modes) |
| `1`–`9`, `0`, `O` | Tools |
| `C` / `X` / `F` / `H` / `P` | Clear / random experiment / cinematic / hide UI / screenshot |
| `R` | Gizmo move ↔ rotate |
| `[` `]` | Brush size |

Click the big **VISCOSITY** readout to step through the reference sequence:
0 → 1 → 20 → 40 → 80 → 99 %.

## Development notes

`dev/simtest.html` is a stripped-down harness for the solver alone. It has debug sprites
and lets you step frames and read back statistics, which is useful for tuning the
physics:

```bash
npx vite --config dev/vite.dev.config.ts   # then open /dev/simtest.html?v=0.99
```
