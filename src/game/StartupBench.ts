import { Course } from '../data/Course';
import { FIELD } from './Config';
import { HorseSimulation } from './HorseSimulation';

/**
 * Boot-time CPU probe (design §5: pick the initial quality from a quick benchmark). Runs a
 * 2,000-horse race through the start and a few racing ticks (≈ 40 ms on a desktop, a few
 * hundred on a weak phone), scales the cost per tick to the full field, and also leaves the
 * simulation code JIT-compiled before the first real race.
 */
export function estimateFullTickMs(): number {
  const n = 2000;
  const sim = new HorseSimulation(new Course(424242), 424242, n);
  const startTicks = Math.ceil(FIELD.START_DELAY * 30) + 3;
  for (let t = 0; t < startTicks; t++) sim.step();
  const ticks = 12;
  const t0 = performance.now();
  for (let t = 0; t < ticks; t++) sim.step({ steer: 0.3, jump: false, dash: false });
  const per = (performance.now() - t0) / ticks;
  return per * (FIELD.HORSES / n);
}

/**
 * Initial render LOD level from the estimated full-field sim tick (ms). The sim runs at
 * 30 Hz (33 ms budget) and shares the frame with rendering, so a slow sim leaves less room
 * for drawing; touch devices are stricter (GPU / thermals). Starts at most at level 2 (the
 * auto-upgrade ceiling); the quality manager adapts from there.
 */
export function chooseInitialLevel(estTickMs: number, isTouch: boolean): number {
  if (!Number.isFinite(estTickMs) || estTickMs <= 0) return isTouch ? 1 : 2;
  if (isTouch) return estTickMs <= 4 ? 2 : estTickMs <= 10 ? 1 : 0;
  return estTickMs <= 6 ? 2 : estTickMs <= 12 ? 1 : 0;
}
