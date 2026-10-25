import { describe, expect, it } from 'vitest';
import { Course } from '../src/data/Course';
import { HorseSimulation, HorseState, Layer, type PlayerIntent } from '../src/game/HorseSimulation';
import { SpatialHash } from '../src/game/Collision';
import { computeRank } from '../src/game/Race';
import { HORSE, LOD } from '../src/game/Config';

function scriptedInput(tick: number): PlayerIntent {
  return {
    steer: Math.sin(tick * 0.05),
    jump: tick % 45 === 0,
    dash: tick % 120 < 40,
  };
}

function run(seed: number, ticks: number, n = 10000): HorseSimulation {
  const sim = new HorseSimulation(new Course(seed), seed, n);
  for (let t = 0; t < ticks; t++) sim.step(scriptedInput(t));
  return sim;
}

describe('HorseSimulation', () => {
  it('starts with the player in last place (10,000 / 10,000)', () => {
    const sim = new HorseSimulation(new Course(1), 1);
    expect(sim.n).toBe(10000);
    expect(computeRank(sim, 0)).toBe(10000);
  });

  it('is deterministic for the same seed and input log', () => {
    const a = run(777, 240);
    const b = run(777, 240);
    expect(a.checksum()).toBe(b.checksum());
    expect(a.fallsTotal).toBe(b.fallsTotal);
  });

  it('diverges for a different seed', () => {
    expect(run(777, 120).checksum()).not.toBe(run(778, 120).checksum());
  });

  it('keeps layer budgets in range and every horse in exactly one layer', () => {
    const sim = run(3, 200);
    const c = sim.layerCounts;
    expect(c[0] + c[1] + c[2]).toBe(10000);
    expect(c[0]).toBeLessThan(LOD.TARGET_A * 2.5);
    expect(c[0] + c[1]).toBeLessThan(LOD.TARGET_B * 2);
    expect(sim.layer[0]).toBe(Layer.A);
  });

  it('fallen horses always recover (no permanent falls)', () => {
    const sim = new HorseSimulation(new Course(9), 9, 2000);
    for (let t = 0; t < 60; t++) sim.step();
    for (let i = 1; i < 200; i++) sim.fall(i);
    const maxDown = (HORSE.FALL_TIME_MAX + HORSE.RECOVER_TIME + 1.5) * 30;
    for (let t = 0; t < maxDown; t++) sim.step();
    for (let i = 1; i < 200; i++) {
      // may have fallen again in a chain, but never stuck for the whole window
      expect(sim.stateTime[i]).toBeLessThan(HORSE.FALL_TIME_MAX + 1.5);
    }
  });

  it('chain reaction: horses tripping over a fallen one', () => {
    const sim = new HorseSimulation(new Course(11), 11, 3000);
    for (let t = 0; t < 60; t++) sim.step();
    // knock over a horse right in front of the player area
    const before = sim.fallsTotal;
    let falls = 0;
    for (let t = 0; t < 150; t++) {
      if (t % 30 === 0) {
        for (let k = 0; k < sim.activeCount; k++) {
          const i = sim.active[k];
          if (i !== 0 && sim.state[i] === HorseState.RUN) {
            sim.fall(i);
            break;
          }
        }
      }
      sim.step();
    }
    falls = sim.fallsTotal - before;
    expect(falls).toBeGreaterThan(5); // seeded falls plus at least a few knock-ons
  });

  it('a jumping player clears a fallen horse', () => {
    const sim = new HorseSimulation(new Course(2), 2, 2);
    for (let t = 0; t < 120; t++) sim.step();
    // put NPC 1 lying 7 m ahead of the player in the same lane
    sim.x[1] = sim.x[0];
    sim.progress[1] = sim.progress[0] + 7;
    sim.speed[1] = 0;
    sim.fall(1);
    sim.grace[0] = 0;
    sim.step({ steer: 0, jump: true, dash: false });
    for (let t = 0; t < 25; t++) sim.step();
    expect(sim.fallCount[0]).toBe(0);
    expect(sim.progress[0]).toBeGreaterThan(sim.progress[1]);
  });
});

describe('SpatialHash', () => {
  it('finds every neighbour that brute force finds', () => {
    const n = 400;
    const xs = new Float32Array(n);
    const ps = new Float32Array(n);
    const ids = new Int32Array(n);
    let s = 1;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      xs[i] = rnd() * 60 - 30;
      ps[i] = rnd() * 60 - 30;
      ids[i] = i;
    }
    const hash = new SpatialHash(2.5, 256, n);
    hash.build(ids, n, xs, ps);
    for (let i = 0; i < n; i += 7) {
      const found = new Set<number>();
      hash.forEachInRect(xs[i] - 3, ps[i] - 3, xs[i] + 3, ps[i] + 3, (j) => {
        expect(found.has(j)).toBe(false); // reported at most once
        found.add(j);
      });
      for (let j = 0; j < n; j++) {
        if (Math.abs(xs[j] - xs[i]) <= 3 && Math.abs(ps[j] - ps[i]) <= 3) expect(found.has(j)).toBe(true);
      }
    }
  });
});

describe('jump timing', () => {
  it('running straight into a fallen horse without jumping usually trips', () => {
    let trips = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const sim = new HorseSimulation(new Course(seed), seed, 2);
      for (let t = 0; t < 120; t++) sim.step();
      sim.x[1] = sim.x[0];
      sim.progress[1] = sim.progress[0] + 7;
      sim.speed[1] = 0;
      sim.fall(1);
      sim.grace[0] = 0;
      for (let t = 0; t < 25; t++) sim.step();
      if (sim.fallCount[0] > 0 || sim.state[0] === HorseState.STUMBLE) trips++;
    }
    expect(trips).toBeGreaterThan(5);
  });
});
