import * as THREE from 'three';
import type { Prim } from './sim/MPMSolver';
import type { ObstacleSpec } from './types';

/** Geometry of the stage: a platform on top of a twisted stack of slabs (as in the reference). */
export const PLATFORM = {
  center: new THREE.Vector3(0, 0.42, 0),
  half: new THREE.Vector3(0.165, 0.02, 0.165),
  round: 0.008,
};

export const PILLAR_SLABS = Array.from({ length: 10 }, (_, i) => ({
  y: PLATFORM.center.y - 0.044 * (i + 1),
  angle: (i + 1) * 0.085 + Math.sin(i * 0.9) * 0.05,
  half: new THREE.Vector3(0.152, 0.0185, 0.152),
  round: 0.006,
}));

export const PLATFORM_TOP = PLATFORM.center.y + PLATFORM.half.y;

const yAxis = new THREE.Vector3(0, 1, 0);

export function platformQuat(tilt: [number, number], spinAngle: number, out = new THREE.Quaternion()) {
  const e = new THREE.Euler(tilt[0], spinAngle, tilt[1], 'YXZ');
  return out.setFromEuler(e);
}

export function stagePrims(opts: {
  showPlatform: boolean;
  platformQuat: THREE.Quaternion;
  platformAngVel: THREE.Vector3;
}): Prim[] {
  if (!opts.showPlatform) return [];
  const prims: Prim[] = [];
  prims.push({
    type: 0,
    center: PLATFORM.center.clone(),
    quat: opts.platformQuat.clone(),
    a: [PLATFORM.half.x, PLATFORM.half.y, PLATFORM.half.z, PLATFORM.round],
    angVel: opts.platformAngVel.clone(),
    bound: PLATFORM.half.length(),
  });
  for (const s of PILLAR_SLABS) {
    prims.push({
      type: 0,
      center: new THREE.Vector3(0, s.y, 0),
      quat: new THREE.Quaternion().setFromAxisAngle(yAxis, s.angle),
      a: [s.half.x, s.half.y, s.half.z, s.round],
      bound: s.half.length(),
    });
  }
  return prims;
}

/** Local-space description of each obstacle type (unit scale). */
export const OBSTACLE_DEFS = {
  ramp: { half: [0.16, 0.012, 0.075] as [number, number, number] },
  block: { half: [0.05, 0.05, 0.05] as [number, number, number] },
  pillar: { half: [0.025, 0.12, 0.025] as [number, number, number] },
  // lathe profiles: polyline in (radius, y) and wall thickness
  funnel: { pts: [0.13, 0.07, 0.022, -0.04, 0.02, -0.1, 0.02, -0.1] as number[], thickness: 0.008 },
  container: { pts: [0.0, -0.06, 0.085, -0.06, 0.085, 0.07, 0.085, 0.07] as number[], thickness: 0.009 },
};

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

export function obstaclePrim(o: ObstacleSpec): Prim {
  _e.set(o.rotation[0], o.rotation[1], o.rotation[2], 'XYZ');
  _q.setFromEuler(_e);
  const center = new THREE.Vector3(...o.position);
  const s = o.scale;
  switch (o.kind) {
    case 'ramp':
    case 'block':
    case 'pillar': {
      const h = OBSTACLE_DEFS[o.kind].half;
      return {
        type: 0,
        center,
        quat: _q.clone(),
        a: [h[0] * s, h[1] * s, h[2] * s, Math.min(h[0], h[1], h[2]) * s * 0.3],
        bound: Math.hypot(h[0], h[1], h[2]) * s,
      };
    }
    case 'funnel':
    case 'container': {
      const d = OBSTACLE_DEFS[o.kind];
      const p = d.pts.map((v) => v * s);
      return {
        type: 2,
        center,
        quat: _q.clone(),
        a: [p[0], p[1], p[2], p[3]],
        b: [p[4], p[5], p[6], p[7]],
        thickness: d.thickness * Math.max(0.8, s),
        bound: Math.max(...p.map(Math.abs)) * 1.5,
      };
    }
  }
}
