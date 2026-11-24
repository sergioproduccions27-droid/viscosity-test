// GLSL ES 3.0 sources for the WebGL2 MLS-MPM solver.
//
// Particle state lives in 7 RGBA32F textures (ping-ponged):
//   T0: position.xyz (grid cells), C22
//   T1: velocity.xyz (cells/s), phi (grid volume fraction from the last gather)
//   T2: C00 C01 C02 C10          (APIC affine velocity gradient)
//   T3: C11 C12 C20 C21
//   T4: b00 b11 b22 b01          (isochoric left Cauchy-Green tensor, viscoelastic memory)
//   T5: b02 b12 temperature age
//   T6: colour.rgb  materialSlot (-1 = dead)
//
// Grid is a 3D lattice packed into a 2D atlas of z-slices.

export const MAX_MATS = 8;
export const MAX_PRIMS = 48;
export const MAX_FORCES = 4;
export const MAX_BODIES = 16;

const header = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
uniform ivec3 uGrid;
uniform int uTilesX;
uniform ivec2 uPTex;
ivec2 nodePix(ivec3 n) {
  return ivec2(n.x + (n.z % uTilesX) * uGrid.x, n.y + (n.z / uTilesX) * uGrid.y);
}
ivec2 pTexel(int id) { return ivec2(id % uPTex.x, id / uPTex.x); }
void bspline(vec3 x, out vec3 base, out vec3 w0, out vec3 w1, out vec3 w2) {
  base = floor(x - 0.5);
  vec3 fx = x - base;
  w0 = 0.5 * (1.5 - fx) * (1.5 - fx);
  w1 = 0.75 - (fx - 1.0) * (fx - 1.0);
  w2 = 0.5 * (fx - 0.5) * (fx - 0.5);
}
float wsel(int i, float a, float b, float c) { return i == 0 ? a : (i == 1 ? b : c); }
`;

const materials = /* glsl */ `
uniform vec4 uMatA[${MAX_MATS}]; // density, c^2 (cells^2/s^2), cohesion, colour mix rate
uniform vec4 uMatB[${MAX_MATS}]; // strain damping rate, liquid shear c^2, relax rate, yield strain
uniform vec4 uMatC[${MAX_MATS}]; // refTemp, tempSensitivity, freezePoint, coolRate
uniform vec4 uMatD[${MAX_MATS}]; // solid shear c^2, solid damping rate, stick rate, boil point
float viscMul(int m, float T) { return clamp(exp(-uMatC[m].y * (T - uMatC[m].x)), 0.03, 40.0); }
float solidFrac(int m, float T) { return 1.0 - smoothstep(uMatC[m].z - 2.5, uMatC[m].z + 2.5, T); }
`;

const sdf = /* glsl */ `
uniform sampler2D uPrims;
uniform int uPrimCount;
vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
vec3 qrotInv(vec4 q, vec3 v) { return qrot(vec4(-q.xyz, q.w), v); }
float sdRoundBox(vec3 p, vec3 h, float r) {
  vec3 q = abs(p) - (h - r);
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}
float sdSeg2(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}
float primDist(int i, vec3 p) {
  vec4 c = texelFetch(uPrims, ivec2(0, i), 0);
  vec4 q = texelFetch(uPrims, ivec2(1, i), 0);
  vec4 a = texelFetch(uPrims, ivec2(2, i), 0);
  vec3 pl = qrotInv(q, p - c.xyz);
  int type = int(c.w + 0.5);
  if (type == 0) return sdRoundBox(pl, a.xyz, a.w);
  if (type == 1) return length(pl) - a.x;
  vec4 b = texelFetch(uPrims, ivec2(3, i), 0);
  float th = texelFetch(uPrims, ivec2(6, i), 0).y;
  vec2 q2 = vec2(length(pl.xz), pl.y);
  float d = sdSeg2(q2, a.xy, a.zw);
  d = min(d, sdSeg2(q2, a.zw, b.xy));
  d = min(d, sdSeg2(q2, b.xy, b.zw));
  return d - th;
}
float sceneDist(vec3 p, out int idx) {
  float best = 1e9;
  idx = -1;
  for (int i = 0; i < ${MAX_PRIMS}; i++) {
    if (i >= uPrimCount) break;
    vec4 c = texelFetch(uPrims, ivec2(0, i), 0);
    float br = texelFetch(uPrims, ivec2(6, i), 0).x;
    if (length(p - c.xyz) - br > best) continue;
    float d = primDist(i, p);
    if (d < best) { best = d; idx = i; }
  }
  return best;
}
vec3 primNormal(int i, vec3 p) {
  const float e = 0.08;
  vec2 k = vec2(1.0, -1.0);
  vec3 n = k.xyy * primDist(i, p + k.xyy * e) + k.yyx * primDist(i, p + k.yyx * e) +
           k.yxy * primDist(i, p + k.yxy * e) + k.xxx * primDist(i, p + k.xxx * e);
  float l = length(n);
  return l > 1e-6 ? n / l : vec3(0.0, 1.0, 0.0);
}
vec3 primVel(int i, vec3 p) {
  vec4 c = texelFetch(uPrims, ivec2(0, i), 0);
  vec4 lv = texelFetch(uPrims, ivec2(4, i), 0);
  vec4 av = texelFetch(uPrims, ivec2(5, i), 0);
  return lv.xyz + cross(av.xyz, p - c.xyz);
}
`;

export const fullscreenVert = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// ---------------------------------------------------------------------------
// Prep: per-particle stress -> APIC affine matrix used by the splat.
// ---------------------------------------------------------------------------
export const prepFrag = /* glsl */ `
${header}
${materials}
uniform sampler2D T0, T1, T2, T3, T4, T5, T6;
uniform float uDt;
uniform float uVp0;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 a6 = texelFetch(T6, t, 0);
  if (a6.a < -0.5) { o0 = vec4(0.0); o1 = vec4(0.0); o2 = vec4(0.0); o3 = vec4(0.0); return; }
  int m = int(a6.a + 0.5);
  vec4 a0 = texelFetch(T0, t, 0);
  vec4 a1 = texelFetch(T1, t, 0);
  vec4 a2 = texelFetch(T2, t, 0);
  vec4 a3 = texelFetch(T3, t, 0);
  vec4 a4 = texelFetch(T4, t, 0);
  vec4 a5 = texelFetch(T5, t, 0);
  mat3 C = mat3(a2.x, a2.w, a3.z, a2.y, a3.x, a3.w, a2.z, a3.y, a0.w);
  float temp = a5.z;
  float vm = viscMul(m, temp);
  float solid = solidFrac(m, temp);
  vec4 mA = uMatA[m];
  vec4 mB = uMatB[m];
  vec4 mD = uMatD[m];

  // Viscosity: exact exponential decay of the strain-rate (symmetric) part of the
  // velocity gradient. Rotation (antisymmetric part) is preserved, which matters for coiling.
  float damp = mix(mB.x * vm, mD.y, solid);
  mat3 D = 0.5 * (C + transpose(C));
  mat3 Cp = (C - D) + D * exp(-damp * uDt);

  // Pressure from grid volume fraction (Tait EOS); tension allowed for cohesion.
  float phi = clamp(a1.w, 0.25, 3.0);
  float K = mA.x * mA.y;
  // Below rest density the liquid may pull (tension) but only down to a floor: a constant
  // surface tension at the free surface instead of a collapse of thin streams.
  float p = phi >= 1.0 ? K * 0.25 * (phi * phi * phi * phi - 1.0) : max(K * (phi - 1.0), -K * mA.z);

  // Viscoelastic / elastic deviatoric stress from b.
  mat3 b = mat3(a4.x, a4.w, a5.x, a4.w, a4.y, a5.y, a5.x, a5.y, a4.z);
  float cs2 = mix(mB.y, mD.x, solid);
  float G = mA.x * cs2;
  float trb = (a4.x + a4.y + a4.z) / 3.0;
  mat3 tau = mat3(-p) + G * (b - mat3(trb));

  float mass = mA.x * uVp0;
  mat3 A = mass * Cp - uDt * uVp0 * 4.0 * tau;
  o0 = vec4(a0.xyz, mass);
  o1 = vec4(a1.xyz, A[2][2]);
  o2 = vec4(A[0][0], A[1][0], A[2][0], A[0][1]);
  o3 = vec4(A[1][1], A[2][1], A[0][2], A[1][2]);
}
`;

// ---------------------------------------------------------------------------
// P2G splat: one point per (particle, neighbour node), additive blending.
// ---------------------------------------------------------------------------
export const splatVert = /* glsl */ `
${header}
uniform sampler2D Q0, Q1, Q2, Q3, T6;
uniform ivec2 uAtlas;
uniform float uVp0;
flat out vec4 vG0;
flat out vec4 vG1;
void main() {
  int id = gl_VertexID / 27;
  int o = gl_VertexID - id * 27;
  ivec2 t = pTexel(id);
  vec4 q0 = texelFetch(Q0, t, 0);
  gl_PointSize = 1.0;
  if (q0.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vG0 = vec4(0.0); vG1 = vec4(0.0); return; }
  vec3 x = q0.xyz;
  vec3 base, w0, w1, w2;
  bspline(x, base, w0, w1, w2);
  ivec3 off = ivec3(o % 3, (o / 3) % 3, o / 9);
  float w = wsel(off.x, w0.x, w1.x, w2.x) * wsel(off.y, w0.y, w1.y, w2.y) * wsel(off.z, w0.z, w1.z, w2.z);
  ivec3 node = ivec3(base) + off;
  if (any(lessThan(node, ivec3(0))) || any(greaterThanEqual(node, uGrid))) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vG0 = vec4(0.0); vG1 = vec4(0.0); return;
  }
  vec4 q1 = texelFetch(Q1, t, 0);
  vec4 q2 = texelFetch(Q2, t, 0);
  vec4 q3 = texelFetch(Q3, t, 0);
  mat3 A = mat3(q2.x, q2.w, q3.z, q2.y, q3.x, q3.w, q2.z, q3.y, q1.w);
  vec3 dpos = vec3(node) - x;
  vG0 = vec4(w * (q0.w * q1.xyz + A * dpos), w * q0.w);
  vec3 col = texelFetch(T6, t, 0).rgb;
  vec3 lc = -log(clamp(col, vec3(0.004), vec3(1.0)));
  float wv = w * uVp0;
  vG1 = vec4(lc * wv, wv);
  ivec2 pix = nodePix(node);
  gl_Position = vec4((vec2(pix) + 0.5) / vec2(uAtlas) * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const splatFrag = /* glsl */ `
precision highp float;
flat in vec4 vG0;
flat in vec4 vG1;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() { o0 = vG0; o1 = vG1; }
`;

// ---------------------------------------------------------------------------
// Grid update: momentum -> velocity, gravity, force fields, solid boundaries.
// ---------------------------------------------------------------------------
export const gridFrag = /* glsl */ `
${header}
${sdf}
uniform sampler2D G0;
uniform float uDt;
uniform vec3 uGravity;
uniform float uFriction;
uniform int uWalls;
uniform vec4 uContain; // center.xyz, radius (cells); radius <= 0 disables
uniform vec4 uForceA[${MAX_FORCES}]; // center.xyz, type
uniform vec4 uForceB[${MAX_FORCES}]; // vector.xyz, radius
uniform vec4 uForceC[${MAX_FORCES}]; // strength, height, -, -
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;

vec3 applyForces(vec3 p, vec3 v) {
  for (int i = 0; i < ${MAX_FORCES}; i++) {
    vec4 fa = uForceA[i];
    int type = int(fa.w + 0.5);
    if (type == 0) continue;
    vec4 fb = uForceB[i];
    vec4 fc = uForceC[i];
    vec3 d = p - fa.xyz;
    float R = fb.w;
    if (type == 1) { // stir / drag toward a target velocity
      float f = max(0.0, 1.0 - dot(d, d) / (R * R));
      f *= f;
      v = mix(v, fb.xyz, 1.0 - exp(-fc.x * f * uDt));
    } else if (type == 2) { // whirlpool around a vertical axis
      vec2 r = d.xz;
      float rl = length(r);
      float h = abs(d.y) / max(fc.y, 1.0);
      float f = max(0.0, 1.0 - rl / R) * max(0.0, 1.0 - h * h);
      if (rl > 0.3 && f > 0.0) {
        vec2 tang = vec2(-r.y, r.x) / rl;
        vec3 target = vec3(tang.x, 0.0, tang.y) * fc.x * (0.35 + rl / R) - vec3(r.x, 0.0, r.y) / rl * fc.x * 0.18 + vec3(0.0, fc.x * 0.12, 0.0);
        v = mix(v, v * 0.6 + target, 1.0 - exp(-6.0 * f * uDt));
      }
    } else if (type == 3 || type == 4) { // attract / repel
      float dl = length(d);
      float f = max(0.0, 1.0 - dl / R);
      vec3 dir = dl > 1e-4 ? d / dl : vec3(0.0, 1.0, 0.0);
      float s = type == 3 ? -1.0 : 1.0;
      v += dir * s * fc.x * f * uDt;
      if (type == 3) v *= exp(-2.0 * f * uDt);
    } else if (type == 5) { // directional push / blast
      float f = max(0.0, 1.0 - dot(d, d) / (R * R));
      v += fb.xyz * f * uDt;
    }
  }
  return v;
}

void main() {
  ivec2 pix = ivec2(gl_FragCoord.xy);
  int tx = pix.x / uGrid.x;
  int ty = pix.y / uGrid.y;
  int k = ty * uTilesX + tx;
  o1 = vec4(0.0, 0.0, 0.0, -1.0);
  if (k >= uGrid.z) { o0 = vec4(0.0); return; }
  vec4 g = texelFetch(G0, pix, 0);
  if (g.w <= 1e-9) { o0 = vec4(0.0); return; }
  ivec3 n = ivec3(pix.x - tx * uGrid.x, pix.y - ty * uGrid.y, k);
  vec3 p = vec3(n);
  vec3 v = g.xyz / g.w;
  v += uGravity * uDt;
  v = applyForces(p, v);
  if (uContain.w > 0.0) {
    vec3 d = p - uContain.xyz;
    float dl = length(d);
    if (dl > uContain.w) v -= d / dl * (dl - uContain.w) * 18.0 * uDt;
    v *= exp(-0.15 * uDt);
  }

  int idx;
  float sd = sceneDist(p, idx);
  if (idx >= 0 && sd < 0.75) {
    vec3 nrm = primNormal(idx, p);
    vec3 vs = primVel(idx, p);
    vec4 pv = texelFetch(uPrims, ivec2(4, idx), 0);
    float fr = uFriction * texelFetch(uPrims, ivec2(5, idx), 0).w;
    vec3 vBefore = v;
    vec3 vr = v - vs;
    float vn = dot(vr, nrm);
    if (vn < 0.0) {
      vr -= vn * nrm;
      float vt = length(vr);
      if (vt > 1e-6) vr *= max(0.0, 1.0 - fr * (-vn) / vt);
    }
    if (sd < 0.0) vr -= nrm * min(dot(vr, nrm), 0.0);
    v = vs + vr;
    if (pv.w >= 0.0) o1 = vec4(g.w * (v - vBefore), pv.w);
  }

  // Domain boundaries: the ceiling is always closed. Sides/floor only when walls are on.
  if (n.y > uGrid.y - 4) v.y = min(v.y, 0.0);
  if (uWalls == 1) {
    if (n.x < 3) v.x = max(v.x, 0.0);
    if (n.x > uGrid.x - 4) v.x = min(v.x, 0.0);
    if (n.z < 3) v.z = max(v.z, 0.0);
    if (n.z > uGrid.z - 4) v.z = min(v.z, 0.0);
    if (n.y < 3) { v.y = max(v.y, 0.0); v.xz *= max(0.0, 1.0 - uFriction * 0.5); }
  }
  o0 = vec4(v, g.w);
}
`;

// ---------------------------------------------------------------------------
// Rigid body impulse reduction: one point per grid cell -> body pixel.
// ---------------------------------------------------------------------------
export const bodyReduceVert = /* glsl */ `
${header}
uniform sampler2D Gb;
uniform ivec2 uAtlas;
uniform vec3 uBodyCenter[${MAX_BODIES}];
flat out vec4 vF;
flat out vec4 vT;
void main() {
  ivec2 pix = ivec2(gl_VertexID % uAtlas.x, gl_VertexID / uAtlas.x);
  vec4 g = texelFetch(Gb, pix, 0);
  gl_PointSize = 1.0;
  if (g.w < -0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vF = vec4(0.0); vT = vec4(0.0); return; }
  int tx = pix.x / uGrid.x;
  int ty = pix.y / uGrid.y;
  ivec3 n = ivec3(pix.x - tx * uGrid.x, pix.y - ty * uGrid.y, ty * uTilesX + tx);
  int b = int(g.w + 0.5);
  vec3 r = vec3(n) - uBodyCenter[b];
  vF = vec4(-g.xyz, 1.0);
  vT = vec4(cross(r, -g.xyz), 0.0);
  gl_Position = vec4((float(b) + 0.5) / ${MAX_BODIES}.0 * 2.0 - 1.0, 0.0, 0.0, 1.0);
}
`;

export const bodyReduceFrag = /* glsl */ `
precision highp float;
flat in vec4 vF;
flat in vec4 vT;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() { o0 = vF; o1 = vT; }
`;

// ---------------------------------------------------------------------------
// G2P part 1: velocity, APIC matrix, volume fraction, advection, collisions.
// ---------------------------------------------------------------------------
export const g2p1Frag = /* glsl */ `
${header}
${materials}
${sdf}
uniform sampler2D T0, T1, T6, Gv, G1;
uniform float uDt;
uniform float uMaxStep;
uniform int uWalls;
uniform vec4 uBrush;     // center.xyz, radius
uniform vec4 uBrushAct;  // type, strength, -, -
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
void kill() {
  o0 = vec4(-1.0e4, -1.0e4, -1.0e4, 0.0); o1 = vec4(0.0); o2 = vec4(0.0); o3 = vec4(0.0);
}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 a6 = texelFetch(T6, t, 0);
  if (a6.a < -0.5) { kill(); return; }
  int m = int(a6.a + 0.5);
  vec3 x = texelFetch(T0, t, 0).xyz;
  vec3 base, w0, w1, w2;
  bspline(x, base, w0, w1, w2);
  vec3 v = vec3(0.0);
  mat3 B = mat3(0.0);
  float phi = 0.0;
  for (int i = 0; i < 3; i++)
  for (int j = 0; j < 3; j++)
  for (int k = 0; k < 3; k++) {
    ivec3 node = ivec3(base) + ivec3(i, j, k);
    float w = wsel(i, w0.x, w1.x, w2.x) * wsel(j, w0.y, w1.y, w2.y) * wsel(k, w0.z, w1.z, w2.z);
    vec3 dpos = vec3(node) - x;
    ivec2 pix = nodePix(node);
    vec3 gv = texelFetch(Gv, pix, 0).xyz;
    v += w * gv;
    B += w * outerProduct(gv, dpos);
    phi += w * texelFetch(G1, pix, 0).w;
  }
  mat3 C = 4.0 * B;

  // Adhesion to solids (stickiness): damp motion relative to nearby surfaces.
  int idx;
  float sd = sceneDist(x, idx);
  if (idx >= 0 && sd < 1.6) {
    vec3 vs = primVel(idx, x);
    float stick = uMatD[m].z * (1.0 - smoothstep(0.4, 1.6, sd));
    v = vs + (v - vs) * exp(-stick * uDt);
  }

  float sp = length(v);
  float vmax = uMaxStep / uDt;
  if (sp > vmax) v *= vmax / sp;
  vec3 xn = x + uDt * v;

  // Particle-level collision projection keeps liquid out of thin solids.
  float sd2 = sceneDist(xn, idx);
  if (idx >= 0 && sd2 < 0.35) {
    vec3 nrm = primNormal(idx, xn);
    xn += nrm * (0.35 - sd2);
    vec3 vs = primVel(idx, xn);
    float vn = dot(v - vs, nrm);
    if (vn < 0.0) v -= vn * nrm;
  }

  vec3 g = vec3(uGrid);
  if (uWalls == 1) {
    xn = clamp(xn, vec3(1.6), g - 2.6);
  } else {
    if (xn.y < 1.2 || xn.x < 1.2 || xn.z < 1.2 || xn.x > g.x - 2.2 || xn.z > g.z - 2.2) { kill(); return; }
    xn.y = min(xn.y, g.y - 2.6);
  }
  if (int(uBrushAct.x + 0.5) == 4 && distance(xn, uBrush.xyz) < uBrush.w) { kill(); return; }

  o0 = vec4(xn, C[2][2]);
  o1 = vec4(v, phi);
  o2 = vec4(C[0][0], C[1][0], C[2][0], C[0][1]);
  o3 = vec4(C[1][1], C[2][1], C[0][2], C[1][2]);
}
`;

// ---------------------------------------------------------------------------
// G2P part 2: viscoelastic memory, plasticity, temperature, colour mixing.
// ---------------------------------------------------------------------------
export const g2p2Frag = /* glsl */ `
${header}
${materials}
uniform sampler2D N0, N2, N3, T4, T5, T6, G1;
uniform float uDt;
uniform float uAmbient;
uniform vec4 uBrush;
uniform vec4 uBrushAct;  // type (1 heat, 2 cool, 3 dye, 4 erase), strength
uniform vec3 uDye;
uniform float uSeed;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uSeed) * 43758.5453); }
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 a6 = texelFetch(T6, t, 0);
  vec4 n0 = texelFetch(N0, t, 0);
  if (a6.a < -0.5 || n0.x < -5000.0) {
    o0 = vec4(1.0, 1.0, 1.0, 0.0); o1 = vec4(0.0); o2 = vec4(a6.rgb, -1.0); return;
  }
  int m = int(a6.a + 0.5);
  vec4 n2 = texelFetch(N2, t, 0);
  vec4 n3 = texelFetch(N3, t, 0);
  vec4 a4 = texelFetch(T4, t, 0);
  vec4 a5 = texelFetch(T5, t, 0);
  mat3 C = mat3(n2.x, n2.w, n3.z, n2.y, n3.x, n3.w, n2.z, n3.y, n0.w);
  mat3 b = mat3(a4.x, a4.w, a5.x, a4.w, a4.y, a5.y, a5.x, a5.y, a4.z);
  float temp = a5.z;
  float vm = viscMul(m, temp);
  float solid = solidFrac(m, temp);

  // Upper-convected update of b, then keep it isochoric (volume handled by pressure).
  mat3 F = mat3(1.0) + uDt * C;
  b = F * b * transpose(F);
  float det = determinant(b);
  b *= pow(clamp(det, 1e-4, 1e4), -1.0 / 3.0);

  // Maxwell relaxation (viscous creep). Frozen material keeps its shape.
  float relax = uMatB[m].z / vm * (1.0 - solid);
  b = mat3(1.0) + (b - mat3(1.0)) * exp(-relax * uDt);

  // Plastic yield (von Mises style on the deviatoric part of b).
  float tr3 = (b[0][0] + b[1][1] + b[2][2]) / 3.0;
  mat3 dev = b - mat3(tr3);
  float dn = sqrt(dot(dev[0], dev[0]) + dot(dev[1], dev[1]) + dot(dev[2], dev[2]));
  float yieldS = mix(uMatB[m].w, 1e9, solid);
  if (dn > yieldS) b = mat3(tr3) + dev * (yieldS / dn);
  b *= pow(clamp(determinant(b), 1e-4, 1e4), -1.0 / 3.0);

  // Temperature: Newton cooling toward ambient + heat / freeze brushes.
  temp += (uAmbient - temp) * (1.0 - exp(-uMatC[m].w * uDt));
  vec3 xp = n0.xyz;
  int bt = int(uBrushAct.x + 0.5);
  float bf = max(0.0, 1.0 - distance(xp, uBrush.xyz) / max(uBrush.w, 1e-3));
  if (bt == 1) temp += uBrushAct.y * bf * uDt;
  if (bt == 2) temp -= uBrushAct.y * bf * uDt;

  // Pigment-like colour mixing: relax log-absorbance toward the local grid average.
  vec3 base, w0, w1, w2;
  bspline(xp, base, w0, w1, w2);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 3; i++)
  for (int j = 0; j < 3; j++)
  for (int k = 0; k < 3; k++) {
    float w = wsel(i, w0.x, w1.x, w2.x) * wsel(j, w0.y, w1.y, w2.y) * wsel(k, w0.z, w1.z, w2.z);
    acc += w * texelFetch(G1, nodePix(ivec3(base) + ivec3(i, j, k)), 0);
  }
  vec3 col = clamp(a6.rgb, vec3(0.004), vec3(1.0));
  if (acc.w > 1e-5) {
    vec3 lg = acc.rgb / acc.w;
    vec3 lp = -log(col);
    float mr = uMatA[m].w * (1.0 - solid);
    lp = mix(lp, lg, 1.0 - exp(-mr * uDt));
    col = exp(-lp);
  }
  if (bt == 3 && bf > 0.0) col = mix(col, uDye, 1.0 - exp(-uBrushAct.y * bf * uDt));

  float matOut = float(m);
  // Evaporation above the boiling point.
  if (temp > uMatD[m].w && hash(vec2(t) * 0.37 + temp) < 3.0 * uDt) matOut = -1.0;

  o0 = vec4(b[0][0], b[1][1], b[2][2], b[0][1]);
  o1 = vec4(b[0][2], b[1][2], temp, a5.w + uDt);
  o2 = vec4(col, matOut);
}
`;

// ---------------------------------------------------------------------------
// Emission: write freshly spawned particles into arbitrary slots.
// ---------------------------------------------------------------------------
export const emitVert = /* glsl */ `
precision highp float;
precision highp int;
uniform ivec2 uPTex;
in float aSlot;
in vec3 aPos;
in vec3 aVel;
in vec3 aCol;
in vec2 aMisc; // material, temperature
flat out vec3 vPos;
flat out vec3 vVel;
flat out vec3 vCol;
flat out vec2 vMisc;
void main() {
  int id = int(aSlot + 0.5);
  vec2 px = vec2(float(id % uPTex.x), float(id / uPTex.x)) + 0.5;
  gl_Position = vec4(px / vec2(uPTex) * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
  vPos = aPos; vVel = aVel; vCol = aCol; vMisc = aMisc;
}
`;

export const emitMainFrag = /* glsl */ `
precision highp float;
flat in vec3 vPos;
flat in vec3 vVel;
flat in vec3 vCol;
flat in vec2 vMisc;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
void main() { o0 = vec4(vPos, 0.0); o1 = vec4(vVel, 1.0); o2 = vec4(0.0); o3 = vec4(0.0); }
`;

export const emitAuxFrag = /* glsl */ `
precision highp float;
flat in vec3 vPos;
flat in vec3 vVel;
flat in vec3 vCol;
flat in vec2 vMisc;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
void main() { o0 = vec4(1.0, 1.0, 1.0, 0.0); o1 = vec4(0.0, 0.0, vMisc.y, 0.0); o2 = vec4(vCol, vMisc.x); }
`;

// Kill every particle (clear) — optionally only those of one material.
export const clearMainFrag = /* glsl */ `
precision highp float;
uniform sampler2D T0, T1, T2, T3, T6;
uniform float uOnlyMat;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  float m = texelFetch(T6, t, 0).a;
  if (uOnlyMat >= 0.0 && abs(m - uOnlyMat) > 0.5) {
    o0 = texelFetch(T0, t, 0); o1 = texelFetch(T1, t, 0); o2 = texelFetch(T2, t, 0); o3 = texelFetch(T3, t, 0);
    return;
  }
  o0 = vec4(-1.0e4, -1.0e4, -1.0e4, 0.0); o1 = vec4(0.0); o2 = vec4(0.0); o3 = vec4(0.0);
}
`;

export const clearAuxFrag = /* glsl */ `
precision highp float;
uniform sampler2D T4, T5, T6;
uniform float uOnlyMat;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 a6 = texelFetch(T6, t, 0);
  if (uOnlyMat >= 0.0 && abs(a6.a - uOnlyMat) > 0.5) {
    o0 = texelFetch(T4, t, 0); o1 = texelFetch(T5, t, 0); o2 = a6;
    return;
  }
  o0 = vec4(1.0, 1.0, 1.0, 0.0); o1 = vec4(0.0); o2 = vec4(a6.rgb, -1.0);
}
`;

// Pack position + speed for CPU-side statistics.
export const packFrag = /* glsl */ `
precision highp float;
uniform sampler2D T0, T1, T5, T6;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 a6 = texelFetch(T6, t, 0);
  vec3 x = texelFetch(T0, t, 0).xyz;
  float sp = length(texelFetch(T1, t, 0).xyz);
  float temp = texelFetch(T5, t, 0).z;
  o0 = vec4(x, a6.a < -0.5 ? -1.0 : sp);
  // alpha packs material slot and temperature: slot * 10000 + (T + 1000)
  o1 = vec4(a6.rgb, a6.a < -0.5 ? -1000.0 : a6.a * 10000.0 + clamp(temp, -999.0, 4999.0) + 1000.0);
}
`;
