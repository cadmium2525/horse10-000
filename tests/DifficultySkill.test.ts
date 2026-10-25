import { describe, expect, it } from 'vitest';
import { DIFFICULTY_SEEDS, OPTIMAL, mean, median, report, runRace, wins, type RaceRun } from './helpers/race';

/**
 * Difficulty fixed against bot proxies (Phase 1b review M1/M2/M4 + the Phase 1 M3/M4 checks).
 * Part 1: the optimal bot and what jumping is worth. Seeds and bots are deterministic, so
 * these are exact regression checks of the balance, not flaky statistics.
 */
describe('difficulty: optimal play', () => {
  let optimal: RaceRun[] = [];
  let noJump: RaceRun[] = [];

  it('optimal bot wins most races (≥ 50 %), PERFECT stays rare (≤ 40 %)', () => {
    optimal = DIFFICULTY_SEEDS.map((s) => runRace(s, OPTIMAL));
    report('optimal', optimal);
    const n = optimal.length;
    expect(wins(optimal)).toBeGreaterThanOrEqual(Math.ceil(n * 0.5));
    expect(optimal.filter((r) => r.perfect).length).toBeLessThanOrEqual(Math.floor(n * 0.4));
    expect(median(optimal.map((r) => r.rank))).toBeLessThanOrEqual(20);
  }, 900000);

  it('M2: on the turns the optimal line is situational (40–80 % within 35 m of the rail)', () => {
    const share = mean(optimal.map((r) => r.insideShare));
    expect(share).toBeGreaterThanOrEqual(0.4);
    expect(share).toBeLessThanOrEqual(0.8);
    // the field packs the inside rail on the turn: inner 20 m at 1.4–1.6× the mean density
    const dens = mean(optimal.map((r) => r.innerDensity));
    expect(dens).toBeGreaterThanOrEqual(1.4);
    expect(dens).toBeLessThanOrEqual(1.6);
  });

  it('M4 race feel: the optimal bot has passed ≥ 2,000 horses 30 s after the start', () => {
    for (const r of optimal) expect(r.rank30).toBeLessThanOrEqual(8000);
  });

  it('jumping matters: no-jump play is slower on average and wins no more; ≥ 5 jump chances per race', () => {
    noJump = DIFFICULTY_SEEDS.map((s) => runRace(s, { ...OPTIMAL, jump: false }));
    report('no-jump', noJump);
    expect(mean(noJump.map((r) => r.gap))).toBeGreaterThanOrEqual(mean(optimal.map((r) => r.gap)) + 1);
    expect(mean(noJump.map((r) => r.rank))).toBeGreaterThan(mean(optimal.map((r) => r.rank)));
    expect(wins(noJump)).toBeLessThanOrEqual(wins(optimal));
    const n = optimal.length;
    expect(optimal.filter((r) => r.jumpChances >= 5).length).toBeGreaterThanOrEqual(Math.ceil(n * 0.8));
    expect(optimal.filter((r) => r.jumpsCleared >= 1).length).toBeGreaterThanOrEqual(Math.ceil(n * 0.7));
  }, 900000);

  it('accidents are visible all race long (Phase 1 review M3)', () => {
    for (const r of optimal) {
      expect(r.firstBig).toBeGreaterThanOrEqual(0);
      expect(r.firstBig).toBeLessThanOrEqual(15);
      expect(r.bigFalls).toBeGreaterThanOrEqual(4);
      // after 40 s: on average ≥ 5 new falls in view per 10 s, and never a dead window
      const late = r.visible.slice(4, -1);
      expect(mean(late)).toBeGreaterThanOrEqual(5);
      expect(Math.min(...late)).toBeGreaterThanOrEqual(1);
    }
  });
});
