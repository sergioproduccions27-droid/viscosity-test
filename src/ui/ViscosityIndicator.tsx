import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';

/** The reference video's viscosity sequence — click the indicator to step through it. */
const SEQUENCE = [0, 0.01, 0.2, 0.4, 0.8, 0.99];

export function ViscosityIndicator() {
  const emitter = useStore((s) => s.emitters.find((e) => e.id === s.selectedEmitterId) ?? s.emitters[0]);
  const updatePhysics = useStore((s) => s.updatePhysics);
  const target = emitter?.material.physics.viscosity ?? 0;
  const [shown, setShown] = useState(target);
  const [bump, setBump] = useState(false);
  const raf = useRef(0);
  const shownRef = useRef(shown);

  // smooth odometer-style count toward the live value
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    const step = () => {
      const cur = shownRef.current;
      const next = cur + (target - cur) * 0.22;
      const done = Math.abs(next - target) < 0.002;
      shownRef.current = done ? target : next;
      setShown(shownRef.current);
      if (!done) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target]);

  if (!emitter) return null;
  const cycle = () => {
    const i = SEQUENCE.findIndex((v) => v > target + 0.001);
    const next = i < 0 ? SEQUENCE[0] : SEQUENCE[i];
    updatePhysics({ viscosity: next });
    setBump(true);
    setTimeout(() => setBump(false), 450);
  };
  return (
    <div className={`visc ${bump ? 'bump' : ''}`} onClick={cycle} role="button" tabIndex={0} data-testid="visc-indicator" aria-label={`Viscosity ${Math.round(target * 100)} percent. Click to step through the reference sequence.`}
      onKeyDown={(e) => (e.key === 'Enter' ? cycle() : undefined)}>
      <span className="num">{Math.round(shown * 100)}%</span>
      <span className="lbl">VISCOSITY</span>
      <span className="mat">{emitter.material.name}</span>
      <span className="hint">click · 0 → 1 → 20 → 40 → 80 → 99%</span>
    </div>
  );
}
