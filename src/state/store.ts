import { create } from 'zustand';
import type {
  BodySpec,
  Emitter,
  FluidStats,
  GameMode,
  Material,
  MaterialId,
  MaterialLook,
  MaterialPhysics,
  ObstacleSpec,
  QualityTier,
  ToolId,
  Vec3,
  WorldSettings,
} from '../engine/types';
import { MATERIALS, cloneMaterial } from './materials';

let idCounter = 1;
export const uid = (p: string) => `${p}${Date.now().toString(36)}${(idCounter++).toString(36)}`;

export const MAX_EMITTERS = 6;

export function defaultEmitter(material: Material = MATERIALS.custom, overrides: Partial<Emitter> = {}): Emitter {
  const m = cloneMaterial(material);
  return {
    id: uid('e'),
    position: [0, 1.1, 0],
    rotation: [0, 0, 0],
    material: m,
    streams: 3,
    colors: [...m.palette],
    thickness: 0.026,
    flowSpeed: 1.0,
    twistRadius: 0.05,
    twistSpeed: 1.2,
    enabled: true,
    ...overrides,
  };
}

export const defaultWorld = (): WorldSettings => ({
  gravityMode: 'normal',
  customGravity: [0, -1, 0],
  gravityStrength: 1,
  ambientTemp: 20,
  friction: 0.45,
  simSpeed: 1,
  walls: false,
  containment: false,
  platformTilt: [0, 0],
  platformSpin: 0,
  showPlatform: true,
});

export interface PerfStats {
  fps: number;
  frameMs: number;
  substeps: number;
  grid: string;
  tier: QualityTier;
  renderScale: number;
  gpu: string;
}

export type Selection = { kind: 'emitter' | 'obstacle' | 'body'; id: string } | null;

export interface Toast {
  id: number;
  text: string;
  tone?: 'info' | 'good' | 'warn';
}

export interface ModeHud {
  title: string;
  subtitle?: string;
  lines?: { label: string; value: string; accent?: boolean }[];
  progress?: number; // 0..1
  progressLabel?: string;
  target?: string; // colour swatch (colour mixing)
  current?: string;
  banner?: string;
  actions?: { id: string; label: string; primary?: boolean }[];
  holdToPour?: boolean;
  valves?: { id: string; label: string; color: string; value: number }[];
}

export interface AppState {
  emitters: Emitter[];
  selectedEmitterId: string;
  world: WorldSettings;
  obstacles: ObstacleSpec[];
  bodies: BodySpec[];
  environment: string;

  tool: ToolId;
  toolSize: number;
  toolStrength: number;
  dyeColor: string;
  paused: boolean;
  mode: GameMode;
  quality: 'auto' | QualityTier;
  activeTier: QualityTier;
  showStats: boolean;
  tooltips: boolean;
  sound: boolean;
  volume: number;
  cinematic: boolean;
  uiHidden: boolean;
  recording: boolean;
  recordSeconds: number;
  selection: Selection;
  transformMode: 'translate' | 'rotate';
  stats: FluidStats;
  perf: PerfStats;
  toasts: Toast[];
  hud: ModeHud | null;
  engineError: string | null;
  engineReady: boolean;
  revision: number; // bumps when the scene must be fully re-applied (load/share/mode)
  pouring: boolean; // hold-to-pour in game modes
  valves: Record<string, number>;

  // actions
  set: (p: Partial<AppState>) => void;
  selectedEmitter: () => Emitter;
  updateEmitter: (id: string, p: Partial<Emitter>) => void;
  updatePhysics: (p: Partial<MaterialPhysics>) => void;
  updateLook: (p: Partial<MaterialLook>) => void;
  applyPreset: (id: MaterialId) => void;
  addEmitter: () => void;
  removeEmitter: (id: string) => void;
  updateWorld: (p: Partial<WorldSettings>) => void;
  addObstacle: (kind: ObstacleSpec['kind'], position?: Vec3) => string;
  updateObstacle: (id: string, p: Partial<ObstacleSpec>) => void;
  removeObstacle: (id: string) => void;
  addBody: (kind: BodySpec['kind'], position?: Vec3) => string;
  removeBody: (id: string) => void;
  toast: (text: string, tone?: Toast['tone']) => void;
  removeSelection: () => void;
}

const BODY_COLORS = ['#ffd84d', '#ff5d8f', '#4dd2ff', '#9bff6a', '#ffffff', '#ff9a3d'];

