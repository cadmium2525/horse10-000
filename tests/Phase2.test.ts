import { describe, expect, it } from 'vitest';
import { Course } from '../src/data/Course';
import { FIELD, HORSE, PLAYER, RACE, SIM } from '../src/game/Config';
import { HorseSimulation, HorseState } from '../src/game/HorseSimulation';
import { AutoBot } from '../src/game/PlayerController';
import { OvertakeTracker, computeRank, isAhead } from '../src/game/Race';
import { HUMAN_250, OPTIMAL } from './helpers/race';

/**
 * Phase 2 acceptance (design §9 Phase 2): 10,000 unique horses with consistent progress,
 * rank and overtake counts; the difficulty curve (mass overtaking → avoiding → fight at the
 * front); no freeze, no complete blockage and no permanent falls even with frequent
 * accidents, over whole races on several seeds.
 */
const log = (s: string) =>
  (globalThis as { process?: { stderr: { write(s: string): void } } }).process?.stderr.write(s + '\n');

/** exact rank of `who` by a full sort (independent of computeRank's O(N) scan) */
function rankBySort(sim: HorseSimulation, who: number): number {
  const ids = Array.from({ length: sim.n }, (_, i) => i);
  ids.sort((a, b) => (isAhead(sim, a, b) ? -1 : isAhead(sim, b, a) ? 1 : 0));
  return ids.indexOf(who) + 1;
}

describe('Phase 2: ids, progress, rank and overtakes stay consistent', () => {
  it('whole race (bot player): permutation order, exact ranks, distinct-pass counter bounds', () => {
    const seed = 77;
    const sim = new HorseSimulation(new Course(seed), seed);
    const bot = new AutoBot({ ...OPTIMAL, seed });
    const ot = new OvertakeTracker(sim.n);
    const p = FIELD.PLAYER;
    let checks = 0;
    let minNet = Infinity;
    for (let t = 0; t < 30 * RACE.TIME_LIMIT && sim.finishTime[p] < 0; t++) {
      const before = Float64Array.from(sim.progress);
      sim.step(bot.decide(sim));
      if (t % RACE.RANK_PERIOD === 0) ot.update(sim);
      // nobody moves backwards or teleports forwards; positions stay on the track
      if (t % 15 === 0) {
        for (let i = 0; i < sim.n; i++) {
          const d = sim.progress[i] - before[i];
          expect(d).toBeGreaterThanOrEqual(-0.2); // (contact corrections may nudge back ≤ 0.2 m)
          expect(d).toBeLessThan((PLAYER.MAX_SPEED + 4) * SIM.DT);
          expect(Math.abs(sim.x[i])).toBeLessThanOrEqual(sim.course.width / 2);
        }
      }
      if (t % 450 === 0 && sim.started) {
        // unique ids: `order` is a permutation and orderPos its inverse; it is sorted by the
        // progress it was built from (the previous tick)
        const seen = new Uint8Array(sim.n);
        for (let k = 0; k < sim.n; k++) {
          const i = sim.order[k];
          expect(seen[i]).toBe(0);
          seen[i] = 1;
          expect(sim.orderPos[i]).toBe(k);
          if (k > 0) expect(before[sim.order[k - 1]]).toBeGreaterThanOrEqual(before[i]);
        }
        // computeRank (O(N) scan) equals an exact full sort
        const r = computeRank(sim, p);
        expect(r).toBe(rankBySort(sim, p));
        // distinct passes ≥ net places gained (start: last), never more than N−1
        ot.update(sim);
        expect(ot.total).toBeGreaterThanOrEqual(sim.n - r);
        expect(ot.total).toBeLessThanOrEqual(sim.n - 1);
        minNet = Math.min(minNet, ot.total - (sim.n - r));
        checks++;
      }
    }
    ot.update(sim);
    const final = computeRank(sim, p);
    log(`P2 consistency: ${checks} checkpoints, final rank ${final}, distinct passes ${ot.total}, min (passes − net gain) ${minNet}`);
    expect(sim.finishTime[p]).toBeGreaterThan(0);
    expect(ot.total).toBeGreaterThanOrEqual(sim.n - final);
  }, 300000);
});

