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

/**
 * Per-race statistics on top of OvertakeTracker:
 *  - streak: distinct NPCs passed since the player's last fall; maxStreak is the
 *    "最大連続追い抜き" shown on the result.
 *  - bursts: passes are collected for up to BURST_WINDOW s (or until a BURST_GAP pause);
 *    each completed burst drives one "+582 頭抜き！" callout. All numbers come from the
 *    real tracker.
 */
export class RaceStats {
  static readonly BURST_GAP = 1.2;
  static readonly BURST_WINDOW = 2.0;
  readonly overtakes: OvertakeTracker;
  streak = 0;
  maxStreak = 0;
  /** passes in the burst currently being collected */
  burst = 0;
  /** size of the last completed burst, and a counter that increments when one completes */
  lastBurst = 0;
  burstSeq = 0;
  private burstStart = 0;
  private lastPassAt = -Infinity;
  private lastFalls = 0;

  constructor(n: number, player = 0) {
    this.overtakes = new OvertakeTracker(n, player);
  }

  reset(): void {
    this.overtakes.reset();
    this.streak = this.maxStreak = this.burst = this.lastBurst = this.burstSeq = 0;
    this.lastPassAt = -Infinity;
    this.lastFalls = 0;
  }

  get total(): number {
    return this.overtakes.total;
  }

  /** call at the rank cadence with the sim time and the player's fall count */
  update(view: RaceView, time: number, playerFalls: number): number {
    if (playerFalls > this.lastFalls) {
      this.lastFalls = playerFalls;
      this.streak = 0;
      this.closeBurst();
    }
    const d = this.overtakes.update(view);
    if (this.burst > 0 && (time - this.lastPassAt > RaceStats.BURST_GAP || time - this.burstStart > RaceStats.BURST_WINDOW)) {
      this.closeBurst();
    }
    if (d > 0) {
      this.streak += d;
      if (this.streak > this.maxStreak) this.maxStreak = this.streak;
      if (this.burst === 0) this.burstStart = time;
      this.burst += d;
      this.lastPassAt = time;
    }
    return d;
  }

  private closeBurst(): void {
    if (this.burst > 0) {
      this.lastBurst = this.burst;
      this.burstSeq++;
    }
    this.burst = 0;
  }
}

/** Everything the result screen (and the Phase 3 share card) needs. */
export interface RaceResult {
  seed: number;
  rank: number;
  field: number;
  /** race time in seconds at the finish line, or null if the time limit ran out */
  time: number | null;
  timedOut: boolean;
  overtakes: number;
  falls: number;
  maxStreak: number;
  win: boolean;
  /** 1st place AND zero falls (design §2) */
  perfect: boolean;
  /** ISO date */
  date: string;
}

export function makeResult(args: Omit<RaceResult, 'win' | 'perfect' | 'date'> & { date?: string }): RaceResult {
  const win = !args.timedOut && args.rank === 1;
  return { ...args, win, perfect: win && args.falls === 0, date: args.date ?? new Date().toISOString() };
}

/** "01:12.34" */
export function formatTime(sec: number | null): string {
  if (sec === null || !isFinite(sec)) return '--:--.--';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

/** "1,248" */
export function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
