import * as THREE from 'three';
import {
  MAX_BODIES,
  MAX_FORCES,
  MAX_MATS,
  MAX_PRIMS,
  bodyReduceFrag,
  bodyReduceVert,
  clearAuxFrag,
  clearMainFrag,
  emitAuxFrag,
  emitMainFrag,
  emitVert,
  fullscreenVert,
  g2p1Frag,
  g2p2Frag,
  gridFrag,
  packFrag,
  prepFrag,
  splatFrag,
  splatVert,
} from './shaders';

export interface SolverConfig {
  grid: [number, number, number];
  particleTex: [number, number];
}

/** Solid primitive in world units. */
export interface Prim {
  type: 0 | 1 | 2; // rounded box, sphere, lathe (revolved polyline)
  center: THREE.Vector3;
  quat: THREE.Quaternion;
  a: [number, number, number, number];
  b?: [number, number, number, number];
  thickness?: number;
  linVel?: THREE.Vector3;
  angVel?: THREE.Vector3;
  body?: number;
  friction?: number;
  bound: number;
}

export interface MaterialUniforms {
  a: THREE.Vector4;
  b: THREE.Vector4;
  c: THREE.Vector4;
  d: THREE.Vector4;
}

export interface ForceField {
  type: 0 | 1 | 2 | 3 | 4 | 5; // none, stir, whirlpool, attract, repel, push
  center: THREE.Vector3; // world
  vector: THREE.Vector3; // world units / s (stir target velocity or push accel)
  radius: number; // world
  strength: number;
  height?: number; // world (whirlpool vertical extent)
}

export interface BrushAction {
  type: 0 | 1 | 2 | 3 | 4; // none, heat, cool, dye, erase
  center: THREE.Vector3;
  radius: number;
  strength: number;
  dye?: THREE.Color;
}

export const EMIT_STRIDE = 12;
export const MAX_EMIT = 8192;
export const DOMAIN_ORIGIN = new THREE.Vector3(-0.5, 0, -0.5);
export const DOMAIN_WIDTH = 1.0;
export const DOMAIN_HEIGHT = 1.25;

function mrt(w: number, h: number, count: number, type: THREE.TextureDataType) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    count,
    type,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  for (const t of rt.textures) {
    t.generateMipmaps = false;
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
  }
  return rt;
}

type U<T> = { value: T };

export class MPMSolver {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly tilesX: number;
  readonly atlasW: number;
  readonly atlasH: number;
  readonly pw: number;
  readonly ph: number;
  readonly capacity: number;
  readonly dx: number;
  readonly spacing = 0.6; // particle spacing in cells (~4.6 particles per cell)
  readonly vp0: number;
  readonly halfFloatGrid: boolean;

  private renderer: THREE.WebGLRenderer;
  private stateMain: THREE.WebGLRenderTarget[];
  private stateAux: THREE.WebGLRenderTarget[];
  private cur = 0;
  private prepRT: THREE.WebGLRenderTarget;
  private splatRT: THREE.WebGLRenderTarget;
  private gridRT: THREE.WebGLRenderTarget;
  private bodyRT: THREE.WebGLRenderTarget;
  private packRT: THREE.WebGLRenderTarget;
  private cam = new THREE.Camera();
  private quad: THREE.Mesh;
  private splatPts: THREE.Points;
  private bodyPts: THREE.Points;
  private emitMainPts: THREE.Points;
  private emitAuxPts: THREE.Points;
  private emitGeo: THREE.BufferGeometry;
  private emitBuf: THREE.InterleavedBuffer;
  readonly emitData = new Float32Array(MAX_EMIT * EMIT_STRIDE);

  private prepMat: THREE.RawShaderMaterial;
  private gridMat: THREE.RawShaderMaterial;
  private g2p1Mat: THREE.RawShaderMaterial;
  private g2p2Mat: THREE.RawShaderMaterial;
  private clearMainMat: THREE.RawShaderMaterial;
  private clearAuxMat: THREE.RawShaderMaterial;
  private packMat: THREE.RawShaderMaterial;

  private primData: Float32Array;
  private primTex: THREE.DataTexture;

