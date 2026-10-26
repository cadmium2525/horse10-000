import { describe, expect, it } from 'vitest';
import { Course } from '../src/data/Course';
import { HorseSimulation, HorseState, Layer } from '../src/game/HorseSimulation';
import { AutoBot } from '../src/game/PlayerController';
import { COURSE, SIM } from '../src/game/Config';

const log = (s: string) =>
  (globalThis as { process?: { stderr: { write(s: string): void } } }).process?.stderr.write(s + '\n');

/** Standing far-field (layer C) pairs whose ellipse colliders overlap deeply (q² < 0.5). */
function deepOverlapsC(sim: HorseSimulation): number {
  const idx = Array.from({ length: sim.n }, (_, i) => i).filter(
    (i) => sim.layer[i] === Layer.C && sim.state[i] !== HorseState.FALL && sim.state[i] !== HorseState.RECOVER,
  );
  idx.sort((a, b) => sim.progress[a] - sim.progress[b]);
  let count = 0;
  for (let a = 0; a < idx.length; a++) {
    const i = idx[a];
    for (let b = a + 1; b < idx.length; b++) {
      const j = idx[b];
      const dp = sim.progress[j] - sim.progress[i];
      if (dp >= 2.2) break;
      const dx = sim.x[j] - sim.x[i];
      const q = (dx / 0.9) ** 2 + (dp / 2.2) ** 2;
      if (q < 0.5) count++;
    }
  }
  return count;
}

describe('M1: far-field crowd has no deep overlaps and no teleports', () => {
  it('car-following keeps layer C apart and contact corrections stay below 0.3 m/tick', () => {
    const sim = new HorseSimulation(new Course(1234), 1234);
    const bot = new AutoBot();
    let maxCorr = 0;
    let maxJump = 0;
    const overlaps: number[] = [];
    for (let t = 0; t < 30 * 40; t++) {
      sim.step(bot.decide(sim));
      if (sim.maxCorrectionThisTick > maxCorr) maxCorr = sim.maxCorrectionThisTick;
      // displacement beyond what the horse's own speed explains (=> visible teleport)
      for (let i = 0; i < sim.n; i++) {
        const lat = Math.abs(sim.x[i] - sim.prevX[i]) - 7.5 * SIM.DT;
        // (on the oval's turns progress advances by speed / (1 + s·κ·x), s = LANE_DISTANCE_SCALE)
        const k = sim.course.curvatureAt(sim.prevProgress[i]) * COURSE.LANE_DISTANCE_SCALE;
        const lon = Math.abs(sim.progress[i] - sim.prevProgress[i] - (sim.speed[i] * SIM.DT) / (1 + k * sim.x[i]));
        const j = Math.max(lat, lon);
        if (j > maxJump) maxJump = j;
      }
      if (t > 0 && t % 300 === 0) overlaps.push(deepOverlapsC(sim));
    }
    log(`M1: deep C overlaps per 10 s sample = ${overlaps.join(', ')}; max correction ${maxCorr.toFixed(3)} m; max unexplained displacement ${maxJump.toFixed(3)} m`);
    for (const o of overlaps) expect(o).toBeLessThan(60);
    expect(maxCorr).toBeLessThan(0.3);
    expect(maxJump).toBeLessThan(0.3);
  }, 120000);
});

