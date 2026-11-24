import { Droplets, Eraser, Flame, Hand, Magnet, MousePointer2, Paintbrush, Rotate3d, Snowflake, Tornado, Wind, Zap } from 'lucide-react';
import type { ToolId } from '../engine/types';
import { useStore } from '../state/store';
import { Slider, pct } from './controls';

export const TOOLS: { id: ToolId; label: string; key: string; icon: typeof Hand; desc: string }[] = [
  { id: 'stir', label: 'Stir & push', key: '1', icon: Wind, desc: 'Drag through the liquid to push and stir it' },
  { id: 'whirlpool', label: 'Whirlpool', key: '2', icon: Tornado, desc: 'Hold to spin a vortex around a vertical axis' },
  { id: 'attract', label: 'Attract', key: '3', icon: Magnet, desc: 'Gravity well that pulls liquid and objects in' },
  { id: 'repel', label: 'Repel', key: '4', icon: Zap, desc: 'Blast liquid and objects away' },
  { id: 'pour', label: 'Pour here', key: '5', icon: Droplets, desc: 'Pour the selected liquid wherever you press' },
  { id: 'freeze', label: 'Freeze', key: '6', icon: Snowflake, desc: 'Cool liquid until it solidifies' },
  { id: 'heat', label: 'Melt / heat', key: '7', icon: Flame, desc: 'Heat liquid: thins it, melts frozen material, boils water' },
  { id: 'dye', label: 'Dye', key: '8', icon: Paintbrush, desc: 'Paint colour into the liquid — it mixes like pigment' },
  { id: 'erase', label: 'Erase', key: '9', icon: Eraser, desc: 'Remove liquid under the brush' },
  { id: 'select', label: 'Select & move', key: '0', icon: MousePointer2, desc: 'Move/rotate emitters and obstacles, drag balls' },
  { id: 'orbit', label: 'Camera', key: 'O', icon: Rotate3d, desc: 'Orbit the camera with one finger / left mouse' },
];

const DYES = ['#ff3df2', '#ff2b4f', '#ffb21f', '#ffe81f', '#3dff7a', '#1fd2ff', '#2f5bff', '#9b3dff', '#ffffff', '#111111'];

export function ToolDock() {
  const tool = useStore((s) => s.tool);
  return (
    <div className="dock glass" role="toolbar" aria-label="Tools">
      {TOOLS.map((t, i) => {
        const I = t.icon;
        return (
          <span key={t.id} style={{ display: 'contents' }}>
            {(i === 4 || i === 9) && <div className="sep" />}
            <button
              type="button"
              data-testid={`tool-${t.id}`}
              className={`icon-btn ${tool === t.id ? 'active' : ''} ${t.id === 'erase' ? 'danger' : ''}`}
              aria-label={t.label}
              aria-pressed={tool === t.id}
              onClick={() => useStore.setState({ tool: t.id })}
            >
              <I size={19} />
              <span className="tip">
                {t.label}
                <kbd>{t.key}</kbd>
              </span>
            </button>
          </span>
        );
      })}
    </div>
  );
}

export function BrushSettings() {
  const tool = useStore((s) => s.tool);
  const size = useStore((s) => s.toolSize);
  const strength = useStore((s) => s.toolStrength);
  const dye = useStore((s) => s.dyeColor);
  const transformMode = useStore((s) => s.transformMode);
  const selection = useStore((s) => s.selection);
  const t = TOOLS.find((x) => x.id === tool)!;
  if (tool === 'orbit') return null;
  if (tool === 'select') {
    return (
      <div className="brush glass">
        <h4>Select & move</h4>
        <div className="seg">
          <button type="button" className={transformMode === 'translate' ? 'on' : ''} onClick={() => useStore.setState({ transformMode: 'translate' })}>Move</button>
          <button type="button" className={transformMode === 'rotate' ? 'on' : ''} onClick={() => useStore.setState({ transformMode: 'rotate' })}>Rotate</button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          {selection ? 'Drag the gizmo handles. Delete key removes the object.' : 'Tap an emitter, obstacle or ball. Balls can be dragged and thrown.'}
        </p>
        {selection && (
          <button className="pill-btn small" type="button" onClick={() => useStore.getState().removeSelection()}>Remove selected</button>
        )}
      </div>
    );
  }
  return (
    <div className="brush glass">
      <h4>{t.label}</h4>
      <Slider label="Size" value={size} min={0.03} max={0.2} onChange={(v) => useStore.setState({ toolSize: v })} format={(v) => `${Math.round(v * 100)} cm`} testId="brush-size" />
      {tool !== 'erase' && (
        <Slider label="Strength" value={strength} min={0} max={1} onChange={(v) => useStore.setState({ toolStrength: v })} format={pct} />
      )}
      {tool === 'dye' && (
        <div className="swatches">
          {DYES.map((c) => (
            <button key={c} type="button" className={`swatch ${dye === c ? 'on' : ''}`} style={{ background: c }} aria-label={`Dye ${c}`} onClick={() => useStore.setState({ dyeColor: c })} />
          ))}
          <input className="color-input" type="color" value={dye} onChange={(e) => useStore.setState({ dyeColor: e.target.value })} aria-label="Custom dye colour" />
        </div>
      )}
    </div>
  );
}