  // shared uniforms
  readonly u = {
    uGrid: { value: new THREE.Vector3() } as U<THREE.Vector3>,
    uTilesX: { value: 1 } as U<number>,
    uPTex: { value: new THREE.Vector2() } as U<THREE.Vector2>,
    uAtlas: { value: new THREE.Vector2() } as U<THREE.Vector2>,
    uDt: { value: 1 / 240 } as U<number>,
    uVp0: { value: 0.166 } as U<number>,
    uMatA: { value: Array.from({ length: MAX_MATS }, () => new THREE.Vector4(1, 1, 0, 1)) },
    uMatB: { value: Array.from({ length: MAX_MATS }, () => new THREE.Vector4(0, 0, 1, 1e9)) },
    uMatC: { value: Array.from({ length: MAX_MATS }, () => new THREE.Vector4(20, 0, -1e5, 0)) },
    uMatD: { value: Array.from({ length: MAX_MATS }, () => new THREE.Vector4(0, 0, 0, 1e9)) },
    uPrims: { value: null as unknown as THREE.Texture },
    uPrimCount: { value: 0 },
    uGravity: { value: new THREE.Vector3(0, -100, 0) },
    uFriction: { value: 0.4 },
    uWalls: { value: 0 },
    uContain: { value: new THREE.Vector4(0, 0, 0, 0) },
    uForceA: { value: Array.from({ length: MAX_FORCES }, () => new THREE.Vector4()) },
    uForceB: { value: Array.from({ length: MAX_FORCES }, () => new THREE.Vector4()) },
    uForceC: { value: Array.from({ length: MAX_FORCES }, () => new THREE.Vector4()) },
    uBrush: { value: new THREE.Vector4() },
    uBrushAct: { value: new THREE.Vector4() },
    uDye: { value: new THREE.Color(1, 1, 1) },
    uAmbient: { value: 20 },
    uMaxStep: { value: 0.9 },
    uSeed: { value: 0 },
    uBodyCenter: { value: Array.from({ length: MAX_BODIES }, () => new THREE.Vector3()) },
  };

  bodyCount = 0;
  stepsThisFrame = 0;
  simTime = 0;
  private readbackBusy = false;
  private bodyReadBusy = false;

