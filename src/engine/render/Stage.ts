import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { OBSTACLE_DEFS, PILLAR_SLABS, PLATFORM } from '../SceneLayout';
import type { BodySpec, Emitter, ObstacleSpec } from '../types';
import { emitterDirection } from '../sim/Emission';

export const fogUniforms = {
  uFogColor: { value: new THREE.Color(0x2b1849) },
  uFogY: { value: 0.12 },
};

/** Inject a height fog (fading into the abyss below the stage) into a built-in material. */
export function withHeightFog<T extends THREE.Material>(m: T): T {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uFogColor = fogUniforms.uFogColor;
    shader.uniforms.uFogY = fogUniforms.uFogY;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWorldY;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWorldY = (modelMatrix * vec4(transformed, 1.0)).y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vWorldY;\nuniform vec3 uFogColor;\nuniform float uFogY;')
      .replace(
        '#include <dithering_fragment>',
        '#include <dithering_fragment>\ngl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, smoothstep(uFogY, uFogY - 0.45, vWorldY));',
      );
  };
  m.customProgramCacheKey = () => 'hfog';
  return m;
}

function concreteTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#d6d4d8';
  g.fillRect(0, 0, 512, 512);
  // soft large-scale variation
  for (let i = 0; i < 40; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const r = 40 + Math.random() * 120;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const v = Math.random() > 0.5 ? 255 : 150;
    grd.addColorStop(0, `rgba(${v},${v},${v},0.06)`);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // speckles / pores like polished concrete
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const s = Math.random() * 1.6 + 0.3;
    const v = Math.random() > 0.3 ? 90 + Math.random() * 60 : 235;
    g.fillStyle = `rgba(${v},${v},${v + 4},${0.25 + Math.random() * 0.35})`;
    g.beginPath();
    g.arc(x, y, s, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function latheProfile(pts: number[], thickness: number): THREE.Vector2[] {
  const line: THREE.Vector2[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const v = new THREE.Vector2(pts[i], pts[i + 1]);
    if (!line.length || line[line.length - 1].distanceTo(v) > 1e-5) line.push(v);
  }
  const outer: THREE.Vector2[] = [];
  const inner: THREE.Vector2[] = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(line.length - 1, i + 1)];
    const t = new THREE.Vector2().subVectors(b, a).normalize();
    const n = new THREE.Vector2(t.y, -t.x);
    outer.push(line[i].clone().addScaledVector(n, thickness));
    inner.push(line[i].clone().addScaledVector(n, -thickness));
  }
  const prof = [...outer, ...inner.reverse()];
  prof.push(prof[0].clone());
  return prof.map((p) => new THREE.Vector2(Math.max(0, p.x), p.y));
}

export function obstacleGeometry(kind: ObstacleSpec['kind']): THREE.BufferGeometry {
  switch (kind) {
    case 'ramp':
    case 'block':
    case 'pillar': {
      const h = OBSTACLE_DEFS[kind].half;
      return new RoundedBoxGeometry(h[0] * 2, h[1] * 2, h[2] * 2, 3, Math.min(...h) * 0.3);
    }
    case 'funnel':
    case 'container': {
      const d = OBSTACLE_DEFS[kind];
      return new THREE.LatheGeometry(latheProfile(d.pts, d.thickness * 0.9), 48);
    }
  }
}