describe('Phase 2: difficulty curve — mass overtaking → avoiding → fight at the front', () => {
  it('250 ms proxy: big gains early, hazards mid-race, a slow grind in the leading pack', () => {
    for (const seed of [1234, 42]) {
      const sim = new HorseSimulation(new Course(seed), seed);
      const bot = new AutoBot({ ...HUMAN_250, seed });
      const p = FIELD.PLAYER;
      const rankAt: number[] = [];
      let hazardTicks = 0; // ticks with a downed horse 5–40 m ahead within ±3 m (mid race)
      for (let t = 0; t < 30 * RACE.TIME_LIMIT && sim.finishTime[p] < 0; t++) {
        sim.step(bot.decide(sim));
        if (!sim.started) continue;
        if (sim.tick % 30 === 0) rankAt.push(computeRank(sim, p));
        if (sim.raceTime > 25 && sim.raceTime < 60 && sim.tick % 3 === 0) {
          for (let i = 1; i < sim.n; i++) {
            const d = sim.progress[i] - sim.progress[p];
            if (d > 5 && d < 40 && sim.state[i] === HorseState.FALL && Math.abs(sim.x[i] - sim.x[p]) < 3) {
              hazardTicks++;
              break;
            }
          }
        }
      }
      const end = rankAt.length - 1;
      const early = (rankAt[0] - rankAt[30]) / 30; // places per second, first 30 s
      const late = (rankAt[Math.max(0, end - 15)] - rankAt[end]) / 15; // last 15 s
      log(`P2 curve seed ${seed}: rank 1s ${rankAt[0]} → 30s ${rankAt[30]} → 60s ${rankAt[60]} → finish ${rankAt[end]}; ` +
        `places/s early ${early.toFixed(0)} late ${late.toFixed(1)}; mid-race hazard time ${(hazardTicks / 10).toFixed(1)} s`);
      expect(rankAt[0] - rankAt[30]).toBeGreaterThanOrEqual(1000); // mass overtaking
      expect(hazardTicks / 10).toBeGreaterThanOrEqual(5); // something to avoid / jump mid-race
      expect(rankAt[end]).toBeLessThanOrEqual(1000); // ends among the leaders…
      expect(late).toBeLessThan(early * 0.6); // …where every place is harder won
    }
  }, 300000);
});

describe('Phase 2: robustness — whole races with frequent accidents', () => {
  for (const [seed, withBot] of [
    [1234, true],
    [9, false],
    [314, true],
  ] as const) {
    it(`seed ${seed} (${withBot ? 'bot' : 'no input'}): no freeze, no complete blockage, no permanent fall`, () => {
      const sim = new HorseSimulation(new Course(seed), seed);
      const bot = new AutoBot({ seed });
      const downFor = new Float32Array(sim.n);
      let longestDown = 0;
      let maxTick = 0;
      let minWindowGain = Infinity;
      const windowTicks = 30 * 10;
      let snap = Float64Array.from(sim.progress);
      let leaderDone = -1;
      let lastHome = -1;
      for (let t = 0; t < 30 * (RACE.TIME_LIMIT + 90); t++) {
        const t0 = performance.now();
        sim.step(withBot ? bot.decide(sim) : undefined);
        maxTick = Math.max(maxTick, performance.now() - t0);
        for (let i = 0; i < sim.n; i++) {
          if (sim.state[i] === HorseState.FALL) {
            downFor[i] += SIM.DT;
            if (downFor[i] > longestDown) longestDown = downFor[i];
          } else downFor[i] = 0;
        }
        if (leaderDone < 0 && sim.finishTime[sim.order[0]] >= 0) leaderDone = sim.raceTime;
        // every 10 s: every horse still racing has moved on (no complete blockage anywhere)
        if (sim.started && sim.raceTime > 5 && t % windowTicks === 0) {
          for (let i = 0; i < sim.n; i++) {
            if (sim.finishTime[i] >= 0) continue;
            minWindowGain = Math.min(minWindowGain, sim.progress[i] - snap[i]);
          }
          snap = Float64Array.from(sim.progress);
        }
        if (t % 30 === 0) {
          let all = true;
          for (let i = 0; i < sim.n && all; i++) if (sim.finishTime[i] < 0) all = false;
          if (all) {
            lastHome = sim.raceTime;
            break;
          }
        }
      }
      let unfinished = 0;
      for (let i = 0; i < sim.n; i++) if (sim.finishTime[i] < 0) unfinished++;
      log(`P2 robustness seed ${seed}: falls ${sim.fallsTotal}, longest down ${longestDown.toFixed(2)} s, ` +
        `min 10 s progress ${minWindowGain.toFixed(0)} m, max tick ${maxTick.toFixed(1)} ms, leader ${leaderDone.toFixed(1)} s, last home ${lastHome.toFixed(1)} s, unfinished ${unfinished}`);
      expect(sim.fallsTotal).toBeGreaterThan(800); // accidents are frequent…
      // …but a downed horse always gets up (scripted piles stay down longest)
      expect(longestDown).toBeLessThanOrEqual(HORSE.FALL_TIME_MAX * 2.5 + 0.5);
      expect(minWindowGain).toBeGreaterThan(30); // nobody is boxed in for 10 s
      expect(maxTick).toBeLessThan(250); // no freeze (generous: shared CI machine)
      expect(unfinished).toBe(0); // the whole field gets home (stragglers too)
    }, 300000);
  }
});
