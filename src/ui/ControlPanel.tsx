import { Box, CircleDot, Container, Copy, Dice5, Download, FlaskConical, Globe2, Layers, Plus, Save, Settings2, Shapes, Trash2, Triangle, Waves, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ENVIRONMENTS } from '../engine/render/Environment';
import { kinematicViscosity, soundSpeed } from '../engine/sim/materialUniforms';
import type { GravityMode, MaterialId, QualityTier } from '../engine/types';
import { applyConfig, captureConfig, deleteExperiment, listExperiments, saveExperiment, type SavedExperiment } from '../state/config';
import { MATERIALS, MATERIAL_ORDER, MATERIAL_TAGLINE } from '../state/materials';
import { MAX_EMITTERS, useStore } from '../state/store';
import { copyShareLink, getEngine, randomize, thumbnail } from './actions';
import { Info, Section, Seg, Slider, Toggle, pct } from './controls';
import { QuickButtons } from './TopBar';

type Tab = 'liquid' | 'physics' | 'flow' | 'world' | 'objects' | 'library' | 'settings';
const TABS: { id: Tab; label: string; icon: typeof Waves }[] = [
  { id: 'liquid', label: 'Liquid', icon: FlaskConical },
  { id: 'physics', label: 'Physics', icon: Layers },
  { id: 'flow', label: 'Flow', icon: Waves },
  { id: 'world', label: 'World', icon: Globe2 },
  { id: 'objects', label: 'Objects', icon: Shapes },
  { id: 'library', label: 'Library', icon: Save },
  { id: 'settings', label: 'Settings', icon: Settings2 },
];

const deg = (r: number) => `${Math.round((r * 180) / Math.PI)}°`;
const rad = (d: number) => (d * Math.PI) / 180;

function blobStyle(id: MaterialId): React.CSSProperties {
  const m = MATERIALS[id];
  const [a, b, c] = m.rainbow ? ['#ff4d4d', '#4dff88', '#4d8dff'] : [m.palette[0], m.palette[1] ?? m.palette[0], m.palette[2] ?? m.palette[0]];
  const glow = m.look.glow > 0.3 ? `0 0 22px ${m.look.glowColor}` : '0 8px 18px rgba(0,0,0,.35)';
  const bg = m.rainbow
    ? `conic-gradient(from 40deg, #ff4d4d, #ffd24d, #4dff88, #4dd2ff, #9b4dff, #ff4d4d)`
    : m.look.metallic > 0.5
      ? `radial-gradient(circle at 30% 25%, #ffffff, ${a} 30%, #6b7380 70%, #2a2f38)`
      : `radial-gradient(circle at 32% 28%, rgba(255,255,255,${0.35 + m.look.reflectivity * 0.4}), ${a} 32%, ${b} 62%, ${c})`;
  return { background: bg, boxShadow: `${glow}, inset 0 -6px 12px rgba(0,0,0,.3)`, opacity: 1 - m.look.transparency * 0.25 };
}

