import { Rng, deriveSeed } from '../data/Seed';
import type { CourseSpec } from '../data/Course';
import { COLLISION, DEFAULT_TUNING, FIELD, HORSE, LOD, PLAYER, SIM, type SimTuning } from './Config';
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
 * B: mid range — simple state machine, coarse avoid, contact separation, tripping over
 *    fallen horses (reduced odds).
 * C: far — no pairwise contact. Speed/lane re-decided at low frequency from a density
 *    field ("crowd flow"), plus a per-tick car-following cap against the horse ahead in
 *    the same/adjacent lane, so crowds never overlap and entering B/A never teleports.
 *    Rare group-fall events stand in for far-field chain reactions.
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
  readonly tuning: SimTuning;

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
  /** chain-reaction generation of the current/last fall (0 = spontaneous) */
  readonly chainGen: Uint8Array;
  /** seconds until this horse may be rolled for another accident */
  readonly eventCooldown: Float32Array;

  // --- presentation helpers (deterministic, but not used by the rules) ---------------
  readonly gaitPhase: Float32Array;

  // --- LOD --------------------------------------------------------------------------
  readonly layer: Uint8Array;
  /** ticks since the horse entered A/B (capped at 255; 0 while in C) */
  readonly layerAge: Uint8Array;
  /** indices of layer A ∪ B horses this tick (ascending) */
  readonly active: Int32Array;
  activeCount = 0;
  readonly layerCounts = new Int32Array(3);
  radiusA = 0;
  radiusB = 0;
  private radiiInitialised = false;

  // --- crowd density field (all horses, rebuilt each tick) -----------------------------
  readonly densityCols: number;
  readonly densityRows: number;
  readonly densitySMin: number;
  readonly density: Uint16Array;

  // --- ordering / lanes (layer C car-following) ----------------------------------------
  /** all horses sorted by progress, descending (maintained incrementally) */
  readonly order: Int32Array;
  readonly laneCount: number;
  readonly laneOf: Int16Array;
  readonly laneStart: Int32Array;
  readonly laneList: Int32Array;
  readonly posInLane: Int32Array;
  private readonly laneCursor: Int32Array;
  /** progress / x copied in lane order (cache-friendly follow scan) */
  private readonly laneP: Float64Array;
  private readonly laneX: Float32Array;
  /** per-tick speed cap from car-following (layer C) */
  readonly followCap: Float32Array;
  /** 1 when the car-following cap is restricting this horse (used to trigger lane changes) */
  readonly blocked: Uint8Array;

  // --- player-only state ---------------------------------------------------------------
  dashGauge = 1;
  dashing = false;
  jumpCooldown = 0;

  // --- bookkeeping -----------------------------------------------------------------------
  tick = 0;
  readonly rng: Rng;
  readonly hash: SpatialHash;
  private groupEvents: GroupEvent[] = [];
  /** statistics for debug / tests */
  contactsThisTick = 0;
  fallsTotal = 0;
  /** falls caused by tripping over another fallen horse (chain reactions, layers A/B) */
  tripFalls = 0;
  /** largest positional correction applied by contact resolution this tick (m) */
  maxCorrectionThisTick = 0;
  /** per-horse correction used this tick (collision budget) */
  readonly corrUsed: Float32Array;

  constructor(course: CourseSpec, seed: number, n: number = FIELD.HORSES, tuning?: Partial<SimTuning>) {
    this.n = n;
    this.course = course;
    this.seed = seed;
    this.tuning = { ...DEFAULT_TUNING, ...tuning };
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
    this.chainGen = new Uint8Array(n);
    this.eventCooldown = new Float32Array(n);
    this.gaitPhase = new Float32Array(n);
    this.layer = new Uint8Array(n).fill(Layer.C);
    this.layerAge = new Uint8Array(n);
    this.active = new Int32Array(n);
    this.corrUsed = new Float32Array(n);

    this.densityCols = Math.ceil(course.width / LOD.DENSITY_CELL) + 2;
    this.densitySMin = course.sMin;
    this.densityRows = Math.ceil((course.sMax - course.sMin) / LOD.DENSITY_CELL) + 2;
    this.density = new Uint16Array(this.densityCols * this.densityRows);

    this.order = new Int32Array(n);
    this.laneCount = Math.ceil(course.width / LOD.LANE_WIDTH) + 2;
    this.laneOf = new Int16Array(n);
    this.laneStart = new Int32Array(this.laneCount + 1);
    this.laneList = new Int32Array(n);
    this.posInLane = new Int32Array(n);
    this.laneCursor = new Int32Array(this.laneCount);
    this.laneP = new Float64Array(n);
    this.laneX = new Float32Array(n);
    this.followCap = new Float32Array(n).fill(Infinity);
    this.blocked = new Uint8Array(n);

    this.hash = new SpatialHash(COLLISION.CELL, 4096, n);
    this.setupField();
    // initial global order (later maintained incrementally by insertion sort)
    const idx = Array.from({ length: n }, (_, i) => i);
    idx.sort((a, b) => this.progress[b] - this.progress[a] || a - b);
    this.order.set(idx);
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
      const p = -row * FIELD.GRID_ROW_SPACING + rng.range(-FIELD.GRID_PROGRESS_JITTER, FIELD.GRID_PROGRESS_JITTER);
      this.x[i] = x;
      this.progress[i] = p;
      this.laneTarget[i] = x;
      // a weak correlation: front rows are slightly faster on average
      const frontBias = rows > 1 ? 1 - row / (rows - 1) : 1;
      const fb = HORSE.FRONT_BIAS;
      this.baseSpeed[i] =
        HORSE.NPC_SPEED_MIN + (HORSE.NPC_SPEED_MAX - HORSE.NPC_SPEED_MIN) * ((1 - fb) * rng.next() + fb * frontBias);
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

  /** Global accident multiplier: master knob × start ramp (no carnage right off the gate). */
  accidentScale(): number {
    const g = this.tuning.startGrace;
    const t = this.raceTime;
    const ramp = g > 0 ? Math.min(1, 0.15 + (0.85 * Math.max(0, t)) / g) : 1;
    return this.tuning.accidentRate * ramp;
  }

  /** Advance exactly one fixed step. Deterministic given (seed, tuning, sequence of intents). */
  step(intent: PlayerIntent = NO_INPUT): void {
    this.prevX.set(this.x);
    this.prevProgress.set(this.progress);
    this.prevY.set(this.y);
    this.tick++;
    this.contactsThisTick = 0;
    this.maxCorrectionThisTick = 0;

    if (!this.started) {
      for (let i = 0; i < this.n; i++) this.gaitPhase[i] += SIM.DT * 2; // restless idle
      return;
    }

    this.classifyLayers();
    this.buildDensity();
    this.sortOrder();
    this.buildLanes();
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
        this.decideLocal(i, layer);
      }
    }

    this.computeFollowCaps();
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
    if (!this.radiiInitialised) this.initRadii(px, pp);
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
      if (layer !== Layer.C) {
        this.active[k++] = i;
        if (this.layerAge[i] < 255) this.layerAge[i]++;
      } else {
        this.layerAge[i] = 0;
      }
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

  /** First classification: pick radii exactly from a distance histogram (no start-up bloat). */
  private initRadii(px: number, pp: number): void {
    const hist = new Int32Array(LOD.RADIUS_B_MAX + 1);
    for (let i = 0; i < this.n; i++) {
      const dx = this.x[i] - px;
      const dp = this.progress[i] - pp;
      const d = Math.sqrt(dx * dx + dp * dp);
      hist[Math.min(LOD.RADIUS_B_MAX, d | 0)]++;
    }
    let cum = 0;
    let rA = LOD.RADIUS_A_MAX;
    let rB = LOD.RADIUS_B_MAX;
    let doneA = false;
    for (let r = 0; r <= LOD.RADIUS_B_MAX; r++) {
      cum += hist[r];
      if (!doneA && cum >= LOD.TARGET_A) {
        rA = r + 1;
        doneA = true;
      }
      if (cum >= LOD.TARGET_B) {
        rB = r + 1;
        break;
      }
    }
    this.radiusA = clampf(rA, LOD.RADIUS_A_MIN, LOD.RADIUS_A_MAX);
    this.radiusB = clampf(rB, Math.max(LOD.RADIUS_B_MIN, this.radiusA + 8), LOD.RADIUS_B_MAX);
    this.radiiInitialised = true;
  }

  // ======================================================================================
  // density field, ordering, lanes
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

  /** Insertion sort on the previous order: O(N + overtakes) per tick, deterministic. */
  private sortOrder(): void {
    const o = this.order;
    const p = this.progress;
    for (let k = 1; k < o.length; k++) {
      const v = o[k];
      const pv = p[v];
      let j = k - 1;
      while (j >= 0 && (p[o[j]] < pv || (p[o[j]] === pv && o[j] > v))) {
        o[j + 1] = o[j];
        j--;
      }
      o[j + 1] = v;
    }
  }

  laneIndex(x: number): number {
    const l = Math.floor((x + this.course.width * 0.5) / LOD.LANE_WIDTH) + 1;
    return l < 0 ? 0 : l >= this.laneCount ? this.laneCount - 1 : l;
  }

  /** Stable counting sort of `order` into per-lane lists (each sorted by progress desc). */
  private buildLanes(): void {
    const start = this.laneStart;
    start.fill(0);
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const l = this.laneIndex(this.x[i]);
      this.laneOf[i] = l;
      start[l + 1]++;
    }
    for (let l = 1; l <= this.laneCount; l++) start[l] += start[l - 1];
    const cur = this.laneCursor;
    cur.set(start.subarray(0, this.laneCount));
    for (let k = 0; k < n; k++) {
      const i = this.order[k];
      const l = this.laneOf[i];
      const pos = cur[l]++;
      this.laneList[pos] = i;
      this.posInLane[i] = pos;
      this.laneP[pos] = this.progress[i];
      this.laneX[pos] = this.x[i];
    }
  }

  /** true if no other horse occupies the slot (x, p ± LANE_CHANGE_CLEAR) — lane lists, O(log n) */
  slotFree(x: number, p: number, exclude: number): boolean {
    const w = HORSE.HALF_WIDTH * 2;
    const clear = LOD.LANE_CHANGE_CLEAR;
    const l0 = this.laneIndex(x - w);
    const l1 = this.laneIndex(x + w);
    for (let l = l0; l <= l1; l++) {
      const a = this.laneStart[l];
      const b = this.laneStart[l + 1];
      // first index with progress <= p + clear (descending list)
      let lo = a;
      let hi = b;
      const top = p + clear;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.laneP[mid] > top) lo = mid + 1;
        else hi = mid;
      }
      for (let k = lo; k < b; k++) {
        if (this.laneP[k] < p - clear) break;
        const j = this.laneList[k];
        if (j !== exclude && Math.abs(this.x[j] - x) < w) return false;
      }
    }
    return true;
  }

  /** Try a one-body lane change towards `pref`, else the other side. */
  private tryLaneChange(i: number, pref: number): void {
    const x = this.x[i];
    const p = this.progress[i];
    const step = HORSE.HALF_WIDTH * 2;
    const half = this.course.width * 0.5 - 1;
    for (const side of [pref, -pref]) {
      const nx = x + side * step;
      if (nx < -half || nx > half) continue;
      if (this.slotFree(nx, p, i)) {
        this.laneTarget[i] = nx;
        return;
      }
    }
  }

  /**
   * Car-following. For every horse, the leader is the nearest horse ahead that overlaps it
   * laterally, taken from its own lane and both adjacent lanes (two-pointer walk: lanes are
   * sorted, so O(N) overall).
   * Layer C: hard speed cap so the gap to the leader never closes.
   * Layers A/B: the cap only lowers the *target* speed (accel-limited), so NPCs queue
   * naturally but can still be bumped / tripped by real contacts.
   */
  private computeFollowCaps(): void {
    const minGap = LOD.FOLLOW_MIN_GAP;
    const T = LOD.FOLLOW_HEADWAY;
    const look = LOD.FOLLOW_DIST;
    const w = HORSE.HALF_WIDTH * 2 - 0.05; // barely touching flanks do not block
    const alongside = HORSE.HALF_LENGTH;
    const { laneStart, laneList, laneP, laneX, x, state, speed, layer, targetSpeed, followCap, blocked } = this;
    const nl = this.laneCount;
    for (let l = 0; l < nl; l++) {
      const a = laneStart[l];
      const b = laneStart[l + 1];
      if (a === b) continue;
      // pointers into the neighbour lanes: index of first entry with progress <= p
      let pl = l > 0 ? laneStart[l - 1] : 0;
      const plEnd = l > 0 ? laneStart[l] : 0;
      const plStart = pl;
      let pr = l + 1 < nl ? laneStart[l + 1] : 0;
      const prEnd = l + 1 < nl ? laneStart[l + 2] : 0;
      const prStart = pr;
      for (let k = a; k < b; k++) {
        const i = laneList[k];
        const p = laneP[k];
        while (pl < plEnd && laneP[pl] > p) pl++;
        while (pr < prEnd && laneP[pr] > p) pr++;
        if (i === FIELD.PLAYER) continue;
        let best = -1;
        let bestDp: number = look;
        let beside = -1; // overlapping horse that is alongside rather than ahead
        const xi = laneX[k];
        for (let m = k - 1; m >= a; m--) {
          const dp = laneP[m] - p;
          if (dp >= bestDp) break;
          const j = laneList[m];
          if (dp < alongside) {
            if (beside < 0) beside = j;
            continue;
          }
          best = j;
          bestDp = dp;
          break;
        }
        // both adjacent lanes: lane width == horse width, so either can hold an overlapping horse
        for (let side = 0; side < 2; side++) {
          const from = side === 0 ? pl - 1 : pr - 1;
          const stop = side === 0 ? plStart : prStart;
          for (let m = from; m >= stop; m--) {
            const dp = laneP[m] - p;
            if (dp >= bestDp) break;
            if (Math.abs(laneX[m] - xi) >= w) continue;
            const j = laneList[m];
            if (dp < alongside) {
              if (beside < 0) beside = j;
              continue;
            }
            best = j;
            bestDp = dp;
            break;
          }
        }
        // far field: side-by-side overlaps are eased apart laterally (no braking deadlock)
        if (beside >= 0 && layer[i] === Layer.C) {
          const d = x[i] - x[beside];
          x[i] += (d > 0 || (d === 0 && i > beside) ? 1 : -1) * LOD.SIDE_NUDGE;
        }
        if (best < 0) {
          followCap[i] = Infinity;
          blocked[i] = 0;
          continue;
        }
        const lenI = state[i] === HorseState.FALL ? HORSE.FALLEN_HALF_LENGTH : HORSE.HALF_LENGTH;
        const lenJ = state[best] === HorseState.FALL ? HORSE.FALLEN_HALF_LENGTH : HORSE.HALF_LENGTH;
        const gap = bestDp - lenI - lenJ;
        const lead = speed[best];
        const leadGain = targetSpeed[best] - lead;
        const anticipate = leadGain > 0 ? (leadGain < LOD.FOLLOW_ANTICIPATE ? leadGain : LOD.FOLLOW_ANTICIPATE) : 0;
        let cap = lead + anticipate + (gap - minGap) / T;
        // brake firmly but not to a standstill on a transient overlap (prevents jam waves)
        const floor = lead - LOD.FOLLOW_MAX_BRAKE;
        if (cap < floor) cap = floor;
        if (cap < 0) cap = 0;
        // "stuck behind a slower horse" -> layer C flow looks for a way round
        blocked[i] = gap < 3 && targetSpeed[best] < targetSpeed[i] * 0.97 ? 1 : 0;
        if (layer[i] === Layer.C) {
          followCap[i] = cap;
        } else {
          followCap[i] = Infinity;
          const st = state[i];
          if ((st === HorseState.RUN || st === HorseState.AVOID) && cap < targetSpeed[i]) targetSpeed[i] = cap;
        }
      }
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
    if (this.eventCooldown[i] > 0) this.eventCooldown[i] -= dt;
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

  /**
   * Knock a horse over: comedic tumble, auto-recovers after 1–1.6 s (+0.5 s getting up).
   * `gen` is the chain-reaction generation (0 = spontaneous / seeded).
   */
  fall(i: number, side: number = 0, gen: number = 0): void {
    const st = this.state[i];
    if (this.grace[i] > 0 || st === HorseState.FALL || st === HorseState.RECOVER) return;
    this.setState(i, HorseState.FALL, this.rng.range(HORSE.FALL_TIME_MIN, HORSE.FALL_TIME_MAX));
    this.fallSide[i] = side !== 0 ? (side > 0 ? 1 : -1) : this.rng.sign();
    this.vy[i] = HORSE.FALL_HOP_VY * this.rng.range(0.7, 1.2);
    if (this.y[i] < 0.01) this.y[i] = 0.01;
    this.chainGen[i] = gen > 255 ? 255 : gen;
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
    return 1 + HORSE.PACE_AMPLITUDE * Math.sin(this.time * this.paceFreq[i] + this.pacePhase[i]);
  }

  /** Layer C: low-frequency crowd flow decision based on the density field. */
  private decideFlow(i: number): void {
    const x = this.x[i];
    const p = this.progress[i];
    const cell = LOD.DENSITY_CELL;
    const ref = LOD.DENSITY_REF;
    const here = this.densityAt(x, p);
    const ahead = this.densityAt(x, p + cell);
    const left = this.densityAt(x - cell, p + cell);
    const right = this.densityAt(x + cell, p + cell);
    // crowding ahead slows the flow a little
    const crowd = 1 - clampf((ahead / ref - 0.5) * 0.25, 0, 0.15);
    this.targetSpeed[i] = this.baseSpeed[i] * crowd * this.pace(i);
    // stuck behind a slower horse: change lane by one body width if (and only if) there is room
    if (this.blocked[i] && Math.abs(this.laneTarget[i] - x) < 0.2) {
      const pref = left < right ? -1 : right < left ? 1 : i & 1 ? 1 : -1;
      this.tryLaneChange(i, pref);
    }
    this.desiredVx[i] = clampf((this.laneTarget[i] - x) * 1.2, -1.0, 1.0);

    // rare group falls, more likely in dense regions (far-field "chain reaction" proxy)
    const dens = here / ref;
    const hz = LOD.C_FALL_HAZARD * dens * dens * LOD.C_PERIOD * this.accidentScale();
    if (this.state[i] === HorseState.RUN && this.rng.next() < hz) {
      this.fall(i, 0, 0);
      this.groupEvents.push({ x, p, r: LOD.C_FALL_CLUSTER_RADIUS * this.rng.range(0.8, 1.6) });
    }
  }

  /**
   * Far-field chain reaction resolved as one cheap group event (no per-pair contacts).
   * Only horses in the event's progress window are visited (binary search on `order`).
   */
  private processGroupEvents(): void {
    if (this.groupEvents.length === 0) return;
    const events = this.groupEvents;
    this.groupEvents = [];
    const o = this.order;
    for (const e of events) {
      const r2 = e.r * e.r;
      const pHi = e.p + 1.5;
      const pLo = e.p - e.r;
      // first index with progress <= pHi (order is descending)
      let lo = 0;
      let hi = o.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.progress[o[mid]] > pHi) lo = mid + 1;
        else hi = mid;
      }
      for (let k = lo; k < o.length; k++) {
        const i = o[k];
        const dp = this.progress[i] - e.p;
        if (this.progress[i] < pLo) break;
        if (i === FIELD.PLAYER || this.layer[i] !== Layer.C) continue;
        const dx = this.x[i] - e.x;
        // horses just behind the event are the ones that pile in
        if (dx * dx + dp * dp > r2) continue;
        if (this.state[i] === HorseState.RUN && this.rng.next() < 0.6) this.fall(i, Math.sign(dx), 1);
      }
    }
  }

  /** Layers A/B: lane keeping; both perceive hazards ahead and AVOID (B coarser/less often). */
  private decideLocal(i: number, layer: number): void {
    this.targetSpeed[i] = this.baseSpeed[i] * this.pace(i);
    if (this.state[i] === HorseState.AVOID) {
      this.desiredVx[i] = this.avoidDir[i] * HORSE.LATERAL_MAX;
      return;
    }
    if (this.blocked[i] && Math.abs(this.laneTarget[i] - this.x[i]) < 0.2 && (i + this.tick) % 6 === 0) {
      // stuck behind a slower horse: move one body to the emptier side if there is room
      const l = this.densityAt(this.x[i] - LOD.DENSITY_CELL, this.progress[i] + LOD.DENSITY_CELL);
      const r = this.densityAt(this.x[i] + LOD.DENSITY_CELL, this.progress[i] + LOD.DENSITY_CELL);
      this.tryLaneChange(i, l < r ? -1 : r < l ? 1 : i & 1 ? 1 : -1);
    }
    this.desiredVx[i] = clampf((this.laneTarget[i] - this.x[i]) * 0.6, -1.2, 1.2);
    const isA = layer === Layer.A;
    if (this.state[i] === HorseState.RUN) this.maybeMisstep(i);
    if (!isA && (i + this.tick) % COLLISION.B_PERCEIVE_PERIOD !== 0) return;
    const hazard = this.findHazardAhead(i);
    if (hazard < 0) return;
    const react = this.skill[i] * this.tuning.avoidSkill * (isA ? 0.35 : 0.35 * COLLISION.B_PERCEIVE_PERIOD * 0.8);
    if (this.rng.next() < react) {
      const dx = this.x[i] - this.x[hazard];
      const dir = Math.abs(dx) > 0.05 ? Math.sign(dx) : this.rng.sign();
      this.avoidDir[i] = dir;
      this.setState(i, HorseState.AVOID, this.rng.range(0.4, 0.8));
      this.desiredVx[i] = dir * HORSE.LATERAL_MAX;
    }
  }

  /** Spontaneous misstep (A/B): density-driven, never right in front of the player. */
  private maybeMisstep(i: number): void {
    const dens = this.densityAt(this.x[i], this.progress[i]) / LOD.DENSITY_REF;
    const hz = COLLISION.MISSTEP_HAZARD * SIM.DT * dens * dens * this.accidentScale();
    if (this.rng.next() >= hz) return;
    const p0 = FIELD.PLAYER;
    const dp = this.progress[i] - this.progress[p0];
    if (dp > -2 && dp < COLLISION.SAFE_AHEAD && Math.abs(this.x[i] - this.x[p0]) < COLLISION.SAFE_SIDE) return;
    if (this.rng.next() < COLLISION.MISSTEP_FALL_SHARE) this.fall(i, 0, 0);
    else this.stumble(i);
  }

  /** Nearest fallen/stumbling/much slower horse in the lane ahead (spatial hash). */
  private findHazardAhead(i: number): number {
    const x = this.x[i];
    const p = this.progress[i];
    const look = COLLISION.LOOKAHEAD;
    let best = -1;
    let bestDp = Infinity;
    // hash holds last tick's A∪B membership; lookahead tolerates one tick of staleness
    this.hash.forEachInRect(x - 1.6, p + 0.5, x + 1.6, p + look, (j) => {
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
      // car-following (layer C only; Infinity elsewhere). Hard cap: far away, invisible.
      const cap = this.followCap[i];
      if (sp > cap) sp = cap;
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
  if (count > target * 1.15) r *= 0.96;
  else if (count < target * 0.85) r *= 1.04;
  return r < lo ? lo : r > hi ? hi : r;
}
