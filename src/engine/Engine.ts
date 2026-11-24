import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { useStore, type AppState } from '../state/store';
import { SoundEngine } from './audio/Sound';
import { InputSystem } from './Input';
import { BodySystem } from './physics/Bodies';
import { ENVIRONMENTS, EnvironmentSystem, displayColor } from './render/Environment';
import { FluidRenderer } from './render/FluidRenderer';
import { Post } from './render/Post';
import { Stage, fogUniforms } from './render/Stage';
import { PLATFORM, PLATFORM_TOP, obstaclePrim, platformQuat, stagePrims } from './SceneLayout';
import { EmissionSystem, SlotAllocator } from './sim/Emission';
import { MPMSolver, DOMAIN_ORIGIN, type ForceField, type BrushAction, type Prim } from './sim/MPMSolver';
import { physicsToUniforms, shearSpeeds } from './sim/materialUniforms';
import { MAX_MATS } from './sim/shaders';
import type { Emitter, FluidStats, QualityTier } from './types';
import { createMode, type ModeController } from './modes';

export const BASE_GRAVITY = 1.6;

export const TIERS: Record<QualityTier, {
  grid: [number, number, number];
  ptex: [number, number];
  fluidScale: number;
  smooth: number;
  maxSub: number;
  shadow: number;
  dprCap: number;
}> = {
  low: { grid: [48, 60, 48], ptex: [256, 96], fluidScale: 0.6, smooth: 2, maxSub: 6, shadow: 1024, dprCap: 1.25 },
  medium: { grid: [64, 80, 64], ptex: [256, 192], fluidScale: 0.7, smooth: 3, maxSub: 8, shadow: 1536, dprCap: 1.5 },
  high: { grid: [80, 100, 80], ptex: [512, 192], fluidScale: 0.8, smooth: 3, maxSub: 10, shadow: 2048, dprCap: 2 },
  ultra: { grid: [96, 120, 96], ptex: [512, 384], fluidScale: 0.9, smooth: 3, maxSub: 12, shadow: 2048, dprCap: 2 },
};
const TIER_ORDER: QualityTier[] = ['low', 'medium', 'high', 'ultra'];

export interface ReadbackData {
  pos: Float32Array;
  col: Float32Array;
  dx: number;
  count: number;
}

const _c = new THREE.Color();