// ---------------------------------------------------------------- tabs
function LiquidTab() {
  const e = useStore((s) => s.emitters.find((x) => x.id === s.selectedEmitterId) ?? s.emitters[0]);
  const applyPreset = useStore((s) => s.applyPreset);
  const updateLook = useStore((s) => s.updateLook);
  const updateEmitter = useStore((s) => s.updateEmitter);
  if (!e) return null;
  const look = e.material.look;
  return (
    <>
      <Section title="Material presets">
        <div className="mats">
          {MATERIAL_ORDER.map((id) => (
            <button key={id} type="button" data-testid={`preset-${id}`} className={`mat-card ${e.material.id === id ? 'on' : ''}`} onClick={() => { applyPreset(id); getEngine()?.sound.click(1.2); }} title={MATERIAL_TAGLINE[id]}>
              <i className="mat-blob" style={blobStyle(id)} />
              <span>{MATERIALS[id].name}</span>
            </button>
          ))}
        </div>
        <div className="mat-tag">{MATERIAL_TAGLINE[e.material.id]}</div>
      </Section>
      <Section title="Stream colours">
        <div className="stream-colors">
          {Array.from({ length: e.streams }, (_, i) => (
            <input
              key={i}
              className="color-input"
              style={{ width: 30, height: 30 }}
              type="color"
              aria-label={`Stream ${i + 1} colour`}
              value={e.colors[i % e.colors.length] ?? '#ffffff'}
              onChange={(ev) => {
                const colors = Array.from({ length: Math.max(e.streams, e.colors.length) }, (_, k) => e.colors[k % e.colors.length]);
                colors[i] = ev.target.value;
                updateEmitter(e.id, { colors });
              }}
            />
          ))}
          <button className="pill-btn small" type="button" onClick={() => updateEmitter(e.id, { colors: [...MATERIALS[e.material.id].palette] })}>Reset</button>
        </div>
        <Toggle label="Rainbow hue cycling" checked={e.material.rainbow} onChange={(v) => updateEmitter(e.id, { material: { ...e.material, rainbow: v } })} />
      </Section>
      <Section title="Appearance">
        <Slider label="Transparency" value={look.transparency} min={0} max={1} onChange={(v) => updateLook({ transparency: v })} format={pct} info="How much light passes through. Thicker liquid absorbs more (Beer–Lambert), tinting what's behind it." />
        <Slider label="Reflectivity" value={look.reflectivity} min={0} max={1} onChange={(v) => updateLook({ reflectivity: v })} format={pct} info="Strength of environment reflections (Fresnel-weighted)." />
        <Slider label="Gloss" value={1 - look.roughness} min={0} max={1} onChange={(v) => updateLook({ roughness: 1 - v })} format={pct} info="Smooth surfaces give sharp highlights; rough ones look satin or matte." />
        <Slider label="Metallic" value={look.metallic} min={0} max={1} onChange={(v) => updateLook({ metallic: v })} format={pct} />
        <Slider label="Glow" value={look.glow} min={0} max={1} onChange={(v) => updateLook({ glow: v })} format={pct} info="Self-illumination. For lava and molten glass the glow follows the liquid's temperature." />
        <div className="row">
          <span className="label">Glow colour</span>
          <input className="color-input" type="color" value={look.glowColor} onChange={(ev) => updateLook({ glowColor: ev.target.value })} aria-label="Glow colour" />
          <span className="label" style={{ marginLeft: 12 }}>Solid colour</span>
          <input className="color-input" type="color" value={look.solidColor} onChange={(ev) => updateLook({ solidColor: ev.target.value })} aria-label="Frozen colour" />
        </div>
        <Toggle label="Temperature-driven glow" checked={look.thermalGlow} onChange={(v) => updateLook({ thermalGlow: v })} />
      </Section>
    </>
  );
}

