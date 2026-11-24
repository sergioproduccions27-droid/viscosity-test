import * as THREE from 'three';
import { DOMAIN_ORIGIN, type MPMSolver } from '../sim/MPMSolver';
import { MAX_MATS } from '../sim/shaders';

/**
 * Screen-space fluid rendering (sphere impostors → smoothed depth → shaded surface).
 * Produces a composited HDR image of scene + liquid.
 */

const particleCommon = /* glsl */ `
uniform highp sampler2D uPos;
uniform highp sampler2D uAux;
uniform highp sampler2D uCol;
uniform int uPW;
uniform float uDx;
uniform vec3 uOrigin;
uniform vec3 uGridN;
uniform float uRadius;
uniform float uProjScale;
uniform float uMaxPoint;
uniform float uFade; // 1 = open boundaries -> shrink near kill zone
uniform float uDissolve;
uniform vec4 uThermal[${MAX_MATS}]; // freezePoint, glowRefTemp, thermalGlow, glow
bool fetchParticle(out vec3 wp, out vec3 gp, out vec4 col, out vec4 aux, out float r) {
  ivec2 t = ivec2(gl_VertexID % uPW, gl_VertexID / uPW);
  col = texelFetch(uCol, t, 0);
  if (col.a < -0.5) return false;
  gp = texelFetch(uPos, t, 0).xyz;
  aux = texelFetch(uAux, t, 0);
  wp = gp * uDx + uOrigin;
  r = uRadius * (1.0 - uDissolve);
  if (uFade > 0.5) {
    float e = min(min(gp.y - 1.2, min(gp.x - 1.2, gp.z - 1.2)), min(uGridN.x - 2.2 - gp.x, uGridN.z - 2.2 - gp.z));
    r *= clamp(e / 4.0, 0.0, 1.0);
  }
  r *= 0.55 + 0.45 * smoothstep(0.0, 0.08, aux.w);
  return r > 1e-5;
}
`;

const depthVert = /* glsl */ `
${particleCommon}
out vec3 vCenter;
out float vR;
flat out vec4 vColor;
flat out vec2 vInfo;
void main() {
  vec3 wp, gp; vec4 col, aux; float r;
  if (!fetchParticle(wp, gp, col, aux, r)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(2.0 * r * uProjScale / -mv.z, uMaxPoint);
  vCenter = mv.xyz;
  vR = r;
  int m = int(col.a + 0.5);
  vec4 th = uThermal[m];
  float frozen = 1.0 - smoothstep(th.x - 2.5, th.x + 2.5, aux.z);
  float heat = th.z > 0.5 ? clamp((aux.z - th.x) / max(th.y - th.x, 1.0), 0.0, 1.2) : 1.0;
  vColor = vec4(col.rgb, col.a);
  vInfo = vec2(th.w * heat * heat, frozen);
}
`;

const depthFrag = /* glsl */ `
uniform mat4 projectionMatrix;
in vec3 vCenter;
in float vR;
flat in vec4 vColor;
flat in vec2 vInfo;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  q.y = -q.y;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  vec3 pv = vCenter + vec3(q * vR, sqrt(1.0 - r2) * vR);
  vec4 clip = projectionMatrix * vec4(pv, 1.0);
  gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
  o0 = vec4(-pv.z, vInfo.x, vInfo.y, 1.0);
  o1 = vColor;
}
`;

const thickVert = /* glsl */ `
${particleCommon}
out float vR;
out float vDepth;
void main() {
  vec3 wp, gp; vec4 col, aux; float r;
  if (!fetchParticle(wp, gp, col, aux, r)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(2.0 * r * uProjScale / -mv.z * 0.5, uMaxPoint);
  vR = r;
  vDepth = -mv.z;
}
`;

const thickFrag = /* glsl */ `
uniform sampler2D uSceneDepth;
uniform vec2 uInvSize;
uniform float uNear;
uniform float uFar;
in float vR;
in float vDepth;
layout(location = 0) out vec4 o0;
float linDepth(float d) { float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float sd = linDepth(texture(uSceneDepth, gl_FragCoord.xy * uInvSize).x);
  if (vDepth - vR > sd) discard;
  o0 = vec4(2.0 * vR * sqrt(1.0 - r2), 0.0, 0.0, 1.0);
}
`;

