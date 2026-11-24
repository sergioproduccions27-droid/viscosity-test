import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { getEngine, setMode, toggleCinematic } from './actions';

export function StatsPanel() {
  const show = useStore((s) => s.showStats);
  const perf = useStore((s) => s.perf);
  const st = useStore((s) => s.stats);
  const ambient = useStore((s) => s.world.ambientTemp);
  const panelOpen = useStore((s) => s.panelOpen);
  const [hist, setHist] = useState<number[]>([]);
  useEffect(() => {
    if (show) setHist((h) => [...h.slice(-39), perf.fps]);
  }, [perf, show]);
  if (!show) return null;
  const max = Math.max(70, ...hist);
  const pts = hist.map((v, i) => `${(i / 39) * 100},${26 - (v / max) * 24}`).join(' ');
  const fpsColor = perf.fps >= 50 ? 'var(--good)' : perf.fps >= 30 ? 'var(--warn)' : '#ff6b8b';
  return (
    <div className={`stats glass ${panelOpen ? '' : 'wide'}`} data-testid="stats">
      <div className="fps" style={{ color: fpsColor }}>
        {perf.fps.toFixed(0)}
        <small>FPS · {perf.frameMs.toFixed(1)} ms</small>
      </div>
      <svg className="spark" viewBox="0 0 100 26" preserveAspectRatio="none">
        <polyline points={pts} fill="none" stroke={fpsColor} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="r"><span>Particles</span><span>{st.alive.toLocaleString()} / {st.capacity.toLocaleString()}</span></div>
      <div className="r"><span>Grid · quality</span><span>{perf.grid} · {perf.tier}</span></div>
      <div className="r"><span>Sub-steps / frame</span><span>{perf.substeps}</span></div>
      <div className="r"><span>Render scale</span><span>{perf.renderScale.toFixed(2)}×</span></div>
      <div className="r"><span>On platform</span><span>{st.onPlatform.toLocaleString()}</span></div>
      <div className="r"><span>Pile height</span><span>{(st.maxHeight * 100).toFixed(1)} cm</span></div>
      <div className="r"><span>Mean speed</span><span>{(st.avgSpeed * 100).toFixed(1)} cm/s</span></div>
      <div className="r"><span>Kinetic energy</span><span>{(st.kinetic * 1e3).toFixed(2)} mJ</span></div>
      <div className="r"><span>Mean temperature</span><span>{st.alive ? st.avgTemp.toFixed(0) : ambient} °C</span></div>
      <div className="r"><span>Frozen particles</span><span>{st.frozen.toLocaleString()}</span></div>
    </div>
  );
}

