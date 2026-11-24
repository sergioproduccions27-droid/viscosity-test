import * as THREE from 'three';

export interface EnvPreset {
  id: string;
  name: string;
  top: string;
  bottom: string;
  glow: string; // halo behind the stage
  fog: string;
  light: string;
  rim: string;
  stars: number;
  grid: number;
  exposure: number;
  slab: string;
}

export const ENVIRONMENTS: EnvPreset[] = [
  { id: 'amethyst', name: 'Amethyst', top: '#7d5fb0', bottom: '#2a1a46', glow: '#6c50a0', fog: '#2c1c48', light: '#fff6ee', rim: '#b9a0ff', stars: 0, grid: 0, exposure: 1.0, slab: '#c9c6cc' },
  { id: 'midnight', name: 'Midnight', top: '#24345e', bottom: '#05070f', glow: '#3d5fa8', fog: '#070a16', light: '#dfe8ff', rim: '#5b8cff', stars: 0.35, grid: 0, exposure: 1.05, slab: '#9ea4b5' },
  { id: 'sunset', name: 'Sunset', top: '#ff9e6e', bottom: '#4b1838', glow: '#ffc78f', fog: '#4b1838', light: '#ffe2c2', rim: '#ff7aa8', stars: 0, grid: 0, exposure: 0.95, slab: '#d8c3bd' },
  { id: 'studio', name: 'Studio', top: '#d8d3e6', bottom: '#77708f', glow: '#ffffff', fog: '#7a7392', light: '#ffffff', rim: '#ffffff', stars: 0, grid: 0, exposure: 0.85, slab: '#e3e1e8' },
  { id: 'sandstone', name: 'Sandstone', top: '#7a4e34', bottom: '#f0c49a', glow: '#ffd7a8', fog: '#e8b88c', light: '#fff1de', rim: '#ffcf9a', stars: 0, grid: 0, exposure: 0.9, slab: '#e8d9c8' },
  { id: 'neon', name: 'Neon Grid', top: '#1a0b3a', bottom: '#03010a', glow: '#ff3fd8', fog: '#06021a', light: '#e6d9ff', rim: '#29f0ff', stars: 0.2, grid: 1, exposure: 1.1, slab: '#8d86a8' },
  { id: 'space', name: 'Deep Space', top: '#0c0a24', bottom: '#000000', glow: '#4b2a8a', fog: '#000000', light: '#ffffff', rim: '#7aa7ff', stars: 1, grid: 0, exposure: 1.1, slab: '#9b98a8' },
];

const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

