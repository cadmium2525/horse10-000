import { it } from 'vitest';
import { Course } from '../src/data/Course';
import { HorseSimulation } from '../src/game/HorseSimulation';
import { AutoBot } from '../src/game/PlayerController';
import { computeRank } from '../src/game/Race';
it('d', () => {
  const sim = new HorseSimulation(new Course(5), 5); const bot = new AutoBot({ seed: 5 });
  let line = ''; let slow = 0, dashT = 0, blk = 0, n = 0, sumV = 0, lastP = sim.progress[0], sumX = 0;
  for (let t = 0; t < 30 * 125 && sim.finishTime[0] < 0; t++) {
    sim.step(bot.decide(sim));
    if (!sim.started) continue;
    n++; sumV += sim.speed[0]; sumX += sim.x[0]; if (sim.speed[0] < 17) slow++; if (sim.dashing) dashT++; if (sim.dashBlocked) blk++;
    if (t % 300 === 0) { line += `\n[${sim.raceTime.toFixed(0)}s v=${(sumV/n).toFixed(1)} slow=${(slow/n*100).toFixed(0)}% dash=${(dashT/n*100).toFixed(0)}% blocked=${(blk/n*100).toFixed(0)}% dp=${(sim.progress[0]-lastP).toFixed(0)} x=${(sumX/n).toFixed(0)} g=${sim.dashGauge.toFixed(2)} r=${computeRank(sim,0)} falls=${sim.fallCount[0]} st=${sim.state[0]} cl=${sim.jumpsCleared}]`; sumV = 0; n = 0; slow = 0; dashT = 0; blk=0; sumX=0; lastP = sim.progress[0]; }
  }
  (globalThis as any).process.stderr.write(line + `\nfinish ${sim.finishTime[0].toFixed(1)} passes ${sim.playerPasses} near ${sim.nearMisses}\n`);
}, 300000);
