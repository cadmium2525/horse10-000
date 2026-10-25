import { Rng, deriveSeed } from '../data/Seed';
import type { CourseSpec } from '../data/Course';
import { COLLISION, FIELD, HORSE, LOD, PLAYER, SIM } from './Config';
import { SpatialHash, resolveCollisions } from './Collision';

/** Horse behaviour states (stored in a Uint8Array). */
export const HorseState = {
  RUN: 0,
  AVOID: 1,
  STUMBLE: 2,
  FALL: 3,
  RECOVER: 4,
  FINISH: 5,
} as const;
export type HorseStateId = (typeof HorseState)[keyof typeof HorseState];
export const STATE_NAMES = ['RUN', 'AVOID', 'STUMBLE', 'FALL', 'RECOVER', 'FINISH'] as const;

/**
 * Simulation LOD layers.
 * A: near the player — individual behaviour, perception/avoid, full contact & fall rules.
 * B: mid range — simple state machine, contact separation, tripping over fallen horses.
 * C: far — no per-horse contact; speed/lane re-decided at low frequency from a
 *    density field ("crowd flow"), rare group-fall events. Position integrates every
 *    tick so motion stays smooth and layer changes never teleport.
 */
export const Layer = { A: 0, B: 1, C: 2 } as const;

/** Per-tick player input (already digitised by PlayerController). */
export interface PlayerIntent {
  /** -1 (left) .. +1 (right) */
  steer: number;
  /** edge-triggered jump request */
  jump: boolean;
  /** dash held */
  dash: boolean;
}

export const NO_INPUT: PlayerIntent = { steer: 0, jump: false, dash: false };

interface GroupEvent {
  x: number;
  p: number;
  r: number;
}

/**
 * All 10,000 horses in Structure-of-Arrays form. Index == horse id; index 0 is the player.
 * Pure logic: no Three.js / DOM dependency, so it can run in tests (and later in a worker).
 */
export class HorseSimulation {
  readonly n: number;
  readonly course: CourseSpec;
  readonly seed: number;

  // --- kinematics ---------------------------------------------------------
  readonly x: Float32Array; // lateral (m)
  readonly progress: Float64Array; // forward distance (m)
  readonly y: Float32Array; // height above ground (jump / bounce)
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly speed: Float32Array; // forward m/s
  readonly prevX: Float32Array;
  readonly prevProgress: Float64Array;
  readonly prevY: Float32Array;

  // --- intent / personality ---------------------------------------------------
  readonly targetSpeed: Float32Array;
  readonly desiredVx: Float32Array;
  readonly baseSpeed: Float32Array;
  readonly laneTarget: Float32Array;
  readonly skill: Float32Array; // 0..1 reaction quality
  readonly paceFreq: Float32Array;
  readonly pacePhase: Float32Array;

  // --- state machine ------------------------------------------------------------
  readonly state: Uint8Array;
  readonly stateTime: Float32Array;
  readonly stateDuration: Float32Array;
  readonly grace: Float32Array;
  readonly fallSide: Int8Array; // roll direction for the tumble animation
  readonly avoidDir: Int8Array;
  readonly fallCount: Uint16Array;
  readonly finished: Uint8Array;
  readonly finishTime: Float32Array; // race seconds, -1 = not finished

  // --- presentation helpers (deterministic, but not used by the rules) ---------------
  readonly gaitPhase: Float32Array;

  // --- LOD --------------------------------------------------------------------------
  readonly layer: Uint8Array;
  /** indices of layer A ∪ B horses this tick (ascending) */
  readonly active: Int32Array;
  activeCount = 0;
  readonly layerCounts = new Int32Array(3);
  radiusA: number = LOD.RADIUS_A_MAX * 0.5;
  radiusB: number = LOD.RADIUS_B_MAX * 0.5;

  // --- crowd density field (all horses, rebuilt each tick) -----------------------------
  readonly densityCols: number;
  readonly densityRows: number;
  readonly densitySMin: number;
  readonly density: Uint16Array;

  // --- player-only state ---------------------------------------------------------------
  dashGauge = 1;
  dashing = false;
  jumpCooldown = 0;

  // --- bookkeeping -----------------------------------------------------------------------
  tick = 0;
  readonly rng: Rng;
  readonly hash: SpatialHash;
  private groupEvents: GroupEvent[] = [];
  /** statistics for debug */
  contactsThisTick = 0;
  fallsTotal = 0;

