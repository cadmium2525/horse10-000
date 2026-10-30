import { describe, expect, it } from 'vitest';
import { DIFFICULTY_SEEDS, HUMAN_150, HUMAN_250, mean, median, report, runRace, wins, type RaceRun } from './helpers/race';

/**
 * Difficulty part 2: human proxies (reaction delay + steering noise; Phase 1b review M1).
 * A quick player can win sometimes, a 250 ms player stays in sight of the winner without
 * winning, button mashing and doing nothing end clearly lower.
 */
describe('difficulty: human proxies', () => {
  let h250: RaceRun[] = [];

  it('150 ms proxy: wins at least once in 10, median rank ≤ 60', () => {
    const runs = DIFFICULTY_SEEDS.map((s) => runRace(s, HUMAN_150));
    report('human-150ms', runs);
    expect(wins(runs)).toBeGreaterThanOrEqual(1);
    expect(median(runs.map((r) => r.rank))).toBeLessThanOrEqual(60);
  }, 900000);

  // P2-1: a typical quick player lands in the top 30–150, wins about one race in ten
  it('250 ms proxy: wins at most 1 in 5, median ≤ 6.5 s behind the winner, median rank 30–150', () => {
    h250 = DIFFICULTY_SEEDS.map((s) => runRace(s, HUMAN_250));
    report('human-250ms', h250);
    expect(wins(h250)).toBeLessThanOrEqual(Math.floor(h250.length * 0.2));
    expect(median(h250.map((r) => r.gap))).toBeLessThanOrEqual(6.5);
    const m = median(h250.map((r) => r.rank));
    expect(m).toBeGreaterThanOrEqual(30);
    expect(m).toBeLessThanOrEqual(150);
    // M4 race feel: ≥ 1,000 horses passed 30 s after the start
    for (const r of h250) expect(r.rank30).toBeLessThanOrEqual(9000);
  }, 900000);

  it('P2-1 dash masher (button held: no fresh presses) never wins and lands around 200–800th', () => {
    const runs = DIFFICULTY_SEEDS.map((s) => runRace(s, { ...HUMAN_250, dash: 'hold' }));
    report('masher', runs);
    expect(wins(runs)).toBe(0);
    const m = median(runs.map((r) => r.rank));
    expect(m).toBeGreaterThanOrEqual(200);
    expect(m).toBeLessThanOrEqual(800);
    expect(mean(runs.map((r) => r.rank))).toBeGreaterThanOrEqual(2 * mean(h250.map((r) => r.rank)));
  }, 900000);
});
