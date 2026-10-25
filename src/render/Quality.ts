import type { RenderLodSettings } from './HorseLOD';

/**
 * Automatic quality control. Watches smoothed frame time and steps the device pixel
 * ratio first (cheapest visual loss), then the render LOD distances. Hysteresis keeps it
 * from oscillating: degrade quickly (after ~1.5 s over budget), upgrade slowly (~5 s).
 */
export interface QualityState {
  pixelRatio: number;
  level: number; // 0 = lowest .. LEVELS.length-1 = highest
}

export const LOD_LEVELS: Array<Pick<RenderLodSettings, 'nearDist' | 'midDist' | 'nearCap' | 'midCap' | 'shadows'>> = [
  { nearDist: 18, midDist: 70, nearCap: 50, midCap: 400, shadows: false },
  { nearDist: 26, midDist: 100, nearCap: 100, midCap: 800, shadows: true },
  { nearDist: 38, midDist: 140, nearCap: 160, midCap: 1400, shadows: true },
  { nearDist: 50, midDist: 180, nearCap: 300, midCap: 2600, shadows: true },
];

export interface QualityOptions {
  /** frame budget in ms (e.g. 1000/55 for a 60 Hz display with headroom) */
  targetMs: number;
  maxPixelRatio: number;
  minPixelRatio: number;
  /** fixed pixel ratio / level: disables automatic adjustment */
  fixed?: boolean;
  initialLevel?: number;
}

export class QualityManager {
  readonly state: QualityState;
  private avg = 16;
  private overTime = 0;
  private underTime = 0;
  private cooldown = 0;
  changes = 0;

  constructor(
    private readonly opts: QualityOptions,
    private readonly apply: (s: QualityState) => void,
  ) {
    this.state = {
      pixelRatio: opts.maxPixelRatio,
      level: opts.initialLevel ?? LOD_LEVELS.length - 2,
    };
    this.apply(this.state);
  }

  get smoothedFrameMs(): number {
    return this.avg;
  }

  /** feed the real frame interval (ms) once per rendered frame */
  sample(frameMs: number, dtSec: number): void {
    // tab switches are filtered by the caller (visibilitychange resets the clock);
    // clamp so one long stall cannot dominate, but a very slow device still degrades
    if (frameMs > 250) frameMs = 250;
    if (dtSec > 0.25) dtSec = 0.25;
    this.avg += (frameMs - this.avg) * 0.08;
    if (this.opts.fixed) return;
    if (this.cooldown > 0) {
      this.cooldown -= dtSec;
      return;
    }
    const target = this.opts.targetMs;
    if (this.avg > target * 1.12) {
      this.overTime += dtSec;
      this.underTime = 0;
    } else if (this.avg < target * 0.7) {
      this.underTime += dtSec;
      this.overTime = 0;
    } else {
      this.overTime = Math.max(0, this.overTime - dtSec);
      this.underTime = Math.max(0, this.underTime - dtSec);
    }
    if (this.overTime > 1.5) this.degrade();
    else if (this.underTime > 5) this.upgrade();
  }

  private degrade(): void {
    const s = this.state;
    const o = this.opts;
    if (s.pixelRatio > o.minPixelRatio + 1e-3) {
      s.pixelRatio = Math.max(o.minPixelRatio, round2(s.pixelRatio * 0.85));
    } else if (s.level > 0) {
      s.level--;
    } else {
      return;
    }
    this.commit();
  }

  private upgrade(): void {
    const s = this.state;
    const o = this.opts;
    if (s.level < LOD_LEVELS.length - 2) {
      s.level++;
    } else if (s.pixelRatio < o.maxPixelRatio - 1e-3) {
      s.pixelRatio = Math.min(o.maxPixelRatio, round2(s.pixelRatio * 1.12));
    } else {
      return;
    }
    this.commit();
  }

  private commit(): void {
    this.overTime = 0;
    this.underTime = 0;
    this.cooldown = 1;
    this.changes++;
    this.apply(this.state);
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
