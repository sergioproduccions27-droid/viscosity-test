// Shared types between the simulation engine and the UI layer.
// All world-space quantities use "playground units": the simulation domain is
// 1.0 wide/deep and 1.25 tall. One unit is presented to the user as 1 m.

export type Vec3 = [number, number, number];

export type MaterialId =
  | 'water'
  | 'honey'
  | 'lava'
  | 'slime'
  | 'chocolate'
  | 'paint'
  | 'metal'
  | 'glass'
  | 'toothpaste'
  | 'jelly'
  | 'rainbow'
  | 'custom';

/** Physical parameters of a liquid. Sliders are normalised 0..1 unless noted. */
export interface MaterialPhysics {
  /** 0 = water-like, 1 = extremely thick (maps exponentially to kinematic viscosity). */
  viscosity: number;
  /** Relative density (g/cm³). Water = 1. */
  density: number;
  /** Cohesion / surface tension strength (approximated with tensile pressure). */
  surfaceTension: number;
  /** Temperature of the liquid as it leaves the emitter (°C). */
  temperature: number;
  /** Adhesion to solid surfaces. */
  stickiness: number;
  /** Elastic shear modulus + memory (viscoelastic Maxwell model). */
  elasticity: number;
  /** 0 = no yield, >0 = plastic flow above a yield strain (toothpaste-like). */
  plasticity: number;
  /** Bulk stiffness of the liquid — how hard it pushes back when compressed. */
  pressure: number;
  /** Viscosity is evaluated relative to this temperature (°C). */
  refTemp: number;
  /** Arrhenius-like sensitivity (1/°C). Higher = viscosity changes faster with temperature. */
  tempSensitivity: number;
  /** Below this temperature the material solidifies (°C). */
  freezePoint: number;
  /** Newtonian cooling rate toward ambient (1/s). */
  coolRate: number;
  /** Above this temperature the liquid evaporates (°C). null = never. */
  boilPoint: number | null;
  /** Stiffness of the frozen state 0..1. */
  solidStiffness: number;
  /** Internal damping of the frozen state 0..1 (low = bouncy). */
  solidDamping: number;
}

export interface MaterialLook {
  /** 0 = fully opaque, 1 = crystal clear */
  transparency: number;
  /** Strength of environment reflections 0..1 */
  reflectivity: number;
  /** Surface roughness 0..1 */
  roughness: number;
  /** Self-illumination 0..1 (also multiplied by temperature for hot materials) */
  glow: number;
  /** Metallic response 0..1 (tints reflections with the base colour) */
  metallic: number;
  /** Whether glow is driven by temperature (lava, glass) */
  thermalGlow: boolean;
  /** Colour that hot material glows with */
  glowColor: string;
  /** Colour the frozen / solidified state shifts toward */
  solidColor: string;
}

export interface Material {
  id: MaterialId;
  name: string;
  physics: MaterialPhysics;
  look: MaterialLook;
  /** Default stream palette */
  palette: string[];
  /** Hue-cycling colours along the stream */
  rainbow: boolean;
}

export interface Emitter {
  id: string;
  position: Vec3;
  /** Euler rotation (radians) applied to the default downward direction. */
  rotation: Vec3;
  material: Material;
  streams: number;
  colors: string[];
  /** Stream radius in world units */
  thickness: number;
  /** Exit speed in world units / s */
  flowSpeed: number;
  /** Radius of the helix the streams twist around */
  twistRadius: number;
  /** Helix rotation speed (rev / s) */
  twistSpeed: number;
  enabled: boolean;
}

export type GravityMode = 'normal' | 'zero' | 'reversed' | 'custom';

export interface WorldSettings {
  gravityMode: GravityMode;
  /** Custom gravity vector in m/s² (only used for 'custom'), scaled by gravityStrength */
  customGravity: Vec3;
  /** Gravity magnitude multiplier for normal / reversed / custom */
  gravityStrength: number;
  ambientTemp: number;
  /** Coulomb friction coefficient of all solid surfaces */
  friction: number;
  /** Slow motion → accelerated (0.1 .. 3) */
  simSpeed: number;
  /** Closed box instead of open edges */
  walls: boolean;
  /** Soft spherical containment (zero gravity mode) */
  containment: boolean;
  platformTilt: [number, number];
  platformSpin: number;
  showPlatform: boolean;
}

export type ObstacleKind = 'ramp' | 'funnel' | 'container' | 'block' | 'pillar';
export type BodyKind = 'ball' | 'cube';

export interface ObstacleSpec {
  id: string;
  kind: ObstacleKind;
  position: Vec3;
  rotation: Vec3;
  scale: number;
}

export interface BodySpec {
  id: string;
  kind: BodyKind;
  position: Vec3;
  size: number;
  density: number;
  color: string;
}

export type ToolId =
  | 'orbit'
  | 'stir'
  | 'whirlpool'
  | 'attract'
  | 'repel'
  | 'pour'
  | 'freeze'
  | 'heat'
  | 'dye'
  | 'erase'
  | 'select';

export type GameMode =
  | 'sandbox'
  | 'tower'
  | 'colormix'
  | 'fill'
  | 'chaos'
  | 'relax'
  | 'zerog';

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface FluidStats {
  alive: number;
  capacity: number;
  maxHeight: number; // settled liquid height above platform (m)
  peakHeight: number; // highest liquid anywhere above platform (m)
  avgSpeed: number;
  kinetic: number;
  avgTemp: number;
  frozen: number;
  onPlatform: number;
}
