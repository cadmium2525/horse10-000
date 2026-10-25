import { SIM } from './Config';

/**
 * Fixed-timestep accumulator (pure, DOM-free so it can be unit-tested).
 * Real frame time accumulates; the simulation advances in whole DT steps, at most
 * `maxSteps` per frame (excess backlog is dropped => slow motion instead of a spiral of
 * death). Returns the interpolation factor for rendering between the last two states.
 */
export class FixedStepper {
  acc = 0;
  /** total ticks executed */
  ticks = 0;
  /** ticks of backlog dropped because of the per-frame cap */
  dropped = 0;

  constructor(
    readonly dt: number = SIM.DT,
    readonly maxSteps: number = SIM.MAX_STEPS_PER_FRAME,
  ) {}

  /** Advance by a frame of `frameSec` real seconds, calling `step` per fixed tick. */
  advance(frameSec: number, step: () => void): { steps: number; alpha: number } {
    this.acc += Math.min(Math.max(frameSec, 0), 0.25);
    let steps = 0;
    while (this.acc >= this.dt && steps < this.maxSteps) {
      step();
      this.acc -= this.dt;
      steps++;
    }
    if (steps === this.maxSteps && this.acc >= this.dt) {
      this.dropped += Math.floor(this.acc / this.dt);
      this.acc = this.dt * 0.999;
    }
    this.ticks += steps;
    return { steps, alpha: this.acc / this.dt };
  }

  reset(): void {
    this.acc = 0;
  }
}