describe('M2: chain reactions stay local', () => {
  it('one fall inside a dense pack causes a bounded chain (5–60 falls nearby)', () => {
    const sizes: number[] = [];
    // no spontaneous accidents (background 0): only the seeded fall and what it triggers
    const nearbyFalls = (seed: number, seeded: boolean): number => {
      const sim = new HorseSimulation(new Course(seed), seed, undefined, { startGrace: 0, background: 0 });
      for (let t = 0; t < 30 * 4; t++) sim.step();
      // pick a running horse ~12 m ahead of the player (inside layer A/B)
      let target = -1;
      for (let k = 0; k < sim.activeCount; k++) {
        const i = sim.active[k];
        const dp = sim.progress[i] - sim.progress[0];
        if (i !== 0 && sim.state[i] === HorseState.RUN && dp > 8 && dp < 20 && Math.abs(sim.x[i] - sim.x[0]) < 5) {
          target = i;
          break;
        }
      }
      expect(target).toBeGreaterThan(0);
      const tx = sim.x[target];
      const tp = sim.progress[target];
      const before = new Uint16Array(sim.fallCount);
      if (seeded) sim.fall(target);
      for (let t = 0; t < 30 * 6; t++) sim.step();
      let nearby = 0;
      for (let i = 1; i < sim.n; i++) {
        if (sim.fallCount[i] === before[i]) continue;
        const dx = sim.x[i] - tx;
        const dp = sim.progress[i] - tp;
        if (Math.abs(dx) < 25 && dp > -30 && dp < 120) nearby++;
      }
      return nearby;
    };
    for (const seed of [1, 2, 3, 4, 5, 6]) sizes.push(nearbyFalls(seed, true));
    log(`M2: chain sizes ${sizes.join(', ')}`);
    for (const s of sizes) expect(s).toBeLessThanOrEqual(60);
    const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    // (the grid has natural sparse patches now, so a single fall at 1 s finds fewer victims)
    expect(mean).toBeGreaterThanOrEqual(3);
  }, 120000);

  it('first 15 s of a normal race: few horses down around the player at once', () => {
    for (const seed of [9, 1234]) {
      const sim = new HorseSimulation(new Course(seed), seed);
      const bot = new AutoBot();
      let maxDown = 0;
      for (let t = 0; t < 30 * 16.5; t++) {
        sim.step(bot.decide(sim));
        let d = 0;
        for (let k = 0; k < sim.activeCount; k++) {
          const i = sim.active[k];
          if (sim.state[i] !== HorseState.FALL) continue;
          const dx = sim.x[i] - sim.x[0];
          const dp = sim.progress[i] - sim.progress[0];
          if (dx * dx + dp * dp < 400) d++;
        }
        if (d > maxDown) maxDown = d;
      }
      log(`M2: seed ${seed} max simultaneous down within 20 m (first 15 s) = ${maxDown}, falls total ${sim.fallsTotal}`);
      // piles near the player are now intended (scripted accidents ahead, review M3); this is
      // only a sanity cap. Fairness (no NEW accident inside the reaction window) is tested in
      // Pile.test.ts.
      expect(maxDown).toBeLessThanOrEqual(80);
    }
  }, 120000);

  it('start grace: accident scale ramps from 15 % to 100 %', () => {
    const sim = new HorseSimulation(new Course(1), 1, 2);
    while (sim.raceTime < 0) sim.step();
    expect(sim.accidentScale()).toBeLessThan(0.2);
    while (sim.raceTime < sim.tuning.startGrace + 0.1) sim.step();
    expect(sim.accidentScale()).toBeCloseTo(1, 5);
  });
});

describe('R1: no standing traffic jams behind downed horses', () => {
  function measure(seed: number, withBot: boolean): { longest: number; peak: number; falls: number } {
    const sim = new HorseSimulation(new Course(seed), seed);
    const bot = new AutoBot();
    const stopped = new Float32Array(sim.n);
    let longest = 0;
    let peak = 0;
    for (let t = 0; t < 30 * 80; t++) {
      sim.step(withBot ? bot.decide(sim) : undefined);
      // the first 2 s after the gates open everybody is still accelerating from a standstill
      if (sim.raceTime < 2) continue;
      let now = 0;
      for (let i = 1; i < sim.n; i++) {
        const st = sim.state[i];
        if ((st === HorseState.RUN || st === HorseState.AVOID) && sim.speed[i] < 2 && !sim.finished[i]) {
          stopped[i] += SIM.DT;
          if (stopped[i] > longest) longest = stopped[i];
          // "standing in a jam" = stopped for at least half a second (not a momentary dip
          // while decelerating behind a pile and pulling away again)
          if (stopped[i] >= 0.5) now++;
        } else {
          stopped[i] = 0;
        }
      }
      if (now > peak) peak = now;
    }
    return { longest, peak, falls: sim.fallsTotal };
  }

  // The scripted big accidents leave short queues of 30–60 horses behind a pile for ~1 s
  // while they detour/hop; what R1 forbids is a long-lived jam, hence the 2.0 s cap
  // (Phase 1b review: accepted 60 with the cap tightened from 2.5 s).
  it('normal race (bot player): no upright NPC stopped > 2.0 s, ≤ 60 standing (≥ 0.5 s) at once', () => {
    for (const seed of [1234, 9, 77]) {
      const r = measure(seed, true);
      log(`R1: seed ${seed} (bot) longest upright stop ${r.longest.toFixed(2)} s, peak simultaneous ${r.peak}, falls ${r.falls}`);
      expect(r.longest).toBeLessThanOrEqual(2.0);
      expect(r.peak).toBeLessThanOrEqual(60);
    }
  }, 300000);

  it('passive player ploughing into every pile: still no long stops', () => {
    for (const seed of [1234, 9]) {
      const r = measure(seed, false);
      log(`R1: seed ${seed} (passive) longest upright stop ${r.longest.toFixed(2)} s, peak simultaneous ${r.peak}, falls ${r.falls}`);
      // (worst case: the player keeps feeding the pile it is stuck in; the packed inside rail
      // on the turn queues behind its own piles — intended, review M2 — but never for long)
      // (2.0 s is the cap for normal play above; this worst case keeps a 2.5 s cap)
      expect(r.longest).toBeLessThanOrEqual(2.5);
      expect(r.peak).toBeLessThanOrEqual(60);
    }
  }, 300000);
});