function PhysicsTab() {
  const e = useStore((s) => s.emitters.find((x) => x.id === s.selectedEmitterId) ?? s.emitters[0]);
  const up = useStore((s) => s.updatePhysics);
  if (!e) return null;
  const p = e.material.physics;
  const nu = kinematicViscosity(p.viscosity);
  const nuText = nu === 0 ? 'inviscid' : nu < 1e-3 ? `${(nu * 1e6).toFixed(0)} mm²/s` : `${(nu * 1e4).toFixed(nu < 0.01 ? 1 : 0)} cm²/s`;
  return (
    <>
      <Section title={`Liquid physics · ${e.material.name}`}>
        <Slider label="Viscosity" value={p.viscosity} min={0} max={1} step={0.01} onChange={(v) => up({ viscosity: v })} format={pct} testId="slider-viscosity"
          colors={['#6fe9ff', '#ff9a3d']}
          info={`Resistance to flow. Kinematic viscosity now ≈ ${nuText}. Low: splashes, thin streams and fast colour mixing. High: rope coiling and stacking towers.`}
          approx="strain-rate damping + Maxwell viscoelastic element at high values" />
        <Slider label="Density" value={p.density} min={0.2} max={15} scale="log" onChange={(v) => up({ density: v })} format={(v) => `${v.toFixed(v < 2 ? 2 : 1)} g/cm³`}
          info="Mass per volume. Heavy liquids sink beneath light ones, hit objects harder and make balls float. Gravity alone accelerates every density equally." />
        <Slider label="Surface tension" value={p.surfaceTension} min={0} max={1} onChange={(v) => up({ surfaceTension: v })} format={pct}
          info="Cohesion: the liquid pulls itself together into beads and blobs, and streams pinch into droplets."
          approx="tensile pressure floor at the free surface" />
        <Slider label="Temperature" value={p.temperature + 60} min={10} max={1560} scale="log" onChange={(v) => up({ temperature: Math.round(v - 60) })} format={(v) => `${Math.round(v - 60)} °C`}
          info={`Temperature as it leaves the nozzle. Viscosity follows an Arrhenius-style law around ${p.refTemp} °C; below ${p.freezePoint} °C it solidifies${p.boilPoint !== null ? `; above ${p.boilPoint} °C it boils away` : ''}.`}
          approx="exponential viscosity law, Newtonian cooling" />
        <Slider label="Stickiness" value={p.stickiness} min={0} max={1} onChange={(v) => up({ stickiness: v })} format={pct}
          info="Adhesion to solid surfaces. Sticky liquids cling to the pillar and drip down slowly instead of sliding off." />
        <Slider label="Elasticity" value={p.elasticity} min={0} max={1} onChange={(v) => up({ elasticity: v })} format={pct}
          info="Elastic memory: the liquid springs back like jelly. Combined with viscosity it becomes viscoelastic slime."
          approx="Upper-Convected Maxwell model with Neo-Hookean stress" />
        <Slider label="Plasticity" value={p.plasticity} min={0} max={1} onChange={(v) => up({ plasticity: v })} format={pct}
          info="Yield behaviour: below the yield strain it holds its shape, above it flows (toothpaste, mayo)."
          approx="von Mises-style yield on the elastic strain" />
        <Slider label="Liquid pressure" value={p.pressure} min={0} max={1} onChange={(v) => up({ pressure: v })} format={(v) => `${soundSpeed({ ...p, pressure: v }).toFixed(1)} m/s`}
          info="Bulk stiffness (speed of sound in the liquid). High = nearly incompressible with crisp, energetic splashes. Low = soft and squishy."
          approx="weakly-compressible Tait equation of state" />
      </Section>
      <Section title="Thermal behaviour" defaultOpen={false}>
        <Slider label="Freezing point" value={p.freezePoint + 60} min={10} max={1560} scale="log" onChange={(v) => up({ freezePoint: Math.round(v - 60) })} format={(v) => `${Math.round(v - 60)} °C`} info="Below this temperature the material becomes solid. Try the freeze brush!" />
        <Slider label="Heat sensitivity" value={p.tempSensitivity} min={0} max={0.08} onChange={(v) => up({ tempSensitivity: v })} format={(v) => v.toFixed(3)} info="How strongly viscosity drops as the liquid heats up." />
        <Slider label="Cooling rate" value={p.coolRate} min={0} max={0.6} onChange={(v) => up({ coolRate: v })} format={(v) => `${v.toFixed(2)} /s`} info="How fast the liquid approaches the ambient temperature." />
        <Slider label="Frozen stiffness" value={p.solidStiffness} min={0} max={1} onChange={(v) => up({ solidStiffness: v })} format={pct} />
        <Slider label="Frozen damping" value={p.solidDamping} min={0} max={1} onChange={(v) => up({ solidDamping: v })} format={pct} info="Low damping makes the frozen state bouncy (jelly)." />
      </Section>
    </>
  );
}