function detectTier(gl: WebGL2RenderingContext): { tier: QualityTier; gpu: string } {
  let gpu = '';
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  if (dbg) gpu = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 600;
  const g = gpu.toLowerCase();
  if (/swiftshader|llvmpipe|software|basic render/.test(g)) return { tier: 'low', gpu };
  if (coarse && small) return { tier: /apple|adreno \(tm\) 7[3-9]|mali-g7[1-9]|immortalis/.test(g) ? 'medium' : 'low', gpu };
  if (/rtx|radeon rx|geforce gtx 1[06-9]|apple m[2-9]|apple m1 (pro|max|ultra)|arc a/.test(g)) return { tier: 'high', gpu };
  return { tier: 'medium', gpu };
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly gizmo: TransformControls;
  readonly overlay = new THREE.Scene();
  private transparentScene = new THREE.Scene();
  readonly env: EnvironmentSystem;
  readonly stage = new Stage();
  readonly bodies = new BodySystem();
  readonly sound = new SoundEngine();
  readonly emission = new EmissionSystem();
  solver!: MPMSolver;
  fluid!: FluidRenderer;
  alloc!: SlotAllocator;
  private post: Post;
  private sceneRT: THREE.WebGLRenderTarget;
  private compRT: THREE.WebGLRenderTarget;
  private glassRT: THREE.WebGLRenderTarget;
  private keyLight: THREE.DirectionalLight;
  private rimLight: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  readonly input: InputSystem;
  private cursor: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private clock = new THREE.Clock();
  private raf = 0;
  private disposed = false;
  tier: QualityTier = 'medium';
  private gpu = '';
  private time = 0;
  private frame = 0;
  private spinAngle = 0;
  private prevTilt: [number, number] = [0, 0];
  private gravity = new THREE.Vector3(0, -BASE_GRAVITY, 0);
  private lastEmitters: Emitter[] | null = null;
  private lastObstacles: AppState['obstacles'] | null = null;
  private lastBodies: AppState['bodies'] | null = null;
  private lastEnv = '';
  private lastRevision = -1;
  private lastMode = '';
  private slotByEmitter = new Map<string, number>();
  private readbackFrame = 0;
  private fpsAcc = { frames: 0, time: 0, slowTime: 0, fastTime: 0 };
  private pixelRatio = 1;
  private autoChecked = false;
  private startTime = performance.now();
  private screenshotCb: ((b: Blob | null) => void) | null = null;
  private recorder: MediaRecorder | null = null;
  private recordChunks: Blob[] = [];
  private recordStart = 0;
  mode: ModeController | null = null;
  private modeId = '';
  private obstaclePrev = new Map<string, { p: THREE.Vector3; r: THREE.Euler }>();
  /** extra transient emitters driven by modes / the pour tool */
  extraEmitters: Emitter[] = [];
  extraForces: ForceField[] = [];
  lastReadback: ReadbackData | null = null;
  readbackListeners = new Set<(d: ReadbackData) => void>();
  private landing = 0;
  private dissolveT = -1;
  private gizmoDragging = false;
  private cameraShake = 0;
  private autoRotate = false;
  private viewInset = 0;
  private viewInsetB = 0;
  private resizePending = false;
  /** On phones the tool strip + transport cover the bottom of the screen: lift the stage. */
  private bottomInsetTarget(s: AppState) {
    return this.container.clientWidth <= 900 && !s.uiHidden ? Math.min(200, this.container.clientHeight * 0.24) : 0;
  }

  constructor(private container: HTMLElement) {
    const canvas = document.createElement('canvas');
    canvas.className = 'gl-canvas';
    container.appendChild(canvas);
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL 2 is not available on this device or browser.');
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('This GPU cannot render to floating-point textures (EXT_color_buffer_float), which the GPU fluid solver needs.');
    }
    this.renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: false });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const det = detectTier(gl);
    this.gpu = det.gpu;
    const st = useStore.getState();
    this.tier = st.quality === 'auto' ? det.tier : st.quality;

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.02, 60);
    this.camera.position.set(0, 0.82, 1.7);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.64, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.35;
    this.controls.maxDistance = 4;
    this.controls.maxPolarAngle = Math.PI * 0.92;
    this.controls.autoRotateSpeed = 0.6;

    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.setSize(0.8);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.gizmoDragging = !!(e as unknown as { value: boolean }).value;
      this.controls.enabled = !this.gizmoDragging;
    });
    this.gizmo.addEventListener('objectChange', () => this.onGizmoChange());
    this.overlay.add(this.gizmo.getHelper());

    this.cursor = new THREE.Mesh(
      new THREE.RingGeometry(0.92, 1, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthTest: false, side: THREE.DoubleSide }),
    );
    this.cursor.visible = false;
    this.overlay.add(this.cursor);

    this.env = new EnvironmentSystem(this.renderer);
    this.scene.add(this.env.sky);
    this.scene.add(this.stage.group);
    this.transparentScene.add(this.stage.transparentGroup);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x332255, 0.55);
    this.scene.add(this.hemi);
    this.keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
    this.keyLight.position.set(0.55, 1.75, 0.85);
    this.keyLight.target.position.set(0, 0.45, 0);
    this.keyLight.castShadow = true;
    const sc = this.keyLight.shadow.camera as THREE.OrthographicCamera;
    sc.left = -0.6;
    sc.right = 0.6;
    sc.top = 0.6;
    sc.bottom = -0.6;
    sc.near = 0.1;
    sc.far = 3.5;
    this.keyLight.shadow.bias = -0.0005;
    this.keyLight.shadow.normalBias = 0.006;
    this.keyLight.shadow.camera.layers.enable(FluidRenderer.SHADOW_LAYER);
    this.scene.add(this.keyLight, this.keyLight.target);
    this.rimLight = new THREE.DirectionalLight(0xb9a0ff, 1.2);
    this.rimLight.position.set(-0.8, 0.9, -1.2);
    this.scene.add(this.rimLight);

    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(1, 1),
    });
    this.compRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.glassRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(1, 1) });
    this.post = new Post(this.renderer);

    this.buildTier(this.tier);

    this.input = new InputSystem(canvas, this.camera, () => this.controls.target, {
      tool: () => useStore.getState().tool,
      pick: (ndc) => this.pick(ndc),
      surface: (ndc) => this.surface(ndc),
      fluidDepth: () => this.fluid.pickedDepth,
      requestFluidDepth: (ndc) => this.fluid.requestPick(ndc),
      onSelect: (sel) => this.select(sel as AppState['selection']),
      onBodyDrag: (id, phase, target) => {
        if (phase === 'start') this.bodies.beginDrag(id);
        else if (phase === 'move') this.bodies.drag(id, target);
        else this.bodies.endDrag(id);
      },
      isGizmoActive: () => this.gizmo.dragging || (this.gizmo as unknown as { axis: string | null }).axis !== null,
      onFirstGesture: () => this.sound.ensure(),
      onToolStart: () => {
        const t = useStore.getState().tool;
        if (t === 'stir' || t === 'whirlpool') this.sound.whoosh();
      },
    });

    window.addEventListener('resize', this.onResize);
    this.onResize();
    this.frameCamera();
    this.applyEnvironment(useStore.getState().environment);
    useStore.setState({ engineReady: true, activeTier: this.tier });
    this.loop();
  }

  // ------------------------------------------------------------------ setup
  private buildTier(tier: QualityTier) {
    const cfg = TIERS[tier];
    if (this.solver) {
      this.solver.dispose();
      this.fluid.dispose();
      this.scene.remove(this.fluid.shadowCaster);
    }
    this.tier = tier;
    this.solver = new MPMSolver(this.renderer, { grid: cfg.grid, particleTex: cfg.ptex });
    this.fluid = new FluidRenderer(this.renderer, this.solver);
    this.fluid.scale = cfg.fluidScale;
    this.fluid.smoothIterations = cfg.smooth;
    this.scene.add(this.fluid.shadowCaster);
    this.alloc = new SlotAllocator(this.solver.capacity);
    this.emission.reset();
    this.keyLight.shadow.mapSize.set(cfg.shadow, cfg.shadow);
    this.keyLight.shadow.map?.dispose();
    this.keyLight.shadow.map = null;
    this.lastObstacles = null;
    this.lastBodies = null;
    this.lastEmitters = null;
    this.lastEnv = '';
    this.slotByEmitter.clear();
    this.onResize();
    useStore.setState({ activeTier: tier });
  }

  setQuality(q: 'auto' | QualityTier) {
    const target = q === 'auto' ? detectTier(this.renderer.getContext() as WebGL2RenderingContext).tier : q;
    this.autoChecked = q !== 'auto';
    this.startTime = performance.now();
    if (target !== this.tier) {
      this.buildTier(target);
      useStore.getState().toast(`Quality: ${target} — liquid reset`, 'info');
    }
  }

  private onResize = () => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    const cap = TIERS[this.tier].dprCap;
    if (!this.pixelRatio || this.pixelRatio > Math.min(window.devicePixelRatio || 1, cap)) this.pixelRatio = Math.min(window.devicePixelRatio || 1, cap);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    const pw = Math.max(1, Math.floor(w * this.pixelRatio));
    const ph = Math.max(1, Math.floor(h * this.pixelRatio));
    this.sceneRT.setSize(pw, ph);
    this.compRT.setSize(pw, ph);
    this.glassRT.setSize(pw, ph);
    this.fluid?.setSize(pw, ph);
    this.post.setSize(Math.floor(pw / 2), Math.floor(ph / 2));
    const prevAspect = this.camera.aspect;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // keep the stage framed when the window shape changes a lot (e.g. phone rotation)
    if (this.frame > 0 && Math.abs(Math.log(prevAspect / this.camera.aspect)) > 0.25) this.frameCamera(true);
  };

  frameCamera(animate = false) {
    const aspect = this.container.clientWidth / Math.max(1, this.container.clientHeight);
    const h = Math.max(1, this.container.clientHeight);
    const kVis = h / (h + this.bottomInsetTarget(useStore.getState()));
    const tanH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * kVis;
    const needW = 0.42; // half-width to keep in view
    const needH = 0.6;
    const dist = Math.max(needH / tanH, needW / (aspect * tanH)) * 1.02;
    const dir = new THREE.Vector3(0, 0.12, 1).normalize();
    const target = new THREE.Vector3(0, 0.66, 0);
    const pos = target.clone().addScaledVector(dir, dist);
    if (!animate) {
      this.controls.target.copy(target);
      this.camera.position.copy(pos);
    } else {
      this.camTween = { from: this.camera.position.clone(), to: pos, tFrom: this.controls.target.clone(), tTo: target, t: 0 };
    }
  }
  private camTween: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; t: number } | null = null;

  applyEnvironment(id: string) {
    const preset = ENVIRONMENTS.find((e) => e.id === id) ?? ENVIRONMENTS[0];
    this.env.apply(preset, this.scene);
    this.lastEnv = id;
    displayColor(preset.fog, preset.exposure, fogUniforms.uFogColor.value);
    this.fluid.compositeMat.uniforms.uFogColor.value.copy(fogUniforms.uFogColor.value);
    this.keyLight.color.set(preset.light);
    this.rimLight.color.set(preset.rim);
    this.hemi.color.set(preset.top);
    this.hemi.groundColor.set(preset.bottom);
    this.stage.setSlabColor(preset.slab);
    this.post.exposure = preset.exposure;
    this.fluid.compositeMat.uniforms.uEnv.value = this.env.envCube;
    this.fluid.compositeMat.uniforms.uEnvMaxLod.value = this.env.envMaxLod;
  }

  // ------------------------------------------------------------------ picking
  private pick(ndc: THREE.Vector2) {
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.stage.pickables(), true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && !o.userData.pick) o = o.parent;
      if (o?.userData.pick) return { ...(o.userData.pick as { kind: string; id: string }), point: h.point };
    }
    return null;
  }

  private surface(ndc: THREE.Vector2) {
    this.raycaster.setFromCamera(ndc, this.camera);
    const objs: THREE.Object3D[] = [this.stage.platform, ...this.stage.pillar.children, ...this.stage.pickables().filter((o) => o.userData.pick?.kind !== 'emitter'), this.stage.transparentGroup];
    const hits = this.raycaster.intersectObjects(objs, true);
    const h = hits[0];
    if (!h) return null;
    const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    return { point: h.point.clone(), normal: n };
  }

  select(sel: AppState['selection']) {
    useStore.setState({ selection: sel });
    if (sel?.kind === 'emitter') useStore.setState({ selectedEmitterId: sel.id });
  }

  private onGizmoChange() {
    const s = useStore.getState();
    const sel = s.selection;
    const obj = this.gizmo.object;
    if (!sel || !obj) return;
    const pos: [number, number, number] = [
      THREE.MathUtils.clamp(obj.position.x, -0.47, 0.47),
      THREE.MathUtils.clamp(obj.position.y, 0.05, 1.18),
      THREE.MathUtils.clamp(obj.position.z, -0.47, 0.47),
    ];
    obj.position.set(...pos);
    if (sel.kind === 'emitter') {
      if (this.gizmo.mode === 'rotate') {
        const e = new THREE.Euler().setFromQuaternion(obj.quaternion, 'XYZ');
        // emitter meshes are oriented so local -y follows the stream direction
        s.updateEmitter(sel.id, { position: pos, rotation: [e.x, e.y, e.z] });
      } else s.updateEmitter(sel.id, { position: pos });
    } else if (sel.kind === 'obstacle') {
      s.updateObstacle(sel.id, { position: pos, rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z] });
    }
  }

  private syncGizmo(s: AppState) {
    const sel = s.selection;
    let obj: THREE.Object3D | undefined;
    if (sel && s.tool === 'select') {
      if (sel.kind === 'emitter') obj = this.stage.emitterObject(sel.id);
      else if (sel.kind === 'obstacle') obj = this.stage.obstacleObject(sel.id);
    }
    if (obj) {
      if (this.gizmo.object !== obj) this.gizmo.attach(obj);
      if (this.gizmo.mode !== s.transformMode) this.gizmo.setMode(s.transformMode);
      this.gizmo.getHelper().visible = true;
    } else if (this.gizmo.object) {
      this.gizmo.detach();
    }
  }

  // ------------------------------------------------------------------ actions
  clearLiquid(animated = true) {
    if (animated) this.dissolveT = 0;
    else {
      this.solver.clear();
      this.alloc.reset();
    }
  }

  /** Small JPEG data URL of the next rendered frame (drawn right after rendering). */
  thumbnail(width = 160): Promise<string | undefined> {
    return new Promise((res) => {
      this.thumbCb = (canvas) => {
        const c = document.createElement('canvas');
        c.width = width;
        c.height = Math.round((canvas.height / canvas.width) * width);
        c.getContext('2d')?.drawImage(canvas, 0, 0, c.width, c.height);
        res(c.toDataURL('image/jpeg', 0.72));
      };
    });
  }
  private thumbCb: ((c: HTMLCanvasElement) => void) | null = null;

  screenshot(): Promise<Blob | null> {
    return new Promise((res) => {
      this.screenshotCb = res;
    });
  }

  get recording() {
    return !!this.recorder;
  }

  startRecording(): boolean {
    const canvas = this.renderer.domElement;
    if (!('captureStream' in canvas) || typeof MediaRecorder === 'undefined') return false;
    const stream = canvas.captureStream(60);
    const audio = this.sound.stream;
    if (audio && this.sound.enabled) audio.getAudioTracks().forEach((t) => stream.addTrack(t));
    const types = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
    try {
      this.recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 12_000_000 } : undefined);
    } catch {
      return false;
    }
    this.recordChunks = [];
    this.recorder.ondataavailable = (e) => e.data.size && this.recordChunks.push(e.data);
    this.recorder.start(250);
    this.recordStart = performance.now();
    return true;
  }

  stopRecording(): Promise<Blob | null> {
    const rec = this.recorder;
    if (!rec) return Promise.resolve(null);
    return new Promise((res) => {
      rec.onstop = () => {
        const type = rec.mimeType || 'video/webm';
        res(new Blob(this.recordChunks, { type }));
        this.recorder = null;
      };
      rec.stop();
    });
  }

  shake(amount = 1) {
    this.cameraShake = Math.max(this.cameraShake, amount);
  }

  setAutoRotate(on: boolean) {
    this.autoRotate = on;
  }

  /** Apply an impulse to every body (chaos events) */
  kickBodies(fn: (p: THREE.Vector3) => THREE.Vector3) {
    this.bodies.impulseAll(fn);
  }

  // ------------------------------------------------------------------ per-frame
  private slotFor(e: Emitter): number {
    let s = this.slotByEmitter.get(e.id);
    if (s === undefined) {
      const used = new Set(this.slotByEmitter.values());
      s = 0;
      while (used.has(s) && s < MAX_MATS - 1) s++;
      this.slotByEmitter.set(e.id, s);
    }
    return s;
  }

  private updateMaterials(emitters: Emitter[]) {
    const live = new Set(emitters.map((e) => e.id));
    for (const id of this.slotByEmitter.keys()) if (!live.has(id) && !id.startsWith('x')) this.slotByEmitter.delete(id);
    const look = this.fluid.look;
    for (const e of emitters) {
      const slot = this.slotFor(e);
      const m = e.material;
      this.solver.setMaterial(slot, physicsToUniforms(m.physics, this.solver.dx));
      const l = m.look;
      look.lookA[slot].set(l.transparency, l.reflectivity, l.roughness, l.metallic);
      _c.set(l.glowColor).convertSRGBToLinear();
      look.glowCol[slot].copy(_c);
      _c.set(l.solidColor).convertSRGBToLinear();
      const tint = m.id === 'jelly' || m.id === 'rainbow' ? 0.0 : m.id === 'lava' ? 0.85 : 0.45;
      look.solidCol[slot].set(_c.r, _c.g, _c.b, tint);
      look.thermal[slot].set(m.physics.freezePoint, Math.max(m.physics.temperature, m.physics.freezePoint + 1), l.thermalGlow ? 1 : 0, l.glow);
    }
  }

  private computeSubsteps(dt: number, emitters: Emitter[]) {
    let cMax = 0;
    let flow = 0;
    for (const e of emitters) {
      const s = shearSpeeds(e.material.physics);
      cMax = Math.max(cMax, s.c, s.liquid, s.solid);
      flow = Math.max(flow, e.flowSpeed);
    }
    const g = this.gravity.length();
    const vEst = Math.sqrt(2 * g * 1.1) + flow + 0.4;
    const vmax = Math.max(cMax, vEst);
    const n = Math.ceil((dt * vmax) / this.solver.dx / 0.5);
    return THREE.MathUtils.clamp(n, 1, TIERS[this.tier].maxSub);
  }

  /** Obstacle collider with a kinematic velocity estimated from how it was dragged. */
  private movingObstaclePrim(o: AppState['obstacles'][number], dt: number): Prim {
    const prim = obstaclePrim(o);
    const prev = this.obstaclePrev.get(o.id);
    const p = new THREE.Vector3(...o.position);
    const r = new THREE.Euler(o.rotation[0], o.rotation[1], o.rotation[2], 'XYZ');
    if (prev && dt > 0) {
      prim.linVel = p.clone().sub(prev.p).divideScalar(dt).clampLength(0, 3);
      prim.angVel = new THREE.Vector3((r.x - prev.r.x) / dt, (r.y - prev.r.y) / dt, (r.z - prev.r.z) / dt).clampLength(0, 10);
    }
    this.obstaclePrev.set(o.id, { p, r });
    return prim;
  }

  private toolForces(s: AppState): { forces: ForceField[]; brush: BrushAction | null; pour: Emitter | null; stir: number } {
    const p = this.input.state;
    const forces: ForceField[] = [...this.extraForces];
    let brush: BrushAction | null = null;
    let pour: Emitter | null = null;
    let stir = 0;
    const size = s.toolSize;
    const k = s.toolStrength;
    const dx = this.solver.dx;
    if (p.active) {
      switch (s.tool) {
        case 'stir':
          forces.push({ type: 1, center: p.pos, vector: p.vel.clone().multiplyScalar(1.5), radius: size, strength: 10 + 45 * k });
          stir = Math.min(1, p.vel.length() / 2);
          break;
        case 'whirlpool':
          forces.push({ type: 2, center: p.pos, vector: new THREE.Vector3(), radius: size * 1.7, strength: (0.6 + 2.4 * k) / dx, height: 0.8 });
          stir = 0.4 * k;
          break;
        case 'attract':
          forces.push({ type: 3, center: p.pos, vector: new THREE.Vector3(), radius: size * 2.2, strength: (2 + 14 * k) / dx });
          break;
        case 'repel':
          forces.push({ type: 4, center: p.pos, vector: new THREE.Vector3(), radius: size * 2, strength: (3 + 22 * k) / dx });
          break;
        case 'freeze':
          brush = { type: 2, center: p.pos, radius: size * 1.2, strength: 150 + 2500 * k };
          break;
        case 'heat':
          brush = { type: 1, center: p.pos, radius: size * 1.2, strength: 150 + 2500 * k };
          break;
        case 'dye':
          brush = { type: 3, center: p.pos, radius: size, strength: 4 + 30 * k, dye: new THREE.Color(s.dyeColor).convertSRGBToLinear() };
          break;
        case 'erase':
          brush = { type: 4, center: p.pos, radius: size, strength: 1 };
          break;
        case 'pour': {
          const base = s.selectedEmitter();
          pour = {
            ...base,
            id: 'x-pour',
            position: [p.pos.x, Math.min(1.15, p.pos.y + 0.1), p.pos.z],
            rotation: [0, 0, 0],
            streams: 1,
            twistRadius: 0,
            twistSpeed: 0,
            thickness: Math.max(0.017, size * 0.35),
            flowSpeed: 0.5 + 0.8 * k,
            enabled: true,
          };
          this.slotByEmitter.set('x-pour', this.slotFor(base));
          break;
        }
      }
    }
    return { forces, brush, pour, stir };
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    try {
      this.tick();
    } catch (err) {
      console.error(err);
      useStore.setState({ engineError: String((err as Error)?.message ?? err) });
      cancelAnimationFrame(this.raf);
    }
  };

  private tick() {
    // resizing clears the canvas, so it must happen before (not after) this frame's render
    if (this.resizePending) {
      this.resizePending = false;
      this.onResize();
    }
    const realDt = Math.min(this.clock.getDelta(), 0.1);
    const s = useStore.getState();
    this.frame++;
    this.alloc.frame = this.frame;

    // ---- mode / revision changes
    if (s.mode !== this.lastMode || s.revision !== this.lastRevision) {
      const modeChanged = s.mode !== this.lastMode;
      this.lastMode = s.mode;
      this.lastRevision = s.revision;
      if (modeChanged) {
        const prev = this.mode ? this.modeId : '';
        this.mode?.exit();
        this.modeId = s.mode;
        this.mode = createMode(s.mode, this, prev);
        this.mode?.enter();
      }
      this.clearLiquid(false);
      this.lastEmitters = null;
    }
    if (s.environment !== this.lastEnv) this.applyEnvironment(s.environment);
    if (s.sound !== this.sound.enabled) this.sound.setEnabled(s.sound);
    if (s.volume !== this.sound.volume) this.sound.setVolume(s.volume);

    const w = s.world;
    // ---- gravity
    const g0 = BASE_GRAVITY * w.gravityStrength;
    if (w.gravityMode === 'normal') this.gravity.set(0, -g0, 0);
    else if (w.gravityMode === 'reversed') this.gravity.set(0, g0, 0);
    else if (w.gravityMode === 'zero') this.gravity.set(0, 0, 0);
    else this.gravity.set(...w.customGravity).multiplyScalar(g0);

    const simDt = s.paused ? 0 : Math.min(realDt, 1 / 30) * w.simSpeed;
    this.time += simDt;

    // ---- platform transform
    this.spinAngle += w.platformSpin * simDt;
    const pq = platformQuat(w.platformTilt, this.spinAngle);
    const tiltRate = simDt > 0 ? [(w.platformTilt[0] - this.prevTilt[0]) / simDt, (w.platformTilt[1] - this.prevTilt[1]) / simDt] : [0, 0];
    this.prevTilt = [...w.platformTilt];
    const angVel = new THREE.Vector3(tiltRate[0], w.platformSpin, tiltRate[1]).clampLength(0, 8);
    this.stage.setPlatform(pq, w.showPlatform);
    this.bodies.setPlatform(pq, angVel, w.showPlatform);

    // ---- scene sync
    const showSel = s.tool === 'select';
    if (showSel !== this.stage.showSelection) {
      this.stage.showSelection = showSel;
      this.lastEmitters = null;
    }
    if (s.emitters !== this.lastEmitters) {
      this.stage.syncEmitters(s.emitters, s.selectedEmitterId);
      this.updateMaterials(s.emitters);
      this.lastEmitters = s.emitters;
    }
    if (s.obstacles !== this.lastObstacles) {
      this.stage.syncObstacles(s.obstacles);
      this.bodies.syncObstacles(s.obstacles);
      this.lastObstacles = s.obstacles;
    }
    if (s.bodies !== this.lastBodies) {
      this.stage.syncBodies(s.bodies);
      this.bodies.syncBodies(s.bodies);
      this.lastBodies = s.bodies;
    }
    this.syncGizmo(s);

    // ---- mode logic
    this.mode?.update(simDt, realDt, s);

    // ---- solids
    const prims: Prim[] = [
      ...stagePrims({ showPlatform: w.showPlatform, platformQuat: pq, platformAngVel: angVel }),
      ...s.obstacles.map((o) => this.movingObstaclePrim(o, simDt)),
      ...this.bodies.prims(),
    ];
    this.solver.setPrims(prims);

    // ---- solver uniforms
    this.solver.setGravity(this.gravity);
    const su = this.solver.u;
    su.uFriction.value = w.friction;
    su.uAmbient.value = w.ambientTemp;
    su.uWalls.value = w.walls ? 1 : 0;
    this.fluid.setOpenBoundaries(!w.walls);
    if (w.containment) {
      const c = this.solver.worldToGrid(new THREE.Vector3(0, 0.62, 0));
      su.uContain.value.set(c.x, c.y, c.z, 0.3 / this.solver.dx);
    } else su.uContain.value.set(0, 0, 0, 0);

    this.input.tick();
    const tool = this.toolForces(s);
    this.solver.setForces(tool.forces);
    this.solver.setBrush(tool.brush);
    // whirlpool / attract also move rigid bodies
    if (this.input.state.active && (s.tool === 'whirlpool' || s.tool === 'attract' || s.tool === 'repel' || s.tool === 'stir') && simDt > 0) {
      const c = this.input.state.pos;
      const R = s.toolSize * 2;
      this.bodies.impulseAll((p) => {
        const d = p.clone().sub(c);
        const dist = d.length();
        if (dist > R) return new THREE.Vector3();
        const f = (1 - dist / R) * simDt;
        if (s.tool === 'whirlpool') return new THREE.Vector3(-d.z, 0.2, d.x).normalize().multiplyScalar(3 * f * s.toolStrength);
        if (s.tool === 'stir') return this.input.state.vel.clone().multiplyScalar(4 * f);
        return d.normalize().multiplyScalar((s.tool === 'attract' ? -6 : 8) * f * s.toolStrength);
      });
    }

    // ---- simulate
    const allEmitters = [...s.emitters, ...this.extraEmitters, ...(tool.pour ? [tool.pour] : [])];
    if (simDt > 0) {
      if (this.dissolveT >= 0) {
        this.dissolveT += realDt / 0.35;
        this.fluid.dissolve = Math.min(1, this.dissolveT);
        if (this.dissolveT >= 1) {
          this.solver.clear();
          this.alloc.reset();
          this.dissolveT = -1;
          this.fluid.dissolve = 0;
        }
      }
      const emitting = this.dissolveT < 0 ? allEmitters : [];
      for (const e of emitting) if (!this.slotByEmitter.has(e.id)) this.slotFor(e);
      if (this.extraEmitters.length) this.updateMaterials([...s.emitters, ...this.extraEmitters]);
      const n = this.emission.generate(emitting, this.time - simDt, simDt, this.solver, this.alloc, (e) => this.slotFor(e));
      this.solver.emit(n);
      const sub = this.computeSubsteps(simDt, allEmitters);
      this.solver.step(simDt, sub);
      this.bodies.step(simDt, this.gravity);
      if (this.bodies.count > 0) {
        void this.solver.readBodyImpulses().then((r) => {
          if (r) this.bodies.applyFluid(r.force, r.torque, this.solver.dx);
        });
      }
      for (const id of this.bodies.fellOut) s.removeBody(id);
    } else {
      this.fluid.dissolve = 0;
    }
    this.bodies.syncMeshes((id) => this.stage.bodyObject(id));

    // ---- readback (stats, free slots, game modes)
    if (this.frame - this.readbackFrame >= 10) {
      this.readbackFrame = this.frame;
      const issue = this.frame;
      void this.solver.readParticles().then((r) => {
        if (!r || this.disposed) return;
        this.alloc.refresh((i) => r.col[i * 4 + 3] < -500, issue);
        this.processReadback(r.pos, r.col);
      });
    }

    // ---- sound
    const flowing = allEmitters.filter((e) => e.enabled).length;
    const visc = s.selectedEmitter().material.physics.viscosity;
    this.sound.update(realDt, s.paused ? 0 : Math.min(1, flowing / 3), visc, s.paused ? 0 : this.landing, s.paused ? 0 : tool.stir);

    // ---- camera (keep the stage centred in the area not covered by the side panel)
    const desktop = this.container.clientWidth > 900;
    const inset = desktop && s.panelOpen && !s.uiHidden ? 376 : 0;
    const insetB = this.bottomInsetTarget(s);
    const k = Math.min(1, realDt * 6);
    this.viewInset += (inset - this.viewInset) * k;
    this.viewInsetB += (insetB - this.viewInsetB) * k;
    if (Math.abs(this.viewInset) > 0.5 || Math.abs(this.viewInsetB) > 0.5) {
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      this.camera.setViewOffset(w + this.viewInset, h + this.viewInsetB, this.viewInset, this.viewInsetB, w, h);
    } else if (this.camera.view?.enabled) {
      this.camera.clearViewOffset();
      this.camera.aspect = this.container.clientWidth / Math.max(1, this.container.clientHeight);
      this.camera.updateProjectionMatrix();
    }
    this.controls.autoRotate = this.autoRotate || s.cinematic;
    this.updateOrbitButtons(s);
    if (this.camTween) {
      const t = this.camTween;
      t.t = Math.min(1, t.t + realDt / 0.8);
      const e = 1 - Math.pow(1 - t.t, 3);
      this.camera.position.lerpVectors(t.from, t.to, e);
      this.controls.target.lerpVectors(t.tFrom, t.tTo, e);
      if (t.t >= 1) this.camTween = null;
    }
    this.controls.update(realDt);
    if (this.cameraShake > 0.001) {
      this.cameraShake *= Math.exp(-realDt * 5);
    }

    this.render(s, realDt);
    this.updatePerf(realDt, s);
  }

  private updateOrbitButtons(s: AppState) {
    const orbitTool = s.tool === 'orbit';
    this.controls.mouseButtons = {
      LEFT: orbitTool ? THREE.MOUSE.ROTATE : (-1 as unknown as THREE.MOUSE),
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    this.controls.touches = {
      ONE: orbitTool ? THREE.TOUCH.ROTATE : (-1 as unknown as THREE.TOUCH),
      TWO: THREE.TOUCH.DOLLY_ROTATE,
    };
  }

  private processReadback(pos: Float32Array, col: Float32Array) {
    const dx = this.solver.dx;
    const n = this.solver.capacity;
    let alive = 0, onPlatform = 0, frozen = 0, sumSp = 0, ke = 0, sumT = 0;
    const settledHeights: number[] = [];
    let peak = 0;
    let landingCount = 0;
    const s = useStore.getState();
    const freezeBySlot = new Array(MAX_MATS).fill(-1e9);
    const densBySlot = new Array(MAX_MATS).fill(1);
    for (const e of s.emitters) {
      const sl = this.slotByEmitter.get(e.id);
      if (sl !== undefined) {
        freezeBySlot[sl] = e.material.physics.freezePoint;
        densBySlot[sl] = e.material.physics.density;
      }
    }
    const top = PLATFORM_TOP;
    const hx = PLATFORM.half.x + 0.01;
    for (let i = 0; i < n; i++) {
      const sp = pos[i * 4 + 3];
      if (sp < 0) continue;
      alive++;
      const x = pos[i * 4] * dx + DOMAIN_ORIGIN.x;
      const y = pos[i * 4 + 1] * dx;
      const z = pos[i * 4 + 2] * dx + DOMAIN_ORIGIN.z;
      const v = sp * dx;
      const packed = col[i * 4 + 3];
      const slot = Math.floor(packed / 10000);
      const temp = packed - slot * 10000 - 1000;
      sumSp += v;
      ke += 0.5 * densBySlot[slot] * v * v;
      sumT += temp;
      if (temp < (freezeBySlot[slot] ?? -1e9)) frozen++;
      if (Math.abs(x) < hx && Math.abs(z) < hx && y > top - 0.01) {
        onPlatform++;
        const h = y - top;
        if (h > peak) peak = h;
        if (v < 0.18) settledHeights.push(h);
        if (v > 0.4 && h < 0.08) landingCount++;
      }
    }
    settledHeights.sort((a, b) => a - b);
    const maxH = settledHeights.length > 20 ? settledHeights[Math.floor(settledHeights.length * 0.995)] : settledHeights[settledHeights.length - 1] ?? 0;
    this.landing = Math.min(1, landingCount / 60);
    const stats: FluidStats = {
      alive,
      capacity: n,
      maxHeight: maxH,
      peakHeight: peak,
      avgSpeed: alive ? sumSp / alive : 0,
      kinetic: ke * this.solver.vp0 * dx * dx * dx,
      avgTemp: alive ? sumT / alive : s.world.ambientTemp,
      frozen,
      onPlatform,
    };
    useStore.setState({ stats });
    const data: ReadbackData = { pos, col, dx, count: n };
    this.lastReadback = data;
    this.mode?.onReadback?.(data);
    for (const l of this.readbackListeners) l(data);
  }

  private render(s: AppState, realDt: number) {
    const r = this.renderer;
    this.env.update(this.time);
    // brush cursor
    const showCursor = !['orbit', 'select'].includes(s.tool) && (this.input.hover || this.input.state.active) && !s.uiHidden;
    this.cursor.visible = showCursor;
    if (showCursor) {
      this.cursor.position.copy(this.input.state.pos);
      this.cursor.quaternion.copy(this.camera.quaternion);
      const rad = ['whirlpool', 'attract', 'repel'].includes(s.tool) ? s.toolSize * 1.8 : s.toolSize;
      this.cursor.scale.setScalar(rad);
      const m = this.cursor.material as THREE.MeshBasicMaterial;
      m.opacity = this.input.state.active ? 0.85 : 0.45;
      m.color.set(s.tool === 'dye' ? s.dyeColor : s.tool === 'freeze' ? '#7fdcff' : s.tool === 'heat' ? '#ff7a3a' : s.tool === 'erase' ? '#ff4d6d' : '#ffffff');
    }

    // camera shake
    const shakeOffset = new THREE.Vector3();
    if (this.cameraShake > 0.001) {
      shakeOffset.set((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).multiplyScalar(this.cameraShake * 0.02);
      this.camera.position.add(shakeOffset);
      this.camera.updateMatrixWorld();
    }

    // 1. opaque scene (shadow map includes the liquid)
    this.keyLight.shadow.needsUpdate = true;
    r.setRenderTarget(this.sceneRT);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    r.render(this.scene, this.camera);
    this.fluid.updateShadow(this.keyLight);

    // 2. transparent objects (glass cups) into their own layer
    let glass: THREE.WebGLRenderTarget | null = null;
    if (this.stage.transparentGroup.children.length) {
      r.setRenderTarget(this.glassRT);
      r.setClearColor(0x000000, 0);
      r.clear(true, true, false);
      this.transparentScene.environment = this.scene.environment;
      r.render(this.transparentScene, this.camera);
      glass = this.glassRT;
    }

    // 3. liquid composite (+ glass layer)
    this.fluid.render(this.camera, this.sceneRT, this.compRT, this.keyLight, this.keyLight.color.clone().multiplyScalar(this.keyLight.intensity * 0.55), this.rimLight.color, glass);

    // 4. bloom + tone mapping to screen
    this.post.letterbox = s.cinematic ? 0.09 : 0;
    this.post.render(this.compRT, this.time, true);

    // 5. overlay (gizmo, brush cursor)
    const prevAuto = r.autoClear;
    r.autoClear = false;
    r.clearDepth();
    r.render(this.overlay, this.camera);
    r.autoClear = prevAuto;

    if (shakeOffset.lengthSq() > 0) this.camera.position.sub(shakeOffset);

    if (this.thumbCb) {
      const cb = this.thumbCb;
      this.thumbCb = null;
      cb(r.domElement);
    }
    if (this.screenshotCb) {
      const cb = this.screenshotCb;
      this.screenshotCb = null;
      r.domElement.toBlob((b) => cb(b), 'image/png');
    }
    if (this.recorder) useStore.setState({ recordSeconds: Math.floor((performance.now() - this.recordStart) / 1000) });
    void realDt;
  }

  private updatePerf(dt: number, s: AppState) {
    const a = this.fpsAcc;
    a.frames++;
    a.time += dt;
    if (a.time >= 0.5) {
      const fps = a.frames / a.time;
      a.frames = 0;
      a.time = 0;
      useStore.setState({
        perf: {
          fps,
          frameMs: 1000 / fps,
          substeps: this.solver.stepsThisFrame,
          grid: `${this.solver.nx}×${this.solver.ny}×${this.solver.nz}`,
          tier: this.tier,
          renderScale: this.pixelRatio,
          gpu: this.gpu,
        },
      });
      // adaptive resolution
      const cap = Math.min(window.devicePixelRatio || 1, TIERS[this.tier].dprCap);
      if (fps < 45) {
        a.slowTime += 0.5;
        a.fastTime = 0;
      } else if (fps > 57) {
        a.fastTime += 0.5;
        a.slowTime = 0;
      } else {
        a.slowTime = 0;
        a.fastTime = 0;
      }
      if (a.slowTime >= 1.5 && this.pixelRatio > 0.6) {
        this.pixelRatio = Math.max(0.6, this.pixelRatio * 0.85);
        a.slowTime = 0;
        this.resizePending = true;
      } else if (a.fastTime >= 4 && this.pixelRatio < cap) {
        this.pixelRatio = Math.min(cap, this.pixelRatio * 1.1);
        a.fastTime = 0;
        this.resizePending = true;
      }
      // auto tier downgrade during the first seconds
      const since = (performance.now() - this.startTime) / 1000;
      if (s.quality === 'auto' && !this.autoChecked && since > 4 && !document.hidden) {
        if (fps < 30 && this.pixelRatio <= 0.75) {
          const idx = TIER_ORDER.indexOf(this.tier);
          if (idx > 0) {
            this.buildTier(TIER_ORDER[idx - 1]);
            this.startTime = performance.now();
            s.toast(`Auto quality → ${this.tier} for smoother play`, 'info');
          } else this.autoChecked = true;
        } else if (since > 14) this.autoChecked = true;
      }
    }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    this.mode?.exit();
    this.controls.dispose();
    this.gizmo.dispose();
    this.solver.dispose();
    this.fluid.dispose();
    this.env.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
