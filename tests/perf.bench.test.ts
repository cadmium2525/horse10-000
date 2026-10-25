import { describe, expect, it } from 'vitest';
import { Course } from '../src/data/Course';
import { HorseSimulation, HorseState } from '../src/game/HorseSimulation';
import { OvertakeTracker, computeRank } from '../src/game/Race';

/**
 * Simulation CPU benchmark (10,000 horses, 90 s of race at 30 Hz).
 * Skipped in normal runs; `npm run bench:sim` enables it.
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined>; stderr: { write(s: string): void } } })
  .process;
const enabled = !!env?.env.BENCH;

describe.skipIf(!enabled)('sim benchmark', () => {
  it('10,000 horses / 2,700 ticks', () => {
    const sim = new HorseSimulation(new Course(1234), 1234);
    const ot = new OvertakeTracker(sim.n);
    const times: number[] = [];
    const lines: string[] = [];
    for (let t = 0; t < 2700; t++) {
      const t0 = performance.now();
      sim.step({ steer: Math.sin(t * 0.03) * 0.6, jump: t % 40 === 0, dash: t % 150 < 50 });
      times.push(performance.now() - t0);
      if (t % 3 === 0) ot.update(sim);
      if (t % 300 === 0) {
        let down = 0;
        for (let i = 0; i < sim.n; i++) if (sim.state[i] === HorseState.FALL) down++;
        lines.push(
          `t=${(t / 30).toFixed(0)}s rank=${computeRank(sim, 0)} passed=${ot.total} falls=${sim.fallsTotal} down=${down} ` +
            `playerFalls=${sim.fallCount[0]} A=${sim.layerCounts[0]} B=${sim.layerCounts[1]} contacts=${sim.contactsThisTick}`,
        );
      }
    }
    const s = times.slice(100).sort((a, b) => a - b);
    const avg = s.reduce((a, b) => a + b, 0) / s.length;
    lines.push(
      `tick ms: avg=${avg.toFixed(3)} p50=${s[s.length >> 1].toFixed(3)} p95=${s[Math.floor(s.length * 0.95)].toFixed(3)} max=${s[s.length - 1].toFixed(3)}`,
    );
    env?.stderr.write(lines.join('\n') + '\n');
    expect(avg).toBeLessThan(8);
  }, 120000);
});