function FlowTab() {
  const emitters = useStore((s) => s.emitters);
  const selId = useStore((s) => s.selectedEmitterId);
  const e = emitters.find((x) => x.id === selId) ?? emitters[0];
  const updateEmitter = useStore((s) => s.updateEmitter);
  if (!e) return null;
  const u = (p: Partial<typeof e>) => updateEmitter(e.id, p);
  return (
    <>
      <Section title="Emitters" right={<span className="muted">{emitters.length}/{MAX_EMITTERS}</span>}>
        <div className="list">
          {emitters.map((x, i) => (
            <div key={x.id} className={`list-item ${x.id === e.id ? 'on' : ''}`} onClick={() => useStore.setState({ selectedEmitterId: x.id, selection: { kind: 'emitter', id: x.id } })}>
              <span className="dot" style={{ background: x.colors[0] }} />
              <span className="grow">#{i + 1} · {x.material.name} · {Math.round(x.material.physics.viscosity * 100)}%</span>
              <button className="icon-btn" style={{ width: 28, height: 28 }} type="button" aria-label="Remove emitter" onClick={(ev) => { ev.stopPropagation(); useStore.getState().removeEmitter(x.id); }}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
        <button className="pill-btn small" type="button" data-testid="add-emitter" onClick={() => useStore.getState().addEmitter()}><Plus size={14} /> Add emitter</button>
      </Section>
      <Section title="Stream">
        <Toggle label="Flowing" checked={e.enabled} onChange={(v) => u({ enabled: v })} />
        <Slider label="Number of streams" value={e.streams} min={1} max={6} step={1} onChange={(v) => u({ streams: Math.round(v), colors: Array.from({ length: Math.round(v) }, (_, k) => e.colors[k % e.colors.length]) })} format={(v) => `${Math.round(v)}`} />
        <Slider label="Stream thickness" value={e.thickness} min={0.008} max={0.05} onChange={(v) => u({ thickness: v })} format={(v) => `${(v * 200).toFixed(1)} cm Ø`} info="Diameter of each stream. Thicker streams carry more liquid and coil into bigger ropes." />
        <Slider label="Flow speed" value={e.flowSpeed} min={0} max={2} onChange={(v) => u({ flowSpeed: v })} format={(v) => `${v.toFixed(2)} m/s`} info="Exit velocity at the nozzle. Volume flow = speed × stream area." />
        <Slider label="Twist radius" value={e.twistRadius} min={0} max={0.12} onChange={(v) => u({ twistRadius: v })} format={(v) => `${(v * 100).toFixed(1)} cm`} info="Radius of the helix the streams twist around — the braided look from the reference." />
        <Slider label="Twist speed" value={e.twistSpeed} min={-3} max={3} onChange={(v) => u({ twistSpeed: v })} format={(v) => `${v.toFixed(2)} rev/s`} />
      </Section>
      <Section title="Placement" defaultOpen={false}>
        <p className="muted" style={{ margin: 0 }}>Tip: use the Select tool to drag the nozzle in 3D.</p>
        <Slider label="Position X" value={e.position[0]} min={-0.45} max={0.45} onChange={(v) => u({ position: [v, e.position[1], e.position[2]] })} format={(v) => `${(v * 100).toFixed(0)} cm`} />
        <Slider label="Height" value={e.position[1]} min={0.3} max={1.18} onChange={(v) => u({ position: [e.position[0], v, e.position[2]] })} format={(v) => `${(v * 100).toFixed(0)} cm`} />
        <Slider label="Position Z" value={e.position[2]} min={-0.45} max={0.45} onChange={(v) => u({ position: [e.position[0], e.position[1], v] })} format={(v) => `${(v * 100).toFixed(0)} cm`} />
        <Slider label="Tilt forward" value={e.rotation[0]} min={-Math.PI / 2} max={Math.PI / 2} onChange={(v) => u({ rotation: [v, e.rotation[1], e.rotation[2]] })} format={deg} />
        <Slider label="Tilt sideways" value={e.rotation[2]} min={-Math.PI / 2} max={Math.PI / 2} onChange={(v) => u({ rotation: [e.rotation[0], e.rotation[1], v] })} format={deg} />
      </Section>
    </>
  );
}

function WorldTab() {
  const w = useStore((s) => s.world);
  const env = useStore((s) => s.environment);
  const up = useStore((s) => s.updateWorld);
  return (
    <>
      <Section title="Gravity">
        <Seg<GravityMode> value={w.gravityMode} onChange={(v) => up({ gravityMode: v })} options={[{ id: 'normal', label: 'Normal' }, { id: 'zero', label: 'Zero' }, { id: 'reversed', label: 'Reversed' }, { id: 'custom', label: 'Custom' }]} />
        {w.gravityMode !== 'zero' && (
          <Slider label="Strength" value={w.gravityStrength} min={0.05} max={3} onChange={(v) => up({ gravityStrength: v })} format={(v) => `${v.toFixed(2)} g`} info="1 g here is tuned so a pour falls like the reference footage." />
        )}
        {w.gravityMode === 'custom' && (
          <>
            <Slider label="Direction X" value={w.customGravity[0]} min={-1} max={1} onChange={(v) => up({ customGravity: [v, w.customGravity[1], w.customGravity[2]] })} format={(v) => v.toFixed(2)} />
            <Slider label="Direction Y" value={w.customGravity[1]} min={-1} max={1} onChange={(v) => up({ customGravity: [w.customGravity[0], v, w.customGravity[2]] })} format={(v) => v.toFixed(2)} />
            <Slider label="Direction Z" value={w.customGravity[2]} min={-1} max={1} onChange={(v) => up({ customGravity: [w.customGravity[0], w.customGravity[1], v] })} format={(v) => v.toFixed(2)} />
          </>
        )}
      </Section>
      <Section title="Environment physics">
        <Slider label="Simulation speed" value={w.simSpeed} min={0.1} max={3} scale="log" onChange={(v) => up({ simSpeed: v })} format={(v) => `${v.toFixed(2)}×`} testId="slider-simspeed" info="Slow motion to accelerated physics. Faster speeds use more sub-steps to stay stable." />
        <Slider label="Ambient temperature" value={w.ambientTemp + 60} min={10} max={1560} scale="log" onChange={(v) => up({ ambientTemp: Math.round(v - 60) })} format={(v) => `${Math.round(v - 60)} °C`} info="Liquids cool or heat toward this temperature: lava crusts in cold air, chocolate sets at room temperature, water freezes below 0 °C." />
        <Slider label="Surface friction" value={w.friction} min={0} max={2} onChange={(v) => up({ friction: v })} format={(v) => `μ ${v.toFixed(2)}`} info="Coulomb friction of every solid surface. Zero = liquid skates off the platform." />
      </Section>
      <Section title="Platform">
        <Toggle label="Show platform & pillar" checked={w.showPlatform} onChange={(v) => up({ showPlatform: v })} />
        <Slider label="Tilt X" value={w.platformTilt[0]} min={rad(-35)} max={rad(35)} onChange={(v) => up({ platformTilt: [v, w.platformTilt[1]] })} format={deg} testId="slider-tiltx" />
        <Slider label="Tilt Z" value={w.platformTilt[1]} min={rad(-35)} max={rad(35)} onChange={(v) => up({ platformTilt: [w.platformTilt[0], v] })} format={deg} />
        <Slider label="Spin" value={w.platformSpin} min={-6} max={6} onChange={(v) => up({ platformSpin: Math.abs(v) < 0.15 ? 0 : v })} format={(v) => `${Math.round((v * 60) / (2 * Math.PI))} rpm`} info="A spinning turntable drags the liquid with friction and flings it outward." />
        <div className="row">
          <button className="pill-btn small" type="button" onClick={() => up({ platformTilt: [0, 0], platformSpin: 0 })}>Level & stop</button>
        </div>
        <Toggle label="Closed box (walls)" checked={w.walls} onChange={(v) => up({ walls: v })} info="Keep liquid inside an invisible box instead of letting it fall off the world." />
      </Section>
      <Section title="Backdrop">
        <div className="swatches">
          {ENVIRONMENTS.map((en) => (
            <button key={en.id} type="button" className={`swatch ${env === en.id ? 'on' : ''}`} title={en.name} aria-label={en.name}
              style={{ width: 34, height: 34, background: `linear-gradient(180deg, ${en.top}, ${en.bottom})` }}
              onClick={() => useStore.setState({ environment: en.id })} />
          ))}
        </div>
        <div className="muted">{ENVIRONMENTS.find((x) => x.id === env)?.name}</div>
      </Section>
    </>
  );
}

function ObjectsTab() {
  const obstacles = useStore((s) => s.obstacles);
  const bodies = useStore((s) => s.bodies);
  const selection = useStore((s) => s.selection);
  const s = useStore.getState();
  const [density, setDensity] = useState<'float' | 'neutral' | 'heavy'>('float');
  const dens = density === 'float' ? 0.45 : density === 'neutral' ? 1 : 4;
  const spawnBody = (kind: 'ball' | 'cube') => {
    const id = useStore.getState().addBody(kind);
    if (id) useStore.setState({ bodies: useStore.getState().bodies.map((b) => (b.id === id ? { ...b, density: dens } : b)) });
  };
  const selObstacle = selection?.kind === 'obstacle' ? obstacles.find((o) => o.id === selection.id) : undefined;
  return (
    <>
      <Section title="Spawn">
        <div className="spawn-grid">
          <button className="spawn-btn" type="button" data-testid="spawn-ball" onClick={() => spawnBody('ball')}><CircleDot size={20} />Ball</button>
          <button className="spawn-btn" type="button" data-testid="spawn-cube" onClick={() => spawnBody('cube')}><Box size={20} />Cube</button>
          <button className="spawn-btn" type="button" data-testid="spawn-ramp" onClick={() => s.addObstacle('ramp')}><Triangle size={20} />Ramp</button>
          <button className="spawn-btn" type="button" data-testid="spawn-funnel" onClick={() => s.addObstacle('funnel')}><FunnelIcon />Funnel</button>
          <button className="spawn-btn" type="button" data-testid="spawn-container" onClick={() => s.addObstacle('container')}><Container size={20} />Container</button>
          <button className="spawn-btn" type="button" data-testid="spawn-block" onClick={() => s.addObstacle('block')}><Shapes size={20} />Block</button>
        </div>
        <div className="row">
          <span className="label">Ball / cube density</span>
          <Info text="Bodies are coupled two-way with the liquid: light ones float on dense liquids, heavy ones sink and splash." />
        </div>
        <Seg value={density} onChange={setDensity} options={[{ id: 'float', label: 'Floaty' }, { id: 'neutral', label: 'Water-like' }, { id: 'heavy', label: 'Heavy' }]} />
      </Section>
      {selObstacle && (
        <Section title="Selected obstacle">
          <Slider label="Scale" value={selObstacle.scale} min={0.5} max={2} onChange={(v) => s.updateObstacle(selObstacle.id, { scale: v })} format={(v) => `${v.toFixed(2)}×`} />
          <Slider label="Rotation Y" value={selObstacle.rotation[1]} min={-Math.PI} max={Math.PI} onChange={(v) => s.updateObstacle(selObstacle.id, { rotation: [selObstacle.rotation[0], v, selObstacle.rotation[2]] })} format={deg} />
          <Slider label="Tilt" value={selObstacle.rotation[2]} min={-Math.PI / 2} max={Math.PI / 2} onChange={(v) => s.updateObstacle(selObstacle.id, { rotation: [selObstacle.rotation[0], selObstacle.rotation[1], v] })} format={deg} />
        </Section>
      )}
      <Section title="In the scene" right={<span className="muted">{obstacles.length + bodies.length}</span>}>
        {obstacles.length + bodies.length === 0 && <p className="muted" style={{ margin: 0 }}>Nothing yet — spawn something above, then move it with the Select tool.</p>}
        <div className="list">
          {obstacles.map((o) => (
            <div key={o.id} className={`list-item ${selection?.id === o.id ? 'on' : ''}`} onClick={() => useStore.setState({ selection: { kind: 'obstacle', id: o.id }, tool: 'select' })}>
              <span className="dot" style={{ background: '#e9e4f6' }} />
              <span className="grow" style={{ textTransform: 'capitalize' }}>{o.kind}</span>
              <button className="icon-btn" style={{ width: 28, height: 28 }} type="button" aria-label="Remove" onClick={(ev) => { ev.stopPropagation(); s.removeObstacle(o.id); }}><Trash2 size={14} /></button>
            </div>
          ))}
          {bodies.map((b) => (
            <div key={b.id} className="list-item">
              <span className="dot" style={{ background: b.color }} />
              <span className="grow" style={{ textTransform: 'capitalize' }}>{b.kind} · {b.density < 0.9 ? 'floaty' : b.density > 2 ? 'heavy' : 'neutral'}</span>
              <button className="icon-btn" style={{ width: 28, height: 28 }} type="button" aria-label="Remove" onClick={() => s.removeBody(b.id)}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
        {(obstacles.length > 0 || bodies.length > 0) && (
          <button className="pill-btn small" type="button" onClick={() => useStore.setState({ obstacles: [], bodies: [], selection: null })}>Remove all</button>
        )}
      </Section>
    </>
  );
}

function FunnelIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4h18l-7 8v7l-4 2v-9z" /></svg>
  );
}

function LibraryTab() {
  const [list, setList] = useState<SavedExperiment[]>(() => listExperiments());
  const [name, setName] = useState('');
  const toast = useStore((s) => s.toast);
  return (
    <>
      <Section title="Save experiment">
        <div className="row">
          <input className="text-input" placeholder="Name your experiment" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} data-testid="exp-name" />
          <button className="pill-btn primary small" type="button" data-testid="exp-save" onClick={async () => {
            const thumb = await thumbnail();
            const exp = saveExperiment(name.trim() || `Experiment ${list.length + 1}`, thumb);
            if (exp) { setList(listExperiments()); setName(''); toast('Experiment saved', 'good'); } else toast('Could not save (storage unavailable)', 'warn');
          }}><Save size={14} />Save</button>
        </div>
        <div className="grid2">
          <button className="pill-btn small" type="button" data-testid="share-link" onClick={() => void copyShareLink()}><Copy size={14} />Copy share link</button>
          <button className="pill-btn small" type="button" onClick={() => {
            const blob = new Blob([JSON.stringify(captureConfig('Exported experiment'), null, 1)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'viscosity-experiment.json';
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          }}><Download size={14} />Export JSON</button>
        </div>
      </Section>
      <Section title="Random experiment">
        <p className="muted" style={{ margin: 0 }}>Generates a surprising combination of materials, streams, gravity, obstacles and backdrop.</p>
        <button className="pill-btn primary" type="button" data-testid="randomize" onClick={() => randomize()}><Dice5 size={16} />Generate experiment</button>
      </Section>
      <Section title={`Saved (${list.length})`}>
        {list.length === 0 && <p className="muted" style={{ margin: 0 }}>Saved experiments live in this browser.</p>}
        <div className="list">
          {list.map((x) => (
            <div key={x.id} className="exp-card">
              {x.thumb ? <img src={x.thumb} alt="" /> : <div className="ph" />}
              <div style={{ minWidth: 0 }}>
                <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.name}</b>
                <small>{new Date(x.date).toLocaleString()}</small>
              </div>
              <div className="row">
                <button className="pill-btn small" type="button" onClick={() => { if (applyConfig(x.config)) toast(`Loaded “${x.name}”`, 'good'); }}>Load</button>
                <button className="icon-btn" style={{ width: 30, height: 30 }} type="button" aria-label="Delete" onClick={() => { deleteExperiment(x.id); setList(listExperiments()); }}><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

function SettingsTab() {
  const quality = useStore((s) => s.quality);
  const tier = useStore((s) => s.activeTier);
  const sound = useStore((s) => s.sound);
  const volume = useStore((s) => s.volume);
  const tooltips = useStore((s) => s.tooltips);
  const showStats = useStore((s) => s.showStats);
  return (
    <>
      <Section title="Quality">
        <Seg<'auto' | QualityTier> value={quality} onChange={(q) => { useStore.setState({ quality: q }); getEngine()?.setQuality(q); }}
          options={[{ id: 'auto', label: 'Auto' }, { id: 'low', label: 'Low' }, { id: 'medium', label: 'Med' }, { id: 'high', label: 'High' }, { id: 'ultra', label: 'Ultra' }]} />
        <p className="muted" style={{ margin: 0 }}>Active: <b style={{ textTransform: 'capitalize' }}>{tier}</b>. Higher tiers use a finer simulation grid and more particles. Auto lowers quality if the frame rate drops and adapts render resolution continuously.</p>
      </Section>
      <Section title="Experience">
        <Toggle label="Sound effects" checked={sound} onChange={(v) => useStore.setState({ sound: v })} />
        {sound && <Slider label="Volume" value={volume} min={0} max={1} onChange={(v) => useStore.setState({ volume: v })} format={pct} />}
        <Toggle label="Educational tooltips" checked={tooltips} onChange={(v) => useStore.setState({ tooltips: v })} />
        <Toggle label="Physics statistics" checked={showStats} onChange={(v) => useStore.setState({ showStats: v })} />
      </Section>
      <Section title="Shortcuts" defaultOpen={false}>
        <div className="muted" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px' }}>
          <b>Space</b><span>Pause / hold to pour (games)</span>
          <b>1–9, 0</b><span>Tools</span>
          <b>Right-drag</b><span>Orbit camera · wheel zoom</span>
          <b>C</b><span>Clear liquid</span>
          <b>X</b><span>Random experiment</span>
          <b>F</b><span>Cinematic fullscreen</span>
          <b>H</b><span>Hide interface</span>
          <b>P</b><span>Screenshot</span>
          <b>R</b><span>Move / rotate gizmo</span>
          <b>[ ]</b><span>Brush size</span>
          <b>Del</b><span>Remove selected</span>
        </div>
      </Section>
      <Section title="About the physics" defaultOpen={false}>
        <p className="muted" style={{ margin: 0 }}>
          The liquid is a real-time <b>MLS-MPM</b> (Moving Least Squares Material Point Method) simulation running entirely on the GPU through WebGL 2: particles scatter momentum to a 3D grid, the grid resolves forces and collisions, and particles gather velocities back. Pressure uses a weakly-compressible Tait equation; viscosity damps strain rate exactly and, for very thick liquids, an upper-convected Maxwell element keeps the solver stable while ropes coil and stack. Surface tension, adhesion, heat and pigment mixing are simplified models and are labelled “approx”.
        </p>
      </Section>
    </>
  );
}

export function ControlPanel() {
  const [tab, setTab] = useState<Tab>('liquid');
  const open = useStore((s) => s.panelOpen);
  const setOpen = (v: boolean) => useStore.setState({ panelOpen: v });
  useEffect(() => {
    const h = () => useStore.setState({ panelOpen: !useStore.getState().panelOpen });
    window.addEventListener('vp:toggle-panel', h);
    return () => window.removeEventListener('vp:toggle-panel', h);
  }, []);
  useEffect(() => {
    const h = (e: Event) => {
      setTab((e as CustomEvent<Tab>).detail);
      useStore.setState({ panelOpen: true });
    };
    window.addEventListener('vp:open-tab', h);
    return () => window.removeEventListener('vp:open-tab', h);
  }, []);
  return (
    <aside className={`panel glass ${open ? '' : 'collapsed'}`} aria-label="Controls" data-testid="panel">
      <div className="panel-head">
        <h3>Laboratory</h3>
        <div className="row panel-quick">
          <QuickButtons withPanelToggle={false} />
          <button className="icon-btn" type="button" aria-label="Close panel" data-testid="panel-close" onClick={() => setOpen(false)}><X size={18} /></button>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => {
          const I = t.icon;
          return (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} data-testid={`tab-${t.id}`} className={`tab ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
              <I size={14} />
              {t.label}
            </button>
          );
        })}
      </div>
      <div className="panel-body">
        {tab === 'liquid' && <LiquidTab />}
        {tab === 'physics' && <PhysicsTab />}
        {tab === 'flow' && <FlowTab />}
        {tab === 'world' && <WorldTab />}
        {tab === 'objects' && <ObjectsTab />}
        {tab === 'library' && <LibraryTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </aside>
  );
}
