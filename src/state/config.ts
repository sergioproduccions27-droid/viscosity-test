import type { BodySpec, Emitter, GameMode, MaterialId, ObstacleSpec, WorldSettings } from '../engine/types';
import { ENVIRONMENTS } from '../engine/render/Environment';
import { MATERIALS, MATERIAL_ORDER, cloneMaterial } from './materials';
import { defaultEmitter, defaultWorld, uid, useStore } from './store';

export interface SceneConfig {
  v: 1;
  name?: string;
  emitters: Emitter[];
  world: WorldSettings;
  obstacles: ObstacleSpec[];
  bodies: BodySpec[];
  environment: string;
}

export interface SavedExperiment {
  id: string;
  name: string;
  date: number;
  thumb?: string;
  config: SceneConfig;
}

const KEY = 'vp.experiments.v1';

export function captureConfig(name?: string): SceneConfig {
  const s = useStore.getState();
  return {
    v: 1,
    name,
    emitters: s.emitters,
    world: s.world,
    obstacles: s.obstacles,
    bodies: s.bodies,
    environment: s.environment,
  };
}

function sanitize(c: SceneConfig): SceneConfig | null {
  if (!c || c.v !== 1 || !Array.isArray(c.emitters) || c.emitters.length === 0) return null;
  const base = defaultEmitter();
  const emitters = c.emitters.slice(0, 6).map((e) => {
    const matId = (MATERIAL_ORDER.includes(e.material?.id) ? e.material.id : 'custom') as MaterialId;
    const preset = MATERIALS[matId];
    return {
      ...base,
      ...e,
      id: uid('e'),
      material: {
        ...cloneMaterial(preset),
        ...e.material,
        physics: { ...preset.physics, ...(e.material?.physics ?? {}) },
        look: { ...preset.look, ...(e.material?.look ?? {}) },
      },
      colors: Array.isArray(e.colors) && e.colors.length ? e.colors.slice(0, 6) : [...preset.palette],
      streams: Math.max(1, Math.min(6, Math.round(e.streams ?? 3))),
    } as Emitter;
  });
  return {
    v: 1,
    name: c.name,
    emitters,
    world: { ...defaultWorld(), ...(c.world ?? {}) },
    obstacles: (c.obstacles ?? []).slice(0, 12).map((o) => ({ ...o, id: uid('o') })),
    bodies: (c.bodies ?? []).slice(0, 12).map((b) => ({ ...b, id: uid('b') })),
    environment: ENVIRONMENTS.some((e) => e.id === c.environment) ? c.environment : 'amethyst',
  };
}

export function applyConfig(raw: SceneConfig, mode: GameMode = 'sandbox'): boolean {
  const c = sanitize(raw);
  if (!c) return false;
  const s = useStore.getState();
  useStore.setState({
    mode,
    emitters: c.emitters,
    selectedEmitterId: c.emitters[0].id,
    world: c.world,
    obstacles: c.obstacles,
    bodies: c.bodies,
    environment: c.environment,
    selection: null,
    hud: null,
    sceneFromConfig: s.mode !== mode,
    revision: s.revision + 1,
  });
  return true;
}

// ---------------------------------------------------------------- local storage
export function listExperiments(): SavedExperiment[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as SavedExperiment[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function saveExperiment(name: string, thumb?: string): SavedExperiment | null {
  const exp: SavedExperiment = { id: uid('x'), name, date: Date.now(), thumb, config: captureConfig(name) };
  try {
    const list = [exp, ...listExperiments()].slice(0, 30);
    localStorage.setItem(KEY, JSON.stringify(list));
    return exp;
  } catch {
    // quota exceeded: retry without thumbnails
    try {
      const list = [{ ...exp, thumb: undefined }, ...listExperiments().map((e) => ({ ...e, thumb: undefined }))].slice(0, 30);
      localStorage.setItem(KEY, JSON.stringify(list));
      return exp;
    } catch {
      return null;
    }
  }
}

export function deleteExperiment(id: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify(listExperiments().filter((e) => e.id !== id)));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- share URLs
const toB64Url = (bytes: Uint8Array) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64Url = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
};

/** Compact representation: drops ids and rounds numbers. */
function compact(c: SceneConfig) {
  const round = (_k: string, v: unknown) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
  return JSON.stringify(
    {
      ...c,
      emitters: c.emitters.map(({ id: _id, ...e }) => e),
      obstacles: c.obstacles.map(({ id: _id, ...o }) => o),
      bodies: c.bodies.map(({ id: _id, ...b }) => b),
    },
    round,
  );
}

export async function encodeShare(c: SceneConfig): Promise<string> {
  const json = compact(c);
  const data = new TextEncoder().encode(json);
  if (typeof CompressionStream !== 'undefined') {
    try {
      const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const buf = new Uint8Array(await new Response(stream).arrayBuffer());
      return 'z' + toB64Url(buf);
    } catch {
      /* fall through */
    }
  }
  return 'j' + toB64Url(data);
}

export async function decodeShare(s: string): Promise<SceneConfig | null> {
  try {
    const kind = s[0];
    const bytes = fromB64Url(s.slice(1));
    let json: string;
    if (kind === 'z') {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      json = await new Response(stream).text();
    } else json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json) as SceneConfig;
    return sanitize(parsed);
  } catch {
    return null;
  }
}

