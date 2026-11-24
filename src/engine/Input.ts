import * as THREE from 'three';
import type { ToolId } from './types';

export interface PointerState {
  active: boolean;
  /** world position of the brush */
  pos: THREE.Vector3;
  /** smoothed world velocity of the brush (units/s) */
  vel: THREE.Vector3;
  screen: THREE.Vector2;
  hasSurface: boolean;
  normal: THREE.Vector3;
}

export interface InputCallbacks {
  tool: () => ToolId;
  pick: (ndc: THREE.Vector2) => { kind: string; id: string; point: THREE.Vector3 } | null;
  surface: (ndc: THREE.Vector2) => { point: THREE.Vector3; normal: THREE.Vector3 } | null;
  fluidDepth: (ndc: THREE.Vector2) => number | null; // view distance of the liquid under the cursor
  requestFluidDepth: (ndc: THREE.Vector2) => void;
  onSelect: (sel: { kind: string; id: string } | null) => void;
  onBodyDrag: (id: string, phase: 'start' | 'move' | 'end', target: THREE.Vector3) => void;
  isGizmoActive: () => boolean;
  onFirstGesture: () => void;
  onToolStart: () => void;
}

/**
 * Pointer handling for brush tools. Orbit/zoom is handled by OrbitControls on the
 * right mouse button / two-finger gestures (or left button with the orbit tool).
 */
export class InputSystem {
  readonly state: PointerState = {
    active: false,
    pos: new THREE.Vector3(0, 0.6, 0),
    vel: new THREE.Vector3(),
    screen: new THREE.Vector2(),
    hasSurface: false,
    normal: new THREE.Vector3(0, 1, 0),
  };
  /** hover position (for the brush cursor), valid when `hover` */
  hover = false;
  private pointers = new Map<number, PointerEvent>();
  private ndc = new THREE.Vector2();
  private lastPos = new THREE.Vector3();
  private lastTime = 0;
  private dragBody: string | null = null;
  private dragPlane = new THREE.Plane();
  private raycaster = new THREE.Raycaster();
  private gestured = false;
  private depthDist = 1.4;

  constructor(
    private el: HTMLElement,
    private camera: THREE.PerspectiveCamera,
    private target: () => THREE.Vector3,
    private cb: InputCallbacks,
  ) {
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    window.addEventListener('pointerup', this.up);
    window.addEventListener('pointercancel', this.up);
    el.addEventListener('pointerleave', () => (this.hover = false));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  dispose() {
    this.el.removeEventListener('pointerdown', this.down);
    this.el.removeEventListener('pointermove', this.move);
    window.removeEventListener('pointerup', this.up);
    window.removeEventListener('pointercancel', this.up);
  }

  private setNdc(e: PointerEvent) {
    const r = this.el.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.state.screen.copy(this.ndc);
  }

  /** Brush point: liquid surface if visible, else solid surface, else a camera-facing plane. */
  private brushPoint(): THREE.Vector3 {
    const s = this.cb.surface(this.ndc);
    this.cb.requestFluidDepth(this.ndc);
    const fd = this.cb.fluidDepth(this.ndc);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const ray = this.raycaster.ray;
    let p: THREE.Vector3 | null = null;
    this.state.hasSurface = false;
    if (fd !== null) {
      // fluid depth is view-space distance along -z; convert to ray distance
      const fwd = new THREE.Vector3();
      this.camera.getWorldDirection(fwd);
      const t = fd / Math.max(0.05, ray.direction.dot(fwd));
      const fp = ray.at(t, new THREE.Vector3());
      if (!s || fp.distanceTo(this.camera.position) < s.point.distanceTo(this.camera.position)) {
        p = fp;
        this.state.hasSurface = true;
        this.state.normal.copy(ray.direction).negate();
      }
    }
    if (!p && s) {
      p = s.point.clone().addScaledVector(s.normal, 0.015);
      this.state.hasSurface = true;
      this.state.normal.copy(s.normal);
    }
    if (!p) {
      const tgt = this.target();
      const dist = this.camera.position.distanceTo(tgt);
      p = ray.at(dist * 0.98, new THREE.Vector3());
      this.state.normal.copy(ray.direction).negate();
    }
    this.depthDist = p.distanceTo(this.camera.position);
    return p;
  }

  private down = (e: PointerEvent) => {
    if (!this.gestured) {
      this.gestured = true;
      this.cb.onFirstGesture();
    }
    this.pointers.set(e.pointerId, e);
    if (this.pointers.size > 1) {
      // second finger: hand over to orbit/zoom
      this.release();
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.cb.isGizmoActive()) return;
    const tool = this.cb.tool();
    this.setNdc(e);
    if (tool === 'orbit') return;
    if (tool === 'select') {
      const hit = this.cb.pick(this.ndc);
      this.cb.onSelect(hit ? { kind: hit.kind, id: hit.id } : null);
      if (hit && hit.kind === 'body') {
        this.dragBody = hit.id;
        const n = new THREE.Vector3();
        this.camera.getWorldDirection(n);
        this.dragPlane.setFromNormalAndCoplanarPoint(n.negate(), hit.point);
        this.cb.onBodyDrag(hit.id, 'start', hit.point);
        this.el.setPointerCapture(e.pointerId);
      }
      return;
    }
    this.el.setPointerCapture(e.pointerId);
    this.state.active = true;
    const p = this.brushPoint();
    this.state.pos.copy(p);
    this.lastPos.copy(p);
    this.state.vel.set(0, 0, 0);
    this.lastTime = performance.now();
    this.cb.onToolStart();
  };

  private move = (e: PointerEvent) => {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, e);
    this.setNdc(e);
    this.hover = e.pointerType === 'mouse';
    if (this.dragBody) {
      this.raycaster.setFromCamera(this.ndc, this.camera);
      const p = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.dragPlane, p)) {
        p.y = Math.max(p.y, 0.2);
        this.cb.onBodyDrag(this.dragBody, 'move', p);
      }
      return;
    }
    if (!this.state.active) {
      if (this.hover) {
        const tool = this.cb.tool();
        if (tool !== 'orbit' && tool !== 'select') this.state.pos.copy(this.brushPoint());
      }
      return;
    }
    const now = performance.now();
    const dt = Math.max(1, now - this.lastTime) / 1000;
    let p = this.brushPoint();
    // keep the brush at a stable depth while dragging through empty space
    if (!this.state.hasSurface) {
      this.raycaster.setFromCamera(this.ndc, this.camera);
      p = this.raycaster.ray.at(this.depthDist, new THREE.Vector3());
    }
    const v = p.clone().sub(this.lastPos).divideScalar(dt);
    this.state.vel.lerp(v.clampLength(0, 6), 0.35);
    this.state.pos.copy(p);
    this.lastPos.copy(p);
    this.lastTime = now;
  };

  private release() {
    this.state.active = false;
    this.state.vel.set(0, 0, 0);
    if (this.dragBody) {
      this.cb.onBodyDrag(this.dragBody, 'end', this.state.pos);
      this.dragBody = null;
    }
  }

  private up = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) this.release();
  };

  /** Called each frame to decay brush velocity when the pointer is still. */
  tick() {
    if (this.state.active && performance.now() - this.lastTime > 60) this.state.vel.multiplyScalar(0.8);
  }

  get touchCount() {
    return this.pointers.size;
  }
}
