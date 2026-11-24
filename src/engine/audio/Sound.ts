/**
 * Procedural sound design (Web Audio, no samples):
 *  - continuous pour noise whose colour follows viscosity and flow
 *  - bubbly droplets "plips" for thin liquids, soft "blorps" for thick ones
 *  - stir swish, body thuds, UI clicks and a relaxing pad
 */
export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private pourGain: GainNode | null = null;
  private pourFilter: BiquadFilterNode | null = null;
  private swishGain: GainNode | null = null;
  private swishFilter: BiquadFilterNode | null = null;
  private padNodes: { gain: GainNode; oscs: OscillatorNode[]; lfo: OscillatorNode } | null = null;
  private noise: AudioBuffer | null = null;
  private recDest: MediaStreamAudioDestinationNode | null = null;
  enabled = false;
  volume = 0.6;
  private dropletAcc = 0;

  /** Must be called from a user gesture at least once. */
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.recDest = ctx.createMediaStreamDestination();
    comp.connect(this.recDest);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + w * 0.029;
      b1 = 0.985 * b1 + w * 0.032;
      b2 = 0.95 * b2 + w * 0.048;
      d[i] = (b0 + b1 + b2 + w * 0.04) * 0.9;
    }
    const mk = (type: BiquadFilterType, f: number, q: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filt = ctx.createBiquadFilter();
      filt.type = type;
      filt.frequency.value = f;
      filt.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(filt).connect(g).connect(this.master!);
      src.start();
      return { filt, g };
    };
    const pour = mk('bandpass', 900, 0.7);
    this.pourFilter = pour.filt;
    this.pourGain = pour.g;
    const sw = mk('bandpass', 1400, 1.2);
    this.swishFilter = sw.filt;
    this.swishGain = sw.g;
  }

  get stream(): MediaStream | null {
    return this.recDest?.stream ?? null;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (on) this.ensure();
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? this.volume : 0, this.ctx.currentTime, 0.05);
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master && this.ctx && this.enabled) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Per-frame update. flow: 0..1 amount of liquid pouring; landing: 0..1 liquid hitting things. */
  update(dt: number, flow: number, viscosity: number, landing: number, stir: number) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const t = ctx.currentTime;
    const thin = 1 - viscosity;
    this.pourGain!.gain.setTargetAtTime(Math.min(0.5, flow * (0.12 + 0.25 * thin)), t, 0.12);
    this.pourFilter!.frequency.setTargetAtTime(260 + 1500 * thin * thin + 200 * flow, t, 0.2);
    this.swishGain!.gain.setTargetAtTime(Math.min(0.35, stir * 0.4), t, 0.05);
    this.swishFilter!.frequency.setTargetAtTime(700 + stir * 1800, t, 0.05);

    // droplets / blorps from liquid landing
    const rate = landing * (thin > 0.5 ? 14 * thin : 3.5);
    this.dropletAcc += rate * dt;
    while (this.dropletAcc > 1) {
      this.dropletAcc -= 1 + Math.random() * 0.6;
      if (thin > 0.45) this.plip(0.4 + Math.random() * 0.6, thin);
      else this.blorp(0.5 + Math.random() * 0.5, viscosity);
    }
  }

  plip(intensity = 1, thin = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const t = ctx.currentTime + Math.random() * 0.02;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const f0 = 380 + Math.random() * 700 * thin;
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * (1.6 + Math.random()), t + 0.07);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07 * intensity, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + 0.13);
  }

  blorp(intensity = 1, viscosity = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 500;
    const f0 = 150 - viscosity * 60 + Math.random() * 40;
    o.type = 'triangle';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + 0.22);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16 * intensity, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(f).connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + 0.32);
  }

  thud(intensity = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || !this.noise) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.15);
    g.gain.setValueAtTime(Math.min(0.35, 0.1 + intensity * 0.25), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + 0.22);
  }

  click(pitch = 1) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880 * pitch, t);
    o.frequency.exponentialRampToValueAtTime(1320 * pitch, t + 0.04);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + 0.1);
  }

  chime(good = true) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    const notes = good ? [523.25, 659.25, 783.99, 1046.5] : [392, 311.13];
    notes.forEach((f, i) => {
      const t = ctx.currentTime + i * 0.09;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.09, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      o.connect(g).connect(this.master!);
      o.start(t);
      o.stop(t + 0.65);
    });
  }

  whoosh() {
    const ctx = this.ctx;
    if (!ctx || !this.enabled || !this.noise) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 2;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(2400, t + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t);
    src.stop(t + 0.55);
  }

  pad(on: boolean) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (on && !this.padNodes) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 700;
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = 0.07;
      lfoGain.gain.value = 350;
      lfo.connect(lfoGain).connect(filt.frequency);
      const oscs = [130.81, 196, 246.94, 329.63].map((f, i) => {
        const o = ctx.createOscillator();
        o.type = i % 2 ? 'sine' : 'triangle';
        o.frequency.value = f;
        o.detune.value = (Math.random() - 0.5) * 12;
        o.connect(filt);
        o.start();
        return o;
      });
      lfo.start();
      filt.connect(gain).connect(this.master!);
      gain.gain.setTargetAtTime(0.05, ctx.currentTime, 2);
      this.padNodes = { gain, oscs, lfo };
    } else if (!on && this.padNodes) {
      const p = this.padNodes;
      p.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.5);
      setTimeout(() => {
        p.oscs.forEach((o) => o.stop());
        p.lfo.stop();
      }, 2500);
      this.padNodes = null;
    }
  }
}
