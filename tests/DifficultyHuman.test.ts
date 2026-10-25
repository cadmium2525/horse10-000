import { describe, expect, it } from 'vitest';
import { DIFFICULTY_SEEDS, HUMAN_150, HUMAN_250, median, report, runRace, wins, type RaceRun } from './helpers/race';

/**
 * Difficulty part 2: human proxies (reaction delay + steering noise; Phase 1b review M1).
 * A quick player can win sometimes, a 250 ms player stays in sight of the winner without
 * winning, button mashing and doing nothing end clearly lower.
 */
describe('difficulty: human proxies', () => {
  let h250: RaceRun[] = [];

  it('150 ms proxy: wins at least 1 in 5, median rank ≤ 50', () => {
    const runs = DIFFICULTY_SEEDS.map((s) => runRace(s, HUMAN_150));
    report('human-150ms', runs);
    expect(wins(runs)).toBeGreaterThanOrEqual(Math.ceil(runs.length * 0.2));
    expect(median(runs.map((r) => r.rank))).toBeLessThanOrEqual(50);
  }, 900000);

  it('250 ms proxy: wins at most 1 in 5, median ≤ 5 s behind the winner, median rank 30–300', () => {
    h250 = DIFFICULTY_SEEDS.map((s) => runRace(s, HUMAN_250));
    report('human-250ms', h250);
    expect(wins(h250)).toBeLessThanOrEqual(Math.floor(h250.length * 0.2));
    expect(median(h250.map((r) => r.gap))).toBeLessThanOrEqual(5);
    const m = median(h250.map((r) => r.rank));
    expect(m).toBeGreaterThanOrEqual(30);
    expect(m).toBeLessThanOrEqual(300);
    // M4 race feel: ≥ 1,000 horses passed 30 s after the start
    for (const r of h250) expect(r.rank30).toBeLessThanOrEqual(9000);
  }, 900000);

  it('dash masher (button held: no fresh presses) wins no more and ends clearly lower than using dash well', () => {
    const runs = DIFFICULTY_SEEDS.map((s) => runRace(s, { ...HUMAN_250, dash: 'hold' }));
    report('masher', runs);
    expect(wins(runs)).toBeLessThanOrEqual(wins(h250));
    expect(median(runs.map((r) => r.rank))).toBeGreaterThanOrEqual(2 * median(h250.map((r) => r.rank)));
  }, 900000);
});
