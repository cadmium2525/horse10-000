import { describe, expect, it } from 'vitest';
import { DIFFICULTY_SEEDS, mean, median, report, runRace, type RaceRun } from './helpers/race';

/**
 * Difficulty fixed against bot proxies (Phase 1 review M1/M3/M4). Part 1: the very good
 * player and what jumping is worth. Seeds and bots are deterministic, so these are exact
 * regression checks of the balance, not flaky statistics.
 */
describe('difficulty: optimal play', () => {
  let optimal: RaceRun[] = [];
  let noJump: RaceRun[] = [];

  it('optimal bot can win, but not routinely (PERFECT stays rare)', () => {
    optimal = DIFFICULTY_SEEDS.map((s) => runRace(s, {}));
    report('optimal', optimal);
    const ranks = optimal.map((r) => r.rank);
    expect(Math.min(...ranks)).toBe(1); // winning is possible
    expect(median(ranks)).toBeLessThanOrEqual(250); // consistently at the sharp end
    expect(optimal.filter((r) => r.perfect).length).toBeLessThanOrEqual(2); // PERFECT stays rare
  }, 600000);

  it('jumping matters: no-jump play ends clearly lower; ≥ 5 jump chances in (almost) every race', () => {
    noJump = DIFFICULTY_SEEDS.map((s) => runRace(s, { jump: false }));
    report('no-jump', noJump);
    expect(mean(noJump.map((r) => r.rank))).toBeGreaterThanOrEqual(mean(optimal.map((r) => r.rank)) + 150);
    expect(noJump.filter((r) => r.rank === 1).length).toBeLessThanOrEqual(optimal.filter((r) => r.rank === 1).length);
    expect(optimal.filter((r) => r.jumpChances >= 5).length).toBeGreaterThanOrEqual(4);
    for (const r of optimal) expect(r.jumpsCleared).toBeGreaterThanOrEqual(1);
  }, 600000);

  it('accidents are visible all race long (M3)', () => {
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
