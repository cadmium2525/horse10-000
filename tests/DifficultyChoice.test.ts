import { describe, expect, it } from 'vitest';
import { CORE_SEEDS, DIFFICULTY_SEEDS, HUMAN_250, mean, median, report, runRace, type RaceRun } from './helpers/race';

/**
 * Difficulty part 3 (Phase 1b review M2/M3/M4): decisions that should matter for a human
 * proxy — using dash, which line to take on the turn — and doing nothing at all.
 */
describe('difficulty: dash, line choice, no input', () => {
  let smart: RaceRun[] = [];

  it('dash is worth using: a 250 ms proxy that never dashes ends clearly lower', () => {
    smart = DIFFICULTY_SEEDS.map((s) => runRace(s, HUMAN_250));
    const never = DIFFICULTY_SEEDS.map((s) => runRace(s, { ...HUMAN_250, dash: 'never' }));
    report('human-250ms', smart);
    report('never-dash', never);
    // finish ≥ 2.5 s later on average, median rank ≥ 2× worse
    expect(mean(never.map((r) => r.time))).toBeGreaterThanOrEqual(mean(smart.map((r) => r.time)) + 2.5);
    expect(median(never.map((r) => r.rank))).toBeGreaterThanOrEqual(2 * median(smart.map((r) => r.rank)));
    expect(mean(never.map((r) => r.rank))).toBeGreaterThan(mean(smart.map((r) => r.rank)));
  }, 900000);

  it('the turn has no single right line: rail-first and ignoring the rail end within 2 s of each other', () => {
    const outside = DIFFICULTY_SEEDS.map((s) => runRace(s, { ...HUMAN_250, insideLine: false }));
    report('outside-line', outside);
    for (const r of outside) expect(r.insideShare).toBeLessThan(0.3);
    const dGap = mean(smart.map((r) => r.gap)) - mean(outside.map((r) => r.gap));
    expect(Math.abs(dGap)).toBeLessThanOrEqual(2);
    // (in finish time both lines are within ±20 % by a wide margin)
    const tIn = mean(smart.map((r) => r.time));
    const tOut = mean(outside.map((r) => r.time));
    expect(Math.abs(tIn - tOut) / tOut).toBeLessThanOrEqual(0.2);
  }, 900000);

  it('M4: a player who never touches the controls still finishes inside the 150 s limit, far back', () => {
    const passive = CORE_SEEDS.map((s) => runRace(s, null));
    report('passive', passive);
    for (const r of passive) {
      expect(r.time).toBeGreaterThan(0);
      expect(r.time).toBeLessThanOrEqual(150);
      // natural gaps let a straight runner through now; it still ends well adrift
      expect(r.gap).toBeGreaterThanOrEqual(8);
    }
    expect(median(passive.map((r) => r.rank))).toBeGreaterThanOrEqual(200);
  }, 900000);
});
