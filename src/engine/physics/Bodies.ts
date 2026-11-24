import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { OBSTACLE_DEFS, PILLAR_SLABS, PLATFORM } from '../SceneLayout';
import type { Prim } from '../sim/MPMSolver';
import { MAX_BODIES } from '../sim/shaders';
import type { BodySpec, ObstacleSpec } from '../types';

const v3 = (v: THREE.Vector3) => new CANNON.Vec3(v.x, v.y, v.z);

interface Dyn {
  spec: BodySpec;
  body: CANNON.Body;
  index: number;
  dragging: boolean;
  dragTarget: THREE.Vector3;
}

/**
 * Rigid bodies (balls & cubes) simulated with cannon-es and coupled two-way to the liquid:
 * the GPU grid update reports the momentum it exchanged with each body.
 */
export class BodySystem {
  readonly world = new CANNON.World();
  private platform: CANNON.Body;
  private obstacleBodies = new Map<string, { body: CANNON.Body; key: string }>();
  private dyn = new Map<string, Dyn>();
  private material = new CANNON.Material('m');
  fellOut: string[] = [];

  constructor() {
    this.world.gravity.set(0, -2, 0);
    this.world.allowSleep = false;
    (this.world.solver as CANNON.GSSolver).iterations = 12;
    this.world.defaultContactMaterial.friction = 0.35;
    this.world.defaultContactMaterial.restitution = 0.25;

    this.platform = new CANNON.Body({ type: CANNON.Body.KINEMATIC, material: this.material });
    this.platform.addShape(new CANNON.Box(v3(PLATFORM.half)));
    this.platform.position.set(PLATFORM.center.x, PLATFORM.center.y, PLATFORM.center.z);
    this.world.addBody(this.platform);
    const pillar = new CANNON.Body({ type: CANNON.Body.STATIC });
    for (const s of PILLAR_SLABS) {
      const q = new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(0, 1, 0), s.angle);
      pillar.addShape(new CANNON.Box(v3(s.half)), new CANNON.Vec3(0, s.y, 0), q);
    }
    this.world.addBody(pillar);
  }

  setPlatform(q: THREE.Quaternion, angVel: THREE.Vector3, visible: boolean) {
    this.platform.quaternion.set(q.x, q.y, q.z, q.w);
    this.platform.angularVelocity.set(angVel.x, angVel.y, angVel.z);
    this.platform.collisionResponse = visible;
  }

  private buildObstacle(o: ObstacleSpec): CANNON.Body {
    const b = new CANNON.Body({ type: CANNON.Body.STATIC, material: this.material });
    const s = o.scale;
    if (o.kind === 'ramp' || o.kind === 'block' || o.kind === 'pillar') {
      const h = OBSTACLE_DEFS[o.kind].half;
      b.addShape(new CANNON.Box(new CANNON.Vec3(h[0] * s, h[1] * s, h[2] * s)));
    } else {
      // revolve the lathe profile as a ring of boxes per segment
      const d = OBSTACLE_DEFS[o.kind];
      const pts = d.pts.map((v) => v * s);
      const n = 14;
      for (let k = 0; k < pts.length - 2; k += 2) {
        const r0 = pts[k], y0 = pts[k + 1], r1 = pts[k + 2], y1 = pts[k + 3];
        const len = Math.hypot(r1 - r0, y1 - y0);
        if (len < 1e-4) continue;
        const rm = (r0 + r1) / 2;
        const ym = (y0 + y1) / 2;
        if (Math.abs(y1 - y0) < 1e-4) {
          // flat disk (container bottom)
          const rr = Math.max(r0, r1);
          b.addShape(new CANNON.Cylinder(rr, rr, d.thickness * 2 * s, 16), new CANNON.Vec3(0, ym, 0));
          continue;
        }
        // ring of boxes: local z points radially, local y follows the profile segment
        const tilt = Math.atan2(r1 - r0, y1 - y0);
        const w = (2 * Math.PI * Math.max(rm, 0.01)) / n;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          const qr = new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(0, 1, 0), a);
          const qtilt = new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(1, 0, 0), tilt);
          const off = new CANNON.Vec3(Math.sin(a) * rm, ym, Math.cos(a) * rm);
          b.addShape(new CANNON.Box(new CANNON.Vec3(w / 2 + 0.002, len / 2, d.thickness * s)), off, qr.mult(qtilt));
        }
      }
    }
    b.position.set(...o.position);
    b.quaternion.setFromEuler(o.rotation[0], o.rotation[1], o.rotation[2], 'XYZ');
    return b;
  }

  syncObstacles(list: ObstacleSpec[]) {
    const live = new Set<string>();
    for (const o of list) {
      live.add(o.id);
      const key = `${o.kind}:${o.scale.toFixed(3)}`;
      let entry = this.obstacleBodies.get(o.id);
      if (!entry || entry.key !== key) {
        if (entry) this.world.removeBody(entry.body);
        entry = { body: this.buildObstacle(o), key };
        this.world.addBody(entry.body);
        this.obstacleBodies.set(o.id, entry);
      }
      entry.body.position.set(...o.position);
      entry.body.quaternion.setFromEuler(o.rotation[0], o.rotation[1], o.rotation[2], 'XYZ');
    }
    for (const [id, e] of this.obstacleBodies) {
      if (!live.has(id)) {
        this.world.removeBody(e.body);
        this.obstacleBodies.delete(id);
      }
    }
  }

  syncBodies(list: BodySpec[]) {
    const live = new Set<string>();
    list.slice(0, MAX_BODIES).forEach((spec) => {
      live.add(spec.id);
      if (this.dyn.has(spec.id)) return;
      const vol = spec.kind === 'ball' ? (4 / 3) * Math.PI * spec.size ** 3 : (2 * spec.size) ** 3;
      const body = new CANNON.Body({
        mass: spec.density * vol,
        material: this.material,
        linearDamping: 0.05,
        angularDamping: 0.12,
      });
      body.addShape(spec.kind === 'ball' ? new CANNON.Sphere(spec.size) : new CANNON.Box(new CANNON.Vec3(spec.size, spec.size, spec.size)));
      body.position.set(...spec.position);
      body.angularVelocity.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
      this.world.addBody(body);
      this.dyn.set(spec.id, { spec, body, index: 0, dragging: false, dragTarget: new THREE.Vector3() });
    });
    for (const [id, d] of this.dyn) {
      if (!live.has(id)) {
        this.world.removeBody(d.body);
        this.dyn.delete(id);
      }
    }
    let i = 0;
    for (const d of this.dyn.values()) d.index = i++;
  }

  get count() {
    return this.dyn.size;
  }

  step(dt: number, gravity: THREE.Vector3) {
    this.world.gravity.set(gravity.x, gravity.y, gravity.z);
    for (const d of this.dyn.values()) {
      if (d.dragging) {
        const b = d.body;
        const to = d.dragTarget;
        const k = Math.min(1, dt * 18);
        b.velocity.set((to.x - b.position.x) * k / dt, (to.y - b.position.y) * k / dt, (to.z - b.position.z) * k / dt);
        b.angularVelocity.scale(0.9, b.angularVelocity);
      }
    }
    this.world.step(1 / 120, dt, 4);
    this.fellOut = [];
    for (const [id, d] of this.dyn) if (d.body.position.y < -0.6) this.fellOut.push(id);
  }

  /** Apply fluid impulses (grid units) read back from the GPU. */
  applyFluid(force: Float32Array, torque: Float32Array, dx: number) {
    const s4 = dx ** 4;
    const s5 = dx ** 5;
    for (const d of this.dyn.values()) {
      if (d.dragging) continue;
      const i = d.index * 4;
      const b = d.body;
      const fx = force[i] * s4, fy = force[i + 1] * s4, fz = force[i + 2] * s4;
      if (!Number.isFinite(fx + fy + fz)) continue;
      const inv = b.invMass;
      const lim = 3; // m/s per frame safety clamp
      b.velocity.x += THREE.MathUtils.clamp(fx * inv, -lim, lim);
      b.velocity.y += THREE.MathUtils.clamp(fy * inv, -lim, lim);
      b.velocity.z += THREE.MathUtils.clamp(fz * inv, -lim, lim);
      const L = new CANNON.Vec3(torque[i] * s5, torque[i + 1] * s5, torque[i + 2] * s5);
      const dw = b.invInertiaWorld.vmult(L);
      b.angularVelocity.x += THREE.MathUtils.clamp(dw.x, -20, 20);
      b.angularVelocity.y += THREE.MathUtils.clamp(dw.y, -20, 20);
      b.angularVelocity.z += THREE.MathUtils.clamp(dw.z, -20, 20);
    }
  }

  prims(): Prim[] {
    const out: Prim[] = [];
    for (const d of this.dyn.values()) {
      const b = d.body;
      const s = d.spec.size;
      out.push({
        type: d.spec.kind === 'ball' ? 1 : 0,
        center: new THREE.Vector3(b.position.x, b.position.y, b.position.z),
        quat: new THREE.Quaternion(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w),
        a: d.spec.kind === 'ball' ? [s, 0, 0, 0] : [s, s, s, s * 0.25],
        linVel: new THREE.Vector3(b.velocity.x, b.velocity.y, b.velocity.z),
        angVel: new THREE.Vector3(b.angularVelocity.x, b.angularVelocity.y, b.angularVelocity.z),
        body: d.index,
        bound: s * 1.75,
      });
    }
    return out;
  }

  syncMeshes(get: (id: string) => THREE.Object3D | undefined) {
    for (const [id, d] of this.dyn) {
      const m = get(id);
      if (!m) continue;
      m.position.set(d.body.position.x, d.body.position.y, d.body.position.z);
      m.quaternion.set(d.body.quaternion.x, d.body.quaternion.y, d.body.quaternion.z, d.body.quaternion.w);
    }
  }

  position(id: string) {
    const d = this.dyn.get(id);
    return d ? new THREE.Vector3(d.body.position.x, d.body.position.y, d.body.position.z) : null;
  }

  beginDrag(id: string) {
    const d = this.dyn.get(id);
    if (d) {
      d.dragging = true;
      d.dragTarget.set(d.body.position.x, d.body.position.y, d.body.position.z);
    }
  }
  drag(id: string, target: THREE.Vector3) {
    const d = this.dyn.get(id);
    if (d) d.dragTarget.copy(target);
  }
  endDrag(id: string) {
    const d = this.dyn.get(id);
    if (d) d.dragging = false;
  }

  impulseAll(fn: (p: THREE.Vector3) => THREE.Vector3) {
    for (const d of this.dyn.values()) {
      const p = new THREE.Vector3(d.body.position.x, d.body.position.y, d.body.position.z);
      const dv = fn(p);
      d.body.velocity.x += dv.x;
      d.body.velocity.y += dv.y;
      d.body.velocity.z += dv.z;
    }
  }
}
