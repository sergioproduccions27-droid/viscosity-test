import * as THREE from 'three';
import type { Emitter } from '../types';
import { EMIT_STRIDE, MAX_EMIT, type MPMSolver } from './MPMSolver';

/**
 * Tracks which particle slots are free. The GPU owns the truth (dead particles have
 * material -1); a periodic async readback refreshes the free list. If no free slot is
 * known, the oldest live particle is recycled.
 */
export class SlotAllocator {
  private free: Int32Array;
  private freeCount: number;
  private allocFrame: Int32Array;
  private queue: Int32Array;
  private queueFrame: Int32Array;
  private qHead = 0;
  private qTail = 0;
  frame = 1;
  recycled = 0;

  constructor(readonly capacity: number) {
    this.free = new Int32Array(capacity);
    this.allocFrame = new Int32Array(capacity);
    this.queue = new Int32Array(capacity * 2);
    this.queueFrame = new Int32Array(capacity * 2);
    this.freeCount = 0;
    this.reset();
  }

  reset() {
    for (let i = 0; i < this.capacity; i++) this.free[i] = this.capacity - 1 - i;
    this.freeCount = this.capacity;
    this.allocFrame.fill(0);
    this.qHead = this.qTail = 0;
  }

  private mark(s: number) {
    this.allocFrame[s] = this.frame;
    const len = this.queue.length;
    this.queue[this.qTail] = s;
    this.queueFrame[this.qTail] = this.frame;
    this.qTail = (this.qTail + 1) % len;
    if (this.qTail === this.qHead) this.qHead = (this.qHead + 1) % len;
  }

  alloc(): number {
    while (this.freeCount > 0) {
      const s = this.free[--this.freeCount];
      this.mark(s);
      return s;
    }
    const len = this.queue.length;
    while (this.qHead !== this.qTail) {
      const s = this.queue[this.qHead];
      const f = this.queueFrame[this.qHead];
      this.qHead = (this.qHead + 1) % len;
      if (this.allocFrame[s] === f) {
        this.recycled++;
        this.mark(s);
        return s;
      }
    }
    return -1;
  }

  /** `dead(i)` reports the GPU state captured at `issueFrame`. */
  refresh(dead: (i: number) => boolean, issueFrame: number) {
    let n = 0;
    for (let i = this.capacity - 1; i >= 0; i--) {
      if (this.allocFrame[i] <= issueFrame && dead(i)) this.free[n++] = i;
    }
    this.freeCount = n;
  }

  get knownFree() {
    return this.freeCount;
  }
}

interface StreamState {
  acc: number;
}

const _col = new THREE.Color();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

export function emitterDirection(e: Pick<Emitter, 'rotation'>, out = new THREE.Vector3()) {
  _e.set(e.rotation[0], e.rotation[1], e.rotation[2], 'XYZ');
  _q.setFromEuler(_e);
  return out.set(0, -1, 0).applyQuaternion(_q);
}

/** Generates stream particles for all emitters every frame. */
export class EmissionSystem {
  private streams = new Map<string, StreamState[]>();
  private disks = new Map<string, Float32Array>();
  private dir = new THREE.Vector3();
  private u = new THREE.Vector3();
  private w = new THREE.Vector3();
  private nozzle = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  emittedTotal = 0;

  /** Hexagonal disk pattern (in cells) for a stream of radius r. */
  private disk(rCells: number, s: number): Float32Array {
    const key = `${rCells.toFixed(3)}:${s}`;
    const cached = this.disks.get(key);
    if (cached) return cached;
    const pts: number[] = [];
    const rowH = (s * Math.sqrt(3)) / 2;
    const R = Math.max(rCells, s * 0.5);
    const rows = Math.ceil(R / rowH) + 1;
    for (let j = -rows; j <= rows; j++) {
      const y = j * rowH;
      const off = Math.abs(j) % 2 === 1 ? s * 0.5 : 0;
      const cols = Math.ceil(R / s) + 1;
      for (let i = -cols; i <= cols; i++) {
        const x = i * s + off;
        if (x * x + y * y <= R * R + 1e-6) pts.push(x, y);
      }
    }
    if (pts.length === 0) pts.push(0, 0);
    const arr = new Float32Array(pts);
    this.disks.set(key, arr);
    return arr;
  }

  reset() {
    this.streams.clear();
  }