const fsVert = /* glsl */ `
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const blurFrag = /* glsl */ `
uniform highp sampler2D uDepth;
uniform highp sampler2D uColor;
uniform vec2 uDir;
uniform float uProjScale;
uniform float uWorldRadius;
uniform float uMaxRadius;
uniform float uDepthFall;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uDepth, 0);
  vec4 c0 = texelFetch(uDepth, p, 0);
  vec4 c1 = texelFetch(uColor, p, 0);
  // 1. coverage mask (w channel) gets a small fixed Gaussian blur everywhere:
  //    after the H+V passes this is a soft 2D mask used for smooth, organic silhouettes.
  float m = 0.0;
  float mw = 0.0;
  for (int i = -3; i <= 3; i++) {
    float g = exp(-float(i * i) / 4.5);
    m += g * texelFetch(uDepth, clamp(p + ivec2(uDir) * i, ivec2(0), sz - 1), 0).w;
    mw += g;
  }
  float mask = m / mw;
  if (c0.x <= 0.0) { o0 = vec4(0.0, 0.0, 0.0, mask); o1 = c1; return; }
  // 2. bilateral smoothing of the liquid depth (and colour)
  float d = c0.x;
  float rad = clamp(uWorldRadius * uProjScale / d, 1.0, uMaxRadius);
  float sigma = rad * 0.5;
  float inv2s2 = 1.0 / (2.0 * sigma * sigma);
  float fall = 1.0 / (uDepthFall * uDepthFall);
  vec3 s0 = vec3(0.0);
  vec3 s1 = vec3(0.0);
  float ws = 0.0;
  int R = int(ceil(rad));
  for (int i = -16; i <= 16; i++) {
    if (i < -R || i > R) continue;
    ivec2 pp = clamp(p + ivec2(uDir) * i, ivec2(0), sz - 1);
    vec4 a = texelFetch(uDepth, pp, 0);
    if (a.x <= 0.0) continue;
    float dd = a.x - d;
    float w = exp(-float(i * i) * inv2s2 - dd * dd * fall);
    s0 += a.xyz * w;
    s1 += texelFetch(uColor, pp, 0).rgb * w;
    ws += w;
  }
  o0 = vec4(s0 / ws, mask);
  o1 = vec4(s1 / ws, c1.a);
}
`;

const thickBlurFrag = /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uDir;
in vec2 vUv;
layout(location = 0) out vec4 o0;
void main() {
  vec2 px = uDir / vec2(textureSize(uTex, 0));
  float s = texture(uTex, vUv).r * 0.2270270270;
  s += (texture(uTex, vUv + px * 1.3846153846).r + texture(uTex, vUv - px * 1.3846153846).r) * 0.3162162162;
  s += (texture(uTex, vUv + px * 3.2307692308).r + texture(uTex, vUv - px * 3.2307692308).r) * 0.0702702703;
  o0 = vec4(s, 0.0, 0.0, 1.0);
}
`;

