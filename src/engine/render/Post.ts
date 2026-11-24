import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

const outputFrag = /* glsl */ `
uniform sampler2D uTex;
uniform float uExposure;
uniform float uVignette;
uniform float uTime;
uniform vec2 uTexel;
uniform float uLetterbox;
in vec2 vUv;
layout(location = 0) out vec4 fc;

vec3 aces(vec3 x) {
  const float a = 2.51; const float b = 0.03; const float c = 2.43; const float d = 0.59; const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 srgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
vec3 tonemap(vec3 c) { return aces(c * uExposure * 0.92); }

void main() {
  // light FXAA on the tone-mapped image
  vec3 cM = tonemap(texture(uTex, vUv).rgb);
  vec3 cN = tonemap(texture(uTex, vUv + vec2(0.0, uTexel.y)).rgb);
  vec3 cS = tonemap(texture(uTex, vUv - vec2(0.0, uTexel.y)).rgb);
  vec3 cE = tonemap(texture(uTex, vUv + vec2(uTexel.x, 0.0)).rgb);
  vec3 cW = tonemap(texture(uTex, vUv - vec2(uTexel.x, 0.0)).rgb);
  float lM = luma(cM), lN = luma(cN), lS = luma(cS), lE = luma(cE), lW = luma(cW);
  float range = max(max(max(lN, lS), max(lE, lW)), lM) - min(min(min(lN, lS), min(lE, lW)), lM);
  vec3 col = cM;
  if (range > 0.08) {
    // blur along the edge (perpendicular to the luminance gradient)
    vec2 dir = vec2(-(lN - lS), lE - lW);
    float dl = length(dir);
    if (dl > 1e-4) {
      dir = dir / dl * uTexel;
      vec3 a = tonemap(texture(uTex, vUv + dir * 0.5).rgb);
      vec3 b = tonemap(texture(uTex, vUv - dir * 0.5).rgb);
      col = mix(cM, (a + b) * 0.5, clamp(range * 3.0, 0.0, 0.65));
    }
  }
  vec2 q = vUv - 0.5;
  float v = 1.0 - dot(q, q) * uVignette;
  col *= v;
  col = srgb(clamp(col, 0.0, 1.0));
  float n = fract(sin(dot(gl_FragCoord.xy + uTime, vec2(12.9898, 78.233))) * 43758.5453);
  col += (n - 0.5) / 255.0;
  if (uLetterbox > 0.0 && abs(vUv.y - 0.5) > 0.5 - uLetterbox) col = vec3(0.0);
  fc = vec4(col, 1.0);
}
`;

export class Post {
  readonly bloom: UnrealBloomPass;
  private outputMat: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private cam = new THREE.Camera();
  exposure = 1;
  letterbox = 0;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.55, 1.25);
    this.outputMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: 'out vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: outputFrag,
      uniforms: {
        uTex: { value: null },
        uExposure: { value: 1 },
        uVignette: { value: 0.55 },
        uTime: { value: 0 },
        uTexel: { value: new THREE.Vector2() },
        uLetterbox: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(geo, this.outputMat);
    this.quad.frustumCulled = false;
  }

  setSize(w: number, h: number) {
    this.bloom.setSize(w, h);
  }

  render(src: THREE.WebGLRenderTarget, time: number, bloomOn: boolean) {
    const r = this.renderer;
    const prevAuto = r.autoClear;
    r.autoClear = false;
    if (bloomOn) this.bloom.render(r, src, src, 0, false);
    const u = this.outputMat.uniforms;
    u.uTex.value = src.texture;
    u.uExposure.value = this.exposure;
    u.uTime.value = time % 100;
    u.uTexel.value.set(1 / src.width, 1 / src.height);
    u.uLetterbox.value = this.letterbox;
    r.setRenderTarget(null);
    r.render(this.quad, this.cam);
    r.autoClear = prevAuto;
  }
}
