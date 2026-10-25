import { describe, expect, it } from 'vitest';
import { Course } from '../src/data/Course';
import { HorseSimulation } from '../src/game/HorseSimulation';
import { FIELD } from '../src/game/Config';

/**
 * Reachability (design §2/§9): winning must be possible but not trivial.
 *  - the leading NPC finishes in 60–90 s
 *  - a solo "ideal" run (empty track, inside rail, dash whenever available) beats the
 *    leader by at least 3 s, i.e. winning is physically possible. In a real race the
 *    traffic costs even the optimal bot 20–30 s, so how hard winning actually is is fixed by
 *    the bot-proxy tests (DifficultySkill / DifficultyHuman), not by this margin.
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
  // ideal line: hug the inside rail (shortest way round the turn), re-press dash whenever
  // the gauge allows (dash needs a fresh press after running dry)
  const inside = -(sim.course.width / 2 - 2);
  let held = false;
  for (let t = 0; t < 30 * 140; t++) {
    const steer = Math.max(-1, Math.min(1, (inside - sim.x[0]) * 0.5));
    // keep holding while dashing; otherwise release for a tick, then press again when ready
    const dash: boolean = sim.dashing ? true : !held && sim.dashGauge >= 0.3;
    held = dash;
    sim.step({ steer, jump: false, dash });
    if (sim.finishTime[0] >= 0) return sim.finishTime[0];
  }
  return Infinity;
}

describe('balance / reachability', () => {
  for (const seed of [1234, 42]) {
    it(`seed ${seed}: leader 60–90 s, ideal solo run ≥ 3 s faster`, () => {
      const full = new HorseSimulation(new Course(seed), seed);
      const start = full.progress[FIELD.PLAYER];
      const { leader } = leaderFinish(seed);
      const ideal = idealPlayerFinish(seed, start);
      (globalThis as { process?: { stderr: { write(s: string): void } } }).process?.stderr.write(
        `seed ${seed}: leader ${leader.toFixed(2)} s, ideal player ${ideal.toFixed(2)} s, margin ${(leader - ideal).toFixed(2)} s\n`,
      );
      expect(leader).toBeGreaterThanOrEqual(60);
      expect(leader).toBeLessThanOrEqual(90);
      expect(leader - ideal).toBeGreaterThanOrEqual(3);
      // (upper bound only guards against a broken course/speed setup: an empty-track run
      // is far faster than anything possible through 9,999 horses)
      expect(leader - ideal).toBeLessThanOrEqual(30);
    }, 60000);
  }
});

describe('skill matters', () => {
  it('a passive player (no steering, no jumps, no dash) ends far from the top', () => {
    const seed = 1234;
    const sim = new HorseSimulation(new Course(seed), seed);
    for (let t = 0; t < 30 * 125 && sim.finishTime[FIELD.PLAYER] < 0; t++) sim.step();
    let ahead = 0;
    for (let i = 1; i < sim.n; i++) if (sim.finishTime[i] >= 0 && (sim.finishTime[FIELD.PLAYER] < 0 || sim.finishTime[i] < sim.finishTime[FIELD.PLAYER])) ahead++;
    expect(ahead + 1).toBeGreaterThan(1000);
  }, 120000);
});
