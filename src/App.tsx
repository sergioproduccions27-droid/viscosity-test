import { useEffect, useRef, useState } from 'react';
import { Engine } from './engine/Engine';
import { applyConfig, decodeShare } from './state/config';
import { useStore } from './state/store';
import { installShortcuts, setEngine } from './ui/actions';
import { ControlPanel } from './ui/ControlPanel';
import { HiddenUiControls, Hints, ModeHud, RecordingPill, StatsPanel, Toasts } from './ui/Hud';
import { BrushSettings, ToolDock } from './ui/ToolDock';
import { TopBar } from './ui/TopBar';
import { Transport } from './ui/Transport';
import { ViscosityIndicator } from './ui/ViscosityIndicator';

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="error-screen">
      <div className="error-card glass">
        <h2>The liquid lab can't start here</h2>
        <p className="muted">{message}</p>
        <p className="muted">
          Viscosity Playground runs a GPU fluid simulation with WebGL 2 and floating-point render targets. Try an up-to-date Chrome, Edge, Firefox or Safari with hardware acceleration enabled.
        </p>
        <button className="pill-btn primary" type="button" onClick={() => location.reload()}>Reload</button>
      </div>
    </div>
  );
}

export default function App() {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const engineError = useStore((s) => s.engineError);
  const uiHidden = useStore((s) => s.uiHidden);
  const ready = useStore((s) => s.engineReady);
  const panelOpen = useStore((s) => s.panelOpen);
  const hasHud = useStore((s) => !!s.hud && s.mode !== 'sandbox' && s.mode !== 'relax');

  useEffect(() => {
    if (!host.current) return;
    let engine: Engine | null = null;
    try {
      engine = new Engine(host.current);
      setEngine(engine);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    const m = location.hash.match(/x=([A-Za-z0-9_-]+)/);
    if (m) {
      void decodeShare(m[1]).then((cfg) => {
        if (cfg && applyConfig(cfg)) useStore.getState().toast('Shared experiment loaded', 'good');
        else useStore.getState().toast('That share link could not be read', 'warn');
      });
    }
    const off = installShortcuts();
    return () => {
      off();
      setEngine(null);
      engine?.dispose();
    };
  }, []);

  if (error || engineError) return <ErrorScreen message={error ?? engineError ?? ''} />;

  return (
    <div className="app">
      <div className="viewport" ref={host} />
      {!ready && <div className="loading">LOADING LIQUIDS…</div>}
      <div className={`ui ${uiHidden ? 'hidden' : ''} ${panelOpen && !uiHidden ? 'panel-open' : ''} ${hasHud ? 'has-hud' : ''}`}>
        <TopBar />
        <ViscosityIndicator />
        <ToolDock />
        <BrushSettings />
        <ModeHud />
        <StatsPanel />
        <ControlPanel />
        <Transport />
        <Hints />
        <RecordingPill />
      </div>
      <Toasts />
      <HiddenUiControls />
    </div>
  );
}