export async function shareUrl(): Promise<string> {
  const code = await encodeShare(captureConfig());
  const u = new URL(window.location.href);
  u.hash = `x=${code}`;
  return u.toString();
}

// ---------------------------------------------------------------- random experiments
const ADJ = ['Molten', 'Velvet', 'Neon', 'Glacial', 'Cosmic', 'Sticky', 'Liquid', 'Twisted', 'Silken', 'Volcanic', 'Prismatic', 'Lazy', 'Electric', 'Gooey'];
const NOUN = ['Cascade', 'Spiral', 'Avalanche', 'Fountain', 'Tornado', 'Waterfall', 'Vortex', 'Ribbon', 'Lagoon', 'Tower', 'Helix', 'Storm', 'Bloom'];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const hsl = (h: number, s: number, l: number) => {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
};

export function randomExperiment(): SceneConfig {
  const n = Math.random() < 0.6 ? 1 : 2 + Math.floor(Math.random() * 2);
  const baseHue = Math.random();
  const emitters: Emitter[] = Array.from({ length: n }, (_, i) => {
    const id = pick(MATERIAL_ORDER.filter((m) => m !== 'custom'));
    const m = cloneMaterial(MATERIALS[id]);
    if (Math.random() < 0.5) m.physics.viscosity = Math.random();
    if (Math.random() < 0.3) m.physics.elasticity = Math.random() * 0.7;
    const streams = n === 1 ? 2 + Math.floor(Math.random() * 3) : 1 + Math.floor(Math.random() * 2);
    const colors = Math.random() < 0.5 ? m.palette : Array.from({ length: 3 }, (_, k) => hsl((baseHue + k * 0.13 + i * 0.3) % 1, 0.85, 0.55));
    const a = (i / n) * Math.PI * 2 + Math.random();
    const r = n === 1 ? 0 : 0.1 + Math.random() * 0.08;
    return defaultEmitter(m, {
      position: [Math.cos(a) * r, 0.95 + Math.random() * 0.17, Math.sin(a) * r],
      rotation: Math.random() < 0.25 ? [(Math.random() - 0.5) * 0.8, 0, (Math.random() - 0.5) * 0.8] : [0, 0, 0],
      streams,
      colors,
      thickness: 0.016 + Math.random() * 0.016,
      flowSpeed: 0.45 + Math.random() * 0.6,
      twistRadius: 0.02 + Math.random() * 0.05,
      twistSpeed: (Math.random() - 0.3) * 2,
    });
  });
  const world = defaultWorld();
  const g = Math.random();
  if (g < 0.1) world.gravityMode = 'reversed';
  else if (g < 0.2) {
    world.gravityMode = 'custom';
    world.customGravity = [(Math.random() - 0.5) * 0.8, -1, (Math.random() - 0.5) * 0.8];
  } else world.gravityStrength = 0.6 + Math.random() * 0.8;
  if (Math.random() < 0.25) world.platformSpin = (Math.random() - 0.5) * 4;
  if (Math.random() < 0.2) world.platformTilt = [(Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5];
  if (Math.random() < 0.15) world.ambientTemp = Math.random() < 0.5 ? -30 : 900;
  const obstacles: ObstacleSpec[] = [];
  const kinds: ObstacleSpec['kind'][] = ['ramp', 'funnel', 'block', 'container'];
  for (let i = 0, k = Math.floor(Math.random() * 3); i < k; i++) {
    const kind = pick(kinds);
    obstacles.push({
      id: uid('o'),
      kind,
      position: [(Math.random() - 0.5) * 0.25, kind === 'container' ? 0.505 : 0.6 + Math.random() * 0.25, (Math.random() - 0.5) * 0.25],
      rotation: kind === 'ramp' ? [0, Math.random() * Math.PI, -0.3 - Math.random() * 0.4] : [0, Math.random() * Math.PI, 0],
      scale: 0.8 + Math.random() * 0.4,
    });
  }
  const bodies: BodySpec[] = [];
  for (let i = 0, k = Math.random() < 0.4 ? Math.floor(Math.random() * 4) : 0; i < k; i++) {
    bodies.push({ id: uid('b'), kind: Math.random() < 0.5 ? 'ball' : 'cube', position: [(Math.random() - 0.5) * 0.2, 0.9, (Math.random() - 0.5) * 0.2], size: 0.03 + Math.random() * 0.02, density: 0.3 + Math.random() * 1.5, color: hsl(Math.random(), 0.8, 0.6) });
  }
  return {
    v: 1,
    name: `${pick(ADJ)} ${pick(NOUN)}`,
    emitters,
    world,
    obstacles,
    bodies,
    environment: pick(ENVIRONMENTS.filter((e) => e.id !== 'space')).id,
  };
}
