import * as THREE from 'three';
import { MATERIALS, cloneMaterial } from '../state/materials';
import { defaultEmitter, defaultWorld, uid, useStore, type AppState, type ModeHud } from '../state/store';
import type { Engine, ReadbackData } from './Engine';
import { OBSTACLE_DEFS, PLATFORM_TOP } from './SceneLayout';
import { DOMAIN_ORIGIN } from './sim/MPMSolver';
import type { Emitter, GameMode, MaterialId, ObstacleSpec } from './types';

export interface ModeController {
  enter(): void;
  update(simDt: number, realDt: number, s: AppState): void;
  onReadback?(d: ReadbackData): void;
  action?(id: string): void;
  exit(): void;
}

const setHud = (hud: ModeHud | null) => useStore.setState({ hud });
const cm = (m: number) => `${(m * 100).toFixed(1)} cm`;

function readBest(key: string): number {
  try {
    return Number(localStorage.getItem(`vp.best.${key}`) ?? 0) || 0;
  } catch {
    return 0;
  }
}
function writeBest(key: string, v: number) {
  try {
    localStorage.setItem(`vp.best.${key}`, String(v));
  } catch {
    /* storage unavailable */
  }
}

function ring(radius: number, color: string, opacity = 0.7) {
  const m = new THREE.Mesh(
    new THREE.TorusGeometry(radius, 0.0025, 8, 96),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false }),
  );
  m.rotation.x = Math.PI / 2;
  return m;
}

/** Shared helper: iterate live particles in world space. */
function forEachParticle(d: ReadbackData, fn: (x: number, y: number, z: number, speed: number, i: number) => void) {
  const { pos, dx, count } = d;
  for (let i = 0; i < count; i++) {
    const sp = pos[i * 4 + 3];
    if (sp < 0) continue;
    fn(pos[i * 4] * dx + DOMAIN_ORIGIN.x, pos[i * 4 + 1] * dx, pos[i * 4 + 2] * dx + DOMAIN_ORIGIN.z, sp * dx, i);
  }
}

function resetScene(p: Partial<AppState>) {
  const s = useStore.getState();
  useStore.setState({
    obstacles: [],
    bodies: [],
    world: defaultWorld(),
    selection: null,
    paused: false,
    uiHidden: false,
    pouring: false,
    valves: {},
    hud: null,
    revision: s.revision + 1,
    ...p,
  });
}

// ---------------------------------------------------------------- sandbox
class SandboxMode implements ModeController {
  constructor(private engine: Engine) {}
  enter() {
    const s = useStore.getState();
    // Only rebuild the default stage if we come from a game mode (keeps shared/loaded scenes intact)
    if (s.hud || s.world.gravityMode !== 'normal' || s.world.walls || s.environment === 'space') {
      const e = defaultEmitter();
      resetScene({ emitters: [e], selectedEmitterId: e.id, environment: 'amethyst', tool: 'stir' });
      this.engine.frameCamera(true);
    }
    setHud(null);
  }
  update() {}
  exit() {}
}