const skyFrag = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uGlow;
uniform float uStars;
uniform float uGrid;
uniform float uTime;
uniform float uPanels;
varying vec3 vDir;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  float t = smoothstep(-0.42, 0.5, h);
  vec3 col = mix(uBottom, uTop, t);
  // soft halo behind the stage
  float halo = exp(-abs(h - 0.05) * 2.6);
  col += uGlow * 0.18 * halo;
  if (uStars > 0.0) {
    vec3 q = d * 260.0;
    vec3 c = floor(q);
    float s = hash(c);
    float tw = 0.6 + 0.4 * sin(uTime * (1.0 + s * 3.0) + s * 40.0);
    float star = smoothstep(0.985, 1.0, s) * smoothstep(0.5, 0.0, length(fract(q) - 0.5)) * tw;
    col += vec3(0.9, 0.95, 1.0) * star * uStars * 2.0;
    // faint nebula
    float n = sin(d.x * 3.1 + d.y * 2.3) * sin(d.z * 2.7 - d.y * 1.7);
    col += uGlow * 0.12 * uStars * smoothstep(0.2, 0.9, n);
  }
  if (uGrid > 0.0 && h < -0.02) {
    vec2 g = d.xz / max(-h, 0.02) * 2.0;
    vec2 gl = abs(fract(g) - 0.5);
    float line = smoothstep(0.47, 0.5, max(gl.x, gl.y));
    col += uGlow * line * uGrid * smoothstep(-0.02, -0.25, h) * 0.6;
  }
  // bright softbox panels for reflections (only rendered into the environment map)
  if (uPanels > 0.0) {
    float key = smoothstep(0.86, 0.9, dot(d, normalize(vec3(0.55, 0.75, 0.45))));
    float fill = smoothstep(0.9, 0.94, dot(d, normalize(vec3(-0.7, 0.45, 0.3))));
    float top = smoothstep(0.93, 0.96, d.y);
    float rim = smoothstep(0.92, 0.95, dot(d, normalize(vec3(-0.2, 0.35, -0.9))));
    col += vec3(4.0) * key + vec3(1.6) * fill + vec3(2.2) * top + uGlow * 2.0 * rim;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Inverse of the ACES fit used in the output pass, so backdrop colours land exactly on screen. */
function inverseAces(y: number): number {
  const a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  y = Math.min(0.97, Math.max(0, y));
  const A = y * c - a;
  const B = y * d - b;
  const C = y * e;
  const disc = Math.max(0, B * B - 4 * A * C);
  return (-B - Math.sqrt(disc)) / (2 * A);
}

/** sRGB hex as it should appear on screen → linear HDR value before tone mapping. */
export function displayColor(hex: string, exposure = 1, out = new THREE.Color()) {
  out.set(hex).convertSRGBToLinear();
  const k = 1 / (exposure * 0.92);
  return out.setRGB(inverseAces(out.r) * k, inverseAces(out.g) * k, inverseAces(out.b) * k);
}

export class EnvironmentSystem {
  readonly sky: THREE.Mesh;
  private envScene = new THREE.Scene();
  private envSky: THREE.Mesh;
  private cubeRT: THREE.WebGLCubeRenderTarget;
  private cubeCam: THREE.CubeCamera;
  private pmrem: THREE.PMREMGenerator;
  private pmremRT: THREE.WebGLRenderTarget | null = null;
  preset: EnvPreset = ENVIRONMENTS[0];
  readonly skyUniforms;

  constructor(private renderer: THREE.WebGLRenderer) {
    const mkUniforms = (panels: number) => ({
      uTop: { value: new THREE.Color() },
      uBottom: { value: new THREE.Color() },
      uGlow: { value: new THREE.Color() },
      uStars: { value: 0 },
      uGrid: { value: 0 },
      uTime: { value: 0 },
      uPanels: { value: panels },
    });
    this.skyUniforms = mkUniforms(0);
    const geo = new THREE.SphereGeometry(30, 48, 24);
    this.sky = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({
        vertexShader: skyVert,
        fragmentShader: skyFrag,
        uniforms: this.skyUniforms,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.envSky = new THREE.Mesh(
      geo,
      new THREE.ShaderMaterial({ vertexShader: skyVert, fragmentShader: skyFrag, uniforms: mkUniforms(1), side: THREE.BackSide, depthWrite: false }),
    );
    this.envScene.add(this.envSky);
    this.cubeRT = new THREE.WebGLCubeRenderTarget(256, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
    });
    this.cubeCam = new THREE.CubeCamera(0.1, 100, this.cubeRT);
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  get envCube() {
    return this.cubeRT.texture;
  }

  get envMaxLod() {
    return Math.log2(256);
  }

  apply(preset: EnvPreset, scene: THREE.Scene) {
    this.preset = preset;
    for (const u of [this.skyUniforms, (this.envSky.material as THREE.ShaderMaterial).uniforms]) {
      displayColor(preset.top, preset.exposure, u.uTop.value);
      displayColor(preset.bottom, preset.exposure, u.uBottom.value);
      displayColor(preset.glow, preset.exposure, u.uGlow.value);
      u.uStars.value = preset.stars;
      u.uGrid.value = preset.grid;
    }
    this.cubeCam.update(this.renderer, this.envScene);
    if (this.pmremRT) this.pmremRT.dispose();
    this.pmremRT = this.pmrem.fromScene(this.envScene, 0.02);
    scene.environment = this.pmremRT.texture;
  }

  update(time: number) {
    this.skyUniforms.uTime.value = time;
  }

  dispose() {
    this.cubeRT.dispose();
    this.pmremRT?.dispose();
    this.pmrem.dispose();
  }
}