export class Stage {
  readonly group = new THREE.Group();
  readonly transparentGroup = new THREE.Group();
  readonly platform: THREE.Mesh;
  readonly pillar = new THREE.Group();
  private slabMat: THREE.MeshStandardMaterial;
  private emitterMeshes = new Map<string, THREE.Group>();
  private obstacleMeshes = new Map<string, THREE.Mesh>();
  private bodyMeshes = new Map<string, THREE.Mesh>();
  private nozzleGeo = new THREE.CylinderGeometry(0.022, 0.03, 0.05, 32, 1, true);
  private capGeo = new THREE.SphereGeometry(0.03, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
  private ringGeo = new THREE.TorusGeometry(0.0275, 0.0035, 12, 48);
  private obstacleMat: THREE.MeshPhysicalMaterial;
  private glassMat: THREE.MeshPhysicalMaterial;
  /** highlight the selected emitter only while the Select tool is active */
  showSelection = false;

  constructor() {
    const tex = concreteTexture();
    this.slabMat = withHeightFog(
      new THREE.MeshStandardMaterial({ color: 0xd8d6da, map: tex, roughness: 0.42, metalness: 0, envMapIntensity: 0.9 }),
    );
    const slabGeo = new RoundedBoxGeometry(PLATFORM.half.x * 2, PLATFORM.half.y * 2, PLATFORM.half.z * 2, 4, PLATFORM.round * 1.6);
    this.platform = new THREE.Mesh(slabGeo, this.slabMat);
    this.platform.position.copy(PLATFORM.center);
    this.platform.castShadow = true;
    this.platform.receiveShadow = true;
    this.group.add(this.platform);

    const pillarGeo = new RoundedBoxGeometry(PILLAR_SLABS[0].half.x * 2, PILLAR_SLABS[0].half.y * 2, PILLAR_SLABS[0].half.z * 2, 3, 0.009);
    const slabs = [...PILLAR_SLABS];
    // visual-only continuation of the pillar into the fog
    for (let i = slabs.length; i < 26; i++) {
      slabs.push({ ...PILLAR_SLABS[0], y: PLATFORM.center.y - 0.044 * (i + 1), angle: (i + 1) * 0.085 + Math.sin(i * 0.9) * 0.05 });
    }
    for (const s of slabs) {
      const m = new THREE.Mesh(pillarGeo, this.slabMat);
      m.position.set(0, s.y, 0);
      m.rotation.y = s.angle;
      m.castShadow = true;
      m.receiveShadow = true;
      this.pillar.add(m);
    }
    this.group.add(this.pillar);

    this.obstacleMat = withHeightFog(
      new THREE.MeshPhysicalMaterial({ color: 0xece8f6, roughness: 0.25, metalness: 0.0, clearcoat: 0.6, clearcoatRoughness: 0.2 }),
    );
    this.glassMat = new THREE.MeshPhysicalMaterial({
      color: 0xdff2ff,
      roughness: 0.08,
      metalness: 0,
      transparent: true,
      opacity: 0.3,
      depthWrite: true,
      side: THREE.DoubleSide,
      clearcoat: 1,
    });
  }

  setSlabColor(c: string) {
    this.slabMat.color.set(c);
  }

  setPlatform(q: THREE.Quaternion, visible: boolean) {
    this.platform.quaternion.copy(q);
    this.platform.visible = visible;
    this.pillar.visible = visible;
  }

  syncEmitters(emitters: Emitter[], selectedId: string) {
    const live = new Set<string>();
    const dir = new THREE.Vector3();
    for (const e of emitters) {
      live.add(e.id);
      let g = this.emitterMeshes.get(e.id);
      if (!g) {
        g = new THREE.Group();
        const shell = new THREE.Mesh(this.nozzleGeo, new THREE.MeshPhysicalMaterial({ color: 0x2a2440, metalness: 0.9, roughness: 0.25, side: THREE.DoubleSide, clearcoat: 1 }));
        const cap = new THREE.Mesh(this.capGeo, shell.material);
        cap.position.y = 0.025;
        const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
        ring.rotation.x = Math.PI / 2;
        ring.position.y = -0.025;
        ring.name = 'ring';
        const halo = new THREE.Mesh(
          new THREE.RingGeometry(0.045, 0.06, 48),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false }),
        );
        halo.rotation.x = Math.PI / 2;
        halo.position.y = -0.025;
        halo.name = 'halo';
        g.add(shell, cap, ring, halo);
        g.userData.pick = { kind: 'emitter', id: e.id };
        for (const c of g.children) c.userData.pick = g.userData.pick;
        this.group.add(g);
        this.emitterMeshes.set(e.id, g);
      }
      g.position.set(...e.position);
      emitterDirection(e, dir);
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
      const scale = Math.max(0.6, e.twistRadius / 0.05 + e.thickness / 0.03) * 0.75;
      g.scale.setScalar(Math.min(1.6, scale));
      const ring = g.getObjectByName('ring') as THREE.Mesh;
      const rm = ring.material as THREE.MeshBasicMaterial;
      rm.color.set(e.colors[0] ?? '#ffffff').multiplyScalar(e.enabled ? 2.2 : 0.3);
      const halo = g.getObjectByName('halo') as THREE.Mesh;
      (halo.material as THREE.MeshBasicMaterial).opacity = e.id === selectedId && this.showSelection ? 0.55 : 0;
    }
    for (const [id, g] of this.emitterMeshes) {
      if (!live.has(id)) {
        this.group.remove(g);
        this.emitterMeshes.delete(id);
      }
    }
  }

  syncObstacles(list: ObstacleSpec[]) {
    const live = new Set<string>();
    for (const o of list) {
      live.add(o.id);
      let m = this.obstacleMeshes.get(o.id);
      if (!m || m.userData.kind !== o.kind) {
        if (m) (m.parent as THREE.Object3D).remove(m);
        const glass = o.kind === 'container';
        m = new THREE.Mesh(obstacleGeometry(o.kind), glass ? this.glassMat : this.obstacleMat);
        m.castShadow = !glass;
        m.receiveShadow = true;
        m.userData.kind = o.kind;
        m.userData.pick = { kind: 'obstacle', id: o.id };
        (glass ? this.transparentGroup : this.group).add(m);
        this.obstacleMeshes.set(o.id, m);
      }
      m.position.set(...o.position);
      m.rotation.set(o.rotation[0], o.rotation[1], o.rotation[2], 'XYZ');
      m.scale.setScalar(o.scale);
    }
    for (const [id, m] of this.obstacleMeshes) {
      if (!live.has(id)) {
        (m.parent as THREE.Object3D).remove(m);
        this.obstacleMeshes.delete(id);
      }
    }
  }

  obstacleObject(id: string) {
    return this.obstacleMeshes.get(id);
  }
  emitterObject(id: string) {
    return this.emitterMeshes.get(id);
  }
  bodyObject(id: string) {
    return this.bodyMeshes.get(id);
  }

  syncBodies(list: BodySpec[]) {
    const live = new Set<string>();
    for (const b of list) {
      live.add(b.id);
      let m = this.bodyMeshes.get(b.id);
      if (!m) {
        const geo = b.kind === 'ball' ? new THREE.SphereGeometry(b.size, 32, 24) : new RoundedBoxGeometry(b.size * 2, b.size * 2, b.size * 2, 3, b.size * 0.25);
        m = new THREE.Mesh(
          geo,
          withHeightFog(new THREE.MeshPhysicalMaterial({ color: b.color, roughness: 0.18, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0.08 })),
        );
        m.castShadow = true;
        m.receiveShadow = true;
        m.userData.pick = { kind: 'body', id: b.id };
        this.group.add(m);
        this.bodyMeshes.set(b.id, m);
      }
    }
    for (const [id, m] of this.bodyMeshes) {
      if (!live.has(id)) {
        this.group.remove(m);
        m.geometry.dispose();
        this.bodyMeshes.delete(id);
      }
    }
  }

  pickables(): THREE.Object3D[] {
    return [...this.emitterMeshes.values(), ...this.obstacleMeshes.values(), ...this.bodyMeshes.values()];
  }
}
