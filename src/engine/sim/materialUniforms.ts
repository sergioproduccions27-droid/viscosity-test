import * as THREE from 'three';
import type { MaterialPhysics } from '../types';
import type { MaterialUniforms } from './MPMSolver';

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Kinematic viscosity in m²/s (playground units) for the 0..1 slider. */
export function kinematicViscosity(v: number): number {
  if (v <= 0.0005) return 0;
  // Calibrated on the stream Reynolds number Re = U·d/ν (U ≈ 1.5 m/s, d ≈ 0.05 m):
  // 1% ≈ 2e-4 (splashy), 20% ≈ 2e-3 (dome), 40% ≈ 0.017 (torus), 80% ≈ 0.5 (coils), 99% ≈ 2.3 (tower)
  return Math.pow(10, -3.8 + 4.2 * Math.pow(v, 0.8));
}

/** Speed of sound used by the weakly-compressible pressure solve (m/s). */
export function soundSpeed(p: MaterialPhysics): number {
  return 0.9 + 2.1 * p.pressure;
}

/** Shear wave speeds (m/s) of the liquid's viscoelastic part and the frozen state. */
export function shearSpeeds(p: MaterialPhysics) {
  const c = soundSpeed(p);
  const csVisc = 1.05 * smooth(0.4, 0.62, p.viscosity);
  const csElastic = 1.35 * p.elasticity;
  const liquid = Math.min(Math.hypot(csVisc, csElastic), 0.95 * c);
  const solid = Math.min((0.45 + 0.85 * p.solidStiffness) * c, 0.95 * c);
  return { liquid, solid, c };
}

/**
 * Convert user-facing material physics into grid-unit solver uniforms.
 *
 * Viscosity model (documented as an approximation in the UI):
 *  - low/medium viscosity: exact exponential damping of the per-particle strain rate,
 *    equivalent to an implicit viscous stress at the grid scale;
 *  - high viscosity: an Upper-Convected Maxwell element (shear modulus G, relaxation λ)
 *    with ν = G·λ/ρ, which stays stable at any viscosity and reproduces rope coiling.
 */
export function physicsToUniforms(p: MaterialPhysics, dx: number): MaterialUniforms {
  const nu = kinematicViscosity(p.viscosity);
  const { liquid: cs, solid: csSolid, c } = shearSpeeds(p);
  const inv2 = 1 / (dx * dx);

  const dampRate = Math.min(8 * nu * inv2, 4e5);
  let relax: number;
  if (cs < 1e-3) relax = 1e6;
  else {
    const lambdaVisc = nu / (cs * cs);
    const lambdaElastic = p.elasticity > 0 ? 0.25 + 9 * p.elasticity * p.elasticity : 0;
    relax = 1 / Math.max(lambdaVisc, lambdaElastic, 1e-6);
  }
  const yieldStrain = p.plasticity > 0 ? 0.03 + 0.7 * Math.pow(1 - p.plasticity, 1.5) : 1e9;
  const mixRate = 2.8 * Math.pow(1 - p.viscosity, 3) + 0.015;
  // Tension floor as a fraction of the bulk modulus. Very viscous liquids pinch off far more
  // slowly (capillary time ~ ηR/σ), so the beading drive is reduced as viscosity rises.
  // 0.04 is the largest floor that stays free of the MPM tensile instability (tested).
  // Expressed relative to K = ρc², so divide by c² to keep the absolute tension independent
  // of the stiffness slider (stiffer liquids must not pull harder).
  const cohesion = 0.04 * Math.pow(p.surfaceTension, 0.8) * Math.min(1, (1.9 * 1.9) / (c * c)) * (1 - 0.85 * smooth(0.45, 0.95, p.viscosity));
  const stickRate = 140 * p.stickiness * p.stickiness;
  const solidDamp = 20 + 380 * p.solidDamping;

  return {
    a: new THREE.Vector4(p.density, c * c * inv2, cohesion, mixRate),
    b: new THREE.Vector4(dampRate, cs * cs * inv2, relax, yieldStrain),
    c: new THREE.Vector4(p.refTemp, p.tempSensitivity, p.freezePoint, p.coolRate),
    d: new THREE.Vector4(csSolid * csSolid * inv2, solidDamp, stickRate, p.boilPoint ?? 1e9),
  };
}
