import type { RenderLodSettings } from './HorseLOD';

/**
 * Automatic quality control.
 *
 * Inputs per frame: the real frame interval (vsync included) and the CPU time we spent
 * (sim + render prep + draw submission). The display refresh period is estimated from the
 * shortest recent intervals and snapped to a common rate (120/90/60/30 Hz), and the frame
 * budget is max(refresh period, 1/60 s). This keeps a device whose rAF is locked to 30 Hz
 * (iOS low-power mode) from being "degraded" forever just because frames are 33 ms apart.
 *
 *  - GPU-bound  (intervals ≫ budget while CPU is fine): lower pixel ratio, then LOD level.
 *  - CPU-bound  (CPU time near the budget): lower LOD level directly (fewer instances).
 *  - Upgrade only after sustained headroom; a failed upgrade doubles the wait (back-off).
 *
 * Changes are never applied synchronously: `takePending()` hands them to the game loop,
 * which applies them *before* the next render (resizing the canvas after rendering would
 * clear the drawing buffer and flash an empty frame).
 */
export interface QualityState {
  pixelRatio: number;
  level: number; // 0 = lowest .. LOD_LEVELS.length-1 = highest
}

export type LodLevel = Omit<RenderLodSettings, never>;

/**
 * Render LOD levels. Level 0 is the floor for weak devices:
 * ≤ 30×926 + 220×270 + 1,500×72 ≈ 195k triangles and ≤ 1,750 instances uploaded per frame.
 */
export const LOD_LEVELS: LodLevel[] = [
  { nearDist: 16, midDist: 55, farDist: 520, nearCap: 30, midCap: 220, farCap: 1500, farKeep: 0.35, shadows: false },
  { nearDist: 24, midDist: 90, farDist: 800, nearCap: 90, midCap: 700, farCap: 4000, farKeep: 0.6, shadows: true },
  { nearDist: 38, midDist: 140, farDist: 1250, nearCap: 160, midCap: 1400, farCap: 10000, farKeep: 1, shadows: true },
  { nearDist: 50, midDist: 180, farDist: 1250, nearCap: 300, midCap: 2600, farCap: 10000, farKeep: 1, shadows: true },
];

export interface QualityOptions {
  maxPixelRatio: number;
  minPixelRatio: number;
  /** fixed pixel ratio / level: disables automatic adjustment */
  fixed?: boolean;
  initialLevel?: number;
  /** highest level automatic upgrades may reach (default: second highest) */
  maxAutoLevel?: number;
}

export interface FrameSample {
  /** time since the previous frame (ms) */
  intervalMs: number;
  /** CPU time spent by the game this frame (ms) */
  cpuMs: number;
}

const REFRESH_RATES_MS = [1000 / 120, 1000 / 90, 1000 / 60, 1000 / 30];

export class QualityManager {
  readonly state: QualityState;
  private pending: QualityState | null = null;
  private avgInterval = 16.7;
  private avgCpu = 2;
  private overTime = 0;
  private underTime = 0;
  private cooldown = 0;
  private windowMin = Infinity;
  private windowTime = 0;
  private refreshMs = 1000 / 60;
  private upgradeWait = 5;
  private sinceUpgrade = Infinity;
  changes = 0;

  constructor(private readonly opts: QualityOptions) {
    this.state = {
      pixelRatio: opts.maxPixelRatio,
      level: clampLevel(opts.initialLevel ?? LOD_LEVELS.length - 2),
    };
  }

  get smoothedIntervalMs(): number {
    return this.avgInterval;
  }

  get smoothedCpuMs(): number {
    return this.avgCpu;
  }

  get estimatedRefreshMs(): number {
    return this.refreshMs;
  }

  /** frame budget (ms) the controller is aiming for */
  get budgetMs(): number {
    return Math.max(1000 / 60, this.refreshMs);
  }

  /** returns a state to apply before the next render, at most once per change */
  takePending(): QualityState | null {
    const p = this.pending;
    this.pending = null;
    return p;
  }

  sample(f: FrameSample): void {
    let interval = f.intervalMs;
    if (!(interval > 0)) return;
    // tab switches are filtered by the caller (visibilitychange resets the clock);
    // clamp so one long stall cannot dominate, but a very slow device still degrades
    if (interval > 250) interval = 250;
    const dt = interval / 1000;

    // refresh estimate: shortest interval seen in the last ~2 s, snapped to a common rate
    this.windowMin = Math.min(this.windowMin, interval);
    this.windowTime += dt;
    if (this.windowTime >= 2) {
      this.refreshMs = snapRefresh(this.windowMin);
      this.windowMin = Infinity;
      this.windowTime = 0;
    }

    this.avgInterval += (interval - this.avgInterval) * 0.08;
    this.avgCpu += (f.cpuMs - this.avgCpu) * 0.08;
    this.sinceUpgrade += dt;
    if (this.opts.fixed) return;
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return;
    }
    const budget = this.budgetMs;
    const gpuOver = this.avgInterval > budget * 1.3;
    const cpuOver = this.avgCpu > budget * 0.8;
    if (gpuOver || cpuOver) {
      this.overTime += dt;
      this.underTime = 0;
    } else if (this.avgInterval < budget * 1.1 && this.avgCpu < budget * 0.4) {
      this.underTime += dt;
      this.overTime = 0;
    } else {
      this.overTime = Math.max(0, this.overTime - dt);
      this.underTime = Math.max(0, this.underTime - dt);
    }
    if (this.overTime > 1.5) this.degrade(cpuOver && !gpuOver);
    else if (this.underTime > this.upgradeWait) this.upgrade();
  }

  private degrade(cpuBound: boolean): void {
    const s = this.state;
    const o = this.opts;
    if (this.sinceUpgrade < 6) this.upgradeWait = Math.min(40, this.upgradeWait * 2); // failed upgrade
    if (!cpuBound && s.pixelRatio > o.minPixelRatio + 1e-3) {
      s.pixelRatio = Math.max(o.minPixelRatio, round2(s.pixelRatio * 0.85));
    } else if (s.level > 0) {
      s.level--;
    } else if (s.pixelRatio > o.minPixelRatio + 1e-3) {
      s.pixelRatio = Math.max(o.minPixelRatio, round2(s.pixelRatio * 0.85));
    } else {
      return;
    }
    this.commit();
  }

  private upgrade(): void {
    const s = this.state;
    const o = this.opts;
    const maxLevel = o.maxAutoLevel ?? LOD_LEVELS.length - 2;
    if (s.pixelRatio < o.maxPixelRatio - 1e-3) {
      s.pixelRatio = Math.min(o.maxPixelRatio, round2(s.pixelRatio * 1.12));
    } else if (s.level < maxLevel) {
      s.level++;
    } else {
      this.underTime = 0;
      return;
    }
    this.sinceUpgrade = 0;
    this.commit();
  }

  private commit(): void {
    this.overTime = 0;
    this.underTime = 0;
    this.cooldown = 1;
    this.changes++;
    this.pending = { ...this.state };
  }
}

export function snapRefresh(ms: number): number {
  let best = REFRESH_RATES_MS[0];
  let bestErr = Infinity;
  for (const r of REFRESH_RATES_MS) {
    const err = Math.abs(Math.log(ms / r));
    if (err < bestErr) {
      bestErr = err;
      best = r;
    }
  }
  return best;
}

function clampLevel(l: number): number {
  return Math.max(0, Math.min(LOD_LEVELS.length - 1, l | 0));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
