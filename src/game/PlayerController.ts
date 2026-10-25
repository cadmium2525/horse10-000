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
    botSkill = 1,
  ) {
    this.bot = autoplay ? new AutoBot(botSkill) : null;
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
 * Deterministic "good player" bot (?autoplay=1, attract mode, balance tests).
 *  - every 0.2 s it scores lateral lanes within ±10 m by the free running distance ahead
 *    (standing horses slower than us block; low downed horses/piles are jumpable),
 *    minus the cost of moving sideways, with hysteresis
 *  - jumps a downed horse / low pile in its corridor at the right distance
 *  - dashes when its corridor is clear (and always in the home straight)
 */
export class AutoBot {
  private laneTarget = 0;
  private replanIn = 0;
  /** skill 0..1: lower values plan less often and look less far (attract mode variety) */
  constructor(private readonly skill = 1) {}

  decide(sim: HorseSimulation): PlayerIntent {
    const p = FIELD.PLAYER;
    const px = sim.x[p];
    const pp = sim.progress[p];
    const halfW = sim.course.width / 2 - 2;
    const look = 12 + 30 * this.skill;
    const found = sim.hash.query(px - 15.5, pp - 1, px + 15.5, pp + look);
    const res = sim.hash.result;
    const mySpeed = Math.max(sim.speed[p], 12);

    if (--this.replanIn <= 0) {
      this.replanIn = this.skill >= 1 ? 6 : 12;
      let best = this.laneTarget;
      let bestScore = -Infinity;
      let currentScore = -Infinity;
      for (let off = -14; off <= 14; off += 1) {
        const lx = Math.max(-halfW, Math.min(halfW, px + off));
        let free = look;
        let crossing = 0;
        for (let r = 0; r < found; r++) {
          const j = res[r];
          if (j === p) continue;
          const d = sim.progress[j] - pp;
          if (d < -1 || d > look) continue;
          const xj = sim.x[j];
          // horses between us and the target lane close ahead make the move costly
          if (d < 5 && ((xj > Math.min(px, lx) - 0.6 && xj < Math.max(px, lx) + 0.6) || Math.abs(xj - lx) < 0.9)) crossing++;
          if (Math.abs(xj - lx) > 1.0 || d < 1) continue;
          const st = sim.state[j];
          if (st === HorseState.FALL) {
            const top = sim.groundY[j] + 0.75;
            if (top < 1.2) continue; // jumpable
          } else if (st !== HorseState.RECOVER && st !== HorseState.STUMBLE && sim.speed[j] > mySpeed - 1.5) {
            continue; // moving as fast as us: not an obstacle
          }
          if (d < free) free = d;
        }
        const score = free - Math.abs(off) * 0.35 - crossing * 1.2;
        if (Math.abs(lx - this.laneTarget) < 0.5) currentScore = score;
        if (score > bestScore) {
          bestScore = score;
          best = lx;
        }
      }
      if (bestScore > currentScore + 2) this.laneTarget = best;
    }

    // jump a downed horse (low enough) ahead in our corridor at the right distance
    let jump = false;
    let clear = look;
    const jumpAt = 2.4 + mySpeed * 0.18;
    for (let r = 0; r < found; r++) {
      const j = res[r];
      if (j === p || Math.abs(sim.x[j] - px) > 1.4) continue;
      const d = sim.progress[j] - pp;
      if (d <= 0) continue;
      if (sim.state[j] === HorseState.FALL) {
        if (sim.groundY[j] + 0.75 < 1.2 && d > jumpAt - 1.2 && d < jumpAt + 0.8) jump = true;
      } else if (d < clear) {
        clear = d;
      }
    }
    const steer = Math.max(-1, Math.min(1, (this.laneTarget - px) * 0.7));
    const homeStraight = sim.course.length - pp < 220;
    const dash = (clear > 12 && sim.dashGauge > 0.3) || (homeStraight && sim.dashGauge > 0);
    return { steer, jump, dash };
  }
}