export function ModeHud() {
  const hud = useStore((s) => s.hud);
  const mode = useStore((s) => s.mode);
  const pouring = useStore((s) => s.pouring);
  const valves = useStore((s) => s.valves);
  const tool = useStore((s) => s.tool);
  if (!hud || mode === 'sandbox' || mode === 'relax') return null;
  const setValve = (id: string, v: number) => useStore.setState({ valves: { ...useStore.getState().valves, [id]: v } });
  const hasBrush = tool !== 'orbit';
  return (
    <>
      {mode === 'chaos' && hud.banner && <div key={hud.banner} className="chaos-banner">{hud.banner}</div>}
      <div className={`hud glass ${hasBrush ? 'has-brush' : ''}`} data-testid="hud">
        <div>
          <h2>{hud.title}</h2>
          {hud.subtitle && <div className="sub">{hud.subtitle}</div>}
        </div>
        {hud.target && (
          <div className="color-target">
            <div style={{ background: hud.target }}>Target</div>
            <div style={{ background: hud.current ?? 'repeating-linear-gradient(45deg, rgba(255,255,255,.06) 0 8px, rgba(255,255,255,.12) 8px 16px)' }}>{hud.current ? 'Your mix' : 'Pour…'}</div>
          </div>
        )}
        {hud.lines && (
          <div className="hud-lines">
            {hud.lines.map((l) => (
              <div key={l.label} className={`hud-stat ${l.accent ? 'accent' : ''}`}>
                <span>{l.label}</span>
                <b>{l.value}</b>
              </div>
            ))}
          </div>
        )}
        {hud.progress !== undefined && (
          <div>
            <div className="bar-label"><span>{hud.progressLabel}</span><span>{Math.round(hud.progress * 100)}%</span></div>
            <div className="bar"><i style={{ width: `${hud.progress * 100}%` }} /></div>
          </div>
        )}
        {hud.valves && (
          <div className="valves">
            {hud.valves.map((v) => (
              <button
                key={v.id}
                type="button"
                className={`valve ${valves[v.id] ? 'on' : ''}`}
                style={{ background: v.color, color: v.color }}
                data-testid={`valve-${v.id}`}
                onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); setValve(v.id, 1); }}
                onPointerUp={() => setValve(v.id, 0)}
                onPointerCancel={() => setValve(v.id, 0)}
                onContextMenu={(e) => e.preventDefault()}
              >
                <span style={{ color: v.id === 'blue' || v.id === 'red' ? '#fff' : '#222' }}>{v.label}</span>
              </button>
            ))}
          </div>
        )}
        {hud.banner && mode !== 'chaos' && <div className="banner">{hud.banner}</div>}
        {hud.actions && (
          <div className="row wrap">
            {hud.actions.map((a) => (
              <button key={a.id} type="button" className={`pill-btn small ${a.primary ? 'primary' : ''}`} data-testid={`hud-${a.id}`} onClick={() => getEngine()?.mode?.action?.(a.id)}>
                {a.label}
              </button>
            ))}
            <button type="button" className="pill-btn small" onClick={() => setMode('sandbox')}>Exit</button>
          </div>
        )}
      </div>
      {hud.holdToPour && (
        <button
          type="button"
          className={`pour-btn ${pouring ? 'on' : ''}`}
          data-testid="hold-pour"
          onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); useStore.setState({ pouring: true }); }}
          onPointerUp={() => useStore.setState({ pouring: false })}
          onPointerCancel={() => useStore.setState({ pouring: false })}
          onContextMenu={(e) => e.preventDefault()}
        >
          POUR
          <small>HOLD · SPACE</small>
        </button>
      )}
    </>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast glass ${t.tone ?? ''}`}>{t.text}</div>
      ))}
    </div>
  );
}

export function Hints() {
  const [show, setShow] = useState(() => {
    try {
      return !localStorage.getItem('vp.hints.seen');
    } catch {
      return true;
    }
  });
  const mode = useStore((s) => s.mode);
  useEffect(() => {
    if (!show) return;
    const t = setTimeout(() => dismiss(), 14000);
    return () => clearTimeout(t);
  }, [show]);
  const dismiss = () => {
    setShow(false);
    try {
      localStorage.setItem('vp.hints.seen', '1');
    } catch {
      /* ignore */
    }
  };
  if (!show || mode !== 'sandbox') return null;
  return (
    <div className="hints glass">
      <span><b>Drag</b> to stir</span>
      <span><b>Right-drag</b> to orbit</span>
      <span><b>Scroll</b> to zoom</span>
      <span><b>Click 40%</b> to change viscosity</span>
      <button type="button" aria-label="Dismiss hints" onClick={dismiss}><X size={14} /></button>
    </div>
  );
}

export function RecordingPill() {
  const rec = useStore((s) => s.recording);
  const secs = useStore((s) => s.recordSeconds);
  if (!rec) return null;
  return (
    <div className="rec-pill glass">
      <span className="rec-dot" />
      REC {String(Math.floor(secs / 60)).padStart(2, '0')}:{String(secs % 60).padStart(2, '0')}
    </div>
  );
}

/** Minimal controls while the interface is hidden (cinematic / relax / H key). */
export function HiddenUiControls() {
  const hidden = useStore((s) => s.uiHidden);
  const mode = useStore((s) => s.mode);
  const cinematic = useStore((s) => s.cinematic);
  const visc = useStore((s) => (s.emitters[0]?.material.physics.viscosity ?? 0));
  const [labelOn, setLabelOn] = useState(true);
  const last = useRef(visc);
  useEffect(() => {
    if (last.current !== visc) {
      last.current = visc;
      setLabelOn(true);
    }
    const t = setTimeout(() => setLabelOn(false), 5000);
    return () => clearTimeout(t);
  }, [visc]);
  if (!hidden) return null;
  return (
    <>
      {mode === 'relax' && (
        <div className="relax-label" style={{ opacity: labelOn ? 1 : 0 }}>{Math.round(visc * 100)}% VISCOSITY</div>
      )}
      <button
        className="pill-btn exit-cine glass"
        type="button"
        data-testid="exit-hidden"
        onClick={() => {
          if (cinematic) void toggleCinematic();
          else if (mode === 'relax') setMode('sandbox');
          else useStore.setState({ uiHidden: false });
        }}
      >
        <X size={15} /> {mode === 'relax' ? 'Exit relax' : 'Show interface'}
      </button>
    </>
  );
}
