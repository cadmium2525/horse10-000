/**
 * Race standings — pure functions over the simulation arrays (no Three.js / DOM).
 *
 * Ordering rule (design §2):
 *   1. A finished horse is ahead of any unfinished horse.
 *   2. Two finished horses: earlier finish time is ahead.
 *   3. Two unfinished horses: larger progress is ahead.
 *   4. Exact ties: the lower (stable) horse id is ahead.
 *
 * Before anyone finishes this reduces to
 *   rank = 1 + count(npc.progress > player.progress)   (+ id tie-break)
 */

export interface RaceView {
  readonly progress: ArrayLike<number>;
  /** race seconds at finish, < 0 when not finished. Optional (pre-finish logic). */
  readonly finishTime?: ArrayLike<number>;
  /** horse count (defaults to progress.length) */
  readonly n?: number;
}

/** true if horse `a` is strictly ahead of horse `b` (ids are indices). */
export function isAhead(view: RaceView, a: number, b: number): boolean {
  const ft = view.finishTime;
  if (ft) {
    const fa = ft[a];
    const fb = ft[b];
    const finA = fa >= 0;
    const finB = fb >= 0;
    if (finA !== finB) return finA;
    if (finA && finB) {
      if (fa !== fb) return fa < fb;
      return a < b;
    }
  }
  const pa = view.progress[a];
  const pb = view.progress[b];
  if (pa !== pb) return pa > pb;
  return a < b;
}

/** 1-based rank of `who` among all horses. O(N), no sorting, no allocation. */
export function computeRank(view: RaceView, who: number): number {
  const n = view.n ?? view.progress.length;
  const progress = view.progress;
  const ft = view.finishTime;
  let ahead = 0;
  if (!ft) {
    const pw = progress[who];
    for (let i = 0; i < n; i++) {
      if (i === who) continue;
      const p = progress[i];
      if (p > pw || (p === pw && i < who)) ahead++;
    }
    return ahead + 1;
  }
  for (let i = 0; i < n; i++) {
    if (i !== who && isAhead(view, i, who)) ahead++;
  }
  return ahead + 1;
}

/**
 * Overtake counter: number of DISTINCT NPCs the player has passed at least once.
 * An NPC counts the first time it is observed behind the player after having been
 * observed ahead. Re-passing the same NPC never counts twice, so the total is at most
 * N-1 (9,999) and is independent of rank swings.
 */
export class OvertakeTracker {
  static readonly SEEN_AHEAD = 1;
  static readonly COUNTED = 2;

  readonly flags: Uint8Array;
  readonly player: number;
  total = 0;
  /** passes registered by the latest update() call */
  lastDelta = 0;

  constructor(n: number, player = 0) {
    this.flags = new Uint8Array(n);
    this.player = player;
  }

  reset(): void {
    this.flags.fill(0);
    this.total = 0;
    this.lastDelta = 0;
  }

  /** Scan all horses once (O(N)). Returns the number of new distinct overtakes. */
  update(view: RaceView): number {
    const n = view.n ?? view.progress.length;
    const flags = this.flags;
    const p = this.player;
    let delta = 0;
    for (let i = 0; i < n; i++) {
      if (i === p) continue;
      const f = flags[i];
      if (f & OvertakeTracker.COUNTED) continue;
      if (isAhead(view, i, p)) {
        flags[i] = f | OvertakeTracker.SEEN_AHEAD;
      } else if (f & OvertakeTracker.SEEN_AHEAD) {
        flags[i] = f | OvertakeTracker.COUNTED;
        delta++;
      }
    }
    this.total += delta;
    this.lastDelta = delta;
    return delta;
  }
}
