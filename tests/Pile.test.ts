import { describe, expect, it } from 'vitest';
import { Course } from '../src/data/Course';
import { HorseSimulation, HorseState } from '../src/game/HorseSimulation';
import { COLLISION, HORSE } from '../src/game/Config';
import { AutoBot } from '../src/game/PlayerController';

function startedSim(n: number, seed = 3): HorseSimulation {
  const sim = new HorseSimulation(new Course(seed), seed, n);
  while (sim.raceTime < 3) sim.step();
  return sim;
}

/** lay NPC i down at (x, p) resting at height g (frozen for the test) */
function layDown(sim: HorseSimulation, i: number, x: number, p: number, g: number): void {
  sim.x[i] = x;
  sim.progress[i] = p;
  sim.speed[i] = 0;
  sim.setState(i, HorseState.FALL, 99);
  sim.groundY[i] = g;
  sim.y[i] = g;
  sim.vy[i] = 0;
}

describe('horse pile model', () => {
  it('a horse that goes down on top of a downed horse rests on it', () => {
    const sim = startedSim(3);
    layDown(sim, 1, sim.x[0] + 10, sim.progress[0] + 30, 0);
    sim.x[2] = sim.x[1] + 0.2;
    sim.progress[2] = sim.progress[1] + 0.5;
    sim.step(); // rebuild the hash with both horses
    sim.grace[2] = 0;
    sim.fall(2);
    expect(sim.groundY[2]).toBeGreaterThan(0.4);
    expect(sim.groundY[2]).toBeLessThanOrEqual(HORSE.PILE_MAX);
  });

  it('a low pile (one or two horses) can be jumped; a three-high pile cannot', () => {
    // low: one downed horse 7 m ahead
    const low = startedSim(2);
    layDown(low, 1, low.x[0], low.progress[0] + 7, 0);
    low.grace[0] = 0;
    low.step({ steer: 0, jump: true, dash: false });
    for (let t = 0; t < 30; t++) low.step();
    expect(low.fallCount[0]).toBe(0);
    expect(low.progress[0]).toBeGreaterThan(low.progress[1] + 2);

    // two-high (top 0.6 + 0.75 = 1.35 m): still under the jump arc
    const two = startedSim(3);
    layDown(two, 1, two.x[0], two.progress[0] + 7, 0);
    layDown(two, 2, two.x[0], two.progress[0] + 7.3, 0.6);
    two.grace[0] = 0;
    two.step({ steer: 0, jump: true, dash: false });
    for (let t = 0; t < 30; t++) two.step();
    expect(two.fallCount[0]).toBe(0);
    expect(two.progress[0]).toBeGreaterThan(two.progress[2] + 2);

    // tall: three stacked downed horses (top ≈ 2.35 m), right in front: no way over
    const tall = startedSim(4);
    layDown(tall, 1, tall.x[0], tall.progress[0] + 4, 0);
    layDown(tall, 2, tall.x[0], tall.progress[0] + 4.2, 0.8);
    layDown(tall, 3, tall.x[0], tall.progress[0] + 4.4, 1.6);
    tall.grace[0] = 0;
    tall.step({ steer: 0, jump: true, dash: false });
    for (let t = 0; t < 30; t++) tall.step();
    expect(tall.fallCount[0] > 0 || tall.progress[0] < tall.progress[3]).toBe(true);
  });

  it('landing a jump onto a downed horse is a failed landing', () => {
    let fails = 0;
    for (let s = 1; s <= 8; s++) {
      const sim = startedSim(2, s);
      // horse lying where the player comes down (airtime 2·JUMP_VY/g = 0.8 s at current speed)
      layDown(sim, 1, sim.x[0], sim.progress[0] + sim.speed[0] * 0.8 + 1, 0);
      sim.grace[0] = 0;
      sim.step({ steer: 0, jump: true, dash: false });
      for (let t = 0; t < 40; t++) sim.step();
      if (sim.fallCount[0] > 0) fails++;
    }
    expect(fails).toBeGreaterThanOrEqual(5);
  });

  it('piles form during a real race and NPCs hop over downed horses', () => {
    const sim = new HorseSimulation(new Course(1234), 1234);
    const bot = new AutoBot();
    let maxPile = 0;
    for (let t = 0; t < 30 * 40; t++) {
      sim.step(bot.decide(sim));
      for (let k = 0; k < sim.activeCount; k++) {
        const i = sim.active[k];
        if (sim.state[i] === HorseState.FALL && sim.groundY[i] > maxPile) maxPile = sim.groundY[i];
      }
    }
    expect(maxPile).toBeGreaterThan(0.4);
    expect(sim.hops).toBeGreaterThan(5);
  }, 60000);
});

describe('fairness: no sudden unavoidable pile right in front of the player', () => {
  it('no spontaneous / NPC-caused accident starts inside the safe box ahead of the player', () => {
    const sim = new HorseSimulation(new Course(77), 77);
    const bot = new AutoBot();
    let violations = 0;
    const prevFalls = new Uint16Array(sim.n);
    for (let t = 0; t < 30 * 40; t++) {
      prevFalls.set(sim.fallCount);
      sim.step(bot.decide(sim));
      for (let i = 1; i < sim.n; i++) {
        if (sim.fallCount[i] === prevFalls[i] || sim.chainGen[i] !== 0) continue;
        // safe box minus a margin for the movement within the tick after the decision
        const dp = sim.progress[i] - sim.progress[0];
        if (!(dp > -1 && dp < COLLISION.SAFE_AHEAD_MIN - 1 && Math.abs(sim.x[i] - sim.x[0]) < COLLISION.SAFE_SIDE - 0.5)) continue;
        // a horse the player itself barged into is fair game
        const touching = Math.abs(sim.x[i] - sim.x[0]) < 1.2 && Math.abs(sim.progress[i] - sim.progress[0]) < 2.6;
        if (!touching) violations++;
      }
    }
    expect(violations).toBe(0);
  }, 60000);
});
