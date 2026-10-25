import { describe, expect, it } from 'vitest';
import { DIFFICULTY_SEEDS, median, report, runRace, type RaceRun } from './helpers/race';

/**
 * Difficulty part 2: human proxies (250 ms reaction delay + steering noise). A first-time
 * player should not win; mashing dash is worse than using it well.
 */
describe('difficulty: human proxies', () => {
  let human: RaceRun[] = [];
  it('250 ms reaction + noise: wins at most 1 of 5, typically hundreds of places back', () => {
    human = DIFFICULTY_SEEDS.map((s) => runRace(s, { reactionMs: 250, noise: 0.25 }));
    report('human-250ms', human);
    expect(human.filter((r) => r.rank === 1).length).toBeLessThanOrEqual(1);
    expect(median(human.map((r) => r.rank))).toBeGreaterThanOrEqual(400);
    expect(median(human.map((r) => r.rank))).toBeLessThanOrEqual(3000);
  }, 600000);

  it('dash masher (button held) never wins and does worse than using dash well', () => {
    const runs = DIFFICULTY_SEEDS.map((s) => runRace(s, { reactionMs: 250, noise: 0.25, dash: 'hold' }));
    report('masher', runs);
    expect(runs.filter((r) => r.rank === 1).length).toBe(0);
    expect(median(runs.map((r) => r.rank))).toBeGreaterThanOrEqual(median(human.map((r) => r.rank)));
  }, 600000);
});