export const useStore = create<AppState>((set, get) => {
  const first = defaultEmitter();
  return {
    emitters: [first],
    selectedEmitterId: first.id,
    world: defaultWorld(),
    obstacles: [],
    bodies: [],
    environment: 'amethyst',

    tool: 'stir',
    toolSize: 0.09,
    toolStrength: 0.6,
    dyeColor: '#ff3df2',
    paused: false,
    mode: 'sandbox',
    quality: 'auto',
    activeTier: 'medium',
    showStats: false,
    tooltips: true,
    sound: false,
    volume: 0.6,
    cinematic: false,
    uiHidden: false,
    recording: false,
    recordSeconds: 0,
    selection: null,
    transformMode: 'translate',
    stats: { alive: 0, capacity: 0, maxHeight: 0, peakHeight: 0, avgSpeed: 0, kinetic: 0, avgTemp: 20, frozen: 0, onPlatform: 0 },
    perf: { fps: 0, frameMs: 0, substeps: 0, grid: '', tier: 'medium', renderScale: 1, gpu: '' },
    toasts: [],
    hud: null,
    engineError: null,
    engineReady: false,
    revision: 0,
    pouring: false,
    valves: {},

    set: (p) => set(p),
    selectedEmitter: () => {
      const s = get();
      return s.emitters.find((e) => e.id === s.selectedEmitterId) ?? s.emitters[0];
    },
    updateEmitter: (id, p) =>
      set((s) => ({ emitters: s.emitters.map((e) => (e.id === id ? { ...e, ...p } : e)) })),
    updatePhysics: (p) =>
      set((s) => ({
        emitters: s.emitters.map((e) =>
          e.id === s.selectedEmitterId
            ? { ...e, material: { ...e.material, id: e.material.id, physics: { ...e.material.physics, ...p } } }
            : e,
        ),
      })),
    updateLook: (p) =>
      set((s) => ({
        emitters: s.emitters.map((e) =>
          e.id === s.selectedEmitterId ? { ...e, material: { ...e.material, look: { ...e.material.look, ...p } } } : e,
        ),
      })),
    applyPreset: (id) =>
      set((s) => ({
        emitters: s.emitters.map((e) => {
          if (e.id !== s.selectedEmitterId) return e;
          const m = cloneMaterial(MATERIALS[id]);
          return { ...e, material: m, colors: [...m.palette] };
        }),
      })),
    addEmitter: () => {
      const s = get();
      if (s.emitters.length >= MAX_EMITTERS) {
        get().toast(`Up to ${MAX_EMITTERS} emitters`, 'warn');
        return;
      }
      const ids = Object.keys(MATERIALS) as MaterialId[];
      const pick = MATERIALS[ids[(s.emitters.length * 5 + 1) % ids.length]];
      const n = s.emitters.length;
      const ang = n * 2.1;
      const e = defaultEmitter(pick, {
        position: [Math.cos(ang) * 0.22, 1.05, Math.sin(ang) * 0.22],
        streams: 1,
        twistRadius: 0.02,
        thickness: 0.024,
      });
      set({ emitters: [...s.emitters, e], selectedEmitterId: e.id, selection: { kind: 'emitter', id: e.id } });
    },
    removeEmitter: (id) => {
      const s = get();
      if (s.emitters.length <= 1) {
        get().toast('Keep at least one emitter — toggle its flow off instead', 'warn');
        return;
      }
      const rest = s.emitters.filter((e) => e.id !== id);
      set({
        emitters: rest,
        selectedEmitterId: s.selectedEmitterId === id ? rest[0].id : s.selectedEmitterId,
        selection: s.selection?.id === id ? null : s.selection,
      });
    },
    updateWorld: (p) => set((s) => ({ world: { ...s.world, ...p } })),
    addObstacle: (kind, position) => {
      const o: ObstacleSpec = {
        id: uid('o'),
        kind,
        position: position ?? (kind === 'container' ? [0, 0.505, 0] : kind === 'funnel' ? [0, 0.78, 0] : kind === 'ramp' ? [0, 0.72, 0] : [0.08, 0.5, 0.05]),
        rotation: kind === 'ramp' ? [0, 0, -0.45] : [0, 0, 0],
        scale: 1,
      };
      set((s) => ({ obstacles: [...s.obstacles, o], selection: { kind: 'obstacle', id: o.id }, tool: 'select' }));
      return o.id;
    },
    updateObstacle: (id, p) => set((s) => ({ obstacles: s.obstacles.map((o) => (o.id === id ? { ...o, ...p } : o)) })),
    removeObstacle: (id) =>
      set((s) => ({ obstacles: s.obstacles.filter((o) => o.id !== id), selection: s.selection?.id === id ? null : s.selection })),
    addBody: (kind, position) => {
      const s = get();
      const b: BodySpec = {
        id: uid('b'),
        kind,
        position: position ?? [(Math.random() - 0.5) * 0.18, 0.95, (Math.random() - 0.5) * 0.18],
        size: kind === 'ball' ? 0.035 : 0.05,
        density: kind === 'ball' ? 0.5 : 0.8,
        color: BODY_COLORS[s.bodies.length % BODY_COLORS.length],
      };
      if (s.bodies.length >= 12) {
        get().toast('Up to 12 dynamic bodies', 'warn');
        return '';
      }
      set({ bodies: [...s.bodies, b] });
      return b.id;
    },
    removeBody: (id) =>
      set((s) => ({ bodies: s.bodies.filter((b) => b.id !== id), selection: s.selection?.id === id ? null : s.selection })),
    toast: (text, tone = 'info') => {
      const id = Date.now() + Math.random();
      set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone }] }));
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3200);
    },
    removeSelection: () => {
      const s = get();
      if (!s.selection) return;
      if (s.selection.kind === 'emitter') s.removeEmitter(s.selection.id);
      else if (s.selection.kind === 'obstacle') s.removeObstacle(s.selection.id);
      else s.removeBody(s.selection.id);
    },
  };
});