  constructor(course: CourseSpec, seed: number, n: number = FIELD.HORSES) {
    this.n = n;
    this.course = course;
    this.seed = seed;
    this.rng = new Rng(deriveSeed(seed, 'sim'));

    this.x = new Float32Array(n);
    this.progress = new Float64Array(n);
    this.y = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.speed = new Float32Array(n);
    this.prevX = new Float32Array(n);
    this.prevProgress = new Float64Array(n);
    this.prevY = new Float32Array(n);
    this.targetSpeed = new Float32Array(n);
    this.desiredVx = new Float32Array(n);
    this.baseSpeed = new Float32Array(n);
    this.laneTarget = new Float32Array(n);
    this.skill = new Float32Array(n);
    this.paceFreq = new Float32Array(n);
    this.pacePhase = new Float32Array(n);
    this.state = new Uint8Array(n);
    this.stateTime = new Float32Array(n);
    this.stateDuration = new Float32Array(n);
    this.grace = new Float32Array(n);
    this.fallSide = new Int8Array(n);
    this.avoidDir = new Int8Array(n);
    this.fallCount = new Uint16Array(n);
    this.finished = new Uint8Array(n);
    this.finishTime = new Float32Array(n).fill(-1);
    this.gaitPhase = new Float32Array(n);
    this.layer = new Uint8Array(n).fill(Layer.C);
    this.active = new Int32Array(n);

    this.densityCols = Math.ceil(course.width / LOD.DENSITY_CELL) + 2;
    this.densitySMin = course.sMin;
    this.densityRows = Math.ceil((course.sMax - course.sMin) / LOD.DENSITY_CELL) + 2;
    this.density = new Uint16Array(this.densityCols * this.densityRows);

    this.hash = new SpatialHash(COLLISION.CELL, 4096, n);
    this.setupField();
  }

  // ======================================================================================
  // setup
  // ======================================================================================

  private setupField(): void {
    const rng = new Rng(deriveSeed(this.seed, 'field'));
    const perRow = Math.floor((FIELD.GRID_HALF_WIDTH * 2) / FIELD.GRID_LATERAL_SPACING) + 1;
    const npc = this.n - 1;
    const rows = Math.ceil(npc / perRow);
    for (let k = 0; k < npc; k++) {
      const i = k + 1;
      const row = Math.floor(k / perRow);
      const col = k % perRow;
      const stagger = row & 1 ? FIELD.GRID_LATERAL_SPACING * 0.5 : 0;
      let x = -FIELD.GRID_HALF_WIDTH + col * FIELD.GRID_LATERAL_SPACING + stagger;
      x += rng.range(-FIELD.GRID_JITTER, FIELD.GRID_JITTER);
      if (x > FIELD.GRID_HALF_WIDTH) x -= FIELD.GRID_LATERAL_SPACING;
      // "all horses start with a slight progress difference" -> unique-ish progress per horse
      const p = -row * FIELD.GRID_ROW_SPACING + rng.range(-0.3, 0.3);
      this.x[i] = x;
      this.progress[i] = p;
      this.laneTarget[i] = x;
      // a weak correlation: front rows are slightly faster on average
      const frontBias = 1 - row / rows;
      this.baseSpeed[i] =
        HORSE.NPC_SPEED_MIN + (HORSE.NPC_SPEED_MAX - HORSE.NPC_SPEED_MIN) * (0.75 * rng.next() + 0.25 * frontBias);
      this.skill[i] = rng.range(0.25, 0.95);
      this.paceFreq[i] = rng.range(0.15, 0.45);
      this.pacePhase[i] = rng.range(0, Math.PI * 2);
      this.gaitPhase[i] = rng.range(0, Math.PI * 2);
    }
    // Player: centre, behind the last row -> starts at rank 10,000.
    const p0 = FIELD.PLAYER;
    let minP = Infinity;
    for (let i = 1; i < this.n; i++) if (this.progress[i] < minP) minP = this.progress[i];
    this.x[p0] = 0;
    this.progress[p0] = (this.n > 1 ? minP : 0) - FIELD.PLAYER_BEHIND_LAST_ROW;
    this.laneTarget[p0] = 0;
    this.baseSpeed[p0] = PLAYER.CRUISE_SPEED;
    this.skill[p0] = 1;
    this.prevX.set(this.x);
    this.prevProgress.set(this.progress);
  }

