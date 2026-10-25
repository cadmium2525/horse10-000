import { describe, expect, it } from 'vitest';
import { computeRank, isAhead, OvertakeTracker } from '../src/game/Race';

describe('computeRank', () => {
  it('is 1 + number of NPCs with larger progress', () => {
    const progress = new Float64Array([5, 10, 3, 7, 5.5]);
    expect(computeRank({ progress }, 0)).toBe(4); // 10, 7, 5.5 ahead
    expect(computeRank({ progress }, 1)).toBe(1);
    expect(computeRank({ progress }, 2)).toBe(5);
  });

  it('starts at 10,000 / 10,000 when the player is last', () => {
    const progress = new Float64Array(10000);
    for (let i = 1; i < 10000; i++) progress[i] = i * 0.01;
    progress[0] = -1;
    expect(computeRank({ progress }, 0)).toBe(10000);
  });

  it('breaks exact ties by lower id', () => {
    const progress = new Float64Array([4, 4, 4, 1]);
    expect(computeRank({ progress }, 0)).toBe(1);
    expect(computeRank({ progress }, 1)).toBe(2);
    expect(computeRank({ progress }, 2)).toBe(3);
    expect(computeRank({ progress }, 3)).toBe(4);
  });

  it('ranks are a permutation (no duplicates) even with ties', () => {
    const progress = new Float64Array([2, 2, 1, 2, 3, 1, 0]);
    const ranks = Array.from(progress, (_, i) => computeRank({ progress }, i)).sort((a, b) => a - b);
    expect(ranks).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('finished horses are ordered by finish time and ahead of unfinished ones', () => {
    const progress = new Float64Array([1600, 1605, 1599, 1700]);
    const finishTime = new Float32Array([80.5, 80.2, -1, 81]);
    const view = { progress, finishTime };
    expect(computeRank(view, 1)).toBe(1);
    expect(computeRank(view, 0)).toBe(2);
    expect(computeRank(view, 3)).toBe(3); // ran further after finishing, but finished later
    expect(computeRank(view, 2)).toBe(4);
    expect(isAhead(view, 0, 2)).toBe(true);
  });

  it('respects n to limit the scanned range', () => {
    const progress = new Float64Array([1, 2, 3, 4]);
    expect(computeRank({ progress, n: 2 }, 0)).toBe(2);
  });
});

describe('OvertakeTracker', () => {
  it('counts distinct NPCs passed, never double counts re-passes', () => {
    const progress = new Float64Array([0, 1, 2, 3]);
    const t = new OvertakeTracker(4, 0);
    expect(t.update({ progress })).toBe(0);
    progress[0] = 1.5; // pass #1
    expect(t.update({ progress })).toBe(1);
    progress[1] = 5; // #1 re-passes the player
    t.update({ progress });
    progress[0] = 6; // player passes #1 again, and #2, #3
    expect(t.update({ progress })).toBe(2);
    expect(t.total).toBe(3);
    progress[0] = -10; // fall back behind everyone
    t.update({ progress });
    progress[0] = 100;
    t.update({ progress });
    expect(t.total).toBe(3);
  });

  it('does not count NPCs that were never ahead', () => {
    const progress = new Float64Array([10, 1, 2]);
    const t = new OvertakeTracker(3, 0);
    t.update({ progress });
    progress[0] = 20;
    t.update({ progress });
    expect(t.total).toBe(0);
  });

  it('caps at N-1 for 10,000 horses', () => {
    const n = 10000;
    const progress = new Float64Array(n);
    for (let i = 1; i < n; i++) progress[i] = i;
    progress[0] = 0;
    const t = new OvertakeTracker(n, 0);
    t.update({ progress });
    for (let k = 0; k < 5; k++) {
      progress[0] = k % 2 === 0 ? 1e6 : -1;
      t.update({ progress });
    }
    expect(t.total).toBe(9999);
  });

  it('agrees with rank changes on a monotonic pass', () => {
    const n = 500;
    const progress = new Float64Array(n);
    for (let i = 1; i < n; i++) progress[i] = i;
    progress[0] = 0.5;
    const t = new OvertakeTracker(n, 0);
    t.update({ progress });
    const r0 = computeRank({ progress }, 0);
    progress[0] = 250.5;
    t.update({ progress });
    const r1 = computeRank({ progress }, 0);
    expect(t.total).toBe(r0 - r1);
  });
});

import { RaceStats, formatInt, formatTime, makeResult } from '../src/game/Race';

describe('RaceStats', () => {
  it('tracks streaks between falls and bursts of passes', () => {
    const progress = new Float64Array([0, 1, 2, 3, 4, 5]);
    const s = new RaceStats(6, 0);
    s.update({ progress }, 0, 0);
    progress[0] = 2.5; // passes #1, #2
    expect(s.update({ progress }, 0.1, 0)).toBe(2);
    expect(s.streak).toBe(2);
    expect(s.burst).toBe(2);
    // player falls: streak resets (max kept) and the burst is closed
    progress[0] = 3.5; // passes #3
    s.update({ progress }, 0.2, 1);
    expect(s.streak).toBe(1);
    expect(s.maxStreak).toBe(2);
    expect(s.lastBurst).toBe(2);
    expect(s.burstSeq).toBe(1);
    // a long pause closes the running burst (size 1) before the next passes count
    progress[0] = 10;
    s.update({ progress }, 5, 1);
    expect(s.burstSeq).toBe(2);
    expect(s.lastBurst).toBe(1);
    expect(s.burst).toBe(2);
    expect(s.maxStreak).toBe(3);
    expect(s.total).toBe(5);
  });

  it('closes bursts after the window even if passes continue', () => {
    const n = 200;
    const progress = new Float64Array(n);
    for (let i = 1; i < n; i++) progress[i] = i;
    const s = new RaceStats(n, 0);
    s.update({ progress }, 0, 0);
    let t = 0;
    for (let k = 1; k <= 60; k++) {
      t = k * 0.1;
      progress[0] = k * 3 + 0.5;
      s.update({ progress }, t, 0);
    }
    expect(s.burstSeq).toBeGreaterThanOrEqual(2);
    expect(s.lastBurst).toBeLessThanOrEqual(3 * 21);
  });
});

describe('results', () => {
  it('PERFECT only for 1st place with zero falls; WIN for 1st', () => {
    const base = { seed: 1, field: 10000, time: 72.5, timedOut: false, overtakes: 9999, maxStreak: 100 };
    expect(makeResult({ ...base, rank: 1, falls: 0 }).perfect).toBe(true);
    const fell = makeResult({ ...base, rank: 1, falls: 1 });
    expect(fell.win).toBe(true);
    expect(fell.perfect).toBe(false);
    expect(makeResult({ ...base, rank: 2, falls: 0 }).win).toBe(false);
    expect(makeResult({ ...base, rank: 1, falls: 0, timedOut: true, time: null }).win).toBe(false);
  });

  it('formats numbers and times', () => {
    expect(formatInt(1248)).toBe('1,248');
    expect(formatInt(10000)).toBe('10,000');
    expect(formatTime(72.34)).toBe('01:12.34');
    expect(formatTime(5.5)).toBe('00:05.50');
    expect(formatTime(null)).toBe('--:--.--');
  });
});

import { isBetter } from '../src/data/Storage';

describe('personal best ordering', () => {
  it('lower rank wins, then faster time; timeouts never beat a finished time', () => {
    expect(isBetter({ rank: 5, time: 80 }, null)).toBe(true);
    expect(isBetter({ rank: 4, time: 90 }, { rank: 5, time: 80 })).toBe(true);
    expect(isBetter({ rank: 5, time: 79 }, { rank: 5, time: 80 })).toBe(true);
    expect(isBetter({ rank: 5, time: 81 }, { rank: 5, time: 80 })).toBe(false);
    expect(isBetter({ rank: 5, time: null }, { rank: 5, time: 80 })).toBe(false);
  });
});
