import { Course } from '../../src/data/Course';
import { FIELD } from '../../src/game/Config';
import { HorseSimulation, HorseState } from '../../src/game/HorseSimulation';
import { AutoBot, type BotOptions } from '../../src/game/PlayerController';
import { computeRank } from '../../src/game/Race';

export const DIFFICULTY_SEEDS = [1234, 9, 77, 5, 42];

export interface RaceRun {
  seed: number;
  rank: number;
  time: number;
  falls: number;
  perfect: boolean;
  jumps: number;
  jumpsCleared: number;
  /** new falls in view (0–80 m ahead, ±35 m) per 10 s window */
  visible: number[];
  /** "big falls": ≥ 8 horses down at once within 60 m ahead */
  bigFalls: number;
  firstBig: number;
  /** jump opportunities: a low downed horse appears 3–12 m ahead in the player's lane */
  jumpChances: number;
}

/** Full 10,000-horse race with a bot player (null = no input). Deterministic. */
export function runRace(seed: number, opts: BotOptions | null, maxSeconds = 130): RaceRun {
  const sim = new HorseSimulation(new Course(seed), seed);
  const bot = opts ? new AutoBot({ ...opts, seed }) : null;
  const p = FIELD.PLAYER;
  const visible: number[] = [];
  let bucket = 0;
  let bigFalls = 0;
  let firstBig = -1;
  let inBig = false;
  let jumpChances = 0;
  let chanceActive = false;
  const prev = new Uint16Array(sim.n);
  for (let t = 0; t < 30 * maxSeconds && sim.finishTime[p] < 0; t++) {
    prev.set(sim.fallCount);
    sim.step(bot ? bot.decide(sim) : undefined);
    if (!sim.started) continue;
    let down = 0;
    let lowAhead = false;
    for (let i = 1; i < sim.n; i++) {
      const dp = sim.progress[i] - sim.progress[p];
      if (dp < 0 || dp > 80 || Math.abs(sim.x[i] - sim.x[p]) > 35) continue;
      if (dp > 3 && dp < 12 && sim.state[i] === HorseState.FALL && Math.abs(sim.x[i] - sim.x[p]) < 1.4 && sim.y[i] + 0.75 < 1.2) lowAhead = true;
      if (sim.fallCount[i] !== prev[i]) bucket++;
      if (sim.state[i] === HorseState.FALL && dp < 60) down++;
    }
    if (down >= 8 && !inBig) {
      bigFalls++;
      inBig = true;
      if (firstBig < 0) firstBig = sim.raceTime;
    }
    if (down < 3) inBig = false;
    if (lowAhead && !chanceActive) jumpChances++;
    chanceActive = lowAhead;
    if (sim.tick % 300 === 0) {
      visible.push(bucket);
      bucket = 0;
    }
  }
  const rank = computeRank(sim, p);
  return {
    seed,
    rank,
    time: sim.finishTime[p],
    falls: sim.fallCount[p],
    perfect: rank === 1 && sim.fallCount[p] === 0,
    jumps: sim.jumpsTaken,
    jumpsCleared: sim.jumpsCleared,
    visible,
    bigFalls,
    firstBig,
    jumpChances,
  };
}

export function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s[s.length >> 1];
}

export function mean(v: number[]): number {
  return v.reduce((a, b) => a + b, 0) / v.length;
}

export function report(label: string, runs: RaceRun[]): void {
  (globalThis as { process?: { stderr: { write(s: string): void } } }).process?.stderr.write(
    `${label}: ranks ${runs.map((r) => r.rank).join(', ')} | falls ${runs.map((r) => r.falls).join(',')} | jumps ${runs
      .map((r) => `${r.jumps}/${r.jumpsCleared}`)
      .join(',')} | big ${runs.map((r) => r.bigFalls).join(',')} | first big ${runs.map((r) => r.firstBig.toFixed(1)).join(',')} | chances ${runs.map((r) => r.jumpChances).join(',')} | late vis/10s ${runs.map((r) => (r.visible.slice(4, -1).reduce((a, b) => a + b, 0) / Math.max(1, r.visible.length - 5)).toFixed(0)).join(',')}\n`,
  );
}
