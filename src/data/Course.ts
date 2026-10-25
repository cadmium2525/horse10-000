import { COURSE } from '../game/Config';

/**
 * Oval course (design change after Phase 1 playtest: "普通の競馬のように楕円型のコース").
 *
 * Simulation works purely in "course space": `x` = lateral offset from the
 * centerline (m, + = right when facing forward = OUTSIDE of the oval, all turns are
 * left-handed), `s`/`progress` = distance along the centerline (m).
 *
 * Layout along s (one lap = 2 straights + 2 semicircles, centerline radius R):
 *   back straight  [sMin, turnA)     the starting grid fills it behind s = 0
 *   turn 3-4       [turnA, homeStart) heading +π
 *   home straight  [homeStart, turnB) finish line at s = length
 *   turn 1-2       [turnB, sMax)      only the run-out / scenery (race < 1 lap)
 *
 * On a turn a horse at lateral offset x travels (1 + κ·x) world metres per centreline
 * metre (κ = 1/R): the inside rail is shorter but crowded, the outside is clear but long.
 * The sim advances progress by speed / (1 + κ·x); rank logic is unchanged because progress
 * is still "centreline distance".
 */
export interface CourseSpec {
  seed: number;
  /** finish line distance from the front of the grid (m) */
  length: number;
  /** rail-to-rail width (m) */
  width: number;
  /** first s covered by the centerline table (behind the grid) */
  sMin: number;
  /** last s covered (one full lap) */
  sMax: number;
  /** centreline curvature at s (1/m, > 0 on the left-hand turns) */
  curvatureAt(s: number): number;
}

export class Course implements CourseSpec {
  readonly seed: number;
  readonly length: number;
  readonly width: number;
  readonly radius: number;
  readonly sMin: number;
  readonly sMax: number;
  readonly lap: number;
  /** s where turn 3-4 starts / the home straight starts / turn 1-2 starts */
  readonly turnA: number;
  readonly homeStart: number;
  readonly turnB: number;
  readonly step = 2; // table resolution (m)

  /** world position of the centerline (x,z) and heading per table entry */
  readonly cx: Float64Array;
  readonly cz: Float64Array;
  readonly sinH: Float32Array;
  readonly cosH: Float32Array;
  readonly heading: Float32Array;
  readonly kappa: Float32Array;
  private readonly n: number;

  constructor(seed: number, opts?: Partial<{ width: number; radius: number }>) {
    this.seed = seed;
    this.width = opts?.width ?? COURSE.WIDTH;
    this.radius = opts?.radius ?? COURSE.TURN_RADIUS;
    const R = this.radius;
    const Ls = COURSE.STRAIGHT;
    this.turnA = COURSE.START_TO_TURN;
    this.sMin = this.turnA - Ls;
    this.homeStart = this.turnA + Math.PI * R;
    this.length = this.homeStart + COURSE.HOME_TO_FINISH;
    this.turnB = this.homeStart + Ls;
    this.lap = 2 * Ls + 2 * Math.PI * R;
    this.sMax = this.sMin + this.lap;

    this.n = Math.ceil((this.sMax - this.sMin) / this.step) + 1;
    this.cx = new Float64Array(this.n);
    this.cz = new Float64Array(this.n);
    this.sinH = new Float32Array(this.n);
    this.cosH = new Float32Array(this.n);
    this.heading = new Float32Array(this.n);
    this.kappa = new Float32Array(this.n);

    // Integrate heading along s (midpoint rule). Start line s = 0 sits at world origin.
    let x = 0;
    let z = 0;
    const i0 = Math.round(-this.sMin / this.step);
    const pts: number[] = [];
    for (let i = 0; i < this.n; i++) {
      const s = this.sMin + i * this.step;
      const h = this.headingAt(s);
      this.heading[i] = h;
      this.sinH[i] = Math.sin(h);
      this.cosH[i] = Math.cos(h);
      this.kappa[i] = this.curvatureAt(s);
      pts.push(x, z);
      const hm = this.headingAt(s + this.step * 0.5);
      x += Math.sin(hm) * this.step;
      z += Math.cos(hm) * this.step;
    }
    const ox = pts[i0 * 2];
    const oz = pts[i0 * 2 + 1];
    for (let i = 0; i < this.n; i++) {
      this.cx[i] = pts[i * 2] - ox;
      this.cz[i] = pts[i * 2 + 1] - oz;
    }
  }

  /** Analytic heading (rad, 0 = +Z, increasing = turning left). */
  headingAt(s: number): number {
    const R = this.radius;
    const halfTurn = Math.PI * R;
    if (s < this.turnA) return 0;
    if (s < this.homeStart) return (s - this.turnA) / R;
    if (s < this.turnB) return Math.PI;
    if (s < this.turnB + halfTurn) return Math.PI + (s - this.turnB) / R;
    return 2 * Math.PI;
  }

  curvatureAt(s: number): number {
    const halfTurn = Math.PI * this.radius;
    if ((s >= this.turnA && s < this.homeStart) || (s >= this.turnB && s < this.turnB + halfTurn)) return 1 / this.radius;
    return 0;
  }

  /** true while s is on one of the turns */
  onTurn(s: number): boolean {
    return this.curvatureAt(s) > 0;
  }

  /** world (x, z) of the oval's centre (middle of the infield) */
  infieldCenter(out: number[] | Float32Array): void {
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    // centre of curvature of each turn = centreline point R to the inside (−x)
    this.toWorld(-this.radius, this.turnA, a);
    this.toWorld(-this.radius, this.turnB, b);
    out[0] = (a[0] + b[0]) / 2;
    out[1] = (a[1] + b[1]) / 2;
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
