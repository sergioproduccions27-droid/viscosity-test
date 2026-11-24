import { ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useStore } from '../state/store';

export function Info({ text, approx }: { text: string; approx?: string }) {
  const tooltips = useStore((s) => s.tooltips);
  if (!tooltips) return null;
  return (
    <button className="info" type="button" aria-label="More info" tabIndex={0}>
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round">
        <path d="M12 11v7M12 6.5v.5" />
      </svg>
      <span className="pop" role="tooltip">
        {text}
        {approx && <em>≈ {approx}</em>}
      </span>
    </button>
  );
}

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  info?: string;
  approx?: string;
  /** Non-linear mapping: 'log' for exponential ranges */
  scale?: 'linear' | 'log';
  colors?: [string, string];
  testId?: string;
}

export function Slider({ label, value, min, max, step, onChange, format, info, approx, scale = 'linear', colors, testId }: SliderProps) {
  const toPos = (v: number) => (scale === 'log' ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
  const fromPos = (p: number) => (scale === 'log' ? min * Math.pow(max / min, p) : min + p * (max - min));
  const pos = Math.min(1, Math.max(0, toPos(value)));
  const style = { '--p': `${pos * 100}%`, ...(colors ? { '--c1': colors[0], '--c2': colors[1] } : {}) } as React.CSSProperties;
  return (
    <label className="slider">
      <div className="slider-top">
        <span>{label}</span>
        {approx && <span className="badge" title={`Simplified model: ${approx}`}>approx</span>}
        {info && <Info text={info} approx={approx} />}
        <span className="val">{format ? format(value) : value.toFixed(2)}</span>
      </div>
      <input
        className="range"
        type="range"
        data-testid={testId}
        aria-label={label}
        min={0}
        max={1000}
        step={step ? Math.max(1, Math.round((step / (max - min)) * 1000)) : 1}
        value={Math.round(pos * 1000)}
        style={style}
        onChange={(e) => {
          let v = fromPos(Number(e.target.value) / 1000);
          if (step) v = Math.round(v / step) * step;
          onChange(Math.min(max, Math.max(min, v)));
        }}
      />
    </label>
  );
}

export function Section({ title, children, defaultOpen = true, right }: { title: string; children: ReactNode; defaultOpen?: boolean; right?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`section ${open ? 'open' : ''}`}>
      <button className="section-head" type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>{title}</span>
        <span className="row">
          {right}
          <ChevronDown size={16} />
        </span>
      </button>
      <div className="section-body">
        <div className="section-inner">{children}</div>
      </div>
    </div>
  );
}

export function Toggle({ label, checked, onChange, info }: { label: string; checked: boolean; onChange: (v: boolean) => void; info?: string }) {
  return (
    <label className="toggle">
      <span className="row">
        {label}
        {info && <Info text={info} />}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="sw" />
    </label>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const pct = (v: number) => `${Math.round(v * 100)}%`;
