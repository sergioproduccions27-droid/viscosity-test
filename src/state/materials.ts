import type { Material, MaterialId, MaterialLook, MaterialPhysics } from '../engine/types';

const phys = (p: Partial<MaterialPhysics>): MaterialPhysics => ({
  viscosity: 0.4,
  density: 1,
  surfaceTension: 0.3,
  temperature: 20,
  stickiness: 0.15,
  elasticity: 0,
  plasticity: 0,
  pressure: 0.5,
  refTemp: 20,
  tempSensitivity: 0.015,
  freezePoint: -20,
  coolRate: 0.05,
  boilPoint: null,
  solidStiffness: 0.7,
  solidDamping: 0.7,
  ...p,
});

const look = (l: Partial<MaterialLook>): MaterialLook => ({
  transparency: 0.4,
  reflectivity: 0.85,
  roughness: 0.05,
  glow: 0,
  metallic: 0,
  thermalGlow: false,
  glowColor: '#ff6a1a',
  solidColor: '#e6f4ff',
  ...l,
});

export const MATERIALS: Record<MaterialId, Material> = {
  water: {
    id: 'water',
    name: 'Water',
    rainbow: false,
    palette: ['#5ec8ff', '#2a8cff', '#9fe7ff'],
    physics: phys({ viscosity: 0, density: 1, surfaceTension: 0.35, stickiness: 0.02, pressure: 0.6, freezePoint: 0, tempSensitivity: 0.012, boilPoint: 100, solidStiffness: 0.95, solidDamping: 0.6 }),
    look: look({ transparency: 0.88, reflectivity: 1, roughness: 0.01, solidColor: '#e8f6ff' }),
  },
  honey: {
    id: 'honey',
    name: 'Honey',
    rainbow: false,
    palette: ['#f6a50f', '#ffc23d', '#e2870b'],
    physics: phys({ viscosity: 0.78, density: 1.42, surfaceTension: 0.3, temperature: 25, refTemp: 25, stickiness: 0.55, pressure: 0.45, tempSensitivity: 0.045, freezePoint: -30, coolRate: 0.03 }),
    look: look({ transparency: 0.6, reflectivity: 0.9, roughness: 0.04, solidColor: '#c98a2a' }),
  },
  lava: {
    id: 'lava',
    name: 'Lava',
    rainbow: false,
    palette: ['#ff6a1a', '#ff3d0a', '#ffb02e'],
    physics: phys({ viscosity: 0.74, density: 2.6, surfaceTension: 0.2, temperature: 1150, refTemp: 1150, stickiness: 0.3, elasticity: 0.04, pressure: 0.5, tempSensitivity: 0.004, freezePoint: 720, coolRate: 0.14, solidStiffness: 0.85, solidDamping: 0.9 }),
    look: look({ transparency: 0, reflectivity: 0.35, roughness: 0.4, glow: 1, thermalGlow: true, glowColor: '#ff5212', solidColor: '#2a201d' }),
  },
  slime: {
    id: 'slime',
    name: 'Slime',
    rainbow: false,
    palette: ['#7dff3a', '#b6ff2e', '#3dff8c'],
    physics: phys({ viscosity: 0.58, density: 1.1, surfaceTension: 0.55, stickiness: 0.45, elasticity: 0.45, plasticity: 0.2, pressure: 0.35, freezePoint: -10, tempSensitivity: 0.02 }),
    look: look({ transparency: 0.5, reflectivity: 0.9, roughness: 0.06, glow: 0.12, glowColor: '#7dff3a', solidColor: '#c8ffd0' }),
  },
  chocolate: {
    id: 'chocolate',
    name: 'Melted Chocolate',
    rainbow: false,
    palette: ['#6b3a1f', '#8a4b28', '#f1dcc0'],
    physics: phys({ viscosity: 0.64, density: 1.3, surfaceTension: 0.25, temperature: 45, refTemp: 45, stickiness: 0.45, pressure: 0.45, tempSensitivity: 0.03, freezePoint: 27, coolRate: 0.045, solidStiffness: 0.8, solidDamping: 0.9 }),
    look: look({ transparency: 0, reflectivity: 0.6, roughness: 0.14, solidColor: '#5a321c' }),
  },
  paint: {
    id: 'paint',
    name: 'Paint',
    rainbow: false,
    palette: ['#ff2b4f', '#ffd21f', '#1f6bff'],
    physics: phys({ viscosity: 0.3, density: 1.25, surfaceTension: 0.2, stickiness: 0.25, pressure: 0.5, freezePoint: -5, tempSensitivity: 0.01 }),
    look: look({ transparency: 0, reflectivity: 0.55, roughness: 0.18, solidColor: '#ffffff' }),
  },
  metal: {
    id: 'metal',
    name: 'Liquid Metal',
    rainbow: false,
    palette: ['#dfe3ea', '#c3c9d2', '#f3f5f8'],
    physics: phys({ viscosity: 0.06, density: 13.5, surfaceTension: 1, stickiness: 0, pressure: 0.75, freezePoint: -39, tempSensitivity: 0.004, boilPoint: 357, solidStiffness: 1, solidDamping: 0.5 }),
    look: look({ transparency: 0, reflectivity: 1, roughness: 0.09, metallic: 1, solidColor: '#9aa1ad' }),
  },
  glass: {
    id: 'glass',
    name: 'Molten Glass',
    rainbow: false,
    palette: ['#c8f2ff', '#ffe2b8', '#d6c8ff'],
    physics: phys({ viscosity: 0.88, density: 2.5, surfaceTension: 0.4, temperature: 1100, refTemp: 1100, stickiness: 0.35, elasticity: 0.04, pressure: 0.5, tempSensitivity: 0.006, freezePoint: 560, coolRate: 0.1, solidStiffness: 1, solidDamping: 0.8 }),
    look: look({ transparency: 0.94, reflectivity: 1, roughness: 0.01, glow: 0.55, thermalGlow: true, glowColor: '#ff8a2a', solidColor: '#eaf8ff' }),
  },
  toothpaste: {
    id: 'toothpaste',
    name: 'Toothpaste',
    rainbow: false,
    palette: ['#ffffff', '#26b6ff', '#ff3b5c'],
    physics: phys({ viscosity: 0.72, density: 1.35, surfaceTension: 0.3, stickiness: 0.35, elasticity: 0.6, plasticity: 0.55, pressure: 0.5, freezePoint: -15 }),
    look: look({ transparency: 0.04, reflectivity: 0.6, roughness: 0.14, solidColor: '#ffffff' }),
  },
  jelly: {
    id: 'jelly',
    name: 'Jelly',
    rainbow: false,
    palette: ['#ff2d6f', '#ff7b2d', '#b02dff'],
    physics: phys({ viscosity: 0.36, density: 1.05, surfaceTension: 0.5, temperature: 40, refTemp: 40, stickiness: 0.1, elasticity: 0.8, pressure: 0.5, tempSensitivity: 0.01, freezePoint: 24, coolRate: 0.12, solidStiffness: 0.3, solidDamping: 0.04 }),
    look: look({ transparency: 0.62, reflectivity: 0.95, roughness: 0.03, solidColor: '#ffffff' }),
  },
  rainbow: {
    id: 'rainbow',
    name: 'Rainbow Liquid',
    rainbow: true,
    palette: ['#ff3b3b', '#3bff6b', '#3b7bff'],
    physics: phys({ viscosity: 0.45, density: 1.1, surfaceTension: 0.4, stickiness: 0.2 }),
    look: look({ transparency: 0.35, reflectivity: 0.95, roughness: 0.03, glow: 0.12, glowColor: '#ffffff' }),
  },
  custom: {
    id: 'custom',
    name: 'Custom',
    rainbow: false,
    palette: ['#ff1e2e', '#2ee04a', '#2a7bff'],
    physics: phys({ viscosity: 0.4, density: 1, surfaceTension: 0.3, stickiness: 0.2, pressure: 0.5 }),
    look: look({ transparency: 0.42, reflectivity: 0.92, roughness: 0.035 }),
  },
};

export const MATERIAL_ORDER: MaterialId[] = [
  'water', 'honey', 'lava', 'slime', 'chocolate', 'paint',
  'metal', 'glass', 'toothpaste', 'jelly', 'rainbow', 'custom',
];

export function cloneMaterial(m: Material): Material {
  return {
    ...m,
    physics: { ...m.physics },
    look: { ...m.look },
    palette: [...m.palette],
  };
}

/** Short tagline shown on the preset card. */
export const MATERIAL_TAGLINE: Record<MaterialId, string> = {
  water: 'Splashy · freezes at 0 °C · boils at 100 °C',
  honey: 'Thick rope coils · warms runny',
  lava: 'Glows hot · crusts into rock as it cools',
  slime: 'Stretchy viscoelastic goo',
  chocolate: 'Glossy · sets at room temperature',
  paint: 'Opaque pigments that mix',
  metal: 'Mirror chrome · 13.5× heavier than water',
  glass: 'Clear & glowing · solidifies below 560 °C',
  toothpaste: 'Yield-stress paste holds its shape',
  jelly: 'Pours warm, sets into bouncy jelly',
  rainbow: 'Hue-cycling candy liquid',
  custom: 'Your own recipe',
};
