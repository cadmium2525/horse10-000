import { describe, expect, it } from 'vitest';
import { DIFFICULTY_SEEDS, HUMAN_250, HUMAN_250_MASH, IDLE_MASH, median, report, runRace, wins } from './helpers/race';

/**
 * Phase 2 review M1: pressing jump over and over must not be the best strategy (leapfrogging
 * the field turned the game into "hold the jump button"). A jump costs dash gauge, standing
 * horses cannot be cleared (landing on one is a tumble) and a flat landing locks the horse
 * out of accelerating for a moment — jumping only pays over accidents (see DifficultySkill).
 */
describe('difficulty: jump spamming does not pay (M1)', () => {
  it('a 250 ms proxy that also presses jump all the time ends worse than the same proxy without it, and never wins more than once', () => {
    const base = DIFFICULTY_SEEDS.map((s) => runRace(s, HUMAN_250));
    const mash = DIFFICULTY_SEEDS.map((s) => runRace(s, HUMAN_250_MASH));
    report('human-250ms', base);
    report('human-250ms+mash', mash);
    expect(median(mash.map((r) => r.rank))).toBeGreaterThan(median(base.map((r) => r.rank)));
    expect(wins(mash)).toBeLessThanOrEqual(1);
  }, 900000);

  it('a player who does nothing but jump ends far behind (median below 800th)', () => {
    const runs = DIFFICULTY_SEEDS.map((s) => runRace(s, IDLE_MASH));
    report('idle+mash', runs);
    expect(median(runs.map((r) => r.rank))).toBeGreaterThan(800);
    expect(wins(runs)).toBe(0);
  }, 900000);
});
