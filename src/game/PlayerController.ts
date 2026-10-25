import { FIELD } from './Config';
import { HorseState, type HorseSimulation, type PlayerIntent } from './HorseSimulation';
import type { Input } from './Input';

/**
 * Produces one PlayerIntent per simulation tick, either from the human Input or from
 * the autoplay bot (?autoplay=1, used for automated verification and attract mode).
 * Every intent fed to the sim is appended to `log` so a race can be replayed exactly.
 */
export class PlayerController {
  readonly log: PlayerIntent[] = [];
  private readonly bot: AutoBot | null;

  constructor(
    private readonly input: Input,
    autoplay: boolean,
  ) {
    this.bot = autoplay ? new AutoBot() : null;
  }

  sample(sim: HorseSimulation): PlayerIntent {
    const intent: PlayerIntent = this.bot
      ? this.bot.decide(sim)
      : { steer: this.input.steer, jump: this.input.consumeJump(), dash: this.input.dash };
    this.log.push(intent);
    return intent;
  }
}

/**
 * Simple deterministic bot: steers toward the least crowded lane ahead, jumps fallen
 * horses at the right distance, dashes when the lane is clear.
 */
export class AutoBot {
  private laneTarget = 0;
  private replanIn = 0;

  decide(sim: HorseSimulation): PlayerIntent {
    const p = FIELD.PLAYER;
    const px = sim.x[p];
    const pp = sim.progress[p];
    const halfW = sim.course.width / 2 - 3;

    if (--this.replanIn <= 0) {
      this.replanIn = 10;
      let best = px;
      let bestScore = Infinity;
      for (let off = -8; off <= 8; off += 2) {
        const lx = Math.max(-halfW, Math.min(halfW, px + off));
        let score = Math.abs(off) * 0.15;
        sim.hash.forEachInRect(lx - 1.2, pp + 1, lx + 1.2, pp + 18, (j) => {
          if (j === p) return;
          if (Math.abs(sim.x[j] - lx) > 1.2) return;
          const d = sim.progress[j] - pp;
          if (d < 1 || d > 18) return;
          score += sim.state[j] === HorseState.FALL ? 3 : 1;
        });
        if (score < bestScore) {
          bestScore = score;
          best = lx;
        }
      }
      this.laneTarget = best;
    }

    // jump if a fallen horse sits 4.5-7.5 m ahead in our lane
    let jump = false;
    let clear = true;
    sim.hash.forEachInRect(px - 1.5, pp + 1, px + 1.5, pp + 9, (j) => {
      if (j === p || Math.abs(sim.x[j] - px) > 1.3) return;
      const d = sim.progress[j] - pp;
      if (d <= 0) return;
      clear = false;
      if (sim.state[j] === HorseState.FALL && d > 4.5 && d < 7.5) jump = true;
    });
    const steer = Math.max(-1, Math.min(1, (this.laneTarget - px) * 0.5));
    return { steer, jump, dash: clear && sim.dashGauge > 0.5 };
  }
}
