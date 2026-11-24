import * as THREE from 'three';
import { MPMSolver } from '../src/engine/sim/MPMSolver';
import { EmissionSystem, SlotAllocator } from '../src/engine/sim/Emission';
import { physicsToUniforms, shearSpeeds } from '../src/engine/sim/materialUniforms';
import { stagePrims, PLATFORM, PILLAR_SLABS } from '../src/engine/SceneLayout';
import type { Emitter, MaterialPhysics } from '../src/engine/types';

const params = new URLSearchParams(location.search);
const visc = parseFloat(params.get('v') ?? '0.4');
const grid = (params.get('g') ?? '48,60,48').split(',').map(Number) as [number, number, number];
const ptex = (params.get('p') ?? '256,96').split(',').map(Number) as [number, number];
const W = 360, H = 640;
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setSize(W, H);
renderer.setPixelRatio(1);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x3a2366);
const camera = new THREE.PerspectiveCamera(35, W / H, 0.01, 20);
camera.position.set(0, 0.75, 1.6);
camera.lookAt(0, 0.55, 0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x443366, 1.2));
const dl = new THREE.DirectionalLight(0xffffff, 2); dl.position.set(1, 2, 1.5); scene.add(dl);
const slabMat = new THREE.MeshStandardMaterial({ color: 0xbbbbbb, roughness: 0.6 });
const top = new THREE.Mesh(new THREE.BoxGeometry(PLATFORM.half.x * 2, PLATFORM.half.y * 2, PLATFORM.half.z * 2), slabMat);
top.position.copy(PLATFORM.center); scene.add(top);
for (const s of PILLAR_SLABS) { const m = new THREE.Mesh(new THREE.BoxGeometry(s.half.x * 2, s.half.y * 2, s.half.z * 2), slabMat); m.position.y = s.y; m.rotation.y = s.angle; scene.add(m); }

const solver = new MPMSolver(renderer, { grid, particleTex: ptex });
const alloc = new SlotAllocator(solver.capacity);
const emission = new EmissionSystem();
const phys: MaterialPhysics = {
  viscosity: visc, density: parseFloat(params.get('d') ?? '1'), surfaceTension: parseFloat(params.get('st') ?? '0.15'), temperature: 20, stickiness: 0.1,
  elasticity: parseFloat(params.get('e') ?? '0'), plasticity: 0, pressure: parseFloat(params.get('pr') ?? '0.4'), refTemp: 20, tempSensitivity: 0,
  freezePoint: -1000, coolRate: 0, boilPoint: null, solidStiffness: 0.5, solidDamping: 0.5,
};
solver.setMaterial(0, physicsToUniforms(phys, solver.dx));
const g = new THREE.Vector3(0, -parseFloat(params.get('grav') ?? '1.6'), 0);
solver.setGravity(g);
solver.setPrims(stagePrims({ showPlatform: true, platformQuat: new THREE.Quaternion(), platformAngVel: new THREE.Vector3() }));
const emitter: Emitter = {
  id: 'e0', position: [0, 1.12, 0], rotation: [0, 0, 0], streams: 3, colors: ['#ff2a3a', '#36e05a', '#2f7bff'],
  thickness: parseFloat(params.get('th') ?? '0.028'), flowSpeed: parseFloat(params.get('fs') ?? '0.6'), twistRadius: 0.05, twistSpeed: parseFloat(params.get('tw') ?? '1.0'), enabled: true,
  material: { id: 'custom', name: 'x', physics: phys, look: {} as any, palette: [], rainbow: false },
};

const ptsMat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms: { uPos: { value: null }, uCol: { value: null }, uPW: { value: solver.pw }, uDx: { value: solver.dx }, uScale: { value: H / (2 * Math.tan((35 * Math.PI) / 360)) } },
  vertexShader: `
    uniform highp sampler2D uPos; uniform highp sampler2D uCol; uniform int uPW; uniform float uDx; uniform float uScale;
    out vec3 vCol;
    void main(){
      ivec2 t = ivec2(gl_VertexID % uPW, gl_VertexID / uPW);
      vec4 c = texelFetch(uCol, t, 0);
      if (c.a < -0.5) { gl_Position = vec4(2.0); gl_PointSize = 0.0; return; }
      vec3 p = texelFetch(uPos, t, 0).xyz * uDx + vec3(-0.5, 0.0, -0.5);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = 0.75 * uDx * uScale / -mv.z;
      vCol = c.rgb;
    }`,
  fragmentShader: `
    in vec3 vCol; out vec4 fc;
    void main(){ vec2 q = gl_PointCoord*2.0-1.0; float r = dot(q,q); if (r>1.0) discard; vec3 n = vec3(q.x,-q.y,sqrt(1.0-r));
      float d = max(dot(n, normalize(vec3(0.5,0.7,0.6))),0.0); vec3 col = pow(vCol, vec3(1.0/2.2)) * (0.35 + 0.75*d) + pow(max(dot(reflect(vec3(0,0,-1),n), normalize(vec3(0.5,0.7,0.6))),0.0),24.0)*0.6; fc = vec4(col,1.0); }`,
});
const geo = new THREE.BufferGeometry(); geo.setDrawRange(0, solver.capacity);
const pts = new THREE.Points(geo, ptsMat); pts.frustumCulled = false; scene.add(pts);

