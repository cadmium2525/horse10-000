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
  /** buckets already visited by the current query (grows on demand) */
  private visited = new Int32Array(64);

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

  /** shared result buffer of `query()` (valid until the next query) */
  result = new Int32Array(256);

  /**
   * Allocation-free variant of forEachInRect: fills `this.result` and returns the count.
   * Same guarantees (each id at most once, may include ids slightly outside the rect).
   */
  query(x0: number, p0: number, x1: number, p1: number): number {
    const inv = this.inv;
    const cx0 = Math.floor(x0 * inv);
    const cx1 = Math.floor(x1 * inv);
    const cy0 = Math.floor(p0 * inv);
    const cy1 = Math.floor(p1 * inv);
    const cells = (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
    if (cells > this.visited.length) this.visited = new Int32Array(Math.min(this.mask + 1, cells * 2));
    let nVisited = 0;
    const visited = this.visited;
    let n = 0;
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
        visited[nVisited++] = b;
        const end = this.cellStart[b + 1];
        for (let e = this.cellStart[b]; e < end; e++) {
          if (n >= this.result.length) {
            const grown = new Int32Array(this.result.length * 2);
            grown.set(this.result);
            this.result = grown;
          }
          this.result[n++] = this.entries[e];
        }
      }
    }
    return n;
  }

  /**
   * Visit every inserted id whose cell overlaps the rectangle. May report ids slightly
   * outside the rectangle (cell granularity / bucket aliasing) — callers filter by distance.
   * Buckets are deduplicated so an id is reported at most once, for any rectangle size.
   */
  forEachInRect(x0: number, p0: number, x1: number, p1: number, fn: (id: number) => void): void {
    const inv = this.inv;
    const cx0 = Math.floor(x0 * inv);
    const cx1 = Math.floor(x1 * inv);
    const cy0 = Math.floor(p0 * inv);
    const cy1 = Math.floor(p1 * inv);
    const cells = (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
    if (cells > this.visited.length) this.visited = new Int32Array(Math.min(this.mask + 1, cells * 2));
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
        visited[nVisited++] = b;
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
 *  - separation (mostly lateral) + speed exchange (rear horse is checked). Positional
 *    correction is budgeted per horse per tick (smaller just after leaving layer C) so
 *    overlaps resolve over several ticks instead of teleporting.
 *  - running into a FALLEN horse => trip (stumble or fall)  [A, B at reduced odds]
 *  - hard contact between upright horses => stumble; stumble + another hit => fall  [A]
 *  - accident rolls happen once per contact EVENT (per-horse cooldown), not every tick,
 *    and trip odds decay with the chain generation of the fallen horse => local chains.
 */
export function resolveCollisions(sim: HorseSimulation): void {
  const hash = sim.hash;
  hash.build(sim.active, sim.activeCount, sim.x, sim.progress);

  const { x, progress, y, speed, vx, state, layer, stateTime, corrUsed, layerAge } = sim;
  for (let k = 0; k < sim.activeCount; k++) corrUsed[sim.active[k]] = 0;
  const reach = HORSE.FALLEN_HALF_LENGTH * 2;
  const reachX = HORSE.FALLEN_HALF_WIDTH * 2;
  const budget = (h: number) =>
    h !== FIELD.PLAYER && layerAge[h] < COLLISION.FRESH_TICKS ? COLLISION.MAX_CORRECTION_FRESH : COLLISION.MAX_CORRECTION;

  for (let k = 0; k < sim.activeCount; k++) {
    const i = sim.active[k];
    // gather neighbours with id > i (each pair handled once, deterministic order)
    let nn = 0;
    const found = hash.query(x[i] - reachX, progress[i] - reach, x[i] + reachX, progress[i] + reach);
    const res = hash.result;
    for (let r = 0; r < found; r++) {
      const j = res[r];
      if (j <= i) continue;
      if (nn >= neighborBuf.length) {
        const grown = new Int32Array(neighborBuf.length * 2);
        grown.set(neighborBuf);
        neighborBuf = grown;
      }
      neighborBuf[nn++] = j;
    }
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

      // a downed horse resting on top of another (pile) is supported, not pushed apart
      if (downI && downJ && Math.abs(y[i] - y[j]) > 0.3) continue;

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

      // positional separation (lateral fully, longitudinal partially: speeds handle the rest),
      // limited by each horse's remaining correction budget for this tick
      const sepX = nx * pen * rx;
      const sepP = np * pen * rp * 0.5;
      const mag = Math.abs(sepX) + Math.abs(sepP);
      if (mag > 0) {
        const needI = mag * wI;
        const needJ = mag * wJ;
        const sI = needI > 0 ? Math.min(1, Math.max(0, budget(i) - corrUsed[i]) / needI) : 0;
        const sJ = needJ > 0 ? Math.min(1, Math.max(0, budget(j) - corrUsed[j]) / needJ) : 0;
        x[i] -= sepX * wI * sI;
        progress[i] -= sepP * wI * sI;
        x[j] += sepX * wJ * sJ;
        progress[j] += sepP * wJ * sJ;
        corrUsed[i] += needI * sI;
        corrUsed[j] += needJ * sJ;
        if (corrUsed[i] > sim.maxCorrectionThisTick) sim.maxCorrectionThisTick = corrUsed[i];
        if (corrUsed[j] > sim.maxCorrectionThisTick) sim.maxCorrectionThisTick = corrUsed[j];
      }

      // speed exchange: the rear horse is checked
      const rear = dp > 0 ? i : j;
      const front = rear === i ? j : i;
      const closing = Math.max(0, speed[rear] - speed[front]) * Math.abs(np);
      const latImpact = Math.abs(vx[i] - vx[j]) * Math.abs(nx);
      const impact = closing + latImpact;
      if (closing > 0) {
        // brushing past a downed horse (no trip) mostly deflects sideways instead of stopping;
        // the player shoulders through NPCs (they are shoved aside) rather than stopping dead
        // (dashing too — the price of ramming the crowd is the higher accident risk)
        const playerRear = rear === FIELD.PLAYER && state[front] !== HorseState.FALL;
        speed[rear] -= closing * (downI !== downJ ? 0.2 : playerRear ? PLAYER.SHOULDER_LOSS : 0.6);
        if (playerRear) vx[front] += (x[front] >= x[rear] ? 1 : -1) * PLAYER.SHOULDER_SHOVE;
        if (state[front] !== HorseState.FALL) speed[front] += closing * 0.15;
      }
      // lateral velocity: share momentum along the normal
      const avgVx = (vx[i] + vx[j]) * 0.5;
      vx[i] += (avgVx - vx[i]) * Math.abs(nx) * 0.5;
      vx[j] += (avgVx - vx[j]) * Math.abs(nx) * 0.5;

      // fresh tumble shoves neighbours (comedic knock-on)
      if (downI && stateTime[i] < 0.35) vx[j] += Math.sign(dx || 1) * COLLISION.FALL_IMPULSE * 0.5;
      if (downJ && stateTime[j] < 0.35) vx[i] -= Math.sign(dx || 1) * COLLISION.FALL_IMPULSE * 0.5;

      // --- outcomes (once per contact event) ------------------------------------
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

/** player accident multiplier: near-neutral, but dashing is risky (Phase 1 review M4) */
function playerMult(sim: HorseSimulation, i: number): number {
  return i === FIELD.PLAYER ? PLAYER.STUMBLE_MULT * (sim.dashing ? PLAYER.DASH_RISK : 1) : 1;
}

/** Runner hits a fallen horse at ground level. */
function trip(sim: HorseSimulation, runner: number, fallen: number, impact: number): void {
  if (!sim.canBeKnocked(runner)) return;
  // coming down onto a downed horse after a jump = failed landing (design §4)
  if (sim.y[runner] > 0.05 && sim.vy[runner] < 0) {
    if (sim.eventCooldown[runner] > 0) return;
    sim.eventCooldown[runner] = COLLISION.EVENT_COOLDOWN;
    const pl =
      (runner === FIELD.PLAYER ? COLLISION.LANDING_FAIL * (sim.dashing ? PLAYER.DASH_LANDING_RISK : 1) : COLLISION.LANDING_FAIL_NPC) *
      Math.pow(sim.tuning.chainDecay, sim.chainGen[fallen]);
    if (sim.rng.next() < pl) {
      sim.fall(runner, Math.sign(sim.x[runner] - sim.x[fallen]) || 1, sim.chainGen[fallen] + 1);
      sim.tripFalls++;
    }
    return;
  }
  if (sim.eventCooldown[runner] > 0) return;
  if (sim.y[runner] > 0.4) return; // rising past the edge of a pile is a graze, not a trip
  sim.eventCooldown[runner] = COLLISION.EVENT_COOLDOWN;
  const gen = sim.chainGen[fallen] + 1;
  let p = (COLLISION.TRIP_BASE + COLLISION.TRIP_PER_IMPACT * impact) * playerMult(sim, runner);
  p *= sim.accidentScale() * Math.pow(sim.tuning.chainDecay, gen - 1);
  if (sim.layer[runner] === Layer.B) p *= COLLISION.TRIP_MULT_B;
  if (p > 0.95) p = 0.95;
  const r = sim.rng.next();
  if (r < p) {
    sim.fall(runner, Math.sign(sim.x[runner] - sim.x[fallen]) || 1, gen);
    sim.tripFalls++;
  }
  else if (r < p + 0.3) sim.stumble(runner);
}

/** Contact between two upright horses. */
function upright(sim: HorseSimulation, i: number, j: number, rear: number, impact: number, detailed: boolean): void {
  if (!detailed) return; // layer B: separation only
  if (impact < COLLISION.STUMBLE_MIN_IMPACT) return;
  const crowd = sim.densityAt(sim.x[i], sim.progress[i]);
  let p =
    COLLISION.STUMBLE_BASE + COLLISION.STUMBLE_PER_IMPACT * impact + COLLISION.STUMBLE_PER_NEIGHBOR * Math.max(0, crowd - 15);
  if (p > COLLISION.STUMBLE_MAX) p = COLLISION.STUMBLE_MAX;
  p *= sim.accidentScale();
  // the rear (hitting) horse is most at risk; a sideswipe can unsettle either
  const other = rear === i ? j : i;
  for (let v = 0; v < 2; v++) {
    const h = v === 0 ? rear : other;
    if (sim.eventCooldown[h] > 0 || !sim.canBeKnocked(h)) continue;
    // the player shrugs off brushing a neighbour (it is riding through a crowd on purpose);
    // running into a horse properly still unsettles it
    if (h === FIELD.PLAYER && impact < PLAYER.SOFT_BUMP) continue;
    sim.eventCooldown[h] = COLLISION.EVENT_COOLDOWN;
    const pv = (v === 0 ? p : p * 0.4) * playerMult(sim, h);
    if (sim.state[h] === HorseState.STUMBLE) {
      // (a NEW fall never starts inside the player's reaction window: design §4 fairness)
      if (impact > 1 && sim.rng.next() < COLLISION.STUMBLE_TO_FALL * playerMult(sim, h) * sim.accidentScale()) {
        if (h === FIELD.PLAYER || !sim.inPlayerSafeBox(h)) sim.fall(h, 0, 0);
      }
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
