import { Activity, Blocks, ChevronDown, Flame, Info as InfoIcon, Maximize2, Orbit, Palette, Rocket, SlidersHorizontal, Sparkles, Trophy, Volume2, VolumeX, Waves } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { GameMode } from '../engine/types';
import { useStore } from '../state/store';
import { setMode, toggleCinematic } from './actions';

export const MODES: { id: GameMode; name: string; desc: string; icon: typeof Waves }[] = [
  { id: 'sandbox', name: 'Free Sandbox', desc: 'Unlimited experimentation', icon: Blocks },
  { id: 'tower', name: 'Tower Challenge', desc: 'Build the tallest liquid tower', icon: Trophy },
  { id: 'colormix', name: 'Color Mixing', desc: 'Reproduce a target colour', icon: Palette },
  { id: 'fill', name: 'Fill the Container', desc: 'Fill cups without overflowing', icon: Waves },
  { id: 'chaos', name: 'Chaos Mode', desc: 'Physics mutates every few seconds', icon: Flame },
  { id: 'relax', name: 'Relaxation', desc: 'Endless pours, no distractions', icon: Sparkles },
  { id: 'zerog', name: 'Zero Gravity', desc: 'Floating liquids in space', icon: Rocket },
];

export function Brand() {
  return (
    <div className="brand">
      <svg className="brand-mark" viewBox="0 0 64 64" aria-hidden>
        <defs>
          <linearGradient id="bm" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ff4d6d" />
            <stop offset=".5" stopColor="#7cf27c" />
            <stop offset="1" stopColor="#4da3ff" />
          </linearGradient>
        </defs>
        <path d="M32 4c9 13 19 24 19 36a19 19 0 0 1-38 0C13 28 23 17 32 4z" fill="url(#bm)" />
        <ellipse cx="25" cy="39" rx="5" ry="8" fill="#fff" opacity=".45" />
      </svg>
      <div className="brand-name">
        Viscosity Playground
        <small>GPU liquid sandbox</small>
      </div>
    </div>
  );
}

export function ModeSelect() {
  const mode = useStore((s) => s.mode);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, []);
  const cur = MODES.find((m) => m.id === mode)!;
  const Icon = cur.icon;
  return (
    <div className="mode-select" ref={ref}>
      <button className="pill-btn mode-trigger" type="button" data-testid="mode-trigger" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <Icon size={15} />
        {cur.name}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="mode-menu glass" role="menu">
          {MODES.map((m) => {
            const I = m.icon;
            return (
              <button
                key={m.id}
                type="button"
                role="menuitem"
                data-testid={`mode-${m.id}`}
                className={`mode-item ${m.id === mode ? 'on' : ''}`}
                onClick={() => {
                  setMode(m.id);
                  setOpen(false);
                }}
              >
                <span className="mi-icon">
                  <I size={17} />
                </span>
                <span>
                  <b>{m.name}</b>
                  <span>{m.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const sound = useStore((s) => s.sound);
  const showStats = useStore((s) => s.showStats);
  const tooltips = useStore((s) => s.tooltips);
  const panelHidden = useStore((s) => s.uiHidden);
  void panelHidden;
  return (
    <>
      <div className="topbar glass">
        <Brand />
        <ModeSelect />
        <button
          className="icon-btn sheet-btn"
          type="button"
          aria-label="Open controls"
          onClick={() => window.dispatchEvent(new CustomEvent('vp:toggle-panel'))}
        >
          <SlidersHorizontal size={18} />
        </button>
      </div>
      <div className="top-right glass">
        <button className={`icon-btn ${sound ? 'active' : ''}`} type="button" aria-label="Sound" data-testid="sound-toggle" onClick={() => useStore.setState({ sound: !sound })} title="Sound (M)">
          {sound ? <Volume2 size={18} /> : <VolumeX size={18} />}
        </button>
        <button className={`icon-btn ${showStats ? 'active' : ''}`} type="button" aria-label="Physics stats" data-testid="stats-toggle" onClick={() => useStore.setState({ showStats: !showStats })} title="Physics statistics">
          <Activity size={18} />
        </button>
        <button className={`icon-btn ${tooltips ? 'active' : ''}`} type="button" aria-label="Educational tooltips" onClick={() => useStore.setState({ tooltips: !tooltips })} title="Educational tooltips">
          <InfoIcon size={18} />
        </button>
        <button className="icon-btn" type="button" aria-label="Cinematic fullscreen" onClick={() => void toggleCinematic()} title="Cinematic fullscreen (F)">
          <Maximize2 size={18} />
        </button>
        <button className="icon-btn" type="button" aria-label="Toggle control panel" data-testid="panel-toggle" onClick={() => window.dispatchEvent(new CustomEvent('vp:toggle-panel'))} title="Controls">
          <Orbit size={18} />
        </button>
      </div>
    </>
  );
}
