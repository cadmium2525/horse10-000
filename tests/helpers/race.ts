import { Course } from '../../src/data/Course';
import { FIELD, RACE } from '../../src/game/Config';
import { HorseSimulation, HorseState } from '../../src/game/HorseSimulation';
import { AutoBot, type BotOptions } from '../../src/game/PlayerController';
import { computeRank } from '../../src/game/Race';

/**
 * Balance seeds. The first five are the Phase 1 set; outcomes per seed are chaotic (any
 * difference in the player's line reshuffles every accident downstream), so rate-type
 * claims ("wins 3 of 5") are checked over all ten with the same proportion.
 */
export const DIFFICULTY_SEEDS = [1234, 9, 77, 5, 42, 11, 23, 314, 2718, 99];
/** the original five (cheaper checks that are not rates) */
export const CORE_SEEDS = DIFFICULTY_SEEDS.slice(0, 5);

/** bot proxies (Phase 1b review): optimal play and humans with a reaction delay + steering noise */
export const OPTIMAL: BotOptions = {};
export const HUMAN_150: BotOptions = { reactionMs: 150, noise: 0.15 };
export const HUMAN_250: BotOptions = { reactionMs: 250, noise: 0.25 };

export function wins(runs: RaceRun[]): number {
  return runs.filter((r) => r.rank === 1).length;
}

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
  /** rank 30 s after the gates open (start rank = field size) */
  rank30: number;
  /** finish time minus the winner's finish time (0 when we won) */
  gap: number;
  /** share of the player's time on the turns spent within 35 m of the inside rail */
  insideShare: number;
  /** density of the inner 20 m of the track / mean density across the width (field on the turn) */
  innerDensity: number;
  /** share of racing time spent dashing */
  dashShare: number;
  /** bot diagnostics: jump chances passed up (landing on a downed horse / tall pile / standing horse) */
  blocks: string;
}

/** Full 10,000-horse race with a bot player (null = no input). Deterministic. */
export function runRace(seed: number, opts: BotOptions | null, maxSeconds: number = RACE.TIME_LIMIT): RaceRun {
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
  let rank30 = sim.n;
  let turnTicks = 0;
  let insideTicks = 0;
  let dashTicks = 0;
  let raceTicks = 0;
  const innerSamples: number[] = [];
  const half = sim.course.width / 2;
  for (let t = 0; t < 30 * maxSeconds && sim.finishTime[p] < 0; t++) {
    prev.set(sim.fallCount);
    sim.step(bot ? bot.decide(sim) : undefined);
    if (!sim.started) continue;
    raceTicks++;
    if (sim.dashing) dashTicks++;
    if (sim.course.curvatureAt(sim.progress[p]) > 0) {
      turnTicks++;
      if (sim.x[p] < -half + 35) insideTicks++;
    }
    if (rank30 === sim.n && sim.raceTime >= 30) rank30 = computeRank(sim, p);
    if (sim.tick % 150 === 0) {
      // field density across the width, for horses on a turn
      let inner = 0;
      let all = 0;
      for (let i = 1; i < sim.n; i++) {
        if (sim.finishTime[i] >= 0 || sim.course.curvatureAt(sim.progress[i]) <= 0) continue;
        all++;
        if (sim.x[i] < -half + 20) inner++;
      }
      if (all > 2000) innerSamples.push(inner / 20 / (all / sim.course.width));
    }
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
  let winner = Infinity;
  for (let i = 0; i < sim.n; i++) if (sim.finishTime[i] >= 0 && sim.finishTime[i] < winner) winner = sim.finishTime[i];
  const myTime = sim.finishTime[p] >= 0 ? sim.finishTime[p] : sim.raceTime;
  return {
    rank30,
    gap: Math.max(0, myTime - winner),
    insideShare: turnTicks ? insideTicks / turnTicks : 0,
    innerDensity: innerSamples.length ? mean(innerSamples) : 0,
    blocks: bot ? `${bot.jumpBlocks.down}/${bot.jumpBlocks.tall}/${bot.jumpBlocks.upright}` : '-',
    dashShare: raceTicks ? dashTicks / raceTicks : 0,
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
      .join(',')} | big ${runs.map((r) => r.bigFalls).join(',')} | first big ${runs.map((r) => r.firstBig.toFixed(1)).join(',')} | chances ${runs.map((r) => r.jumpChances).join(',')} | r30 ${runs.map((r) => r.rank30).join(',')} | gap ${runs.map((r) => r.gap.toFixed(1)).join(',')} | inside ${runs.map((r) => r.insideShare.toFixed(2)).join(',')} | innerDens ${runs.map((r) => r.innerDensity.toFixed(2)).join(',')} | dash ${runs.map((r) => r.dashShare.toFixed(2)).join(',')} | late vis/10s ${runs.map((r) => (r.visible.slice(4, -1).reduce((a, b) => a + b, 0) / Math.max(1, r.visible.length - 5)).toFixed(0)).join(',')}\n`,
  );
}

/** M1 proxies: jump pressed on every tick, alone or on top of a 250 ms human, and a
 *  player who does nothing but jump */
export const HUMAN_250_MASH: BotOptions = { ...HUMAN_250, mash: true };
export const IDLE_MASH: BotOptions = { passive: true, mash: true };
