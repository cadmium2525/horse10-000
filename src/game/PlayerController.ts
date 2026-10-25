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

export interface BotOptions {
  /** 0..1: planning frequency / look distance (attract mode variety) */
  skill?: number;
  /** human reaction delay (ms): intents are applied this late */
  reactionMs?: number;
  /** steering noise amplitude (0..1, seeded, smooth) */
  noise?: number;
  /** 'smart' = dash on clear corridors, 'hold' = keep the button down (button masher) */
  dash?: 'smart' | 'hold' | 'never';
  /** false = never jump (to measure what jumping is worth) */
  jump?: boolean;
  /** prefer the inside rail on the turn (shorter way round) */
  insideLine?: boolean;
  seed?: number;
}

/**
 * Deterministic bot (?autoplay=1, attract mode, balance tests). With default options it
 * plays like a very good player; `reactionMs` / `noise` / `dash: 'hold'` turn it into
 * human proxies for difficulty tests.
 *  - every 0.2 s it scores lateral lanes within ±28 m by the free running distance ahead
 *    (standing horses slower than us block; low downed horses/piles are jumpable),
 *    minus the cost of moving sideways (and of the outside on the turn), with hysteresis
 *  - jumps a downed horse / low pile in its corridor at the right distance
 *  - dashes on a clear corridor (fresh press each time) and in the home straight
 */
export class AutoBot {
  private laneTarget = 0;
  private replanIn = 0;
  private readonly skill: number;
  private readonly delayTicks: number;
  private readonly noise: number;
  private readonly dashMode: 'smart' | 'hold' | 'never';
  private readonly canJump: boolean;
  private readonly insideLine: boolean;
  private readonly queue: PlayerIntent[] = [];
  private readonly candidates: number[] = [];
  private noisePhase: number;
  private prevDash = false;
  /** stats */
  jumpRequests = 0;

  constructor(opts: BotOptions | number = {}) {
    const o = typeof opts === 'number' ? { skill: opts } : opts;
    this.skill = o.skill ?? 1;
    this.delayTicks = Math.round((o.reactionMs ?? 0) / (1000 / 30));
    this.noise = o.noise ?? 0;
    this.dashMode = o.dash ?? 'smart';
    this.canJump = o.jump ?? true;
    this.insideLine = o.insideLine ?? true;
    this.noisePhase = ((o.seed ?? 1) * 2654435761) % 1000;
  }

  decide(sim: HorseSimulation): PlayerIntent {
    const now = this.think(sim);
    if (this.delayTicks <= 0) return now;
    this.queue.push(now);
    // until the first delayed intent arrives the "human" is still reacting: no input
    return this.queue.length > this.delayTicks ? this.queue.shift()! : { steer: 0, jump: false, dash: false };
  }

