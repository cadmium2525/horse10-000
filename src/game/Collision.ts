import { COLLISION, FIELD, HORSE, PLAYER } from './Config';
import { HorseState, Layer, type HorseSimulation } from './HorseSimulation';

/**
 * Uniform-grid spatial hash over course space (x, progress), rebuilt each tick
 * with a counting sort. Only layer A ∪ B horses are inserted (~700), so building
 * and querying is O(active) — never O(N²).
 */
export class SpatialHash {
  readonly cellSize: number;
  private readonly inv: number;
  private readonly mask: number;
  private readonly cellStart: Int32Array; // tableSize + 1
  private readonly cursor: Int32Array;
  private readonly cellOf: Int32Array; // per inserted entry
  private readonly entries: Int32Array;
  private count = 0;
  private readonly visited = new Int32Array(64);

  constructor(cellSize: number, tableSize: number, capacity: number) {
    if ((tableSize & (tableSize - 1)) !== 0) throw new Error('tableSize must be a power of two');
    this.cellSize = cellSize;
    this.inv = 1 / cellSize;
    this.mask = tableSize - 1;
    this.cellStart = new Int32Array(tableSize + 1);
    this.cursor = new Int32Array(tableSize);
    this.cellOf = new Int32Array(capacity);
    this.entries = new Int32Array(capacity);
  }

  bucket(cx: number, cy: number): number {
    return (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) & this.mask;
  }

  /** Insert ids[0..count) at positions (xs[id], ps[id]). Order is preserved per bucket. */
  build(ids: Int32Array, count: number, xs: ArrayLike<number>, ps: ArrayLike<number>): void {
    const start = this.cellStart;
    start.fill(0);
    const inv = this.inv;
    for (let k = 0; k < count; k++) {
      const id = ids[k];
      const b = this.bucket(Math.floor(xs[id] * inv), Math.floor(ps[id] * inv));
      this.cellOf[k] = b;
      start[b + 1]++;
    }
    for (let b = 1; b < start.length; b++) start[b] += start[b - 1];
    // stable placement: walk ids in order, using a cursor copy of start
    const cursor = this.cursor;
    cursor.set(start.subarray(0, start.length - 1));
    for (let k = 0; k < count; k++) {
      const b = this.cellOf[k];
      this.entries[cursor[b]++] = ids[k];
    }
    this.count = count;
  }

  get size(): number {
    return this.count;
  }

  /**
   * Visit every inserted id whose cell overlaps the rectangle. May report ids slightly
   * outside the rectangle (cell granularity / bucket aliasing) — callers filter by distance.
   * Buckets are deduplicated so an id is reported at most once.
   */
  forEachInRect(x0: number, p0: number, x1: number, p1: number, fn: (id: number) => void): void {
    const inv = this.inv;
    const cx0 = Math.floor(x0 * inv);
    const cx1 = Math.floor(x1 * inv);
    const cy0 = Math.floor(p0 * inv);
    const cy1 = Math.floor(p1 * inv);
    let nVisited = 0;
    const visited = this.visited;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const b = this.bucket(cx, cy);
        let dup = false;
        for (let v = 0; v < nVisited; v++) {
          if (visited[v] === b) {
            dup = true;
            break;
          }
        }
        if (dup) continue;
        if (nVisited < visited.length) visited[nVisited++] = b;
        const end = this.cellStart[b + 1];
        for (let e = this.cellStart[b]; e < end; e++) fn(this.entries[e]);
      }
    }
  }
}

// scratch for the pair loop (avoid closures allocating per horse)
let neighborBuf = new Int32Array(256);

/**
 * Local contact resolution for layers A and B.
 *
 * Colliders are axis-aligned ellipses in course space (long in the running direction),
 * with a vertical extent so jumping horses clear fallen ones (but not standing ones).
 *
 * Outcomes:
 *  - separation (mostly lateral) + speed exchange (rear horse is checked)
 *  - running into a FALLEN horse => trip (stumble or fall)  [A and B]  -> chain reactions
 *  - hard contact between upright horses => stumble; stumble + another hit => fall  [A only]
 *  - a freshly tumbling horse shoves neighbours sideways (impulse)
 */
