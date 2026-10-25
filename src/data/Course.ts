import { COURSE } from '../game/Config';
import { Rng, deriveSeed } from './Seed';

/**
 * Course model.
 *
 * Simulation works purely in "course space": `x` = lateral offset from the
 * centerline (m, + = right when facing forward), `s`/`progress` = distance
 * along the centerline (m). The finish line is at s = length; the front row of
 * the starting grid is at s = 0 and the pack extends behind it (negative s).
 *
 * The world-space centerline (gentle curves) only matters to rendering, so it
 * is precomputed as a lookup table here and never consulted by the sim.
 */
export interface CourseSpec {
  seed: number;
  /** finish line distance from the front of the grid (m) */
  length: number;
  /** rail-to-rail width (m) */
  width: number;
  /** first s covered by the centerline table (behind the grid) */
  sMin: number;
  /** last s covered (run-out past the finish) */
  sMax: number;
}

export interface CourseBend {
  center: number; // s at bend apex
  span: number; // half-length of the bend (m)
  angle: number; // total heading change (rad)
}

export class Course implements CourseSpec {
  readonly seed: number;
  readonly length: number;
  readonly width: number;
  readonly sMin: number;
  readonly sMax: number;
  readonly step = 2; // table resolution (m)
  readonly bends: CourseBend[];

  /** world position of the centerline (x,z) and heading per table entry */
  readonly cx: Float64Array;
  readonly cz: Float64Array;
  readonly sinH: Float32Array;
  readonly cosH: Float32Array;
  readonly heading: Float32Array;
  private readonly n: number;

  constructor(seed: number, opts?: Partial<Pick<CourseSpec, 'length' | 'width'>>) {
    this.seed = seed;
    this.length = opts?.length ?? COURSE.LENGTH;
    this.width = opts?.width ?? COURSE.WIDTH;
    this.sMin = -400;
    this.sMax = this.length + 400;
    this.bends = generateBends(seed, this.length);

    this.n = Math.ceil((this.sMax - this.sMin) / this.step) + 1;
    this.cx = new Float64Array(this.n);
    this.cz = new Float64Array(this.n);
    this.sinH = new Float32Array(this.n);
    this.cosH = new Float32Array(this.n);
    this.heading = new Float32Array(this.n);

    // Integrate heading along s. Start straight; start line at world origin.
    let x = 0;
    let z = this.sMin;
    for (let i = 0; i < this.n; i++) {
      const s = this.sMin + i * this.step;
      const h = this.headingAt(s);
      this.heading[i] = h;
      this.sinH[i] = Math.sin(h);
      this.cosH[i] = Math.cos(h);
      this.cx[i] = x;
      this.cz[i] = z;
      x += Math.sin(h) * this.step;
      z += Math.cos(h) * this.step;
    }
    // Re-anchor so that s = 0 sits at world (0, 0).
    const i0 = Math.round(-this.sMin / this.step);
    const ox = this.cx[i0];
    const oz = this.cz[i0];
    for (let i = 0; i < this.n; i++) {
      this.cx[i] -= ox;
      this.cz[i] -= oz;
    }
  }

  /** Analytic heading (rad) at distance s. Smooth (cosine-eased) bends. */
  headingAt(s: number): number {
    let h = 0;
    for (const b of this.bends) {
      const t = (s - (b.center - b.span)) / (2 * b.span);
      if (t <= 0) continue;
      if (t >= 1) {
        h += b.angle;
      } else {
        h += b.angle * (0.5 - 0.5 * Math.cos(Math.PI * t));
      }
    }
    return h;
  }

  /**
   * World transform of a course-space point. Writes into `out`:
   * [0]=worldX, [1]=worldZ, [2]=heading (rad, yaw where 0 faces +Z).
   * Right vector for heading h is (-cos h, 0, sin h).
   */
  toWorld(x: number, s: number, out: Float32Array | number[]): void {
    let f = (s - this.sMin) / this.step;
    if (f < 0) f = 0;
    else if (f > this.n - 1.001) f = this.n - 1.001;
    const i = f | 0;
    const t = f - i;
    const cx = this.cx[i] + (this.cx[i + 1] - this.cx[i]) * t;
    const cz = this.cz[i] + (this.cz[i + 1] - this.cz[i]) * t;
    const sh = this.sinH[i] + (this.sinH[i + 1] - this.sinH[i]) * t;
    const ch = this.cosH[i] + (this.cosH[i + 1] - this.cosH[i]) * t;
    // extrapolate linearly beyond table ends
    const extra = s < this.sMin ? s - this.sMin : s > this.sMax ? s - this.sMax : 0;
    out[0] = cx - ch * x + sh * extra;
    out[1] = cz + sh * x + ch * extra;
    out[2] = this.heading[i] + (this.heading[i + 1] - this.heading[i]) * t;
  }
}

/** Gentle seeded bends: 2–3 bends of at most ~25° total, none near the finish. */
export function generateBends(seed: number, length: number): CourseBend[] {
  const rng = new Rng(deriveSeed(seed, 'course-bends'));
  const count = rng.int(2, 3);
  const bends: CourseBend[] = [];
  const usable = length - 300; // last 300 m is straight
  const slot = usable / count;
  let dir = rng.sign();
  for (let i = 0; i < count; i++) {
    const span = rng.range(110, 180);
    const center = 150 + slot * i + rng.range(span, Math.max(span + 1, slot - span));
    const angle = dir * rng.range(0.18, 0.42);
    bends.push({ center: Math.min(center, usable - span), span, angle });
    dir = -dir; // S-shape keeps the course roughly straight overall
  }
  return bends;
}
