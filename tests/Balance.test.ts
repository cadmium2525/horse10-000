import { describe, expect, it } from 'vitest';
import { Course } from '../src/data/Course';
import { HorseSimulation } from '../src/game/HorseSimulation';
import { FIELD } from '../src/game/Config';

/**
 * Reachability (design §2/§9): winning must be possible but not trivial.
 *  - the leading NPC finishes in 60–90 s
 *  - an ideal player run (no contacts, dash whenever available) beats the leader by ≥ 8 s
 */
function leaderFinish(seed: number): { leader: number; playerStart: number } {
  const sim = new HorseSimulation(new Course(seed), seed);
  let leader = -1;
  for (let t = 0; t < 30 * 120 && leader < 0; t++) {
    sim.step();
    for (let i = 1; i < sim.n; i++) {
      if (sim.finishTime[i] >= 0 && (leader < 0 || sim.finishTime[i] < leader)) leader = sim.finishTime[i];
    }
  }
  return { leader, playerStart: sim.prevProgress[FIELD.PLAYER] - 0 };
}

function idealPlayerFinish(seed: number, startProgress: number): number {
  const sim = new HorseSimulation(new Course(seed), seed, 1);
  sim.progress[0] = startProgress;
  sim.prevProgress[0] = startProgress;
  for (let t = 0; t < 30 * 120; t++) {
    sim.step({ steer: 0, jump: false, dash: true });
    if (sim.finishTime[0] >= 0) return sim.finishTime[0];
  }
  return Infinity;
}

describe('balance / reachability', () => {
  for (const seed of [1234, 42]) {
    it(`seed ${seed}: leader 60–90 s, ideal player ≥ 8 s faster`, () => {
      const full = new HorseSimulation(new Course(seed), seed);
      const start = full.progress[FIELD.PLAYER];
      const { leader } = leaderFinish(seed);
      const ideal = idealPlayerFinish(seed, start);
      (globalThis as { process?: { stderr: { write(s: string): void } } }).process?.stderr.write(
        `seed ${seed}: leader ${leader.toFixed(2)} s, ideal player ${ideal.toFixed(2)} s, margin ${(leader - ideal).toFixed(2)} s\n`,
      );
      expect(leader).toBeGreaterThanOrEqual(60);
      expect(leader).toBeLessThanOrEqual(90);
      expect(leader - ideal).toBeGreaterThanOrEqual(8);
    }, 60000);
  }
});