export function resolveCollisions(sim: HorseSimulation): void {
  const hash = sim.hash;
  hash.build(sim.active, sim.activeCount, sim.x, sim.progress);

  const { x, progress, y, speed, vx, state, layer, stateTime } = sim;
  const reach = HORSE.FALLEN_HALF_LENGTH * 2;
  const reachX = HORSE.FALLEN_HALF_WIDTH * 2;

  for (let k = 0; k < sim.activeCount; k++) {
    const i = sim.active[k];
    // gather neighbours with id > i (each pair handled once, deterministic order)
    let nn = 0;
    hash.forEachInRect(x[i] - reachX, progress[i] - reach, x[i] + reachX, progress[i] + reach, (j) => {
      if (j <= i) return;
      if (nn >= neighborBuf.length) {
        const grown = new Int32Array(neighborBuf.length * 2);
        grown.set(neighborBuf);
        neighborBuf = grown;
      }
      neighborBuf[nn++] = j;
    });
    // bucket iteration order is deterministic, but sort to make it independent of hashing
    if (nn > 1) sortSmall(neighborBuf, nn);

    for (let q = 0; q < nn; q++) {
      const j = neighborBuf[q];
      const downI = state[i] === HorseState.FALL;
      const downJ = state[j] === HorseState.FALL;
      const hwI = downI ? HORSE.FALLEN_HALF_WIDTH : HORSE.HALF_WIDTH;
      const hwJ = downJ ? HORSE.FALLEN_HALF_WIDTH : HORSE.HALF_WIDTH;
      const hlI = downI ? HORSE.FALLEN_HALF_LENGTH : HORSE.HALF_LENGTH;
      const hlJ = downJ ? HORSE.FALLEN_HALF_LENGTH : HORSE.HALF_LENGTH;
      const rx = hwI + hwJ;
      const rp = hlI + hlJ;
      const dx = x[j] - x[i];
      const dp = progress[j] - progress[i];
      if (dx >= rx || dx <= -rx || dp >= rp || dp <= -rp) continue;
      const ux = dx / rx;
      const up = dp / rp;
      const q2 = ux * ux + up * up;
      if (q2 >= 1) continue;

      // vertical overlap: [y, y + height]
      const topI = y[i] + (downI ? HORSE.FALLEN_HEIGHT : HORSE.HEIGHT);
      const topJ = y[j] + (downJ ? HORSE.FALLEN_HEIGHT : HORSE.HEIGHT);
      if (y[i] >= topJ || y[j] >= topI) continue;

      sim.contactsThisTick++;
      const d = Math.sqrt(q2);
      const pen = 1 - d;
      let nx: number;
      let np: number;
      if (d > 1e-4) {
        nx = ux / d;
        np = up / d;
      } else {
        nx = (i + j) & 1 ? 1 : -1;
        np = 0;
      }

      // mass weighting: fallen horses are heavy obstacles; the player is slightly heavy
      let wI = downI ? 0.2 : 1;
      let wJ = downJ ? 0.2 : 1;
      if (i === FIELD.PLAYER) wI *= 0.6;
      const wSum = wI + wJ;
      wI /= wSum;
      wJ /= wSum;

      // positional separation (lateral fully, longitudinal partially: speeds handle the rest)
      const sepX = nx * pen * rx;
      const sepP = np * pen * rp * 0.5;
      x[i] -= sepX * wI;
      x[j] += sepX * wJ;
      progress[i] -= sepP * wI;
      progress[j] += sepP * wJ;

      // speed exchange: the rear horse is checked
      const rear = dp > 0 ? i : j;
      const front = rear === i ? j : i;
      const closing = Math.max(0, speed[rear] - speed[front]) * Math.abs(np);
      const latImpact = Math.abs(vx[i] - vx[j]) * Math.abs(nx);
      const impact = closing + latImpact;
      if (closing > 0) {
        speed[rear] -= closing * 0.6;
        if (!(state[front] === HorseState.FALL)) speed[front] += closing * 0.15;
      }
      // lateral velocity: share momentum along the normal
      const avgVx = (vx[i] + vx[j]) * 0.5;
      vx[i] += (avgVx - vx[i]) * Math.abs(nx) * 0.5;
      vx[j] += (avgVx - vx[j]) * Math.abs(nx) * 0.5;

      // fresh tumble shoves neighbours (comedic knock-on)
      if (downI && stateTime[i] < 0.35) vx[j] += Math.sign(dx || 1) * COLLISION.FALL_IMPULSE * 0.5;
      if (downJ && stateTime[j] < 0.35) vx[i] -= Math.sign(dx || 1) * COLLISION.FALL_IMPULSE * 0.5;

      // --- outcomes -------------------------------------------------------------
      if (downI !== downJ) {
        const runner = downI ? j : i;
        const fallen = downI ? i : j;
        trip(sim, runner, fallen, impact + speed[runner] * 0.05);
      } else if (!downI && !downJ) {
        upright(sim, i, j, rear, impact, layer[i] === Layer.A || layer[j] === Layer.A);
      }
    }
  }
}

function playerMult(i: number): number {
  return i === FIELD.PLAYER ? PLAYER.STUMBLE_MULT : 1;
}

/** Runner hits a fallen horse at ground level. */
function trip(sim: HorseSimulation, runner: number, fallen: number, impact: number): void {
  if (!sim.canBeKnocked(runner)) return;
  if (sim.y[runner] > 0.4) return; // landing on the very top of a pile is a graze, not a trip
  const p = Math.min(0.95, (COLLISION.TRIP_BASE + COLLISION.TRIP_PER_IMPACT * impact) * playerMult(runner));
  const r = sim.rng.next();
  if (r < p) sim.fall(runner, Math.sign(sim.x[runner] - sim.x[fallen]) || 1);
  else if (r < p + 0.3) sim.stumble(runner);
}

/** Contact between two upright horses. */
function upright(sim: HorseSimulation, i: number, j: number, rear: number, impact: number, detailed: boolean): void {
  if (!detailed) return; // layer B: separation only
  if (impact < 0.4) return;
  const crowd = sim.densityAt(sim.x[i], sim.progress[i]);
  let p =
    COLLISION.STUMBLE_BASE + COLLISION.STUMBLE_PER_IMPACT * impact + COLLISION.STUMBLE_PER_NEIGHBOR * Math.max(0, crowd - 15);
  if (p > COLLISION.STUMBLE_MAX) p = COLLISION.STUMBLE_MAX;
  // the rear (hitting) horse is most at risk; a sideswipe can unsettle either
  const other = rear === i ? j : i;
  for (let v = 0; v < 2; v++) {
    const h = v === 0 ? rear : other;
    const pv = (v === 0 ? p : p * 0.4) * playerMult(h);
    if (!sim.canBeKnocked(h)) continue;
    if (sim.state[h] === HorseState.STUMBLE) {
      if (impact > 1 && sim.rng.next() < COLLISION.STUMBLE_TO_FALL * playerMult(h)) sim.fall(h);
    } else if (sim.rng.next() < pv) {
      sim.stumble(h);
    }
  }
}

function sortSmall(a: Int32Array, n: number): void {
  for (let i = 1; i < n; i++) {
    const v = a[i];
    let k = i - 1;
    while (k >= 0 && a[k] > v) {
      a[k + 1] = a[k];
      k--;
    }
    a[k + 1] = v;
  }
}