  constructor(renderer: THREE.WebGLRenderer, cfg: SolverConfig) {
    this.renderer = renderer;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    gl.getExtension('EXT_color_buffer_float');
    const floatBlend = !!gl.getExtension('EXT_float_blend');
    this.halfFloatGrid = !floatBlend;
    const gridType = floatBlend ? THREE.FloatType : THREE.HalfFloatType;

    [this.nx, this.ny, this.nz] = cfg.grid;
    [this.pw, this.ph] = cfg.particleTex;
    this.capacity = this.pw * this.ph;
    this.dx = DOMAIN_WIDTH / this.nx;
    this.tilesX = Math.ceil(Math.sqrt(this.nz));
    const tilesY = Math.ceil(this.nz / this.tilesX);
    this.atlasW = this.nx * this.tilesX;
    this.atlasH = this.ny * tilesY;
    this.vp0 = this.spacing ** 3;

    const u = this.u;
    u.uGrid.value.set(this.nx, this.ny, this.nz);
    u.uTilesX.value = this.tilesX;
    u.uPTex.value.set(this.pw, this.ph);
    u.uAtlas.value.set(this.atlasW, this.atlasH);
    u.uVp0.value = this.vp0;

    this.stateMain = [mrt(this.pw, this.ph, 4, THREE.FloatType), mrt(this.pw, this.ph, 4, THREE.FloatType)];
    this.stateAux = [mrt(this.pw, this.ph, 3, THREE.FloatType), mrt(this.pw, this.ph, 3, THREE.FloatType)];
    this.prepRT = mrt(this.pw, this.ph, 4, THREE.FloatType);
    this.packRT = mrt(this.pw, this.ph, 2, THREE.FloatType);
    this.splatRT = mrt(this.atlasW, this.atlasH, 2, gridType);
    this.gridRT = mrt(this.atlasW, this.atlasH, 2, THREE.FloatType);
    this.bodyRT = mrt(MAX_BODIES, 1, 2, gridType);

    this.primData = new Float32Array(8 * MAX_PRIMS * 4);
    this.primTex = new THREE.DataTexture(this.primData, 8, MAX_PRIMS, THREE.RGBAFormat, THREE.FloatType);
    this.primTex.minFilter = THREE.NearestFilter;
    this.primTex.magFilter = THREE.NearestFilter;
    this.primTex.needsUpdate = true;
    u.uPrims.value = this.primTex;

    const raw = (vertexShader: string, fragmentShader: string, uniforms: Record<string, U<unknown>>, blend = false) => {
      const m = new THREE.RawShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms,
        glslVersion: THREE.GLSL3,
        depthTest: false,
        depthWrite: false,
      });
      if (blend) {
        m.blending = THREE.CustomBlending;
        m.blendEquation = THREE.AddEquation;
        m.blendSrc = THREE.OneFactor;
        m.blendDst = THREE.OneFactor;
        m.blendEquationAlpha = THREE.AddEquation;
        m.blendSrcAlpha = THREE.OneFactor;
        m.blendDstAlpha = THREE.OneFactor;
      } else {
        m.blending = THREE.NoBlending;
      }
      return m;
    };
    const tex = () => ({ value: null as THREE.Texture | null });

    const common = { uGrid: u.uGrid, uTilesX: u.uTilesX, uPTex: u.uPTex };
    const mats = { uMatA: u.uMatA, uMatB: u.uMatB, uMatC: u.uMatC, uMatD: u.uMatD };
    const prims = { uPrims: u.uPrims, uPrimCount: u.uPrimCount };

    this.prepMat = raw(fullscreenVert, prepFrag, {
      ...common, ...mats, uDt: u.uDt, uVp0: u.uVp0,
      T0: tex(), T1: tex(), T2: tex(), T3: tex(), T4: tex(), T5: tex(), T6: tex(),
    });
    const splatMat = raw(splatVert, splatFrag, {
      ...common, uAtlas: u.uAtlas, uVp0: u.uVp0, Q0: tex(), Q1: tex(), Q2: tex(), Q3: tex(), T6: tex(),
    }, true);
    this.gridMat = raw(fullscreenVert, gridFrag, {
      ...common, ...prims, G0: tex(), uDt: u.uDt, uGravity: u.uGravity, uFriction: u.uFriction, uWalls: u.uWalls,
      uContain: u.uContain, uForceA: u.uForceA, uForceB: u.uForceB, uForceC: u.uForceC,
    });
    const bodyMat = raw(bodyReduceVert, bodyReduceFrag, {
      ...common, uAtlas: u.uAtlas, Gb: tex(), uBodyCenter: u.uBodyCenter,
    }, true);
    this.g2p1Mat = raw(fullscreenVert, g2p1Frag, {
      ...common, ...mats, ...prims, T0: tex(), T1: tex(), T6: tex(), Gv: tex(), G1: tex(),
      uDt: u.uDt, uMaxStep: u.uMaxStep, uWalls: u.uWalls, uBrush: u.uBrush, uBrushAct: u.uBrushAct,
    });
    this.g2p2Mat = raw(fullscreenVert, g2p2Frag, {
      ...common, ...mats, N0: tex(), N2: tex(), N3: tex(), T4: tex(), T5: tex(), T6: tex(), G1: tex(),
      uDt: u.uDt, uAmbient: u.uAmbient, uBrush: u.uBrush, uBrushAct: u.uBrushAct, uDye: u.uDye, uSeed: u.uSeed,
    });
    this.clearMainMat = raw(fullscreenVert, clearMainFrag, { T0: tex(), T1: tex(), T2: tex(), T3: tex(), T6: tex(), uOnlyMat: { value: -1 } });
    this.clearAuxMat = raw(fullscreenVert, clearAuxFrag, { T4: tex(), T5: tex(), T6: tex(), uOnlyMat: { value: -1 } });
    this.packMat = raw(fullscreenVert, packFrag, { T0: tex(), T1: tex(), T5: tex(), T6: tex() });

    const quadGeo = new THREE.BufferGeometry();
    quadGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(quadGeo, this.prepMat);
    this.quad.frustumCulled = false;

    const splatGeo = new THREE.BufferGeometry();
    splatGeo.setDrawRange(0, this.capacity * 27);
    this.splatPts = new THREE.Points(splatGeo, splatMat);
    this.splatPts.frustumCulled = false;

    const bodyGeo = new THREE.BufferGeometry();
    bodyGeo.setDrawRange(0, this.atlasW * this.atlasH);
    this.bodyPts = new THREE.Points(bodyGeo, bodyMat);
    this.bodyPts.frustumCulled = false;

    this.emitBuf = new THREE.InterleavedBuffer(this.emitData, EMIT_STRIDE);
    this.emitBuf.setUsage(THREE.DynamicDrawUsage);
    this.emitGeo = new THREE.BufferGeometry();
    this.emitGeo.setAttribute('aSlot', new THREE.InterleavedBufferAttribute(this.emitBuf, 1, 0));
    this.emitGeo.setAttribute('aPos', new THREE.InterleavedBufferAttribute(this.emitBuf, 3, 1));
    this.emitGeo.setAttribute('aVel', new THREE.InterleavedBufferAttribute(this.emitBuf, 3, 4));
    this.emitGeo.setAttribute('aCol', new THREE.InterleavedBufferAttribute(this.emitBuf, 3, 7));
    this.emitGeo.setAttribute('aMisc', new THREE.InterleavedBufferAttribute(this.emitBuf, 2, 10));
    const emitMain = raw(emitVert, emitMainFrag, { uPTex: u.uPTex });
    const emitAux = raw(emitVert, emitAuxFrag, { uPTex: u.uPTex });
    this.emitMainPts = new THREE.Points(this.emitGeo, emitMain);
    this.emitAuxPts = new THREE.Points(this.emitGeo, emitAux);
    this.emitMainPts.frustumCulled = false;
    this.emitAuxPts.frustumCulled = false;

    this.clear();
  }

  // ---- texture accessors for rendering ----
  get posTex() { return this.stateMain[this.cur].textures[0]; }
  get velTex() { return this.stateMain[this.cur].textures[1]; }
  get auxTex() { return this.stateAux[this.cur].textures[1]; }
  get colTex() { return this.stateAux[this.cur].textures[2]; }

  worldToGrid(v: THREE.Vector3, out = new THREE.Vector3()) {
    return out.copy(v).sub(DOMAIN_ORIGIN).divideScalar(this.dx);
  }

  setMaterial(slot: number, m: MaterialUniforms) {
    this.u.uMatA.value[slot].copy(m.a);
    this.u.uMatB.value[slot].copy(m.b);
    this.u.uMatC.value[slot].copy(m.c);
    this.u.uMatD.value[slot].copy(m.d);
  }

  setGravity(g: THREE.Vector3) {
    this.u.uGravity.value.copy(g).divideScalar(this.dx);
  }

  setPrims(prims: Prim[]) {
    const d = this.primData;
    d.fill(0);
    const n = Math.min(prims.length, MAX_PRIMS);
    const inv = 1 / this.dx;
    const c = new THREE.Vector3();
    let bodies = 0;
    for (let i = 0; i < n; i++) {
      const p = prims[i];
      const o = i * 8 * 4;
      this.worldToGrid(p.center, c);
      d.set([c.x, c.y, c.z, p.type], o);
      d.set([p.quat.x, p.quat.y, p.quat.z, p.quat.w], o + 4);
      const a = p.a;
      if (p.type === 0) d.set([a[0] * inv, a[1] * inv, a[2] * inv, a[3] * inv], o + 8);
      else if (p.type === 1) d.set([a[0] * inv, 0, 0, 0], o + 8);
      else d.set([a[0] * inv, a[1] * inv, a[2] * inv, a[3] * inv], o + 8);
      const b = p.b ?? [a[2], a[3], a[2], a[3]];
      d.set([b[0] * inv, b[1] * inv, b[2] * inv, b[3] * inv], o + 12);
      const lv = p.linVel;
      const body = p.body ?? -1;
      if (body >= 0) bodies = Math.max(bodies, body + 1);
      d.set([lv ? lv.x * inv : 0, lv ? lv.y * inv : 0, lv ? lv.z * inv : 0, body], o + 16);
      const av = p.angVel;
      d.set([av ? av.x : 0, av ? av.y : 0, av ? av.z : 0, p.friction ?? 1], o + 20);
      d.set([p.bound * inv + 1.5, (p.thickness ?? 0) * inv, 0, 0], o + 24);
      if (body >= 0) this.u.uBodyCenter.value[body].copy(c);
    }
    this.u.uPrimCount.value = n;
    this.bodyCount = bodies;
    this.primTex.needsUpdate = true;
  }

  setForces(fields: ForceField[]) {
    const u = this.u;
    const inv = 1 / this.dx;
    const c = new THREE.Vector3();
    for (let i = 0; i < MAX_FORCES; i++) {
      const f = fields[i];
      if (!f || f.type === 0) {
        u.uForceA.value[i].set(0, 0, 0, 0);
        continue;
      }
      this.worldToGrid(f.center, c);
      u.uForceA.value[i].set(c.x, c.y, c.z, f.type);
      u.uForceB.value[i].set(f.vector.x * inv, f.vector.y * inv, f.vector.z * inv, f.radius * inv);
      u.uForceC.value[i].set(f.strength, (f.height ?? 10) * inv, 0, 0);
    }
  }

  setBrush(b: BrushAction | null) {
    const u = this.u;
    if (!b || b.type === 0) {
      u.uBrushAct.value.set(0, 0, 0, 0);
      return;
    }
    const c = this.worldToGrid(b.center);
    u.uBrush.value.set(c.x, c.y, c.z, b.radius / this.dx);
    u.uBrushAct.value.set(b.type, b.strength, 0, 0);
    if (b.dye) u.uDye.value.copy(b.dye);
  }

  private pass(mat: THREE.RawShaderMaterial, target: THREE.WebGLRenderTarget) {
    const r = this.renderer;
    const prevAuto = r.autoClear;
    r.autoClear = false;
    this.quad.material = mat;
    r.setRenderTarget(target);
    r.render(this.quad, this.cam);
    r.autoClear = prevAuto;
  }

  private bindTex(mat: THREE.RawShaderMaterial, map: Record<string, THREE.Texture>) {
    for (const k in map) mat.uniforms[k].value = map[k];
  }

  /** Advance the simulation by dt seconds using n substeps. */
  step(dt: number, substeps: number) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    const h = dt / substeps;
    this.u.uDt.value = h;
    if (this.bodyCount > 0) {
      r.setRenderTarget(this.bodyRT);
      r.setClearColor(0x000000, 0);
      r.clear(true, false, false);
    }
    for (let s = 0; s < substeps; s++) {
      this.u.uSeed.value = Math.random() * 100;
      this.substep();
    }
    this.simTime += dt;
    this.stepsThisFrame = substeps;
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
  }

  private substep() {
    const r = this.renderer;
    const src = this.cur;
    const dst = 1 - src;
    const sm = this.stateMain[src].textures;
    const sa = this.stateAux[src].textures;

    this.bindTex(this.prepMat, { T0: sm[0], T1: sm[1], T2: sm[2], T3: sm[3], T4: sa[0], T5: sa[1], T6: sa[2] });
    this.pass(this.prepMat, this.prepRT);

    const pt = this.prepRT.textures;
    const splatMat = this.splatPts.material as THREE.RawShaderMaterial;
    this.bindTex(splatMat, { Q0: pt[0], Q1: pt[1], Q2: pt[2], Q3: pt[3], T6: sa[2] });
    r.setRenderTarget(this.splatRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, false, false);
    r.render(this.splatPts, this.cam);

    this.bindTex(this.gridMat, { G0: this.splatRT.textures[0] });
    this.pass(this.gridMat, this.gridRT);

    if (this.bodyCount > 0) {
      (this.bodyPts.material as THREE.RawShaderMaterial).uniforms.Gb.value = this.gridRT.textures[1];
      r.setRenderTarget(this.bodyRT);
      r.render(this.bodyPts, this.cam);
    }

    this.bindTex(this.g2p1Mat, { T0: sm[0], T1: sm[1], T6: sa[2], Gv: this.gridRT.textures[0], G1: this.splatRT.textures[1] });
    this.pass(this.g2p1Mat, this.stateMain[dst]);

    const nm = this.stateMain[dst].textures;
    this.bindTex(this.g2p2Mat, { N0: nm[0], N2: nm[2], N3: nm[3], T4: sa[0], T5: sa[1], T6: sa[2], G1: this.splatRT.textures[1] });
    this.pass(this.g2p2Mat, this.stateAux[dst]);

    this.cur = dst;
  }

  /** Write `count` new particles from emitData into the current state. */
  emit(count: number) {
    if (count <= 0) return;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAuto = r.autoClear;
    r.autoClear = false;
    this.emitBuf.needsUpdate = true;
    this.emitBuf.clearUpdateRanges();
    this.emitBuf.addUpdateRange(0, count * EMIT_STRIDE);
    this.emitGeo.setDrawRange(0, count);
    r.setRenderTarget(this.stateMain[this.cur]);
    r.render(this.emitMainPts, this.cam);
    r.setRenderTarget(this.stateAux[this.cur]);
    r.render(this.emitAuxPts, this.cam);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAuto;
  }

  /** Kill all particles (or only those of one material slot). */
  clear(onlyMat = -1) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const src = this.cur;
    const dst = 1 - src;
    const sm = this.stateMain[src].textures;
    const sa = this.stateAux[src].textures;
    this.clearMainMat.uniforms.uOnlyMat.value = onlyMat;
    this.clearAuxMat.uniforms.uOnlyMat.value = onlyMat;
    this.bindTex(this.clearMainMat, { T0: sm[0], T1: sm[1], T2: sm[2], T3: sm[3], T6: sa[2] });
    this.pass(this.clearMainMat, this.stateMain[dst]);
    this.bindTex(this.clearAuxMat, { T4: sa[0], T5: sa[1], T6: sa[2] });
    this.pass(this.clearAuxMat, this.stateAux[dst]);
    this.cur = dst;
    r.setRenderTarget(prevTarget);
  }

  /**
   * Asynchronously read back particle positions/speeds and colours/material/temperature.
   * Resolves to null when a read is already in flight.
   */
  async readParticles(): Promise<{ pos: Float32Array; col: Float32Array } | null> {
    if (this.readbackBusy) return null;
    this.readbackBusy = true;
    try {
      const r = this.renderer;
      const prevTarget = r.getRenderTarget();
      const sm = this.stateMain[this.cur].textures;
      const sa = this.stateAux[this.cur].textures;
      this.bindTex(this.packMat, { T0: sm[0], T1: sm[1], T5: sa[1], T6: sa[2] });
      this.pass(this.packMat, this.packRT);
      r.setRenderTarget(prevTarget);
      const n = this.capacity * 4;
      const pos = new Float32Array(n);
      const col = new Float32Array(n);
      const p1 = r.readRenderTargetPixelsAsync(this.packRT, 0, 0, this.pw, this.ph, pos, undefined, 0);
      const p2 = r.readRenderTargetPixelsAsync(this.packRT, 0, 0, this.pw, this.ph, col, undefined, 1);
      await Promise.all([p1, p2]);
      return { pos, col };
    } finally {
      this.readbackBusy = false;
    }
  }

  /** Read accumulated fluid->body impulses (grid units) of the last step. */
  async readBodyImpulses(): Promise<{ force: Float32Array; torque: Float32Array } | null> {
    if (this.bodyReadBusy || this.bodyCount === 0) return null;
    this.bodyReadBusy = true;
    try {
      const r = this.renderer;
      if (this.halfFloatGrid) {
        const a = new Uint16Array(MAX_BODIES * 4);
        const b = new Uint16Array(MAX_BODIES * 4);
        await Promise.all([
          r.readRenderTargetPixelsAsync(this.bodyRT, 0, 0, MAX_BODIES, 1, a, undefined, 0),
          r.readRenderTargetPixelsAsync(this.bodyRT, 0, 0, MAX_BODIES, 1, b, undefined, 1),
        ]);
        const conv = (x: Uint16Array) => Float32Array.from(x, (h) => THREE.DataUtils.fromHalfFloat(h));
        return { force: conv(a), torque: conv(b) };
      }
      const force = new Float32Array(MAX_BODIES * 4);
      const torque = new Float32Array(MAX_BODIES * 4);
      await Promise.all([
        r.readRenderTargetPixelsAsync(this.bodyRT, 0, 0, MAX_BODIES, 1, force, undefined, 0),
        r.readRenderTargetPixelsAsync(this.bodyRT, 0, 0, MAX_BODIES, 1, torque, undefined, 1),
      ]);
      return { force, torque };
    } finally {
      this.bodyReadBusy = false;
    }
  }

  dispose() {
    for (const rt of [...this.stateMain, ...this.stateAux, this.prepRT, this.splatRT, this.gridRT, this.bodyRT, this.packRT]) rt.dispose();
    this.primTex.dispose();
    for (const m of [this.prepMat, this.gridMat, this.g2p1Mat, this.g2p2Mat, this.clearMainMat, this.clearAuxMat, this.packMat]) m.dispose();
    (this.splatPts.material as THREE.Material).dispose();
    (this.bodyPts.material as THREE.Material).dispose();
    (this.emitMainPts.material as THREE.Material).dispose();
    (this.emitAuxPts.material as THREE.Material).dispose();
    this.emitGeo.dispose();
    this.quad.geometry.dispose();
  }
}
