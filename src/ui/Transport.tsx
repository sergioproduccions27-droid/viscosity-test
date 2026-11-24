import { Camera, Circle, Dice5, Eraser, Maximize2, Pause, Play, RotateCcw, Share2, Square, Volume2, VolumeX } from 'lucide-react';
import { useStore } from '../state/store';
import { copyShareLink, getEngine, randomize, resetScene, takeScreenshot, toggleCinematic, togglePause, toggleRecording } from './actions';

const SPEEDS = [0.25, 0.5, 1, 2];

export function Transport() {
  const paused = useStore((s) => s.paused);
  const speed = useStore((s) => s.world.simSpeed);
  const recording = useStore((s) => s.recording);
  const sound = useStore((s) => s.sound);
  const cycleSpeed = () => {
    const i = SPEEDS.findIndex((v) => v > speed + 0.01);
    useStore.getState().updateWorld({ simSpeed: i < 0 ? SPEEDS[0] : SPEEDS[i] });
  };
  return (
    <div className="transport glass" role="toolbar" aria-label="Simulation controls">
      <button className={`icon-btn ${paused ? 'active' : ''}`} type="button" data-testid="pause" aria-label={paused ? 'Resume' : 'Pause'} onClick={togglePause} title="Pause / resume (Space)">
        {paused ? <Play size={19} /> : <Pause size={19} />}
      </button>
      <button className="speed-chip" type="button" data-testid="speed" onClick={cycleSpeed} title="Simulation speed" aria-label={`Simulation speed ${speed.toFixed(2)}x`}>
        {speed < 1 ? `${speed.toFixed(2).replace(/0$/, '')}×` : `${speed.toFixed(speed % 1 ? 1 : 0)}×`}
      </button>
      <button className="icon-btn" type="button" data-testid="clear" aria-label="Clear liquid" onClick={() => getEngine()?.clearLiquid()} title="Clear liquid (C)">
        <Eraser size={19} />
      </button>
      <button className="icon-btn" type="button" data-testid="reset" aria-label="Reset scene" onClick={resetScene} title="Reset (clear & restart pour)">
        <RotateCcw size={19} />
      </button>
      <button className="icon-btn" type="button" data-testid="random" aria-label="Random experiment" onClick={randomize} title="Random experiment (X)">
        <Dice5 size={19} />
      </button>
      <div className="sep" />
      <button className="icon-btn" type="button" data-testid="screenshot" aria-label="Screenshot" onClick={() => void takeScreenshot()} title="Screenshot (P)">
        <Camera size={19} />
      </button>
      <button className={`icon-btn ${recording ? 'active danger' : ''}`} type="button" data-testid="record" aria-label={recording ? 'Stop recording' : 'Record video'} onClick={() => void toggleRecording()} title="Record video">
        {recording ? <Square size={17} /> : <Circle size={19} />}
      </button>
      <button className="icon-btn" type="button" aria-label="Copy share link" onClick={() => void copyShareLink()} title="Copy share link">
        <Share2 size={19} />
      </button>
      <button className={`icon-btn sheet-btn ${sound ? 'active' : ''}`} type="button" aria-label="Sound" onClick={() => useStore.setState({ sound: !sound })}>
        {sound ? <Volume2 size={19} /> : <VolumeX size={19} />}
      </button>
      <button className="icon-btn" type="button" aria-label="Cinematic fullscreen" onClick={() => void toggleCinematic()} title="Cinematic fullscreen (F)">
        <Maximize2 size={19} />
      </button>
    </div>
  );
}
