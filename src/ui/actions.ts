import type { Engine } from '../engine/Engine';
import { applyConfig, randomExperiment, shareUrl } from '../state/config';
import { useStore } from '../state/store';

let engine: Engine | null = null;
export const setEngine = (e: Engine | null) => {
  engine = e;
  // handles for automated testing / console tinkering
  (window as unknown as Record<string, unknown>).__vpEngine = e;
  (window as unknown as Record<string, unknown>).__vpStore = useStore;
};
export const getEngine = () => engine;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function takeScreenshot() {
  if (!engine) return;
  const blob = await engine.screenshot();
  if (!blob) {
    useStore.getState().toast('Screenshot failed', 'warn');
    return;
  }
  download(blob, `viscosity-playground-${stamp()}.png`);
  engine.sound.click(1.5);
  useStore.getState().toast('Screenshot saved', 'good');
}

/** Small JPEG thumbnail of the current frame (for saved experiments). */
export async function thumbnail(): Promise<string | undefined> {
  if (!engine) return undefined;
  return engine.thumbnail(160);
}

export async function toggleRecording() {
  if (!engine) return;
  const s = useStore.getState();
  if (engine.recording) {
    const blob = await engine.stopRecording();
    useStore.setState({ recording: false, recordSeconds: 0 });
    if (blob && blob.size > 0) {
      const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
      download(blob, `viscosity-playground-${stamp()}.${ext}`);
      s.toast('Recording saved', 'good');
    }
    return;
  }
  if (engine.startRecording()) {
    useStore.setState({ recording: true, recordSeconds: 0 });
    s.toast('Recording… press again to stop', 'info');
  } else s.toast('Video recording is not supported in this browser', 'warn');
}

export async function copyShareLink() {
  const s = useStore.getState();
  try {
    const url = await shareUrl();
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      s.toast('Share link copied to clipboard', 'good');
    } catch {
      s.toast('Share link is in the address bar', 'info');
    }
  } catch {
    s.toast('Could not create a share link', 'warn');
  }
}

export function randomize() {
  const cfg = randomExperiment();
  applyConfig(cfg);
  useStore.getState().toast(`🎲 ${cfg.name}`, 'info');
  engine?.sound.whoosh();
}

export function setMode(mode: ReturnType<typeof useStore.getState>['mode']) {
  useStore.setState({ mode, hud: null });
  engine?.sound.click(0.8);
}

export async function toggleCinematic() {
  const s = useStore.getState();
  const on = !s.cinematic;
  useStore.setState({ cinematic: on, uiHidden: on });
  try {
    if (on && !document.fullscreenElement && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch {
    /* fullscreen not permitted (e.g. iOS) — UI-hiding still applies */
  }
}

export function togglePause() {
  const s = useStore.getState();
  useStore.setState({ paused: !s.paused });
}

export function resetScene() {
  const s = useStore.getState();
  engine?.clearLiquid();
  useStore.setState({ revision: s.revision + 1 });
}

export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const s = useStore.getState();
    const k = e.key.toLowerCase();
    if (k === ' ') {
      e.preventDefault();
      if (s.hud?.holdToPour) {
        if (!e.repeat) useStore.setState({ pouring: true });
      } else if (!e.repeat) togglePause();
      return;
    }
    if (e.repeat) return;
    if (k === 'escape') {
      if (s.cinematic) void toggleCinematic();
      else if (s.mode === 'relax') setMode('sandbox');
      else if (s.selection) useStore.setState({ selection: null });
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tools: Record<string, typeof s.tool> = { '1': 'stir', '2': 'whirlpool', '3': 'attract', '4': 'repel', '5': 'pour', '6': 'freeze', '7': 'heat', '8': 'dye', '9': 'erase', '0': 'select', o: 'orbit', v: 'select' };
    if (tools[k]) useStore.setState({ tool: tools[k] });
    else if (k === 'c') engine?.clearLiquid();
    else if (k === 'h') useStore.setState({ uiHidden: !s.uiHidden });
    else if (k === 'f') void toggleCinematic();
    else if (k === 'p') void takeScreenshot();
    else if (k === 'x') randomize();
    else if (k === 'm') useStore.setState({ sound: !s.sound });
    else if (k === 'r') useStore.setState({ transformMode: s.transformMode === 'rotate' ? 'translate' : 'rotate' });
    else if (k === 'delete' || k === 'backspace') s.removeSelection();
    else if (k === '[') useStore.setState({ toolSize: Math.max(0.03, s.toolSize * 0.85) });
    else if (k === ']') useStore.setState({ toolSize: Math.min(0.2, s.toolSize * 1.18) });
  };
  const onUp = (e: KeyboardEvent) => {
    if (e.key === ' ') useStore.setState({ pouring: false });
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onUp);
  const onFs = () => {
    if (!document.fullscreenElement && useStore.getState().cinematic) useStore.setState({ cinematic: false, uiHidden: false });
  };
  document.addEventListener('fullscreenchange', onFs);
  return () => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onUp);
    document.removeEventListener('fullscreenchange', onFs);
  };
}