// ---------------------------------------------------------------- tower
class TowerMode implements ModeController {
  private tank = 1;
  private readonly tankSeconds = 10;
  private state: 'ready' | 'pouring' | 'settling' | 'done' = 'ready';
  private height = 0;
  private best = readBest('tower');
  private settleTimer = 0;
  private marker = ring(0.1, '#ffffff', 0.8);
  private bestMarker = ring(0.12, '#ffd84d', 0.5);
  constructor(private engine: Engine) {}
  enter() {
    const m = cloneMaterial(MATERIALS.custom);
    m.physics.viscosity = 0.97;
    m.physics.stickiness = 0.35;
    const e = defaultEmitter(m, { enabled: false, position: [0, 1.1, 0], thickness: 0.026, flowSpeed: 0.7 });
    resetScene({ emitters: [e], selectedEmitterId: e.id, environment: 'amethyst', tool: 'select', selection: { kind: 'emitter', id: e.id } });
    this.engine.frameCamera(true);
    this.engine.stage.group.parent?.add(this.marker, this.bestMarker);
    this.reset();
  }
  private reset() {
    this.tank = 1;
    this.state = 'ready';
    this.height = 0;
    this.settleTimer = 0;
    this.hud();
  }
  private hud() {
    const banner =
      this.state === 'ready' ? 'Hold POUR to build the tallest liquid tower. Thicker = taller!' :
      this.state === 'settling' ? 'Settling… the tower must stand on its own' :
      this.state === 'done' ? `Final tower: ${cm(this.height)}${this.height >= this.best && this.height > 0 ? ' — NEW RECORD!' : ''}` : undefined;
    setHud({
      title: 'Tower Challenge',
      subtitle: 'Stack viscous liquid as high as you can',
      lines: [
        { label: 'Height', value: cm(this.height), accent: true },
        { label: 'Best', value: cm(this.best) },
      ],
      progress: this.tank,
      progressLabel: 'Liquid tank',
      banner,
      holdToPour: this.state === 'ready' || this.state === 'pouring',
      actions: this.state === 'done' || this.state === 'settling' ? [{ id: 'retry', label: 'Try again', primary: true }] : [{ id: 'retry', label: 'Restart' }],
    });
  }
  update(simDt: number, realDt: number, s: AppState) {
    const e = s.emitters[0];
    if (!e) return;
    const want = s.pouring && this.tank > 0 && (this.state === 'ready' || this.state === 'pouring');
    if (want !== e.enabled) s.updateEmitter(e.id, { enabled: want });
    if (want) {
      this.state = 'pouring';
      this.tank = Math.max(0, this.tank - simDt / this.tankSeconds);
      if (this.tank <= 0) {
        this.state = 'settling';
        this.settleTimer = 0;
      }
    } else if (this.state === 'pouring' && !s.pouring) {
      // allow pausing the pour; keep state
    }
    if (this.state === 'settling') {
      this.settleTimer += realDt;
      if (this.settleTimer > 4 && s.stats.avgSpeed < 0.08) {
        this.state = 'done';
        if (this.height > this.best) {
          this.best = this.height;
          writeBest('tower', this.best);
          this.engine.sound.chime(true);
          useStore.getState().toast(`New tower record: ${cm(this.best)}!`, 'good');
        } else this.engine.sound.chime(false);
      }
    }
    this.marker.position.set(0, PLATFORM_TOP + this.height, 0);
    this.marker.visible = this.height > 0.005;
    this.bestMarker.position.set(0, PLATFORM_TOP + this.best, 0);
    this.bestMarker.visible = this.best > 0.005;
    this.hud();
  }
  onReadback() {
    const s = useStore.getState().stats;
    if (this.state !== 'done') this.height = s.maxHeight;
  }
  action(id: string) {
    if (id === 'retry') {
      this.engine.clearLiquid();
      this.reset();
    }
  }
  exit() {
    this.marker.removeFromParent();
    this.bestMarker.removeFromParent();
  }
}