  // ======================================================================================
  // public API
  // ======================================================================================

  get time(): number {
    return this.tick * SIM.DT;
  }

  /** seconds since the gates opened (negative during the start delay) */
  get raceTime(): number {
    return this.time - FIELD.START_DELAY;
  }

  get started(): boolean {
    return this.raceTime >= 0;
  }

  /** Advance exactly one fixed step. Deterministic given (seed, sequence of intents). */
  step(intent: PlayerIntent = NO_INPUT): void {
    this.prevX.set(this.x);
    this.prevProgress.set(this.progress);
    this.prevY.set(this.y);
    this.tick++;
    this.contactsThisTick = 0;

    if (!this.started) {
      for (let i = 0; i < this.n; i++) this.gaitPhase[i] += SIM.DT * 2; // restless idle
      return;
    }

    this.classifyLayers();
    this.buildDensity();
    this.processGroupEvents();

    this.updatePlayer(intent);
    const cPeriod = LOD.C_PERIOD;
    const tick = this.tick;
    for (let i = 1; i < this.n; i++) {
      if (!this.updateStateMachine(i)) continue;
      const layer = this.layer[i];
      if (layer === Layer.C) {
        if ((i + tick) % cPeriod === 0) this.decideFlow(i);
      } else {
        this.decideLocal(i, layer === Layer.A);
      }
    }

    this.integrate();
    resolveCollisions(this);
    this.checkFinish();
  }

  /** Lightweight checksum of the full state (used by determinism tests). */
  checksum(): number {
    let h = 0x811c9dc5;
    const mix = (v: number) => {
      h ^= Math.round(v * 1000) | 0;
      h = Math.imul(h, 0x01000193);
    };
    for (let i = 0; i < this.n; i++) {
      mix(this.x[i]);
      mix(this.progress[i]);
      mix(this.speed[i]);
      mix(this.state[i]);
      mix(this.y[i]);
    }
    return h >>> 0;
  }

  /** Crowd count in the density cell containing (x, s). */
  densityAt(x: number, s: number): number {
    const c = this.densityIndex(x, s);
    return c < 0 ? 0 : this.density[c];
  }

  // ======================================================================================
  // LOD classification
  // ======================================================================================

  private classifyLayers(): void {
    const p0 = FIELD.PLAYER;
    const px = this.x[p0];
    const pp = this.progress[p0];
    const rA2 = this.radiusA * this.radiusA;
    const rB2 = this.radiusB * this.radiusB;
    let a = 0;
    let b = 0;
    let c = 0;
    let k = 0;
    for (let i = 0; i < this.n; i++) {
      const dx = this.x[i] - px;
      const dp = this.progress[i] - pp;
      const d2 = dx * dx + dp * dp;
      let layer: number;
      if (i === p0 || d2 < rA2) {
        layer = Layer.A;
        a++;
      } else if (d2 < rB2) {
        layer = Layer.B;
        b++;
      } else {
        layer = Layer.C;
        c++;
      }
      this.layer[i] = layer;
      if (layer !== Layer.C) this.active[k++] = i;
    }
    this.activeCount = k;
    this.layerCounts[0] = a;
    this.layerCounts[1] = b;
    this.layerCounts[2] = c;

    // Budget-driven radius adaptation: keep layer sizes near their targets
    // regardless of how dense the pack around the player is.
    this.radiusA = adapt(this.radiusA, a, LOD.TARGET_A, LOD.RADIUS_A_MIN, LOD.RADIUS_A_MAX);
    this.radiusB = adapt(this.radiusB, a + b, LOD.TARGET_B, Math.max(LOD.RADIUS_B_MIN, this.radiusA + 8), LOD.RADIUS_B_MAX);
  }

  // ======================================================================================
  // density field
  // ======================================================================================

  private densityIndex(x: number, s: number): number {
    const cell = LOD.DENSITY_CELL;
    const col = Math.floor((x + this.course.width * 0.5) / cell) + 1;
    const row = Math.floor((s - this.densitySMin) / cell) + 1;
    if (col < 0 || col >= this.densityCols || row < 0 || row >= this.densityRows) return -1;
    return row * this.densityCols + col;
  }