  /**
   * Emit particles for one frame. Returns how many were written to solver.emitData.
   * `slotOf` maps an emitter to its material slot.
   */
  generate(
    emitters: Emitter[],
    time: number,
    dt: number,
    solver: MPMSolver,
    alloc: SlotAllocator,
    slotOf: (e: Emitter) => number,
  ): number {
    const data = solver.emitData;
    const dx = solver.dx;
    const s = solver.spacing;
    const layerWorld = s * dx * 1.15; // hex packing compensation keeps rest density ≈ 1
    let count = 0;
    const live = new Set<string>();

    for (const e of emitters) {
      live.add(e.id);
      let states = this.streams.get(e.id);
      if (!states || states.length !== e.streams) {
        states = Array.from({ length: e.streams }, (_, k) => ({ acc: states?.[k]?.acc ?? Math.random() }));
        this.streams.set(e.id, states);
      }
      if (!e.enabled || e.flowSpeed <= 0) continue;
      const slotMat = slotOf(e);
      const temp = e.material.physics.temperature;
      emitterDirection(e, this.dir);
      // perpendicular basis
      this.u.set(1, 0, 0);
      if (Math.abs(this.dir.x) > 0.9) this.u.set(0, 0, 1);
      this.u.sub(this.tmp.copy(this.dir).multiplyScalar(this.u.dot(this.dir))).normalize();
      this.w.crossVectors(this.dir, this.u).normalize();
      const disk = this.disk(e.thickness / dx, s);
      const v0 = e.flowSpeed;

      for (let k = 0; k < e.streams; k++) {
        const st = states[k];
        st.acc += (v0 * dt) / layerWorld;
        while (st.acc >= 1) {
          st.acc -= 1;
          const tEmit = time + dt - (st.acc * layerWorld) / v0;
          const lag = tEmit - time; // particle sits upstream of the nozzle at frame start
          const theta = 2 * Math.PI * (e.twistSpeed * tEmit + k / e.streams);
          const tr = e.streams > 1 || e.twistSpeed !== 0 ? e.twistRadius : 0;
          this.nozzle
            .set(e.position[0], e.position[1], e.position[2])
            .addScaledVector(this.u, Math.cos(theta) * tr)
            .addScaledVector(this.w, Math.sin(theta) * tr)
            .addScaledVector(this.dir, -v0 * lag);
          if (e.material.rainbow) {
            _col.setHSL((((tEmit * 0.18 + k / Math.max(1, e.streams)) % 1) + 1) % 1, 0.95, 0.55);
          } else {
            _col.set(e.colors[k % Math.max(1, e.colors.length)] ?? '#ffffff');
          }
          _col.convertSRGBToLinear();
          const rot = Math.random() * Math.PI * 2;
          const cr = Math.cos(rot);
          const sr = Math.sin(rot);
          for (let i = 0; i < disk.length; i += 2) {
            if (count >= MAX_EMIT) break;
            const slot = alloc.alloc();
            if (slot < 0) break;
            const a = disk[i] * cr - disk[i + 1] * sr + (Math.random() - 0.5) * 0.12 * s;
            const b = disk[i] * sr + disk[i + 1] * cr + (Math.random() - 0.5) * 0.12 * s;
            // Random offset along the stream: avoids discrete particle disks that would
            // separate into clumps when gravity stretches the stream.
            const along = (Math.random() - 0.5) * layerWorld;
            const px = this.nozzle.x + (this.u.x * a + this.w.x * b) * dx + this.dir.x * along;
            const py = this.nozzle.y + (this.u.y * a + this.w.y * b) * dx + this.dir.y * along;
            const pz = this.nozzle.z + (this.u.z * a + this.w.z * b) * dx + this.dir.z * along;
            const o = count * EMIT_STRIDE;
            data[o] = slot;
            data[o + 1] = (px + 0.5) / dx;
            data[o + 2] = py / dx;
            data[o + 3] = (pz + 0.5) / dx;
            data[o + 4] = (this.dir.x * v0) / dx;
            data[o + 5] = (this.dir.y * v0) / dx;
            data[o + 6] = (this.dir.z * v0) / dx;
            data[o + 7] = _col.r;
            data[o + 8] = _col.g;
            data[o + 9] = _col.b;
            data[o + 10] = slotMat;
            data[o + 11] = temp;
            count++;
          }
        }
      }
    }
    for (const id of this.streams.keys()) if (!live.has(id)) this.streams.delete(id);
    this.emittedTotal += count;
    return count;
  }
}
