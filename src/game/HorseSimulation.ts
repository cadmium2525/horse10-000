import { Rng, deriveSeed } from '../data/Seed';
import type { CourseSpec } from '../data/Course';
import { COLLISION, DEFAULT_TUNING, DIRECTOR, FIELD, HORSE, LOD, PLAYER, SIM, type SimTuning } from './Config';
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
  /** scripted (director) events also knock over near-field horses */
  allLayers?: boolean;
  /** probability per horse in the radius */
  chance?: number;
  /** multiplier on the time spent down */
  downScale?: number;
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
  /**
   * resting height of a downed horse: 0 on the turf, > 0 when it landed on other downed
   * horses ("horse pile", design §4). Low piles can be jumped, tall ones must be avoided.
   */
  readonly groundY: Float32Array;

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
  /** position of each horse in `order` (0 = leader) */
  readonly orderPos: Int32Array;
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
  /**
   * position in a queue of slow horses: 1 = directly behind a downed/stumbling or very slow
   * horse, 2 = behind such a follower, ... (0 = not queued). Braking only chains to depth 2;
   * deeper horses keep rolling and squeeze round, so standing jams cannot form.
   */
  readonly queueDepth: Uint8Array;
  /** seconds a queued horse has been (nearly) stopped — impatience triggers a squeeze */
  readonly queueTime: Float32Array;
  /** the downed/slow horse a queued horse is detouring around (-1 = none) */
  readonly detourFrom: Int32Array;

  // --- player-only state ---------------------------------------------------------------
  dashGauge = 1;
  dashing = false;
  jumpCooldown = 0;
  /** dash pressed last tick (a new dash needs a fresh press) */
  private dashHeldPrev = false;
  /** seconds of "out of breath" after running the gauge dry (cruise × WINDED_FACTOR) */
  winded = 0;
  /** dash requested but blocked by an upright horse right ahead (speed bonus lost, gauge drains) */
  dashBlocked = false;
  /** post-jump acceleration boost remaining (s) */
  boostTime = 0;
  /** the current jump has passed over a downed horse */
  private clearedThisJump = false;
  private wasAirborne = false;
  /** stats: jumps that cleared a downed horse / pile and landed safely; near misses; passes */
  jumpsCleared = 0;
  nearMisses = 0;
  playerPasses = 0;
  /** jump presses that actually launched a jump */
  jumpsTaken = 0;

  // --- bookkeeping -----------------------------------------------------------------------
  tick = 0;
  readonly rng: Rng;
  readonly hash: SpatialHash;
  private groupEvents: GroupEvent[] = [];
  /** scripted accident schedule (race seconds), seeded */
  readonly directorTimes: number[] = [];
  private directorNext = 0;
  /** stats: scripted accidents that fired */
  directorEvents = 0;
  /** statistics for debug / tests */
  contactsThisTick = 0;
  fallsTotal = 0;
  /** falls caused by tripping over another fallen horse (chain reactions, layers A/B) */
  tripFalls = 0;
  /** NPC hops over downed horses (stat) */
  hops = 0;
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
    this.groundY = new Float32Array(n);
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
    this.orderPos = new Int32Array(n);
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
    this.queueDepth = new Uint8Array(n);
    this.detourFrom = new Int32Array(n).fill(-1);
    this.queueTime = new Float32Array(n);

    this.hash = new SpatialHash(COLLISION.CELL, 4096, n);
    this.setupField();
    const dr = new Rng(deriveSeed(seed, 'director'));
    for (let t = dr.range(DIRECTOR.FIRST_MIN, DIRECTOR.FIRST_MAX); t < 200; t += dr.range(DIRECTOR.GAP_MIN, DIRECTOR.GAP_MAX)) {
      this.directorTimes.push(t);
    }
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
    // walk grid slots row by row; behind the first rows, slots inside the "streak" corridors
    // stay empty (design: 中団に隙間の筋 — readable lines a skilled player can run through)
    const xs: number[] = [];
    const rowsOf: number[] = [];
    for (let row = 0; xs.length < npc; row++) {
      const stagger = row & 1 ? FIELD.GRID_LATERAL_SPACING * 0.5 : 0;
      for (let col = 0; col < perRow && xs.length < npc; col++) {
        let x = -FIELD.GRID_HALF_WIDTH + col * FIELD.GRID_LATERAL_SPACING + stagger;
        if (x > FIELD.GRID_HALF_WIDTH) x -= FIELD.GRID_LATERAL_SPACING;
        if (row >= FIELD.CORRIDOR_FROM_ROW && inCorridor(x)) continue;
        xs.push(x);
        rowsOf.push(row);
      }
    }
    const rows = rowsOf[rowsOf.length - 1] + 1;
    for (let k = 0; k < npc; k++) {
      const i = k + 1;
      const row = rowsOf[k];
      let x = xs[k];
      x += rng.range(-FIELD.GRID_JITTER, FIELD.GRID_JITTER);
      // "all horses start with a slight progress difference" -> unique-ish progress per horse
      const p = -row * FIELD.GRID_ROW_SPACING + rng.range(-FIELD.GRID_PROGRESS_JITTER, FIELD.GRID_PROGRESS_JITTER);
      this.x[i] = x;
      this.progress[i] = p;
      this.laneTarget[i] = x;
      // front rows are faster on average
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
      this.warmUp();
      return;
    }

    this.classifyLayers();
    this.buildDensity();
    this.sortOrder();
    this.buildLanes();
    if (this.directorNext < this.directorTimes.length && this.raceTime >= this.directorTimes[this.directorNext]) {
      this.directorNext++;
      if (this.n > 1000) this.directorAccident();
    }
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
    this.planDetours();
    this.integrate();
    resolveCollisions(this);
    this.playerPassBookkeeping(FIELD.PLAYER);
    this.checkFinish();
  }

  /**
   * Countdown: run the per-tick pipeline on the standing grid (no integration, no RNG use)
   * so the JIT has optimised it before the gates open — otherwise the first second of the
   * race shows 10–30 ms spikes. Horses are stationary and non-overlapping, so this changes
   * no state that the race depends on except caches that are rebuilt every tick anyway.
   */
  private warmUp(): void {
    this.classifyLayers();
    this.buildDensity();
    this.sortOrder();
    this.buildLanes();
    this.computeFollowCaps();
    resolveCollisions(this);
    // leave per-horse decision state exactly as at construction
    this.followCap.fill(Infinity);
    this.blocked.fill(0);
    this.queueDepth.fill(0);
    this.queueTime.fill(0);
    this.detourFrom.fill(-1);
    this.targetSpeed.fill(0);
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
    const pos = this.orderPos;
    for (let k = 0; k < o.length; k++) pos[o[k]] = k;
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

  /** true if no other horse occupies the slot [p - behind, p + ahead] at x — lane lists, O(log n) */
  slotFree(x: number, p: number, exclude: number, behind: number = LOD.LANE_CHANGE_CLEAR, ahead: number = LOD.LANE_CHANGE_CLEAR): boolean {
    const w = HORSE.HALF_WIDTH * 2;
    const l0 = this.laneIndex(x - w);
    const l1 = this.laneIndex(x + w);
    for (let l = l0; l <= l1; l++) {
      const a = this.laneStart[l];
      const b = this.laneStart[l + 1];
      // first index with progress <= p + clear (descending list)
      let lo = a;
      let hi = b;
      const top = p + ahead;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.laneP[mid] > top) lo = mid + 1;
        else hi = mid;
      }
      for (let k = lo; k < b; k++) {
        if (this.laneP[k] < p - behind) break;
        const j = this.laneList[k];
        if (j !== exclude && Math.abs(this.x[j] - x) < w) return false;
      }
    }
    return true;
  }

  /**
   * Try a lane change of one (then, if `wide`, two) body widths towards `pref`, else the
   * other side. Returns true if a free slot was found.
   */
  private tryLaneChange(i: number, pref: number, wide = false): boolean {
    const x = this.x[i];
    const p = this.progress[i];
    const step = HORSE.HALF_WIDTH * 2;
    const half = this.course.width * 0.5 - 1;
    const maxK = wide ? 2 : 1;
    for (let k = 1; k <= maxK; k++) {
      for (let s = 0; s < 2; s++) {
        const side = s === 0 ? pref : -pref;
        const nx = x + side * step * k;
        if (nx < -half || nx > half) continue;
        // lane changes keep the streak corridors open
        if (inCorridor(nx)) continue;
        if (wide ? this.slotFree(nx, p, i, 1.2, 2.4) : this.slotFree(nx, p, i)) {
          this.laneTarget[i] = nx;
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Detours (design §4: resolve blockages). Horses queued behind a downed horse steer round
   * it immediately (up to two body widths, every tick until a slot is found) instead of
   * waiting; ordinary "stuck behind a slower horse" cases re-try every few ticks.
   */
  private planDetours(): void {
    const { blocked, laneTarget, x, desiredVx, layer, state } = this;
    const tick = this.tick;
    for (let i = 1; i < this.n; i++) {
      const b = blocked[i];
      if (b === 0) continue;
      const st = state[i];
      if (st !== HorseState.RUN && st !== HorseState.AVOID) continue;
      const settled = Math.abs(laneTarget[i] - x[i]) < 0.2;
      if (b === 2) {
        // near field: a horse arriving at speed may simply hop over a low downed horse
        const lead = this.detourFrom[i];
        if (
          layer[i] !== Layer.C &&
          lead >= 0 &&
          state[lead] === HorseState.FALL &&
          this.y[i] <= 0 &&
          (this.speed[i] > 7 || this.queueTime[i] > LOD.CLIMB_AFTER) &&
          this.eventCooldown[i] <= 0
        ) {
          // (a horse stuck behind a pile for a while scrambles over it — comedic, and it
          // keeps the queue moving)
          const dp = this.progress[lead] - this.progress[i];
          if (dp > 2.2 && dp < 5.5) {
            this.eventCooldown[i] = COLLISION.EVENT_COOLDOWN;
            if (this.rng.next() < this.skill[i] * LOD.NPC_HOP_CHANCE * this.tuning.avoidSkill) {
              this.vy[i] = LOD.NPC_HOP_VY;
              this.y[i] = 0.01;
              this.hops++;
              continue;
            }
          }
        }
        if (settled && (i + tick) % 3 === 0) {
          const lead = this.detourFrom[i];
          const d = lead >= 0 ? x[i] - x[lead] : 0;
          const pref = d > 0.05 ? 1 : d < -0.05 ? -1 : i & 1 ? 1 : -1;
          if (
            !this.tryLaneChange(i, pref, true) &&
            layer[i] !== Layer.C &&
            (this.queueDepth[i] > 2 || this.queueTime[i] > LOD.QUEUE_PATIENCE)
          ) {
            // deep in a queue and boxed in: squeeze past sideways (contacts / nudges resolve it)
            laneTarget[i] = x[i] + pref * HORSE.HALF_WIDTH * 2;
          }
        }
        const v = (laneTarget[i] - x[i]) * 3;
        desiredVx[i] = v > 2.5 ? 2.5 : v < -2.5 ? -2.5 : v;
      } else if (settled && layer[i] !== Layer.C && (i + tick) % 6 === 0) {
        const l = this.densityAt(x[i] - LOD.DENSITY_CELL, this.progress[i] + LOD.DENSITY_CELL);
        const r = this.densityAt(x[i] + LOD.DENSITY_CELL, this.progress[i] + LOD.DENSITY_CELL);
        this.tryLaneChange(i, l < r ? -1 : r < l ? 1 : i & 1 ? 1 : -1);
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
    const { laneStart, laneList, laneP, laneX, x, state, speed, layer, targetSpeed, followCap, blocked, queueDepth } = this;
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
        let downAhead = -1; // far field: downed horse we brush past instead of queueing behind
        const isC = layer[i] === Layer.C;
        const xi = laneX[k];
        for (let m = k - 1; m >= a; m--) {
          const dp = laneP[m] - p;
          if (dp >= bestDp) break;
          const j = laneList[m];
          if (isC && (state[j] === HorseState.FALL || state[j] === HorseState.RECOVER)) {
            if (downAhead < 0 && dp < 3) downAhead = j;
            continue;
          }
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
            if (isC && (state[j] === HorseState.FALL || state[j] === HorseState.RECOVER)) {
              if (downAhead < 0 && dp < 3) downAhead = j;
              continue;
            }
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
        if (beside >= 0 && isC) {
          const d = x[i] - x[beside];
          x[i] += (d > 0 || (d === 0 && i > beside) ? 1 : -1) * LOD.SIDE_NUDGE;
        }
        // far field never queues behind a downed horse (it either went down in the group
        // event or squeezes past it): ease sideways while passing
        if (downAhead >= 0) {
          const d = x[i] - x[downAhead];
          x[i] += (d > 0 || (d === 0 && i > downAhead) ? 1 : -1) * LOD.SIDE_NUDGE * 2;
        }
        if (best < 0) {
          followCap[i] = Infinity;
          blocked[i] = 0;
          queueDepth[i] = 0;
          this.queueTime[i] = 0;
          continue;
        }
        const lenI = state[i] === HorseState.FALL ? HORSE.FALLEN_HALF_LENGTH : HORSE.HALF_LENGTH;
        const lenJ = state[best] === HorseState.FALL ? HORSE.FALLEN_HALF_LENGTH : HORSE.HALF_LENGTH;
        const gap = bestDp - lenI - lenJ;
        const lead = speed[best];
        const leadGain = targetSpeed[best] - lead;
        const anticipate = leadGain > 0 ? (leadGain < LOD.FOLLOW_ANTICIPATE ? leadGain : LOD.FOLLOW_ANTICIPATE) : 0;
        let cap = lead + anticipate + (gap - minGap) / T;
        // brake firmly but not to a standstill (prevents jam waves). An actual overlap with
        // the leader (negative gap: someone cut in / sideways nudge) is resolved sideways,
        // not by braking further and further down a chain.
        const floor = lead - (gap < 0 ? LOD.FOLLOW_OVERLAP_BRAKE : LOD.FOLLOW_MAX_BRAKE);
        if (cap < floor) cap = floor;
        if (gap < 0 && isC) {
          const d = x[i] - x[best];
          x[i] += (d > 0 || (d === 0 && i > best) ? 1 : -1) * LOD.SIDE_NUDGE;
        }
        // queue behind a downed horse: depth 1/2 brake normally, deeper ones keep rolling
        // (they are already steering round) so no standing traffic jam can form
        const sb = state[best];
        const down = sb === HorseState.FALL || sb === HorseState.RECOVER || sb === HorseState.STUMBLE;
        // a leader that is merely still accelerating freely (gate start, after recovering)
        // is not an obstacle worth queueing/detouring for
        const accelerating = targetSpeed[best] > lead + 2 && followCap[best] > lead + 2;
        const slow = down || (lead < targetSpeed[i] * 0.5 && !accelerating);
        const depth = slow ? Math.min(255, queueDepth[best] + 1) : 0;
        queueDepth[i] = depth;
        if (depth > 0 && speed[i] < 2) this.queueTime[i] += SIM.DT;
        else this.queueTime[i] = 0;
        // near field: contacts resolve the squeeze. Far field: ease sideways past the slow
        // leader (like passing a downed horse) so the overlap never becomes deep.
        const impatient = depth > 2 || this.queueTime[i] > LOD.QUEUE_PATIENCE;
        if (impatient && isC) {
          const d = x[i] - x[best];
          x[i] += (d > 0 || (d === 0 && i > best) ? 1 : -1) * LOD.SIDE_NUDGE * 2;
        }
        if (impatient) {
          const keep = targetSpeed[i] * LOD.QUEUE_MIN_SPEED;
          if (cap < keep) cap = keep;
        }
        if (cap < 0) cap = 0;
        if (depth > 0 && gap < 6) {
          blocked[i] = 2;
          this.detourFrom[i] = best;
        } else {
          // "stuck behind a slower horse" -> look for a way round
          blocked[i] = gap < 3 && (targetSpeed[best] < targetSpeed[i] * 0.97 || lead < targetSpeed[i] * 0.8) ? 1 : 0;
          this.detourFrom[i] = best;
        }
        if (layer[i] === Layer.C) {
          followCap[i] = cap;
        } else {
          followCap[i] = Infinity;
          const st = state[i];
          // near field: once already overlapping, contact resolution separates the pair;
          // braking for it only propagates slowdowns through the crowd
          if (gap >= 0 && (st === HorseState.RUN || st === HorseState.AVOID) && cap < targetSpeed[i]) targetSpeed[i] = cap;
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
        // the horses underneath may have got up: settle onto what is left of the pile
        if (this.groundY[i] > 0 && (i + this.tick) % 6 === 0) {
          const h = this.pileHeightAt(i);
          if (h < this.groundY[i]) this.groundY[i] = h;
        }
        if (t >= this.stateDuration[i] && this.y[i] <= this.groundY[i] + 0.01) {
          this.setState(i, HorseState.RECOVER, HORSE.RECOVER_TIME);
          this.groundY[i] = 0; // slides off the pile while getting up
        }
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
        // keep galloping through the line, ease off only well past it (no wall of
        // finished horses in front of the ones still racing)
        this.targetSpeed[i] =
          this.progress[i] < this.course.length + HORSE.FINISH_RUNOUT ? this.baseSpeed[i] : HORSE.FINISH_SPEED;
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
  fall(i: number, side: number = 0, gen: number = 0, downScale: number = 1): void {
    const st = this.state[i];
    if (this.grace[i] > 0 || st === HorseState.FALL || st === HorseState.RECOVER) return;
    this.setState(i, HorseState.FALL, this.rng.range(HORSE.FALL_TIME_MIN, HORSE.FALL_TIME_MAX) * downScale);
    this.fallSide[i] = side !== 0 ? (side > 0 ? 1 : -1) : this.rng.sign();
    this.vy[i] = HORSE.FALL_HOP_VY * this.rng.range(0.7, 1.2);
    this.groundY[i] = this.layer[i] === Layer.C ? 0 : this.pileHeightAt(i);
    if (this.y[i] < this.groundY[i] + 0.01) this.y[i] = this.groundY[i] + 0.01;
    this.chainGen[i] = gen > 255 ? 255 : gen;
    this.fallCount[i]++;
    this.fallsTotal++;
  }

  /** true if horse i is inside the fairness box right in front of the player */
  /**
   * true if horse i is inside the fairness window in front of the player: no NEW
   * spontaneous / scripted accident may start there (≥ SAFE_SECONDS of warning at the
   * player's current speed). Existing piles and chain reactions are not suppressed.
   */
  inPlayerSafeBox(i: number): boolean {
    const p0 = FIELD.PLAYER;
    const dp = this.progress[i] - this.progress[p0];
    const ahead = Math.max(COLLISION.SAFE_AHEAD_MIN, this.speed[p0] * COLLISION.SAFE_SECONDS + 2);
    return dp > -2 && dp < ahead && Math.abs(this.x[i] - this.x[p0]) < COLLISION.SAFE_SIDE;
  }

  /** Height of the top of the downed horses under horse i (pile model, hash = near field). */
  pileHeightAt(i: number): number {
    const x = this.x[i];
    const p = this.progress[i];
    const found = this.hash.query(x - 1.6, p - 2.2, x + 1.6, p + 2.2);
    const res = this.hash.result;
    let top = 0;
    for (let r = 0; r < found; r++) {
      const j = res[r];
      if (j === i || this.state[j] !== HorseState.FALL) continue;
      if (Math.abs(this.x[j] - x) > 1.3 || Math.abs(this.progress[j] - p) > 1.9) continue;
      const t = this.groundY[j] + HORSE.FALLEN_HEIGHT * HORSE.PILE_STACK;
      if (t > top) top = t;
    }
    return top > HORSE.PILE_MAX ? HORSE.PILE_MAX : top;
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
    // on / approaching a turn the field drifts towards the inside rail (shorter way round):
    // the inside gets crowded, the outside opens up
    if (
      !this.blocked[i] &&
      Math.abs(this.laneTarget[i] - x) < 0.2 &&
      this.course.curvatureAt(p + 40) > 0 &&
      this.rng.next() < LOD.INWARD_DRIFT
    ) {
      this.tryLaneChange(i, -1);
    }
    // stuck behind a slower horse: change lane by one body width if (and only if) there is room
    if (this.blocked[i] && Math.abs(this.laneTarget[i] - x) < 0.2) {
      const pref = left < right ? -1 : right < left ? 1 : i & 1 ? 1 : -1;
      this.tryLaneChange(i, pref);
    }
    this.desiredVx[i] = clampf((this.laneTarget[i] - x) * 1.2, -1.0, 1.0);

    // rare group falls, more likely in dense regions (far-field "chain reaction" proxy)
    const dens = Math.max(0.5, here / ref);
    let hz = LOD.C_FALL_HAZARD * dens * LOD.C_PERIOD * this.accidentScale();
    // the leading pack races shoulder to shoulder: extra contact accidents up front
    if (this.orderPos[i] < LOD.LEAD_PACK) hz += LOD.LEAD_HAZARD * SIM.DT * LOD.C_PERIOD * this.accidentScale();
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
        if (i === FIELD.PLAYER || (!e.allLayers && this.layer[i] !== Layer.C)) continue;
        const dx = this.x[i] - e.x;
        // horses just behind the event are the ones that pile in
        if (dx * dx + dp * dp > r2) continue;
        if (e.allLayers && this.inPlayerSafeBox(i)) continue;
        if (this.state[i] === HorseState.RUN && this.rng.next() < (e.chance ?? 0.6)) this.fall(i, Math.sign(dx), 1, e.downScale ?? 1);
      }
    }
  }

  /**
   * Accident "director" (Phase 1 review M3): at seeded times a big fall is seeded in the
   * densest spot 40–80 m ahead of the player (2–4 s of warning at race speed — the hazard
   * markers appear immediately). It then grows as an ordinary local chain. If the player is
   * already clear of the field it happens in the nearest pack ahead instead.
   */
  private directorAccident(): void {
    const p0 = FIELD.PLAYER;
    const pp = this.progress[p0];
    const px = this.x[p0];
    let lo = pp + DIRECTOR.AHEAD_MIN;
    let hi = pp + DIRECTOR.AHEAD_MAX;
    // nothing ahead in range: use the closest group ahead (leading pack)
    if (this.progress[this.order[0]] < lo) return;
    const o = this.order;
    const first = (pv: number) => {
      let a = 0;
      let b = o.length;
      while (a < b) {
        const m = (a + b) >> 1;
        if (this.progress[o[m]] > pv) a = m + 1;
        else b = m;
      }
      return a;
    };
    let k0 = first(hi);
    if (k0 >= o.length || this.progress[o[k0]] < lo) {
      // widen: the next horses ahead of the window
      hi = this.progress[o[Math.max(0, k0 - 1)]] + 5;
      lo = hi - 40;
      k0 = first(hi);
    }
    // most events block the player's own line (jump it or go round), the rest hit the
    // densest spot nearby (spectacle, and piles that change the traffic)
    const inLine = this.rng.next() < DIRECTOR.IN_LINE;
    let best = -1;
    let bestScore = -Infinity;
    for (let k = k0; k < o.length; k++) {
      const i = o[k];
      if (this.progress[i] < lo) break;
      if (i === p0 || this.state[i] !== HorseState.RUN || this.inPlayerSafeBox(i)) continue;
      const dx = Math.abs(this.x[i] - px);
      if (dx > (inLine ? 5 : DIRECTOR.SIDE)) continue;
      const score = inLine
        ? -dx + this.rng.next()
        : this.densityAt(this.x[i], this.progress[i]) - dx * 0.4 + this.rng.next() * 3;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) return;
    this.directorEvents++;
    this.grace[best] = 0;
    // tumble towards the player's line so the pile lands across it
    this.fall(best, px - this.x[best], 0, DIRECTOR.DOWN_SCALE);

    this.groupEvents.push({
      // in-line events are centred on the player's lane so the pile lands across it
      x: inLine ? px : this.x[best],
      p: this.progress[best],
      r: DIRECTOR.RADIUS,
      allLayers: true,
      chance: DIRECTOR.CHANCE,
      downScale: DIRECTOR.DOWN_SCALE,
    });
  }

  /** Layers A/B: lane keeping; both perceive hazards ahead and AVOID (B coarser/less often). */
  private decideLocal(i: number, layer: number): void {
    this.targetSpeed[i] = this.baseSpeed[i] * this.pace(i);
    if (this.state[i] === HorseState.AVOID) {
      this.desiredVx[i] = this.avoidDir[i] * HORSE.LATERAL_MAX;
      return;
    }
    this.desiredVx[i] = clampf((this.laneTarget[i] - this.x[i]) * 0.6, -1.2, 1.2);
    const isA = layer === Layer.A;
    if (this.state[i] === HorseState.RUN) this.maybeMisstep(i);
    if (isA) this.maybeYield(i);
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

  /**
   * A near NPC that hears the (faster) player right behind it sometimes drifts aside if
   * there is room — keeps the player's lines open without making NPCs ghosts.
   */
  private maybeYield(i: number): void {
    const p0 = FIELD.PLAYER;
    const dp = this.progress[p0] - this.progress[i];
    if (dp > -1.5 || dp < -7) return;
    const dx = this.x[i] - this.x[p0];
    if (Math.abs(dx) > 1.1 || this.speed[p0] < this.speed[i] + 1) return;
    if (Math.abs(this.laneTarget[i] - this.x[i]) > 0.2) return;
    if (this.rng.next() >= this.skill[i] * COLLISION.YIELD_RATE * SIM.DT) return;
    this.tryLaneChange(i, dx >= 0 ? 1 : -1);
  }

  /** Spontaneous misstep (A/B): density-driven, never right in front of the player. */
  private maybeMisstep(i: number): void {
    const dens = Math.max(0.5, this.densityAt(this.x[i], this.progress[i]) / LOD.DENSITY_REF);
    let hz = COLLISION.MISSTEP_HAZARD * SIM.DT * dens * this.accidentScale();
    if (this.orderPos[i] < LOD.LEAD_PACK) hz += LOD.LEAD_HAZARD * SIM.DT * this.accidentScale();
    if (this.rng.next() >= hz) return;
    if (this.inPlayerSafeBox(i)) return;
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
    const found = this.hash.query(x - 1.6, p + 0.5, x + 1.6, p + look);
    const res = this.hash.result;
    for (let r = 0; r < found; r++) {
      const j = res[r];
      if (j === i) continue;
      const st = this.state[j];
      const slow = this.speed[j] < this.speed[i] - 4;
      if (st !== HorseState.FALL && st !== HorseState.STUMBLE && !slow) continue;
      const dp = this.progress[j] - p;
      if (dp <= 0.5 || dp > look) continue;
      if (Math.abs(this.x[j] - x) > 1.4) continue;
      if (dp < bestDp) {
        bestDp = dp;
        best = j;
      }
    }
    return best;
  }

  // ======================================================================================
  // player
  // ======================================================================================

  private updatePlayer(intent: PlayerIntent): void {
    const i = FIELD.PLAYER;
    const dt = SIM.DT;
    if (this.jumpCooldown > 0) this.jumpCooldown -= dt;
    if (this.winded > 0) this.winded -= dt;
    if (this.boostTime > 0) this.boostTime -= dt;
    const inControl = this.updateStateMachine(i);
    this.playerJumpBookkeeping(i);

    // dash (design §4 + Phase 1 review M4): a fresh press starts it, it drains the gauge,
    // running dry leaves the horse winded for a moment; while an upright horse blocks the
    // lane right ahead the speed bonus is lost but the gauge still drains
    const pressed = intent.dash && !this.dashHeldPrev;
    this.dashHeldPrev = intent.dash;
    if (this.dashing) {
      if (!intent.dash || !inControl) this.dashing = false;
    } else if (pressed && inControl && this.winded <= 0 && this.dashGauge >= PLAYER.DASH_MIN_TO_START) {
      this.dashing = true;
    }
    if (this.dashing) {
      this.dashGauge -= PLAYER.DASH_DRAIN * dt;
      if (this.dashGauge <= 0) {
        this.dashGauge = 0;
        this.dashing = false;
        this.winded = PLAYER.WINDED_TIME;
      }
    } else {
      this.dashGauge = Math.min(1, this.dashGauge + PLAYER.DASH_REGEN * dt);
    }
    this.dashBlocked = this.dashing && this.uprightAhead(i, PLAYER.DASH_CLEAR_AHEAD);
    if (!inControl) {
      this.dashing = false;
      return;
    }
    let target = PLAYER.CRUISE_SPEED * (this.winded > 0 ? PLAYER.WINDED_FACTOR : 1);
    if (this.dashing && !this.dashBlocked) target = PLAYER.DASH_SPEED;
    if (this.boostTime > 0) target += PLAYER.JUMP_BOOST;
    // hard sideways steering at a gallop costs forward speed (swerving round a pile is not
    // free; a clean jump keeps the pace)
    target *= 1 - (PLAYER.STEER_DRAG * Math.abs(this.vx[i])) / PLAYER.LATERAL_MAX;
    this.targetSpeed[i] = target;
    this.desiredVx[i] = clampf(intent.steer, -1, 1) * PLAYER.LATERAL_MAX;
    if (intent.jump && this.y[i] <= 0 && this.jumpCooldown <= 0) {
      this.vy[i] = PLAYER.JUMP_VY;
      this.y[i] = 0.01;
      this.jumpCooldown = PLAYER.JUMP_COOLDOWN + (2 * PLAYER.JUMP_VY) / HORSE.GRAVITY;
      this.clearedThisJump = false;
      this.jumpsTaken++;
    }
  }

  /** an upright horse in the player's lane within `ahead` metres (hash: last tick) */
  private uprightAhead(i: number, ahead: number): boolean {
    const x = this.x[i];
    const p = this.progress[i];
    const found = this.hash.query(x - 1, p + 0.5, x + 1, p + ahead);
    const res = this.hash.result;
    for (let r = 0; r < found; r++) {
      const j = res[r];
      if (j === i) continue;
      const st = this.state[j];
      if (st === HorseState.FALL || st === HorseState.RECOVER) continue;
      const dp = this.progress[j] - p;
      if (dp > 0.5 && dp < ahead && Math.abs(this.x[j] - x) < 0.95) return true;
    }
    return false;
  }

  /** jump rewards: passing over a downed horse and landing safely refills the gauge + boost */
  private playerJumpBookkeeping(i: number): void {
    const airborne = this.y[i] > 0.05;
    if (airborne) {
      const x = this.x[i];
      const p = this.progress[i];
      const found = this.hash.query(x - 1.6, p - 2.4, x + 1.6, p + 2.4);
      const res = this.hash.result;
      for (let r = 0; r < found; r++) {
        const j = res[r];
        if (j === i || this.state[j] !== HorseState.FALL) continue;
        if (Math.abs(this.x[j] - x) < 1.4 && Math.abs(this.progress[j] - p) < 2.3) this.clearedThisJump = true;
      }
    } else if (this.wasAirborne) {
      if (this.clearedThisJump && this.state[i] !== HorseState.FALL) {
        this.jumpsCleared++;
        this.dashGauge = Math.min(1, this.dashGauge + PLAYER.JUMP_CLEAR_GAUGE);
        this.boostTime = PLAYER.JUMP_BOOST_TIME;
        this.winded = 0;
      }
      this.clearedThisJump = false;
    }
    this.wasAirborne = airborne;
  }

  /** passes made by the player last tick: small gauge refill, near misses a bigger one */
  private playerPassBookkeeping(i: number): void {
    const x = this.x[i];
    const p = this.progress[i];
    const pPrev = this.prevProgress[i];
    const found = this.hash.query(x - 1.6, p - 3, x + 1.6, p + 1);
    const res = this.hash.result;
    for (let r = 0; r < found; r++) {
      const j = res[r];
      if (j === i) continue;
      if (!(this.prevProgress[j] > pPrev && this.progress[j] <= p)) continue;
      this.playerPasses++;
      let g = PLAYER.PASS_GAUGE;
      const st = this.state[j];
      const dx = Math.abs(this.x[j] - x);
      if (st !== HorseState.FALL && dx > 0.9 && dx < 1.4 && this.speed[i] > 17) {
        this.nearMisses++;
        g += PLAYER.NEAR_MISS_GAUGE;
      }
      this.dashGauge = Math.min(1, this.dashGauge + g);
    }
  }

  // ======================================================================================
  // integration
  // ======================================================================================

  private integrate(): void {
    const dt = SIM.DT;
    const course = this.course;
    const curv = (s: number) => course.curvatureAt(s);
    const half = this.course.width * 0.5 - 0.8;
    const p0 = FIELD.PLAYER;
    for (let i = 0; i < this.n; i++) {
      const st = this.state[i];
      const isPlayer = i === p0;
      // forward speed
      // standing starts are punchy (a horse pulls away from a near-stop quickly)
      const accel = isPlayer ? PLAYER.ACCEL : this.speed[i] < 4 ? HORSE.ACCEL_LOW : HORSE.ACCEL;
      const decel = st === HorseState.FALL ? HORSE.FALL_DECEL : HORSE.DECEL;
      let sp = this.speed[i];
      const dv = this.targetSpeed[i] - sp;
      sp += dv > 0 ? Math.min(dv, accel * dt) : Math.max(dv, -decel * dt);
      // car-following (layer C only; Infinity elsewhere). Hard cap: far away, invisible.
      const cap = this.followCap[i];
      if (sp > cap) sp = cap;
      if (sp < 0) sp = 0;
      this.speed[i] = sp;

      // lateral. Upright NPCs drift out of the open "streak" corridors (they keep them open)
      const latAcc = isPlayer ? PLAYER.LATERAL_ACCEL : HORSE.LATERAL_ACCEL;
      let vx = this.vx[i];
      let want = this.desiredVx[i];
      if (!isPlayer && (st === HorseState.RUN || st === HorseState.AVOID) && inCorridor(this.x[i])) {
        const edge = corridorExit(this.x[i]);
        want = edge > this.x[i] ? FIELD.CORRIDOR_EXIT_SPEED : -FIELD.CORRIDOR_EXIT_SPEED;
        if (Math.abs(this.laneTarget[i] - this.x[i]) < 3) this.laneTarget[i] = edge;
      }
      const dvx = want - vx;
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
      // oval: on a turn the inside (x < 0) covers more centreline per world metre
      const k = curv(this.progress[i]);
      this.progress[i] += k === 0 ? sp * dt : (sp * dt) / (1 + k * x);

      // vertical (jumps, tumble bounces)
      let y = this.y[i];
      const ground = st === HorseState.FALL ? this.groundY[i] : 0;
      if (y > ground || this.vy[i] !== 0) {
        let vy = this.vy[i] - HORSE.GRAVITY * dt;
        y += vy * dt;
        if (y <= ground) {
          y = ground;
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

/** true if lateral position x lies in one of the open "streak" corridors */
export function inCorridor(x: number): boolean {
  const sp = FIELD.CORRIDOR_SPACING;
  const m = (((x - FIELD.CORRIDOR_OFFSET) % sp) + sp) % sp;
  return m < FIELD.CORRIDOR_HALF || m > sp - FIELD.CORRIDOR_HALF;
}

/** nearest x just outside the corridor containing x */
export function corridorExit(x: number): number {
  const sp = FIELD.CORRIDOR_SPACING;
  const c = Math.round((x - FIELD.CORRIDOR_OFFSET) / sp) * sp + FIELD.CORRIDOR_OFFSET;
  const h = FIELD.CORRIDOR_HALF + 0.05;
  return x >= c ? c + h : c - h;
}

function clampf(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function adapt(r: number, count: number, target: number, lo: number, hi: number): number {
  if (count > target * 1.15) r *= 0.96;
  else if (count < target * 0.85) r *= 1.04;
  return r < lo ? lo : r > hi ? hi : r;
}