const compositeFrag = /* glsl */ `
#include <packing>
uniform sampler2D uScene;
uniform sampler2D uSceneDepth;
uniform highp sampler2D uF0;
uniform highp sampler2D uF1;
uniform sampler2D uThick;
uniform samplerCube uEnv;
uniform float uEnvMaxLod;
uniform float uEnvIntensity;
uniform mat4 uInvProj;
uniform mat4 uViewInv;
uniform float uNear;
uniform float uFar;
uniform vec3 uLightDir;   // view space, toward light
uniform vec3 uLightColor;
uniform vec3 uRimDir;
uniform vec3 uRimColor;
uniform vec3 uFogColor;
uniform float uFogY;
uniform vec4 uLookA[${MAX_MATS}]; // transparency, reflectivity, roughness, metallic
uniform vec3 uGlowCol[${MAX_MATS}];
uniform vec4 uSolidCol[${MAX_MATS}]; // rgb, tint strength
uniform sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform vec2 uShadowTexel;
uniform float uShadowOn;
uniform float uShowThickness;
uniform sampler2D uGlass;
uniform sampler2D uGlassDepth;
uniform float uGlassOn;
in vec2 vUv;
layout(location = 0) out vec4 fc;

float linDepth(float d) { float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
vec3 viewPos(vec2 uv, float d) {
  vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, -1.0, 1.0);
  v.xyz /= v.w;
  return v.xyz / -v.z * d;
}
float shadowAt(vec3 wp) {
  if (uShadowOn < 0.5) return 1.0;
  vec4 sc = uShadowMatrix * vec4(wp, 1.0);
  sc.xyz /= sc.w;
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
  float s = 0.0;
  for (int i = -1; i <= 1; i++)
  for (int j = -1; j <= 1; j++) {
    float d = unpackRGBAToDepth(texture(uShadowMap, sc.xy + vec2(i, j) * uShadowTexel));
    s += step(sc.z - 0.006, d);
  }
  return s / 9.0;
}

// Transparent objects (glass cups) are rendered to their own layer and blended on top
// wherever they are in front of both the opaque scene and the liquid.
vec3 withGlass(vec3 col, float frontDepth) {
  if (uGlassOn < 0.5) return col;
  float gd = linDepth(texture(uGlassDepth, vUv).x);
  if (gd >= frontDepth) return col;
  vec4 g = texture(uGlass, vUv);
  return col * (1.0 - g.a) + g.rgb;
}

void main() {
  vec4 sc = texture(uScene, vUv);
  vec2 fsz = vec2(textureSize(uF0, 0));
  float sd = linDepth(texture(uSceneDepth, vUv).x);
  // Coverage-aware upsampling of the (lower resolution) liquid buffer. The blurred coverage
  // mask (w) gives soft, rounded silhouettes; the nearest valid texel provides depth/normal.
  vec2 fp = vUv * fsz - 0.5;
  ivec2 b0 = ivec2(floor(fp));
  vec2 fr = fp - vec2(b0);
  float mask = 0.0;
  for (int j = 0; j < 2; j++)
  for (int i = 0; i < 2; i++) {
    ivec2 q = clamp(b0 + ivec2(i, j), ivec2(0), ivec2(fsz) - 1);
    float w = (i == 0 ? 1.0 - fr.x : fr.x) * (j == 0 ? 1.0 - fr.y : fr.y);
    mask += w * texelFetch(uF0, q, 0).w;
  }
  float alpha = smoothstep(0.3, 0.62, mask);
  if (uShowThickness > 1.5) { fc = vec4(vec3(mask), 1.0); return; }
  if (alpha <= 0.001) { fc = vec4(withGlass(sc.rgb, sd), 1.0); return; }
  // nearest texel holding liquid depth (searched in a 4x4 neighbourhood so the silhouette
  // follows the smooth mask instead of the blocky texel boundary)
  float bestD = 1e9;
  ivec2 p = b0;
  for (int j = -1; j <= 2; j++)
  for (int i = -1; i <= 2; i++) {
    ivec2 q = clamp(b0 + ivec2(i, j), ivec2(0), ivec2(fsz) - 1);
    float dq = texelFetch(uF0, q, 0).x;
    vec2 dv = vec2(q) - fp;
    float dist = dot(dv, dv);
    if (dq > 0.0 && dq < sd + 0.004 && dist < bestD) { bestD = dist; p = q; }
  }
  if (bestD > 1e8) { fc = vec4(withGlass(sc.rgb, sd), 1.0); return; }
  vec4 f0 = texelFetch(uF0, p, 0);

  float d = f0.x;
  vec2 texel = 1.0 / fsz;
  vec2 uvC = (vec2(p) + 0.5) * texel;
  vec3 P = viewPos(uvC, d);
  float dl = texelFetch(uF0, p - ivec2(1, 0), 0).x;
  float dr = texelFetch(uF0, p + ivec2(1, 0), 0).x;
  float db = texelFetch(uF0, p - ivec2(0, 1), 0).x;
  float dt = texelFetch(uF0, p + ivec2(0, 1), 0).x;
  vec3 ddx = viewPos(uvC + vec2(texel.x, 0.0), dr) - P;
  vec3 ddx2 = P - viewPos(uvC - vec2(texel.x, 0.0), dl);
  if (dr <= 0.0 || (dl > 0.0 && abs(ddx2.z) < abs(ddx.z))) ddx = ddx2;
  vec3 ddy = viewPos(uvC + vec2(0.0, texel.y), dt) - P;
  vec3 ddy2 = P - viewPos(uvC - vec2(0.0, texel.y), db);
  if (dt <= 0.0 || (db > 0.0 && abs(ddy2.z) < abs(ddy.z))) ddy = ddy2;
  vec3 N = normalize(cross(ddx, ddy));
  if (dl <= 0.0 && dr <= 0.0) N = vec3(0.0, 0.0, 1.0);
  vec3 V = normalize(-P);
  if (dot(N, V) < 0.0) N = -N;

  vec4 f1 = texelFetch(uF1, p, 0);
  // soften colour steps where two liquid surfaces overlap (internal edges)
  {
    vec3 cs = vec3(0.0);
    float cw = 0.0;
    for (int j = 0; j < 2; j++)
    for (int i = 0; i < 2; i++) {
      ivec2 q = clamp(b0 + ivec2(i, j), ivec2(0), ivec2(fsz) - 1);
      float w = (i == 0 ? 1.0 - fr.x : fr.x) * (j == 0 ? 1.0 - fr.y : fr.y);
      float dq = texelFetch(uF0, q, 0).x;
      if (dq > 0.0 && abs(dq - f0.x) < 0.08) { cs += w * texelFetch(uF1, q, 0).rgb; cw += w; }
    }
    if (cw > 0.0) f1.rgb = cs / cw;
  }
  int m = int(clamp(f1.a + 0.5, 0.0, float(${MAX_MATS - 1})));
  vec4 look = uLookA[m];
  float frozen = f0.z;
  float transp = look.x * (1.0 - frozen * 0.6);
  float refl = look.y;
  float rough = mix(look.z, 0.55, frozen * 0.7);
  float metal = look.w;
  vec3 base = max(f1.rgb, vec3(0.0));
  base = mix(base, base * (1.0 - uSolidCol[m].a) + uSolidCol[m].rgb * uSolidCol[m].a, frozen);

  vec3 Nw = normalize(mat3(uViewInv) * N);
  vec3 Vw = normalize(mat3(uViewInv) * V);
  vec3 wp = (uViewInv * vec4(P, 1.0)).xyz;
  float NdV = clamp(dot(N, V), 0.0, 1.0);
  vec3 F0 = mix(vec3(0.04), base, metal);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - NdV, 5.0) * (1.0 - rough * 0.6);
  vec3 R = reflect(-Vw, Nw);
  vec3 env = textureLod(uEnv, R, rough * uEnvMaxLod).rgb * uEnvIntensity;
  vec3 envDiffuse = textureLod(uEnv, Nw, uEnvMaxLod - 1.0).rgb * uEnvIntensity;

  float sh = shadowAt(wp + Nw * 0.004);
  float NdL = dot(N, uLightDir);
  float wrap = clamp((NdL + 0.12) / 1.12, 0.0, 1.0);
  vec3 diffuse = base * (envDiffuse * 0.45 + uLightColor * wrap * (0.2 + 0.8 * sh) * 0.42) * (1.0 - metal);

  // Transmission with Beer-Lambert absorption through the liquid thickness.
  float thick = texture(uThick, vUv).r;
  vec2 ruv = clamp(vUv + N.xy * (0.012 + 0.05 * min(thick * 6.0, 1.0)) * transp, vec2(0.001), vec2(0.999));
  vec3 behind = texture(uScene, ruv).rgb;
  float pathLen = thick * 38.0 + 0.35;
  vec3 trans = behind * pow(clamp(base * 1.08, vec3(0.002), vec3(1.0)), vec3(pathLen));
  vec3 inner = base * (envDiffuse * 0.3 + uLightColor * 0.08) * (1.0 - exp(-thick * 30.0));
  vec3 body = mix(diffuse, trans + inner, transp);

  // Specular highlights: key light + rim light
  vec3 H = normalize(uLightDir + V);
  float shin = mix(180.0, 14.0, rough);
  float spec = pow(max(dot(N, H), 0.0), shin) * (shin + 8.0) / 110.0 * sh;
  vec3 H2 = normalize(uRimDir + V);
  float spec2 = pow(max(dot(N, H2), 0.0), shin * 0.5) * (shin + 8.0) / 160.0;
  vec3 specCol = mix(vec3(1.0), base, metal);

  vec3 col = body * (1.0 - F * refl) + env * F * refl * mix(vec3(1.0), base * 1.4, metal);
  col += specCol * (uLightColor * spec + uRimColor * spec2) * (1.0 - rough * 0.5) * mix(0.4, 1.0, refl);
  // Emissive glow (hot lava / molten glass / neon)
  col += uGlowCol[m] * f0.y * (1.6 + 2.0 * f0.y) * (1.0 - frozen);
  // Frost sparkle on frozen material
  col += frozen * vec3(0.2, 0.25, 0.3) * pow(1.0 - NdV, 2.0);

  // Height fog: liquid falling into the abyss fades out like the pillar.
  float fog = smoothstep(uFogY, uFogY - 0.45, wp.y);
  col = mix(col, uFogColor, fog);
  if (uShowThickness > 0.5) col = vec3(thick * 10.0);
  col = mix(sc.rgb, col, alpha);
  fc = vec4(withGlass(col, d), 1.0);
}
`;