// ---------------------------------------------------------------- colour mixing
const PRIMARIES = [
  { id: 'red', label: 'Crimson', color: '#e8173a' },
  { id: 'yellow', label: 'Yellow', color: '#ffd60a' },
  { id: 'blue', label: 'Blue', color: '#1d5bff' },
  { id: 'white', label: 'White', color: '#ffffff' },
];
const lin = (hex: string) => new THREE.Color(hex).convertSRGBToLinear();
function pigmentMix(weights: number[]): THREE.Color {
  const t = weights.reduce((a, b) => a + b, 0) || 1;
  const acc = [0, 0, 0];
  PRIMARIES.forEach((p, i) => {
    const c = lin(p.color);
    acc[0] += (weights[i] / t) * -Math.log(Math.max(c.r, 0.004));
    acc[1] += (weights[i] / t) * -Math.log(Math.max(c.g, 0.004));
    acc[2] += (weights[i] / t) * -Math.log(Math.max(c.b, 0.004));
  });
  return new THREE.Color(Math.exp(-acc[0]), Math.exp(-acc[1]), Math.exp(-acc[2]));
}
function toLab(c: THREE.Color) {
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = (c.r * 0.4124 + c.g * 0.3576 + c.b * 0.1805) / 0.95047;
  const Y = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
  const Z = (c.r * 0.0193 + c.g * 0.1192 + c.b * 0.9505) / 1.08883;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
const deltaE = (a: THREE.Color, b: THREE.Color) => {
  const A = toLab(a);
  const B = toLab(b);
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
};
const hexOf = (c: THREE.Color) => '#' + c.clone().convertLinearToSRGB().getHexString();

class ColorMixMode implements ModeController {
  private target = new THREE.Color();
  private current: THREE.Color | null = null;
  private accuracy = 0;
  private round = 1;
  private best = readBest('colormix');
  private submitted: number | null = null;
  private basin: ObstacleSpec | null = null;
  constructor(private engine: Engine) {}
  enter() {
    const m = cloneMaterial(MATERIALS.paint);
    m.physics.viscosity = 0.12;
    m.physics.stickiness = 0.1;
    const emitters: Emitter[] = PRIMARIES.map((p, i) => {
      const a = -Math.PI / 2 + (i - 1.5) * 0.55;
      return defaultEmitter(m, {
        id: `cm-${p.id}`,
        position: [Math.cos(a) * 0.075, 0.86, Math.sin(a) * 0.075 + 0.02],
        streams: 1,
        colors: [p.color],
        thickness: 0.017,
        flowSpeed: 0.55,
        twistRadius: 0,
        twistSpeed: 0,
        enabled: false,
      });
    });
    const scale = 1.55;
    const d = OBSTACLE_DEFS.container;
    this.basin = { id: uid('o'), kind: 'container', position: [0, PLATFORM_TOP - d.pts[1] * scale + d.thickness * scale + 0.004, 0], rotation: [0, 0, 0], scale };
    resetScene({ emitters, selectedEmitterId: emitters[0].id, obstacles: [this.basin], environment: 'studio', tool: 'stir', toolSize: 0.06 });
    this.engine.frameCamera(true);
    this.newTarget();
  }
  private newTarget() {
    const w = [Math.random(), Math.random(), Math.random(), Math.random() * 0.6];
    const zero = Math.floor(Math.random() * 3);
    w[zero] *= 0.2;
    this.target = pigmentMix(w);
    this.submitted = null;
    this.current = null;
    this.accuracy = 0;
    this.engine.clearLiquid();
  }
  private hud() {
    const s = useStore.getState();
    setHud({
      title: `Color Mixing · Round ${this.round}`,
      subtitle: 'Hold the colour valves, stir, and match the target',
      target: hexOf(this.target),
      current: this.current ? hexOf(this.current) : undefined,
      lines: [
        { label: 'Match', value: this.current ? `${this.accuracy.toFixed(0)}%` : '—', accent: true },
        { label: 'Best', value: `${this.best.toFixed(0)}%` },
      ],
      banner: this.submitted !== null ? `Scored ${this.submitted.toFixed(0)}% — ${this.submitted > 90 ? 'Master mixer!' : this.submitted > 75 ? 'Great eye!' : 'Keep practising'}` : undefined,
      valves: PRIMARIES.map((p) => ({ id: p.id, label: p.label, color: p.color, value: s.valves[p.id] ?? 0 })),
      actions: this.submitted === null
        ? [{ id: 'submit', label: 'Submit mix', primary: true }, { id: 'drain', label: 'Drain' }]
        : [{ id: 'next', label: 'Next colour', primary: true }],
    });
  }
  update(_simDt: number, _realDt: number, s: AppState) {
    for (const p of PRIMARIES) {
      const e = s.emitters.find((x) => x.id === `cm-${p.id}`);
      if (!e) continue;
      const on = (s.valves[p.id] ?? 0) > 0 && this.submitted === null;
      if (on !== e.enabled) s.updateEmitter(e.id, { enabled: on });
    }
    this.hud();
  }
  onReadback(d: ReadbackData) {
    if (!this.basin) return;
    const def = OBSTACLE_DEFS.container;
    const sc = this.basin.scale;
    const r = (def.pts[2] - def.thickness) * sc;
    const yb = this.basin.position[1] + def.pts[1] * sc;
    const yt = this.basin.position[1] + def.pts[5] * sc;
    const acc = [0, 0, 0];
    let n = 0;
    forEachParticle(d, (x, y, z, _sp, i) => {
      if (x * x + z * z < r * r && y > yb && y < yt + 0.03) {
        acc[0] += -Math.log(Math.max(d.col[i * 4], 0.004));
        acc[1] += -Math.log(Math.max(d.col[i * 4 + 1], 0.004));
        acc[2] += -Math.log(Math.max(d.col[i * 4 + 2], 0.004));
        n++;
      }
    });
    if (n > 30) {
      this.current = new THREE.Color(Math.exp(-acc[0] / n), Math.exp(-acc[1] / n), Math.exp(-acc[2] / n));
      this.accuracy = Math.max(0, 100 - deltaE(this.current, this.target) * 1.6);
    } else {
      this.current = null;
      this.accuracy = 0;
    }
  }
  action(id: string) {
    if (id === 'submit') {
      this.submitted = this.accuracy;
      if (this.accuracy > this.best) {
        this.best = this.accuracy;
        writeBest('colormix', this.best);
      }
      this.engine.sound.chime(this.accuracy > 75);
    } else if (id === 'next') {
      this.round++;
      this.newTarget();
    } else if (id === 'drain') {
      this.engine.clearLiquid();
    }
  }
  exit() {}
}

// ---------------------------------------------------------------- fill the container
interface Cup {
  spec: ObstacleSpec;
  fill: number;
  ring: THREE.Mesh;
}
class FillMode implements ModeController {
  private level = 1;
  private cups: Cup[] = [];
  private tank = 1;
  private tankSeconds = 9;
  private spill = 0;
  private poured = 0;
  private state: 'play' | 'won' | 'failed' = 'play';
  private settle = 0;
  private stars = 0;
  constructor(private engine: Engine) {}
  enter() {
    this.setupLevel();
  }
  private setupLevel() {
    for (const c of this.cups) c.ring.removeFromParent();
    this.cups = [];
    const m = cloneMaterial(MATERIALS.paint);
    m.physics.viscosity = 0.22;
    const e = defaultEmitter(m, { id: 'fill-src', position: [0, 1.05, 0], streams: 1, thickness: 0.018, flowSpeed: 0.5, twistRadius: 0, twistSpeed: 0, enabled: false, colors: ['#2a9dff'] });
    const L = this.level;
    const count = Math.min(3, 1 + Math.floor((L - 1) / 2));
    const obstacles: ObstacleSpec[] = [];
    const d = OBSTACLE_DEFS.container;
    for (let i = 0; i < count; i++) {
      const scale = 0.75 + Math.random() * 0.25;
      const ang = (i / count) * Math.PI * 2 + Math.random() * 0.8;
      const rad = count === 1 ? 0 : 0.08;
      const spec: ObstacleSpec = {
        id: uid('o'),
        kind: 'container',
        position: [Math.cos(ang) * rad, PLATFORM_TOP - d.pts[1] * scale + d.thickness * scale + 0.004, Math.sin(ang) * rad],
        rotation: [0, 0, 0],
        scale,
      };
      obstacles.push(spec);
      const rg = ring((d.pts[2] - d.thickness) * scale * 0.98, '#ffd84d', 0.9);
      this.engine.stage.group.parent?.add(rg);
      this.cups.push({ spec, fill: 0, ring: rg });
    }
    if (L >= 3) {
      obstacles.push({ id: uid('o'), kind: 'ramp', position: [-0.05, 0.78, 0.0], rotation: [0, Math.random() * 3, -0.5], scale: 0.9 });
    }
    if (L >= 5) {
      obstacles.push({ id: uid('o'), kind: 'block', position: [0.12, 0.66, -0.1], rotation: [0.3, 0.5, 0], scale: 0.8 });
    }
    this.tankSeconds = 7 + count * 3.5;
    this.tank = 1;
    this.spill = 0;
    this.poured = 0;
    this.state = 'play';
    this.settle = 0;
    resetScene({ emitters: [e], selectedEmitterId: e.id, obstacles, environment: 'midnight', tool: 'pour', toolSize: 0.05, toolStrength: 0.35 });
    this.engine.frameCamera(true);
  }
  private hud() {
    const lines = this.cups.map((c, i) => ({ label: `Cup ${i + 1}`, value: `${Math.round(c.fill * 100)}%`, accent: c.fill >= 0.75 && c.fill < 1 }));
    lines.push({ label: 'Spilled', value: `${Math.round(this.spill * 100)}%`, accent: false });
    setHud({
      title: `Fill the Container · Level ${this.level}`,
      subtitle: 'Press and hold over a cup to pour. Fill every cup to the gold line (75–99%).',
      lines,
      progress: this.tank,
      progressLabel: 'Liquid tank',
      banner: this.state === 'won' ? `Level complete! ${'★'.repeat(this.stars)}${'☆'.repeat(3 - this.stars)}` : this.state === 'failed' ? 'Out of liquid — try again' : undefined,
      actions: this.state === 'won' ? [{ id: 'next', label: 'Next level', primary: true }, { id: 'retry', label: 'Replay' }] : [{ id: 'retry', label: 'Restart level' }],
    });
  }
  update(simDt: number, realDt: number, s: AppState) {
    if (s.tool === 'pour' && this.state === 'play' && this.tank > 0) {
      // the pour tool is active while the pointer is held; measure tank use
      if (this.engine.input.state.active) {
        this.tank = Math.max(0, this.tank - simDt / this.tankSeconds);
        this.poured += simDt;
      }
    }
    if (this.tank <= 0 && s.tool === 'pour') useStore.setState({ tool: 'orbit' });
    for (const c of this.cups) {
      const d = OBSTACLE_DEFS.container;
      const sc = c.spec.scale;
      const yb = c.spec.position[1] + d.pts[1] * sc;
      const yt = c.spec.position[1] + d.pts[5] * sc;
      c.ring.position.set(c.spec.position[0], yb + (yt - yb) * 0.75, c.spec.position[2]);
    }
    if (this.state === 'play') {
      const allGood = this.cups.every((c) => c.fill >= 0.75 && c.fill < 1.0);
      const anyOver = this.cups.some((c) => c.fill >= 1.0);
      if (allGood && s.stats.avgSpeed < 0.25) {
        this.settle += realDt;
        if (this.settle > 1.2) {
          this.state = 'won';
          this.stars = this.spill < 0.15 ? 3 : this.spill < 0.35 ? 2 : 1;
          this.engine.sound.chime(true);
        }
      } else this.settle = 0;
      if (anyOver) {
        useStore.getState().toast('Overflowing! Ease off…', 'warn');
      }
      if (this.tank <= 0 && !allGood && s.stats.avgSpeed < 0.06 && this.poured > 1) {
        this.state = 'failed';
        this.engine.sound.chime(false);
      }
    }
    this.hud();
  }
  onReadback(d: ReadbackData) {
    const def = OBSTACLE_DEFS.container;
    const vp = this.engine.solver.vp0 * d.dx ** 3;
    let total = 0;
    const inside = this.cups.map(() => 0);
    forEachParticle(d, (x, y, z) => {
      total++;
      this.cups.forEach((c, i) => {
        const sc = c.spec.scale;
        const r = (def.pts[2] - def.thickness) * sc;
        const yb = c.spec.position[1] + def.pts[1] * sc;
        const yt = c.spec.position[1] + def.pts[5] * sc;
        const dx = x - c.spec.position[0];
        const dz = z - c.spec.position[2];
        if (dx * dx + dz * dz < r * r && y > yb && y < yt + 0.02) inside[i]++;
      });
    });
    let inCups = 0;
    this.cups.forEach((c, i) => {
      const sc = c.spec.scale;
      const r = (def.pts[2] - def.thickness) * sc;
      const h = (def.pts[5] - def.pts[1]) * sc - def.thickness * sc;
      c.fill = (inside[i] * vp) / (Math.PI * r * r * h) / 0.82; // 0.82: packing of resting particles
      inCups += inside[i];
    });
    const emitted = this.engine.emission.emittedTotal;
    void total;
    this.spill = emitted > 0 ? THREE.MathUtils.clamp(1 - inCups / Math.max(1, this.pouredParticles(emitted)), 0, 1) : 0;
  }
  private emittedAtStart = 0;
  private pouredParticles(emitted: number) {
    if (this.poured === 0) this.emittedAtStart = emitted;
    return emitted - this.emittedAtStart;
  }
  action(id: string) {
    if (id === 'next') this.level++;
    this.emittedAtStart = this.engine.emission.emittedTotal;
    this.setupLevel();
  }
  exit() {
    for (const c of this.cups) c.ring.removeFromParent();
  }
}

// ---------------------------------------------------------------- chaos
const CHAOS_MATS: MaterialId[] = ['water', 'honey', 'lava', 'slime', 'paint', 'metal', 'glass', 'jelly', 'rainbow', 'toothpaste', 'chocolate'];
class ChaosMode implements ModeController {
  private next = 4;
  private eventTimer = 0;
  private banner = '';
  private bannerTime = 0;
  private count = 0;
  constructor(private engine: Engine) {}
  enter() {
    const emitters = [0, 1, 2].map((i) => {
      const m = cloneMaterial(MATERIALS[CHAOS_MATS[(Math.random() * CHAOS_MATS.length) | 0]]);
      const a = (i / 3) * Math.PI * 2;
      return defaultEmitter(m, { position: [Math.cos(a) * 0.12, 1.05, Math.sin(a) * 0.12], streams: i === 0 ? 3 : 1, thickness: 0.022 });
    });
    resetScene({ emitters, selectedEmitterId: emitters[0].id, environment: 'neon', tool: 'stir' });
    this.engine.frameCamera(true);
    this.banner = 'CHAOS MODE — physics mutates every few seconds';
    this.bannerTime = 3;
  }
  private trigger() {
    const s = useStore.getState();
    const r = Math.random;
    const events: [string, () => void][] = [
      ['GRAVITY FLIP!', () => s.updateWorld({ gravityMode: s.world.gravityMode === 'reversed' ? 'normal' : 'reversed' })],
      ['ZERO G!', () => s.updateWorld({ gravityMode: 'zero' })],
      ['SIDEWAYS GRAVITY', () => s.updateWorld({ gravityMode: 'custom', customGravity: [r() > 0.5 ? 1 : -1, -0.4, (r() - 0.5) * 0.6] })],
      ['HEAVY WORLD', () => s.updateWorld({ gravityMode: 'normal', gravityStrength: 2.2 })],
      ['MOON GRAVITY', () => s.updateWorld({ gravityMode: 'normal', gravityStrength: 0.3 })],
      ['VISCOSITY SHUFFLE', () => useStore.setState({ emitters: s.emitters.map((e) => ({ ...e, material: { ...e.material, physics: { ...e.material.physics, viscosity: r() } } })) })],
      ['MATERIAL SWAP', () => useStore.setState({ emitters: s.emitters.map((e) => { const m = cloneMaterial(MATERIALS[CHAOS_MATS[(r() * CHAOS_MATS.length) | 0]]); return { ...e, material: m, colors: [...m.palette] }; }) })],
      ['WHIRLPOOL!', () => { this.engine.extraForces = [{ type: 2, center: new THREE.Vector3(0, 0.5, 0), vector: new THREE.Vector3(), radius: 0.3, strength: 2.2 / this.engine.solver.dx, height: 0.8 }]; this.eventTimer = 4; }],
      ['PLATFORM TILT', () => s.updateWorld({ platformTilt: [(r() - 0.5) * 0.8, (r() - 0.5) * 0.8] })],
      ['SPIN CYCLE', () => s.updateWorld({ platformSpin: (r() > 0.5 ? 1 : -1) * (2 + r() * 3) })],
      ['DEEP FREEZE', () => s.updateWorld({ ambientTemp: -60 })],
      ['HEAT WAVE', () => s.updateWorld({ ambientTemp: 1300 })],
      ['BALL STORM', () => { for (let i = 0; i < 4; i++) s.addBody(r() > 0.5 ? 'ball' : 'cube'); }],
      ['SLOW MOTION', () => { s.updateWorld({ simSpeed: 0.3 }); this.eventTimer = 4; }],
      ['FAST FORWARD', () => { s.updateWorld({ simSpeed: 2 }); this.eventTimer = 4; }],
      ['THICK STREAMS', () => useStore.setState({ emitters: s.emitters.map((e) => ({ ...e, thickness: 0.035 + r() * 0.02 })) })],
      ['SHOCKWAVE', () => { this.engine.extraForces = [{ type: 4, center: new THREE.Vector3(0, PLATFORM_TOP + 0.03, 0), vector: new THREE.Vector3(), radius: 0.35, strength: 40 / this.engine.solver.dx }]; this.eventTimer = 0.3; this.engine.kickBodies((p) => p.clone().sub(new THREE.Vector3(0, 0.4, 0)).normalize().multiplyScalar(1.5)); }],
    ];
    // undo lingering effects
    s.updateWorld({ gravityStrength: 1, simSpeed: 1, platformSpin: 0, platformTilt: [0, 0], ambientTemp: 20, gravityMode: Math.random() < 0.5 ? 'normal' : s.world.gravityMode });
    const [name, fn] = events[(r() * events.length) | 0];
    fn();
    this.banner = name;
    this.bannerTime = 2.2;
    this.count++;
    this.engine.shake(1);
    this.engine.sound.whoosh();
  }
  update(simDt: number, realDt: number) {
    this.next -= realDt;
    if (this.eventTimer > 0) {
      this.eventTimer -= realDt;
      if (this.eventTimer <= 0) {
        this.engine.extraForces = [];
        useStore.getState().updateWorld({ simSpeed: 1 });
      }
    }
    if (this.next <= 0) {
      this.trigger();
      this.next = 5 + Math.random() * 4;
    }
    this.bannerTime -= realDt;
    void simDt;
    setHud({
      title: 'Chaos Mode',
      subtitle: `${this.count} mutations survived`,
      lines: [{ label: 'Next mutation', value: `${Math.max(0, this.next).toFixed(1)} s`, accent: true }],
      banner: this.bannerTime > 0 ? this.banner : undefined,
      actions: [{ id: 'now', label: 'Mutate now', primary: true }],
    });
  }
  action(id: string) {
    if (id === 'now') {
      this.trigger();
      this.next = 6;
    }
  }
  exit() {
    this.engine.extraForces = [];
  }
}

// ---------------------------------------------------------------- relaxation
const SHOWCASE = [0, 0.01, 0.2, 0.4, 0.8, 0.99];
const PALETTES = [
  ['#ff1e2e', '#2ee04a', '#2a7bff'],
  ['#ff7eb6', '#7afcff', '#feff9c'],
  ['#ffb86b', '#ff6bd6', '#6b8bff'],
  ['#c3f584', '#5ce1e6', '#ff66c4'],
];
class RelaxMode implements ModeController {
  private act = 0;
  private t = 0;
  private readonly actLen = 11;
  constructor(private engine: Engine) {}
  enter() {
    const e = defaultEmitter(MATERIALS.custom, { colors: PALETTES[0] });
    resetScene({ emitters: [e], selectedEmitterId: e.id, environment: 'amethyst', uiHidden: true, tool: 'orbit' });
    this.engine.frameCamera(true);
    this.engine.setAutoRotate(true);
    this.engine.sound.pad(true);
    this.setAct(0);
  }
  private setAct(i: number) {
    this.act = i;
    this.t = 0;
    const s = useStore.getState();
    const e = s.emitters[0];
    if (!e) return;
    const palette = PALETTES[Math.floor(i / SHOWCASE.length) % PALETTES.length];
    s.updateEmitter(e.id, {
      enabled: true,
      colors: palette,
      material: { ...e.material, physics: { ...e.material.physics, viscosity: SHOWCASE[i % SHOWCASE.length] } },
    });
  }
  update(_simDt: number, realDt: number) {
    this.t += realDt;
    const s = useStore.getState();
    const e = s.emitters[0];
    if (e && this.t > this.actLen - 3.5 && e.enabled) s.updateEmitter(e.id, { enabled: false });
    if (this.t > this.actLen) {
      this.engine.clearLiquid();
      this.setAct(this.act + 1);
    }
    setHud({ title: 'Relax', subtitle: 'Tap anywhere and drag to play · Esc to exit' });
  }
  exit() {
    this.engine.setAutoRotate(false);
    this.engine.sound.pad(false);
    useStore.setState({ uiHidden: false });
  }
}

// ---------------------------------------------------------------- zero gravity
class ZeroGMode implements ModeController {
  private t = 0;
  constructor(private engine: Engine) {}
  enter() {
    const mk = (id: MaterialId, pos: [number, number, number], rot: [number, number, number], colors?: string[]) => {
      const m = cloneMaterial(MATERIALS[id]);
      m.physics.surfaceTension = Math.max(0.8, m.physics.surfaceTension);
      return defaultEmitter(m, { position: pos, rotation: rot, streams: 1, thickness: 0.024, flowSpeed: 0.55, twistRadius: 0, twistSpeed: 0, colors: colors ?? m.palette });
    };
    const emitters = [
      mk('water', [-0.36, 0.62, 0], [0, 0, Math.PI / 2]),
      mk('metal', [0.36, 0.7, 0.05], [0, 0, -Math.PI / 2]),
      mk('rainbow', [0, 0.62, -0.36], [-Math.PI / 2, 0, 0]),
    ];
    resetScene({
      emitters,
      selectedEmitterId: emitters[0].id,
      environment: 'space',
      world: { ...defaultWorld(), gravityMode: 'zero', walls: true, containment: true, showPlatform: false, friction: 0.1 },
      tool: 'attract',
    });
    const s = useStore.getState();
    for (let i = 0; i < 3; i++) s.addBody(i % 2 ? 'cube' : 'ball', [(Math.random() - 0.5) * 0.3, 0.5 + Math.random() * 0.25, (Math.random() - 0.5) * 0.3]);
    useStore.setState({ tool: 'attract' });
    this.engine.frameCamera(true);
  }
  update(_simDt: number, realDt: number, s: AppState) {
    this.t += realDt;
    // pulse the emitters to release floating blobs
    s.emitters.forEach((e, i) => {
      const on = (this.t * 0.9 + i * 0.37) % 1 < 0.38;
      if (on !== e.enabled) s.updateEmitter(e.id, { enabled: on });
    });
    setHud({ title: 'Zero Gravity', subtitle: 'Liquid floats and beads up — attract, stir and collide blobs' });
  }
  exit() {}
}

export function createMode(mode: GameMode, engine: Engine): ModeController | null {
  switch (mode) {
    case 'sandbox':
      return new SandboxMode(engine);
    case 'tower':
      return new TowerMode(engine);
    case 'colormix':
      return new ColorMixMode(engine);
    case 'fill':
      return new FillMode(engine);
    case 'chaos':
      return new ChaosMode(engine);
    case 'relax':
      return new RelaxMode(engine);
    case 'zerog':
      return new ZeroGMode(engine);
  }
}

