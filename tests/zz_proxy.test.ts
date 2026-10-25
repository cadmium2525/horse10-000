import { it } from 'vitest';
import { Course } from '../src/data/Course';
import { HorseSimulation, HorseState } from '../src/game/HorseSimulation';
import { AutoBot, type BotOptions } from '../src/game/PlayerController';
import { computeRank } from '../src/game/Race';
const w = (s: string) => (globalThis as any).process.stderr.write(s + '\n');
const env = (globalThis as any).process.env;
it('proxy', () => {
  const seeds = (env.SEEDS ?? '1234,9,77,5,42').split(',').map(Number);
  const proxies: Record<string, BotOptions | null> = JSON.parse(env.PROXIES ?? 'null') ?? {
    optimal: {}, d150: { reactionMs: 150 }, human: { reactionMs: 250, noise: 0.25 }, masher: { reactionMs: 250, noise: 0.25, dash: 'hold' }, nojump: { jump: false }, passive: null,
  };
  for (const [name, o] of Object.entries(proxies)) {
    const out: string[] = [];
    for (const seed of seeds) {
      const course = new Course(seed);
      const sim = new HorseSimulation(course, seed);
      const bot = o ? new AutoBot({ ...o, seed }) : null;
      const visible: number[] = []; let bucket = 0; let big = 0; let firstBig = -1; let inBig = false;
      const prevFalls = new Uint16Array(sim.n);
      for (let t = 0; t < 30 * 130 && sim.finishTime[0] < 0; t++) {
        prevFalls.set(sim.fallCount);
        sim.step(bot ? bot.decide(sim) : undefined);
        if (!sim.started) continue;
        let down = 0;
        for (let i = 1; i < sim.n; i++) {
          const dp = sim.progress[i] - sim.progress[0]; const dx = sim.x[i] - sim.x[0];
          if (dp < 0 || dp > 80 || Math.abs(dx) > 35) continue;
          if (sim.fallCount[i] !== prevFalls[i]) bucket++;
          if (sim.state[i] === HorseState.FALL && dp < 60) down++;
        }
        if (down >= 8 && !inBig) { big++; inBig = true; if (firstBig < 0) firstBig = sim.raceTime; }
        if (down < 3) inBig = false;
        if (t % 300 === 0) { visible.push(bucket); bucket = 0; }
      }
      const rank = computeRank(sim, 0);
      out.push(`s${seed}: rank ${rank} t=${sim.finishTime[0].toFixed(1)} falls ${sim.fallCount[0]}${rank === 1 && sim.fallCount[0] === 0 ? ' PERFECT' : ''} jumps ${sim.jumpsTaken}/clr ${sim.jumpsCleared} req ${bot?.jumpRequests ?? 0} big ${big} first ${firstBig.toFixed(1)} vis10s [${visible.join(',')}] dir ${sim.directorEvents}`);
    }
    w(`== ${name}\n` + out.join('\n'));
  }
}, 1800000);