export interface FluidLook {
  lookA: THREE.Vector4[];
  glowCol: THREE.Color[];
  solidCol: THREE.Vector4[];
  thermal: THREE.Vector4[];
}

export class FluidRenderer {
  static readonly SHADOW_LAYER = 1;
  private depthRT: THREE.WebGLRenderTarget;
  private blurRT: THREE.WebGLRenderTarget[];
  private thickRT: THREE.WebGLRenderTarget[];
  private depthPts: THREE.Points;
  private thickPts: THREE.Points;
  private shadowPts: THREE.Points;
  private quad: THREE.Mesh;
  private quadCam = new THREE.Camera();
  private blurMat: THREE.ShaderMaterial;
  private thickBlurMat: THREE.ShaderMaterial;
  readonly compositeMat: THREE.ShaderMaterial;
  private particleUniforms: Record<string, THREE.IUniform>;
  readonly look: FluidLook;
  scale = 0.75;
  smoothIterations = 2;
  dissolve = 0;
  /** 0 = off, 1 = thickness, 2 = coverage mask (debug views) */
  debugView = 0;
  private width = 1;
  private height = 1;

  constructor(private renderer: THREE.WebGLRenderer, private solver: MPMSolver) {
    const fl = (count: number, type: THREE.TextureDataType, depth = false) =>
      new THREE.WebGLRenderTarget(1, 1, {
        count,
        type,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: depth,
        generateMipmaps: false,
      });
    this.depthRT = fl(2, THREE.FloatType, true);
    this.blurRT = [fl(2, THREE.FloatType), fl(2, THREE.FloatType)];
    this.thickRT = [fl(1, THREE.HalfFloatType), fl(1, THREE.HalfFloatType)];
    for (const rt of this.thickRT) {
      rt.texture.minFilter = THREE.LinearFilter;
      rt.texture.magFilter = THREE.LinearFilter;
    }

    this.look = {
      lookA: Array.from({ length: MAX_MATS }, () => new THREE.Vector4(0.4, 0.8, 0.1, 0)),
      glowCol: Array.from({ length: MAX_MATS }, () => new THREE.Color(1, 0.4, 0.1)),
      solidCol: Array.from({ length: MAX_MATS }, () => new THREE.Vector4(0.9, 0.95, 1, 0.45)),
      thermal: Array.from({ length: MAX_MATS }, () => new THREE.Vector4(-1000, 100, 0, 0)),
    };

    this.particleUniforms = {
      uPos: { value: null },
      uAux: { value: null },
      uCol: { value: null },
      uPW: { value: solver.pw },
      uDx: { value: solver.dx },
      uOrigin: { value: DOMAIN_ORIGIN.clone() },
      uGridN: { value: new THREE.Vector3(solver.nx, solver.ny, solver.nz) },
      uRadius: { value: solver.dx * solver.spacing * 1.25 },
      uProjScale: { value: 500 },
      uMaxPoint: { value: 256 },
      uFade: { value: 1 },
      uDissolve: { value: 0 },
      uThermal: { value: this.look.thermal },
    };
    const gl = renderer.getContext();
    const ptRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array;
    this.particleUniforms.uMaxPoint.value = Math.min(ptRange?.[1] ?? 64, 512);

    const ptsGeo = new THREE.BufferGeometry();
    ptsGeo.setDrawRange(0, solver.capacity);
    const depthMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: depthVert,
      fragmentShader: depthFrag,
      uniforms: this.particleUniforms,
    });
    this.depthPts = new THREE.Points(ptsGeo, depthMat);
    this.depthPts.frustumCulled = false;

    const thickMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: thickVert,
      fragmentShader: thickFrag,
      uniforms: {
        ...this.particleUniforms,
        uSceneDepth: { value: null },
        uInvSize: { value: new THREE.Vector2() },
        uNear: { value: 0.01 },
        uFar: { value: 100 },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      transparent: true,
    });
    this.thickPts = new THREE.Points(ptsGeo, thickMat);
    this.thickPts.frustumCulled = false;

    // Shadow caster: the particle cloud rendered into the key light's shadow map.
    const shadowMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: /* glsl */ `
        ${particleCommon}
        uniform float uShadowScale;
        void main() {
          vec3 wp, gp; vec4 col, aux; float r;
          if (!fetchParticle(wp, gp, col, aux, r)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
          gl_PointSize = max(1.0, 2.0 * r * uShadowScale);
        }`,
      fragmentShader: /* glsl */ `
        #include <packing>
        void main() {
          vec2 q = gl_PointCoord * 2.0 - 1.0;
          if (dot(q, q) > 1.0) discard;
          gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
        }`,
      uniforms: { ...this.particleUniforms, uShadowScale: { value: 1000 } },
    });
    // Lives on layer 1 only: the main camera never draws it, the light's shadow camera does.
    this.shadowPts = new THREE.Points(ptsGeo, shadowMat);
    this.shadowPts.frustumCulled = false;
    this.shadowPts.castShadow = true;
    this.shadowPts.customDepthMaterial = shadowMat;
    this.shadowPts.layers.set(FluidRenderer.SHADOW_LAYER);

    this.blurMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: fsVert,
      fragmentShader: blurFrag,
      uniforms: {
        uDepth: { value: null },
        uColor: { value: null },
        uDir: { value: new THREE.Vector2(1, 0) },
        uProjScale: { value: 500 },
        uWorldRadius: { value: solver.dx * 1.3 },
        uMaxRadius: { value: 14 },
        uDepthFall: { value: solver.dx * 0.9 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.thickBlurMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: fsVert,
      fragmentShader: thickBlurFrag,
      uniforms: { uTex: { value: null }, uDir: { value: new THREE.Vector2(1, 0) } },
      depthTest: false,
      depthWrite: false,
    });
    this.compositeMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: fsVert,
      fragmentShader: compositeFrag,
      uniforms: {
        uScene: { value: null },
        uSceneDepth: { value: null },
        uF0: { value: null },
        uF1: { value: null },
        uThick: { value: null },
        uEnv: { value: null },
        uEnvMaxLod: { value: 8 },
        uEnvIntensity: { value: 1 },
        uInvProj: { value: new THREE.Matrix4() },
        uViewInv: { value: new THREE.Matrix4() },
        uNear: { value: 0.01 },
        uFar: { value: 100 },
        uLightDir: { value: new THREE.Vector3(0, 1, 0) },
        uLightColor: { value: new THREE.Color(1, 1, 1) },
        uRimDir: { value: new THREE.Vector3(-1, 0.3, -0.5) },
        uRimColor: { value: new THREE.Color(0.7, 0.6, 1) },
        uFogColor: { value: new THREE.Color(0, 0, 0) },
        uFogY: { value: 0.1 },
        uLookA: { value: this.look.lookA },
        uGlowCol: { value: this.look.glowCol },
        uSolidCol: { value: this.look.solidCol },
        uShadowMap: { value: null },
        uShadowMatrix: { value: new THREE.Matrix4() },
        uShadowTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },
        uShadowOn: { value: 0 },
        uShowThickness: { value: 0 },
        uGlass: { value: null },
        uGlassDepth: { value: null },
        uGlassOn: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(geo, this.compositeMat);
    this.quad.frustumCulled = false;
  }

  private pickBusy = false;
  private lastSmoothed: THREE.WebGLRenderTarget | null = null;
  /** View-space distance of the liquid under the last requested cursor position (null = none). */
  pickedDepth: number | null = null;

  requestPick(ndc: THREE.Vector2) {
    const rt = this.lastSmoothed;
    if (this.pickBusy || !rt) return;
    this.pickBusy = true;
    const x = THREE.MathUtils.clamp(Math.floor((ndc.x * 0.5 + 0.5) * rt.width), 0, rt.width - 1);
    const y = THREE.MathUtils.clamp(Math.floor((ndc.y * 0.5 + 0.5) * rt.height), 0, rt.height - 1);
    const buf = new Float32Array(4);
    this.renderer
      .readRenderTargetPixelsAsync(rt, x, y, 1, 1, buf, undefined, 0)
      .then((d) => {
        this.pickedDepth = d[0] > 0 ? d[0] : null;
      })
      .catch(() => {
        this.pickedDepth = null;
      })
      .finally(() => {
        this.pickBusy = false;
      });
  }

  /** Object to add to the main scene so the liquid casts shadows. */
  get shadowCaster() {
    return this.shadowPts;
  }

  setSize(w: number, h: number) {
    this.width = w;
    this.height = h;
    const fw = Math.max(1, Math.round(w * this.scale));
    const fh = Math.max(1, Math.round(h * this.scale));
    this.depthRT.setSize(fw, fh);
    for (const rt of this.blurRT) rt.setSize(fw, fh);
    const tw = Math.max(1, Math.round(fw * 0.5));
    const th = Math.max(1, Math.round(fh * 0.5));
    for (const rt of this.thickRT) rt.setSize(tw, th);
  }

  setScale(s: number) {
    if (Math.abs(s - this.scale) < 1e-3) return;
    this.scale = s;
    this.setSize(this.width, this.height);
  }

  setOpenBoundaries(open: boolean) {
    this.particleUniforms.uFade.value = open ? 1 : 0;
  }

  updateShadow(light: THREE.DirectionalLight) {
    const cam = light.shadow.camera as THREE.OrthographicCamera;
    const mat = this.shadowPts.customDepthMaterial as THREE.ShaderMaterial;
    mat.uniforms.uShadowScale.value = light.shadow.mapSize.x / (cam.right - cam.left);
    const cu = this.compositeMat.uniforms;
    if (light.shadow.map) {
      cu.uShadowMap.value = light.shadow.map.texture;
      cu.uShadowMatrix.value.copy(light.shadow.matrix);
      cu.uShadowTexel.value.set(1 / light.shadow.mapSize.x, 1 / light.shadow.mapSize.y);
      cu.uShadowOn.value = 1;
    }
  }

  private fsPass(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quad, this.quadCam);
  }

  /**
   * Render liquid over the scene. `sceneRT` must have a depthTexture.
   * Output is written to `target` (HDR, linear).
   */
  render(
    camera: THREE.PerspectiveCamera,
    sceneRT: THREE.WebGLRenderTarget,
    target: THREE.WebGLRenderTarget,
    light: THREE.DirectionalLight,
    lightColor: THREE.Color,
    rimColor: THREE.Color,
    glassRT: THREE.WebGLRenderTarget | null,
  ) {
    const r = this.renderer;
    const prevAuto = r.autoClear;
    r.autoClear = false;
    const pu = this.particleUniforms;
    pu.uPos.value = this.solver.posTex;
    pu.uAux.value = this.solver.auxTex;
    pu.uCol.value = this.solver.colTex;
    pu.uDissolve.value = this.dissolve;
    const fh = this.depthRT.height;
    const projScale = fh / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    pu.uProjScale.value = projScale;

    // 1. sphere depth + colour
    r.setRenderTarget(this.depthRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(this.depthPts, camera);

    // 2. thickness (half res, additive)
    const tm = this.thickPts.material as THREE.ShaderMaterial;
    tm.uniforms.uSceneDepth.value = sceneRT.depthTexture;
    tm.uniforms.uInvSize.value.set(1 / this.thickRT[0].width, 1 / this.thickRT[0].height);
    tm.uniforms.uNear.value = camera.near;
    tm.uniforms.uFar.value = camera.far;
    r.setRenderTarget(this.thickRT[0]);
    r.clear(true, false, false);
    pu.uProjScale.value = projScale;
    r.render(this.thickPts, camera);
    this.thickBlurMat.uniforms.uTex.value = this.thickRT[0].texture;
    this.thickBlurMat.uniforms.uDir.value.set(1, 0);
    this.fsPass(this.thickBlurMat, this.thickRT[1]);
    this.thickBlurMat.uniforms.uTex.value = this.thickRT[1].texture;
    this.thickBlurMat.uniforms.uDir.value.set(0, 1);
    this.fsPass(this.thickBlurMat, this.thickRT[0]);

    // 3. bilateral smoothing of depth + colour
    const bu = this.blurMat.uniforms;
    bu.uProjScale.value = projScale;
    let src = this.depthRT;
    for (let i = 0; i < this.smoothIterations; i++) {
      bu.uDepth.value = src.textures[0];
      bu.uColor.value = src.textures[1];
      bu.uDir.value.set(1, 0);
      this.fsPass(this.blurMat, this.blurRT[0]);
      bu.uDepth.value = this.blurRT[0].textures[0];
      bu.uColor.value = this.blurRT[0].textures[1];
      bu.uDir.value.set(0, 1);
      this.fsPass(this.blurMat, this.blurRT[1]);
      src = this.blurRT[1];
    }
    this.lastSmoothed = src;

    // 4. composite
    const cu = this.compositeMat.uniforms;
    cu.uScene.value = sceneRT.texture;
    cu.uSceneDepth.value = sceneRT.depthTexture;
    cu.uF0.value = src.textures[0];
    cu.uF1.value = src.textures[1];
    cu.uThick.value = this.thickRT[0].texture;
    cu.uInvProj.value.copy(camera.projectionMatrixInverse);
    cu.uViewInv.value.copy(camera.matrixWorld);
    cu.uNear.value = camera.near;
    cu.uFar.value = camera.far;
    const ld = new THREE.Vector3().copy(light.position).sub(light.target.position).normalize();
    ld.transformDirection(camera.matrixWorldInverse);
    cu.uLightDir.value.copy(ld);
    cu.uLightColor.value.copy(lightColor);
    cu.uRimColor.value.copy(rimColor);
    cu.uRimDir.value.set(-0.6, 0.4, -0.7).normalize().transformDirection(camera.matrixWorldInverse);
    cu.uShowThickness.value = this.debugView;
    cu.uGlassOn.value = glassRT ? 1 : 0;
    cu.uGlass.value = glassRT ? glassRT.texture : null;
    cu.uGlassDepth.value = glassRT ? glassRT.depthTexture : null;
    this.fsPass(this.compositeMat, target);
    r.autoClear = prevAuto;
  }

  dispose() {
    for (const rt of [this.depthRT, ...this.blurRT, ...this.thickRT]) rt.dispose();
  }
}