  private buildDensity(): void {
    this.density.fill(0);
    for (let i = 0; i < this.n; i++) {
      const c = this.densityIndex(this.x[i], this.progress[i]);
      if (c >= 0) this.density[c]++;
    }
  }

  // ======================================================================================
  // state machine (shared by NPCs and player)
  // ======================================================================================

  /** Advance timers / transitions. Returns true if the horse is in voluntary control. */
  private updateStateMachine(i: number): boolean {
    const dt = SIM.DT;
    this.stateTime[i] += dt;
    if (this.grace[i] > 0) this.grace[i] -= dt;
    const st = this.state[i];
    const t = this.stateTime[i];
    switch (st) {
      case HorseState.FALL:
        this.targetSpeed[i] = 0;
        this.desiredVx[i] = 0;
        if (t >= this.stateDuration[i] && this.y[i] <= 0) this.setState(i, HorseState.RECOVER, HORSE.RECOVER_TIME);
        return false;
      case HorseState.RECOVER:
        this.targetSpeed[i] = this.baseSpeed[i] * 0.55;
        this.desiredVx[i] = 0;
        if (t >= this.stateDuration[i]) {
          this.setState(i, this.finished[i] ? HorseState.FINISH : HorseState.RUN, 0);
          this.grace[i] = HORSE.GRACE_TIME;
          this.laneTarget[i] = this.x[i];
        }
        return false;
      case HorseState.STUMBLE:
        this.targetSpeed[i] = this.baseSpeed[i] * HORSE.STUMBLE_SPEED_FACTOR;
        this.desiredVx[i] *= 0.5;
        if (t >= this.stateDuration[i]) this.setState(i, HorseState.RUN, 0);
        return false;
      case HorseState.FINISH:
        this.targetSpeed[i] = HORSE.FINISH_SPEED;
        this.desiredVx[i] = 0;
        return false;
      case HorseState.AVOID:
        if (t >= this.stateDuration[i]) {
          this.setState(i, HorseState.RUN, 0);
          this.laneTarget[i] = this.x[i];
        }
        return true;
      default:
        return true;
    }
  }

  setState(i: number, s: HorseStateId, duration: number): void {
    this.state[i] = s;
    this.stateTime[i] = 0;
    this.stateDuration[i] = duration;
  }

  /** Start a stumble (no-op if immune or already down). */
  stumble(i: number): void {
    const st = this.state[i];
    if (this.grace[i] > 0 || st === HorseState.FALL || st === HorseState.RECOVER || st === HorseState.STUMBLE) return;
    if (this.y[i] > 0.3) return;
    this.setState(i, HorseState.STUMBLE, HORSE.STUMBLE_TIME * this.rng.range(0.8, 1.2));
  }

  /** Knock a horse over: comedic tumble, auto-recovers after 1–1.6 s (+0.5 s getting up). */
  fall(i: number, side: number = 0): void {
    const st = this.state[i];
    if (this.grace[i] > 0 || st === HorseState.FALL || st === HorseState.RECOVER) return;
    this.setState(i, HorseState.FALL, this.rng.range(HORSE.FALL_TIME_MIN, HORSE.FALL_TIME_MAX));
    this.fallSide[i] = side !== 0 ? (side > 0 ? 1 : -1) : this.rng.sign();
    this.vy[i] = HORSE.FALL_HOP_VY * this.rng.range(0.7, 1.2);
    if (this.y[i] < 0.01) this.y[i] = 0.01;
    this.fallCount[i]++;
    this.fallsTotal++;
  }

  canBeKnocked(i: number): boolean {
    const st = this.state[i];
    return this.grace[i] <= 0 && st !== HorseState.FALL && st !== HorseState.RECOVER;
  }

  isDown(i: number): boolean {
    return this.state[i] === HorseState.FALL;
  }

  // ======================================================================================
  // decisions
  // ======================================================================================

  private pace(i: number): number {
    return 1 + 0.035 * Math.sin(this.time * this.paceFreq[i] + this.pacePhase[i]);
  }

