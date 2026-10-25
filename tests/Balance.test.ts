import { describe, expect, it } from 'vitest';
import { Course } from '../src/data/Course';
import { HorseSimulation } from '../src/game/HorseSimulation';
import { FIELD } from '../src/game/Config';

/**
 * Reachability (design §2/§9): winning must be possible but not trivial.
 *  - the leading NPC finishes in 60–90 s
 *  - an ideal player run (no contacts, inside line, dash whenever available) beats the
 *    leader by 3–6 s: winning needs near-perfect play (Phase 1 playtest: too easy)
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
    it(`seed ${seed}: leader 60–90 s, ideal player 3–6 s faster`, () => {
      const full = new HorseSimulation(new Course(seed), seed);
      const start = full.progress[FIELD.PLAYER];
      const { leader } = leaderFinish(seed);
      const ideal = idealPlayerFinish(seed, start);
      (globalThis as { process?: { stderr: { write(s: string): void } } }).process?.stderr.write(
        `seed ${seed}: leader ${leader.toFixed(2)} s, ideal player ${ideal.toFixed(2)} s, margin ${(leader - ideal).toFixed(2)} s\n`,
      );
      expect(leader).toBeGreaterThanOrEqual(60);
      expect(leader).toBeLessThanOrEqual(90);
      // tight: perfect play beats the leader, but only by a few seconds (M1)
      expect(leader - ideal).toBeGreaterThanOrEqual(3);
      expect(leader - ideal).toBeLessThanOrEqual(6);
    }, 60000);
  }
});

describe('Phase 1 race feel (good-player bot)', () => {
  for (const seed of [1234, 9]) {
    it(`seed ${seed}: early big pile, big rank swing by 30 s, top-100 finish`, async () => {
      const { AutoBot } = await import('../src/game/PlayerController');
      const { computeRank } = await import('../src/game/Race');
      const { HorseState } = await import('../src/game/HorseSimulation');
      const sim = new HorseSimulation(new Course(seed), seed);
      const bot = new AutoBot();
      let firstPile = -1;
      let rank30 = 0;
      for (let t = 0; t < 30 * 130 && sim.finishTime[FIELD.PLAYER] < 0; t++) {
        sim.step(bot.decide(sim));
        if (firstPile < 0 && sim.started && t % 15 === 0) {
          // a pile of ≥ 10 downed horses in view ahead of the player
          let down = 0;
          for (let i = 1; i < sim.n; i++) {
            if (sim.state[i] !== HorseState.FALL) continue;
            const d = sim.progress[i] - sim.progress[0];
            if (d > -10 && d < 120 && Math.abs(sim.x[i] - sim.x[0]) < 60) down++;
          }
          if (down >= 10) firstPile = sim.raceTime;
        }
        if (rank30 === 0 && sim.raceTime >= 30) rank30 = computeRank(sim, FIELD.PLAYER);
      }
      const finalRank = computeRank(sim, FIELD.PLAYER);
      (globalThis as { process?: { stderr: { write(s: string): void } } }).process?.stderr.write(
        `phase1 seed ${seed}: first pile ${firstPile.toFixed(1)} s, rank@30s ${rank30}, finish ${sim.finishTime[0].toFixed(1)} s rank ${finalRank}\n`,
      );
      expect(firstPile).toBeGreaterThanOrEqual(0);
      expect(firstPile).toBeLessThanOrEqual(15);
      expect(10000 - rank30).toBeGreaterThanOrEqual(2000);
      expect(finalRank).toBeLessThanOrEqual(100);
    }, 120000);
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