  private think(sim: HorseSimulation): PlayerIntent {
    const p = FIELD.PLAYER;
    const px = sim.x[p];
    const pp = sim.progress[p];
    const halfW = sim.course.width / 2 - 2;
    const look = 12 + 30 * this.skill;
    const found = sim.hash.query(px - 29.5, pp - 1, px + 29.5, pp + look);
    const res = sim.hash.result;
    const mySpeed = Math.max(sim.speed[p], 12);
    // turn ahead: the inside (−x) saves distance — roughly κ·x metres per metre of turn left
    let turnLeft = 0;
    let kAhead = 0;
    for (let d = 0; d < 1200; d += 50) {
      const k = sim.course.curvatureAt(pp + d);
      if (k > 0) {
        turnLeft += 50;
        kAhead = k;
      }
    }

    if (--this.replanIn <= 0) {
      this.replanIn = this.skill >= 1 ? 6 : 12;
      let best = this.laneTarget;
      let bestScore = -Infinity;
      let currentScore = -Infinity;
      // local lanes around us plus the centre of every open corridor (planning ahead)
      const cands = this.candidates;
      cands.length = 0;
      for (let off = -28; off <= 28; off += 1) cands.push(px + off);
      for (let c = FIELD.CORRIDOR_OFFSET - FIELD.CORRIDOR_SPACING * 6; c < halfW; c += FIELD.CORRIDOR_SPACING) {
        if (c > -halfW) cands.push(c);
      }
      for (const cx of cands) {
        const lx = Math.max(-halfW, Math.min(halfW, cx));
        const off = lx - px;
        let free = look;
        let crossing = 0;
        for (let r = 0; r < found; r++) {
          const j = res[r];
          if (j === p) continue;
          const d = sim.progress[j] - pp;
          if (d < -1 || d > look) continue;
          const xj = sim.x[j];
          // horses right beside us on the way to the target lane (first 6 m sideways) block the move
          if (d < 4) {
            const dir = lx >= px ? 1 : -1;
            const rel = (xj - px) * dir;
            if (rel > -0.6 && rel < Math.min(Math.abs(off), 6) + 0.6 && Math.abs(off) > 0.5) crossing++;
          }
          if (Math.abs(xj - lx) > 1.0 || d < 1) continue;
          const st = sim.state[j];
          if (st === HorseState.FALL) {
            const top = sim.groundY[j] + 0.75;
            if (top < 1.2 && this.canJump) continue; // jumpable
          } else if (st !== HorseState.RECOVER && st !== HorseState.STUMBLE && sim.speed[j] > mySpeed - 1.5) {
            continue; // moving as fast as us: not an obstacle
          }
          if (d < free) free = d;
        }
        let score = free - Math.abs(off) * 0.15 - crossing * 1.2;
        // the outside of a turn is a long way round (~ κ·x of the remaining turn)
        if (this.insideLine && kAhead > 0) score -= lx * kAhead * Math.min(turnLeft, 600) * 0.25;
        if (Math.abs(lx - this.laneTarget) < 0.5) currentScore = score;
        if (score > bestScore) {
          bestScore = score;
          best = lx;
        }
      }
      if (bestScore > currentScore + 2) this.laneTarget = best;
    }

    // jump a downed horse (low enough) ahead in our corridor at the right distance, but
    // only if the landing zone (≈ airtime × speed ahead) is clear of downed horses
    let jump = false;
    let clear = look;
    const jumpAt = 2.4 + mySpeed * 0.18;
    const landAt = mySpeed * 0.78;
    let landingBlocked = false;
    for (let r = 0; r < found; r++) {
      const j = res[r];
      if (j === p || Math.abs(sim.x[j] - px) > 1.4) continue;
      const d = sim.progress[j] - pp;
      if (d <= 0) continue;
      if (sim.state[j] === HorseState.FALL) {
        if (this.canJump && sim.groundY[j] + 0.75 < 1.2 && d > jumpAt - 1.2 && d < jumpAt + 0.8) jump = true;
        if (d > landAt - 3 && d < landAt + 3) landingBlocked = true;
      } else if (d < clear) {
        clear = d;
      }
    }
    if (landingBlocked) jump = false;
    if (jump) this.jumpRequests++;
    let steer = (this.laneTarget - px) * 0.7;
    if (this.noise > 0) {
      this.noisePhase += 0.07;
      steer += this.noise * (Math.sin(this.noisePhase) + 0.5 * Math.sin(this.noisePhase * 2.3 + 1));
    }
    steer = Math.max(-1, Math.min(1, steer));
    const homeStraight = sim.course.length - pp < 220;
    let dash: boolean;
    if (this.dashMode === 'hold') dash = true;
    else if (this.dashMode === 'never') dash = false;
    else {
      const want = (clear > 14 && sim.dashGauge > 0.3) || (homeStraight && sim.dashGauge > 0.25);
      // keep holding while it pays; a new dash needs a fresh press
      dash = sim.dashing ? clear > 7 || homeStraight : want && !this.prevDash;
    }
    this.prevDash = dash;
    return { steer, jump, dash };
  }
}