  /** Layer C: low-frequency crowd flow decision based on the density field. */
  private decideFlow(i: number): void {
    const x = this.x[i];
    const p = this.progress[i];
    const cell = LOD.DENSITY_CELL;
    const here = this.densityAt(x, p);
    const ahead = this.densityAt(x, p + cell);
    const left = this.densityAt(x - cell, p + cell);
    const right = this.densityAt(x + cell, p + cell);
    // crowding ahead slows the flow a little (cell capacity ~ 25 horses at grid density)
    const crowd = 1 - clampf((ahead - 14) * 0.012, 0, 0.18);
    this.targetSpeed[i] = this.baseSpeed[i] * crowd * this.pace(i);
    // drift toward the emptier side ahead, but keep loosely to the lane
    let vx = clampf((this.laneTarget[i] - x) * 0.15, -0.6, 0.6);
    if (ahead > 16) vx += left < right ? -0.7 : right < left ? 0.7 : 0;
    this.desiredVx[i] = vx;
    if (Math.abs(this.laneTarget[i] - x) > 3) this.laneTarget[i] = x;

    // rare group falls, more likely in dense regions (far-field "chain reaction" proxy)
    const dens = here / 25;
    if (this.state[i] === HorseState.RUN && this.rng.next() < LOD.C_FALL_HAZARD * dens * dens * LOD.C_PERIOD) {
      this.fall(i);
      this.groupEvents.push({ x, p, r: LOD.C_FALL_CLUSTER_RADIUS * this.rng.range(0.8, 1.6) });
    }
  }

  /** Far-field chain reaction resolved as one cheap group event (no per-pair contacts). */
  private processGroupEvents(): void {
    if (this.groupEvents.length === 0) return;
    const events = this.groupEvents;
    this.groupEvents = [];
    for (const e of events) {
      const r2 = e.r * e.r;
      for (let i = 1; i < this.n; i++) {
        if (this.layer[i] !== Layer.C) continue;
        const dx = this.x[i] - e.x;
        const dp = this.progress[i] - e.p;
        // horses just behind the event are the ones that pile in
        if (dp > 1.5 || dx * dx + dp * dp > r2) continue;
        if (this.state[i] === HorseState.RUN && this.rng.next() < 0.6) this.fall(i, Math.sign(dx));
      }
    }
  }

  /** Layers A/B: per-tick lane keeping; A additionally perceives hazards ahead and AVOIDs. */
  private decideLocal(i: number, perceive: boolean): void {
    this.targetSpeed[i] = this.baseSpeed[i] * this.pace(i);
    if (this.state[i] === HorseState.AVOID) {
      this.desiredVx[i] = this.avoidDir[i] * HORSE.LATERAL_MAX;
      return;
    }
    this.desiredVx[i] = clampf((this.laneTarget[i] - this.x[i]) * 0.6, -1.2, 1.2);
    if (!perceive) return;
    const hazard = this.findHazardAhead(i);
    if (hazard >= 0 && this.rng.next() < this.skill[i] * 0.35) {
      const dx = this.x[i] - this.x[hazard];
      const dir = Math.abs(dx) > 0.05 ? Math.sign(dx) : this.rng.sign();
      this.avoidDir[i] = dir;
      this.setState(i, HorseState.AVOID, this.rng.range(0.4, 0.8));
      this.desiredVx[i] = dir * HORSE.LATERAL_MAX;
    }
  }

  /** Nearest fallen/stumbling/much slower horse in the lane ahead (spatial hash, A only). */
  private findHazardAhead(i: number): number {
    const x = this.x[i];
    const p = this.progress[i];
    const look = COLLISION.LOOKAHEAD;
    let best = -1;
    let bestDp = Infinity;
    const hash = this.hash;
    // hash holds last tick's A∪B membership; lookahead tolerates one tick of staleness
    hash.forEachInRect(x - 1.6, p + 0.5, x + 1.6, p + look, (j) => {
      if (j === i) return;
      const st = this.state[j];
      const slow = this.speed[j] < this.speed[i] - 4;
      if (st !== HorseState.FALL && st !== HorseState.STUMBLE && !slow) return;
      const dp = this.progress[j] - p;
      if (dp <= 0.5 || dp > look) return;
      if (Math.abs(this.x[j] - x) > 1.4) return;
      if (dp < bestDp) {
        bestDp = dp;
        best = j;
      }
    });
    return best;
  }

  // ======================================================================================
  // player
  // ======================================================================================