let time = 0;
let frame = 0;
const cs = shearSpeeds(phys);
function substepsFor(dt: number) {
  const vmax = Math.max(cs.c, cs.liquid, Math.sqrt(2 * g.length() * 0.8) + emitter.flowSpeed);
  return Math.min(12, Math.max(1, Math.ceil((dt * vmax) / solver.dx / 0.5)));
}
let lastRead = 0;
async function doRead() {
  const issue = alloc.frame;
  const r = await solver.readParticles();
  if (!r) return null;
  alloc.refresh((i) => r.col[i * 4 + 3] < -500, issue);
  return r;
}
function stepFrame(dt = 1 / 60) {
  alloc.frame = ++frame;
  const n = emission.generate([emitter], time, dt, solver, alloc, () => 0);
  solver.emit(n);
  solver.step(dt, substepsFor(dt));
  time += dt;
  if (frame - lastRead > 15) { lastRead = frame; doRead(); }
}
function render() {
  ptsMat.uniforms.uPos.value = solver.posTex;
  ptsMat.uniforms.uCol.value = solver.colTex;
  renderer.setRenderTarget(null);
  renderer.render(scene, camera);
}
(window as any).__sim = {
  debug() {
    const out: any = {};
    const anyS = solver as any;
    const rd = (rt: THREE.WebGLRenderTarget, idx: number, w: number, h: number, n: number) => { const a = new Float32Array(w*h*4); renderer.readRenderTargetPixels(rt, 0, 0, w, h, a, undefined, idx); return Array.from(a.slice(0, n)); };
    out.cur = anyS.cur;
    out.T1 = rd(anyS.stateMain[anyS.cur], 1, solver.pw, solver.ph, 4);
    const all = rd(anyS.stateAux[anyS.cur], 2, solver.pw, solver.ph, solver.capacity*4);
    let alive = 0; for (let i = 3; i < all.length; i += 4) if (all[i] > -0.5) alive++;
    out.alive = alive;
    out.T0 = rd(anyS.stateMain[anyS.cur], 0, solver.pw, solver.ph, 12);
    out.T6 = rd(anyS.stateAux[anyS.cur], 2, solver.pw, solver.ph, 12);
    const g = rd(anyS.splatRT, 0, solver.atlasW, solver.atlasH, solver.atlasW*solver.atlasH*4);
    let mass = 0; for (let i = 3; i < g.length; i += 4) mass += g[i];
    out.gridMass = mass;
    out.gl = renderer.getContext().getError();
    out.emitted = emission.emittedTotal;
    return out;
  },
  run(frames: number) { for (let i = 0; i < frames; i++) stepFrame(); render(); return frame; },
  async stats() {
    const r = await solver.readParticles();
    if (!r) return null;
    let alive = 0, maxY = 0, nan = 0, onTop = 0, sumSp = 0;
    const top = PLATFORM.center.y + PLATFORM.half.y;
    for (let i = 0; i < solver.capacity; i++) {
      const sp = r.pos[i * 4 + 3];
      if (sp < 0) continue;
      alive++;
      const x = r.pos[i*4]*solver.dx - 0.5, y = r.pos[i*4+1]*solver.dx, z = r.pos[i*4+2]*solver.dx - 0.5;
      if (!isFinite(x + y + z + sp)) { nan++; continue; }
      sumSp += sp * solver.dx;
      if (Math.abs(x) < 0.17 && Math.abs(z) < 0.17 && y > top && sp * solver.dx < 0.15) { onTop++; maxY = Math.max(maxY, y - top); }
    }
    return { alive, nan, onTop, maxY, avgSp: sumSp / Math.max(1, alive), substeps: solver.stepsThisFrame, recycled: alloc.recycled, cap: solver.capacity };
  },
  timing(frames: number) { const t0 = performance.now(); for (let i = 0; i < frames; i++) stepFrame(); const gl = renderer.getContext(); const px = new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px); return (performance.now() - t0) / frames; },
};
render();
(window as any).__ready = true;
