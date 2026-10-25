/**
 * All sound is synthesised with the Web Audio API (no audio files, design §7/§8).
 *
 * - crowd: looping filtered noise whose level and "hoof" pulse follow the number of
 *   horses near the camera and the player's speed
 * - one-shots: jump, landing thump, comedic "boing" falls, pass ticks, countdown beeps,
 *   GO, dash whoosh, finish fanfare
 *
 * The AudioContext is created lazily on the first user gesture (autoplay policies).
 * Every method is a no-op while disabled or before unlock.
 */
export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private crowdGain: GainNode | null = null;
  private crowdFilter: BiquadFilterNode | null = null;
  private pulseGain: GainNode | null = null;
  private pulseOsc: OscillatorNode | null = null;
  private noise: AudioBuffer | null = null;
  private enabled: boolean;
  private lastBoing = 0;
  private boingsThisSecond = 0;
  private lastPass = 0;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** must be called from a user gesture (click / key / touch) */
  unlock(): void {
    if (typeof window === 'undefined') return;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor();
      } catch {
        return;
      }
      this.build();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(on ? 0.8 : 0, this.ctx.currentTime, 0.05);
  }

  /** pause/resume everything (tab hidden, pause menu) */
  suspend(s: boolean): void {
    if (!this.ctx) return;
    if (s) void this.ctx.suspend();
    else if (this.enabled) void this.ctx.resume();
  }

  private build(): void {
    const ctx = this.ctx!;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.8 : 0;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

    // 2 s of white noise, shared by all noise voices
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      d[i] = (seed / 0x7fffffff) * 2 - 1;
    }

    // crowd rumble: noise -> lowpass -> pulse (hoofbeats) -> crowd gain
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    this.crowdFilter = ctx.createBiquadFilter();
    this.crowdFilter.type = 'lowpass';
    this.crowdFilter.frequency.value = 380;
    this.crowdFilter.Q.value = 0.7;
    this.pulseGain = ctx.createGain();
    this.pulseGain.gain.value = 0.6;
    this.pulseOsc = ctx.createOscillator();
    this.pulseOsc.frequency.value = 7;
    const pulseDepth = ctx.createGain();
    pulseDepth.gain.value = 0.35;
    this.pulseOsc.connect(pulseDepth).connect(this.pulseGain.gain);
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0;
    src.connect(this.crowdFilter).connect(this.pulseGain).connect(this.crowdGain).connect(this.master);
    src.start();
    this.pulseOsc.start();
  }

  /**
   * Continuous crowd level. `density` 0..1 (horses near the camera), `speed` m/s of the
   * player. Call every frame; smoothing is done by the audio graph.
   */
  crowd(density: number, speed: number): void {
    if (!this.ctx || !this.crowdGain || !this.crowdFilter || !this.pulseOsc) return;
    const t = this.ctx.currentTime;
    const level = Math.min(1, density) * (0.25 + Math.min(1, speed / 20) * 0.45);
    this.crowdGain.gain.setTargetAtTime(level, t, 0.25);
    this.crowdFilter.frequency.setTargetAtTime(250 + speed * 18, t, 0.3);
    this.pulseOsc.frequency.setTargetAtTime(4 + speed * 0.35, t, 0.3);
  }

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, peak: number, when = 0): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = this.ctx.createGain();
    this.env(g, t, peak, 0.01, dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private noiseHit(dur: number, freq: number, peak: number, type: BiquadFilterType = 'bandpass'): void {
    if (!this.ctx || !this.master || !this.noise || !this.enabled) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = this.ctx.createGain();
    this.env(g, t, peak, 0.01, dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.05);
  }

  jump(): void {
    this.tone('sine', 320, 760, 0.18, 0.25);
    this.noiseHit(0.15, 1800, 0.08, 'highpass');
  }

  land(): void {
    this.tone('sine', 140, 60, 0.12, 0.3);
  }

  dash(): void {
    this.noiseHit(0.35, 2500, 0.12, 'highpass');
  }

  /** comedic fall; `near` 0..1 scales the volume. Rate-limited so chains stay musical. */
  boing(near: number): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    const now = this.ctx.currentTime;
    if (now - this.lastBoing > 1) this.boingsThisSecond = 0;
    if (this.boingsThisSecond > 6) return;
    this.boingsThisSecond++;
    this.lastBoing = now;
    const t = now + Math.random() * 0.05;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    const base = 380 + Math.random() * 220;
    o.frequency.setValueAtTime(base, t);
    o.frequency.exponentialRampToValueAtTime(base * 0.3, t + 0.45);
    const vib = this.ctx.createOscillator();
    vib.frequency.value = 16;
    const vibDepth = this.ctx.createGain();
    vibDepth.gain.value = 40;
    vib.connect(vibDepth).connect(o.frequency);
    const g = this.ctx.createGain();
    this.env(g, t, 0.05 + 0.25 * Math.min(1, near), 0.01, 0.5);
    o.connect(g).connect(this.master);
    o.start(t);
    vib.start(t);
    o.stop(t + 0.6);
    vib.stop(t + 0.6);
  }

  /** a short tick for passes (rate-limited); pitch rises with the burst size */
  pass(burst: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    if (now - this.lastPass < 0.07) return;
    this.lastPass = now;
    this.tone('triangle', 900 + Math.min(burst, 400) * 2, 1300 + Math.min(burst, 400) * 2, 0.05, 0.06);
  }

  countdown(n: number): void {
    if (n > 0) this.tone('square', 520, 520, 0.14, 0.12);
    else this.tone('square', 1040, 1040, 0.45, 0.14);
  }

  fanfare(kind: 'perfect' | 'win' | 'finish'): void {
    const notes =
      kind === 'finish' ? [523, 659, 784] : kind === 'win' ? [523, 659, 784, 1047, 784, 1047] : [523, 659, 784, 1047, 1319, 1568, 2093];
    notes.forEach((f, k) => {
      this.tone('triangle', f, f, 0.22, 0.16, k * 0.13);
      this.tone('square', f / 2, f / 2, 0.2, 0.04, k * 0.13);
    });
  }

  timeUp(): void {
    this.tone('sawtooth', 300, 150, 0.6, 0.12);
  }
}