  private updatePlayer(intent: PlayerIntent): void {
    const i = FIELD.PLAYER;
    const dt = SIM.DT;
    if (this.jumpCooldown > 0) this.jumpCooldown -= dt;
    const inControl = this.updateStateMachine(i);

    // dash gauge (drains while dashing, regenerates otherwise)
    const wantsDash = intent.dash && inControl;
    if (wantsDash && (this.dashing ? this.dashGauge > 0 : this.dashGauge >= PLAYER.DASH_MIN_TO_START)) {
      this.dashing = true;
      this.dashGauge = Math.max(0, this.dashGauge - PLAYER.DASH_DRAIN * dt);
    } else {
      this.dashing = false;
      this.dashGauge = Math.min(1, this.dashGauge + PLAYER.DASH_REGEN * dt);
    }
    if (!inControl) {
      this.dashing = false;
      return;
    }
    this.targetSpeed[i] = this.dashing ? PLAYER.DASH_SPEED : PLAYER.CRUISE_SPEED;
    this.desiredVx[i] = clampf(intent.steer, -1, 1) * PLAYER.LATERAL_MAX;
    if (intent.jump && this.y[i] <= 0 && this.jumpCooldown <= 0) {
      this.vy[i] = PLAYER.JUMP_VY;
      this.y[i] = 0.01;
      this.jumpCooldown = PLAYER.JUMP_COOLDOWN + (2 * PLAYER.JUMP_VY) / HORSE.GRAVITY;
    }
  }

  // ======================================================================================
  // integration
  // ======================================================================================

  private integrate(): void {
    const dt = SIM.DT;
    const half = this.course.width * 0.5 - 0.8;
    const p0 = FIELD.PLAYER;
    for (let i = 0; i < this.n; i++) {
      const st = this.state[i];
      const isPlayer = i === p0;
      // forward speed
      const accel = isPlayer ? PLAYER.ACCEL : HORSE.ACCEL;
      const decel = st === HorseState.FALL ? HORSE.FALL_DECEL : HORSE.DECEL;
      let sp = this.speed[i];
      const dv = this.targetSpeed[i] - sp;
      sp += dv > 0 ? Math.min(dv, accel * dt) : Math.max(dv, -decel * dt);
      if (sp < 0) sp = 0;
      this.speed[i] = sp;

      // lateral
      const latAcc = isPlayer ? PLAYER.LATERAL_ACCEL : HORSE.LATERAL_ACCEL;
      let vx = this.vx[i];
      const dvx = this.desiredVx[i] - vx;
      const maxDv = latAcc * dt;
      vx += dvx > maxDv ? maxDv : dvx < -maxDv ? -maxDv : dvx;
      let x = this.x[i] + vx * dt;
      if (x > half) {
        x = half;
        vx = 0;
      } else if (x < -half) {
        x = -half;
        vx = 0;
      }
      this.vx[i] = vx;
      this.x[i] = x;
      this.progress[i] += sp * dt;

      // vertical (jumps, tumble bounces)
      let y = this.y[i];
      if (y > 0 || this.vy[i] !== 0) {
        let vy = this.vy[i] - HORSE.GRAVITY * dt;
        y += vy * dt;
        if (y <= 0) {
          y = 0;
          if (st === HorseState.FALL && vy < -2) vy = -vy * HORSE.FALL_RESTITUTION;
          else vy = 0;
        }
        this.vy[i] = vy;
        this.y[i] = y;
      }

      // gait animation phase (~0.8 rad per metre at a gallop); kicks wildly while down
      this.gaitPhase[i] += st === HorseState.FALL ? 14 * dt : sp * 0.8 * dt;
    }
  }

  private checkFinish(): void {
    const L = this.course.length;
    for (let i = 0; i < this.n; i++) {
      if (this.finished[i] || this.progress[i] < L) continue;
      this.finished[i] = 1;
      // interpolate the crossing inside the tick for a precise, tie-resistant time
      const over = this.progress[i] - L;
      const travelled = this.progress[i] - this.prevProgress[i];
      const frac = travelled > 0 ? over / travelled : 0;
      this.finishTime[i] = this.raceTime - frac * SIM.DT;
      const st = this.state[i];
      if (st === HorseState.RUN || st === HorseState.AVOID || st === HorseState.STUMBLE) {
        this.setState(i, HorseState.FINISH, 0);
      }
    }
  }
}

function clampf(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function adapt(r: number, count: number, target: number, lo: number, hi: number): number {
  if (count > target * 1.15) r *= 0.97;
  else if (count < target * 0.85) r *= 1.03;
  return r < lo ? lo : r > hi ? hi : r;
}
