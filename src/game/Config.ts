/**
 * Tunable constants. Everything here is a starting point for Phase 1/2 tuning;
 * keep gameplay numbers in this one place so balancing does not require
 * touching logic.
 *
 * Balance invariants:
 *  - tests/Balance.test.ts: the leading NPC finishes in 60–90 s; an ideal solo run (empty
 *    track, inside rail, dash) beats it by 3–30 s (winning is physically possible)
 *  - how hard winning actually is is pinned by bot proxies over 10 seeds
 *    (tests/Difficulty*.test.ts): optimal bot wins ≥ 50 % with PERFECT ≤ 40 %, 150 ms proxy
 *    can win, 250 ms proxy wins ≤ 20 % with median rank 30–300, never-dash / dash-held /
 *    no-jump / no-input play ends clearly lower
 */
export const SIM = {
  /** fixed simulation rate */
  HZ: 30,
  DT: 1 / 30,
  /** max sim steps per rendered frame (prevents spiral of death) */
  MAX_STEPS_PER_FRAME: 4,
} as const;

/**
 * Oval: two straights + two semicircles (left-handed). The race starts on the back
 * straight, runs turn 3-4 and finishes on the home straight (< 1 lap).
 * With |x| ≤ 75 and R = 360 the inside/outside distance factor stays within 0.79–1.21.
 */
export const COURSE = {
  WIDTH: 150,
  TURN_RADIUS: 360,
  STRAIGHT: 460,
  /** start line (front of the grid) to the first turn */
  START_TO_TURN: 120,
  /** turn exit to the finish line on the home straight */
  HOME_TO_FINISH: 200,
  /**
   * share of the true inside/outside distance difference the race counts (1 = exact
   * geometry, progress += v / (1 + κx)). The track is ~5× wider than a real one to hold
   * 10,000 horses; at full geometry running 30 m off the rail costs ~94 m (4 s) per turn
   * and the rail is the only line. Scaled, the rail is still shorter but a free outside
   * line can compete with a jammed inside (Phase 1b review M2).
   */
  LANE_DISTANCE_SCALE: 0.7,
} as const;

export const FIELD = {
  HORSES: 10000, // player + 9,999 NPC
  PLAYER: 0, // player index == player id
  /**
   * starting grid (~134 per row, 75 rows => ~150 m deep). Lateral spacing is 2 horse widths
   * and odd rows are offset by exactly one width, so diagonal neighbours never overlap
   * laterally: each horse only queues behind the one two rows ahead (4 m) at the start.
   */
  GRID_LATERAL_SPACING: 1.8,
  GRID_ROW_SPACING: 2.0,
  GRID_HALF_WIDTH: 70,
  GRID_JITTER: 0.25,
  GRID_PROGRESS_JITTER: 0.15,
  /**
   * natural gaps instead of laid-out corridors (Phase 1b user feedback): the grid density is
   * modulated by seeded low-frequency noise (a few plane waves at oblique angles, wavelengths
   * GAP_WAVE_MIN–MAX m). Slots where it exceeds GAP_THRESHOLD stay empty, giving irregular
   * sparse patches that drift apart and close as horses with different speeds mix — never a
   * straight aligned lane.
   */
  GAP_FROM_ROW: 4,
  GAP_THRESHOLD: 0.8,
  GAP_WAVE_MIN: 10,
  GAP_WAVE_MAX: 32,
  /** player starts this far behind the last row */
  PLAYER_BEHIND_LAST_ROW: 3.5,
  /** seconds before the gates open */
  START_DELAY: 3.0,
} as const;

export const HORSE = {
  /** collider half extents in course space (standing) */
  HALF_WIDTH: 0.45,
  HALF_LENGTH: 1.1,
  HEIGHT: 2.0,
  /** standing horses slower than this (jammed up against a pile, nearly stopped) are hopped
   *  like a downed one; any other standing horse is a wall the jump cannot clear (M1) */
  JAM_SPEED: 3,
  /** lying (fallen) collider */
  FALLEN_HALF_WIDTH: 0.95,
  FALLEN_HALF_LENGTH: 1.25,
  FALLEN_HEIGHT: 0.75,
  /** a horse falling onto downed horses rests this fraction of their height above them */
  PILE_STACK: 0.8,
  /** tallest pile (m): 3 layers */
  PILE_MAX: 1.8,
  /** piles whose top is at most this high are cleared by a normal jump (peak ≈ 1.7 m): one or
   *  two layers (0.75 / 1.35 m) — yellow markers; three layers are red (go round) */
  JUMPABLE_TOP: 1.5,

  NPC_SPEED_MIN: 13.45,
  NPC_SPEED_MAX: 15.55,
  /** share of base speed decided by start row: front rows are faster, so the field fans
   *  out instead of locking into a solid block, and difficulty rises towards the front */
  FRONT_BIAS: 0.6,
  PACE_AMPLITUDE: 0.03,
  /** NPC stamina: pace drops linearly by up to FADE over the last FADE_DIST m */
  FADE: 0.06,
  FADE_DIST: 500,
  ACCEL: 4.5,
  /** acceleration below 4 m/s */
  ACCEL_LOW: 8,
  DECEL: 9,
  LATERAL_MAX: 4.5,
  LATERAL_ACCEL: 10,
  GRAVITY: 20,

  STUMBLE_TIME: 0.55,
  STUMBLE_SPEED_FACTOR: 0.6,
  FALL_TIME_MIN: 1.0,
  FALL_TIME_MAX: 1.6,
  FALL_DECEL: 10,
  FALL_HOP_VY: 4.2,
  FALL_RESTITUTION: 0.45,
  RECOVER_TIME: 0.5,
  /** immunity after standing up (prevents permanent fall loops) */
  GRACE_TIME: 1.2,

  /** metres past the line at full pace before easing to the run-out speed */
  FINISH_RUNOUT: 180,
  /** run-out speed after finishing */
  FINISH_SPEED: 9,
} as const;

export const PLAYER = {
  CRUISE_SPEED: 21,
  DASH_SPEED: 29,
  /** hard ceiling on the player's target speed (dash + chained landing boosts) */
  MAX_SPEED: 36,
  ACCEL: 9,
  /** acceleration while dashing (the burst must be felt within a 2 s gauge) */
  DASH_ACCEL: 14,
  LATERAL_MAX: 7.5,
  LATERAL_ACCEL: 30,
  /** peak = vy²/2g ≈ 1.72 m: clears downed horses and 1–2 layer piles, never a standing horse (2 m) */
  JUMP_VY: 8.3,
  /** a jump costs this much dash gauge (no jump when the gauge is lower) */
  JUMP_COST: 0.25,
  /** after a landing that cleared nothing the horse cannot accelerate for this long (s) */
  LANDING_LOCK: 0.3,
  /** coming down on a standing horse's back = this chance of tumbling (comedic, no injury) */
  UPRIGHT_LANDING_FAIL: 0.95,
  JUMP_COOLDOWN: 0.35,
  DASH_DRAIN: 0.5, // gauge / s (full gauge = 2 s)
  /** slow natural refill: jumps, near misses and passes are the real fuel (review M4) */
  DASH_REGEN: 0.2,
  DASH_MIN_TO_START: 0.25,
  /** running the gauge dry: winded for this long at cruise × factor */
  WINDED_TIME: 1.0,
  WINDED_FACTOR: 0.85,
  /** an upright horse this close ahead in the lane cancels the dash bonus (gauge still drains) */
  DASH_CLEAR_AHEAD: 3,
  /** accident multipliers while dashing (contact stumbles/trips, landing on a downed horse) */
  DASH_RISK: 1.7,
  DASH_LANDING_RISK: 1.3,
  /** gauge refills */
  JUMP_CLEAR_GAUGE: 0.5,
  NEAR_MISS_GAUGE: 0.05,
  PASS_GAUGE: 0.0012,
  /** forward-speed loss at full lateral speed (fraction) */
  STEER_DRAG: 0.06,
  /** clearing a downed horse / low pile gives a short burst */
  JUMP_BOOST: 13,
  JUMP_BOOST_TIME: 3,
  /** clearing again within this many seconds chains: boost × (1 + bonus × (chain − 1)), max ×2 */
  JUMP_CHAIN_WINDOW: 6,
  JUMP_CHAIN_BONUS: 0.5,
  /** the landing boost pauses while an upright horse is this close ahead in the lane */
  BOOST_CLEAR_AHEAD: 5,
  /** share of the closing speed the player loses when hitting an NPC from behind */
  SHOULDER_LOSS: 0.25,
  /** lateral shove (m/s) given to an NPC the player runs into */
  SHOULDER_SHOVE: 1.0,
  /** contacts softer than this (m/s) never unsettle the player (side brushes in a crowd) */
  SOFT_BUMP: 1.8,
  /** probability multiplier on accidental stumbles (player-friendly) */
  STUMBLE_MULT: 0.72,
} as const;

/**
 * Master difficulty knobs (design §4: tune "accident frequency" and "room to avoid"
 * independently). Copied into each HorseSimulation as `sim.tuning` so tests and future
 * difficulty settings can change them per race.
 */
export interface SimTuning {
  /** scales every accident probability (stumble, trip, far-field hazard) */
  accidentRate: number;
  /** scales NPC hazard-avoid reaction probability (higher = fewer chain victims) */
  avoidSkill: number;
  /** trip probability multiplier per chain generation (0..1): damps chain reactions */
  chainDecay: number;
  /** seconds after the gates open over which accident rates ramp up from 15 % to 100 % */
  startGrace: number;
  /** spontaneous accidents (missteps, far-field and lead-pack falls, scripted crashes); 0 = only
   *  contact chains (tests isolate one chain with it) */
  background: number;
}

export const DEFAULT_TUNING: Readonly<SimTuning> = {
  accidentRate: 1,
  avoidSkill: 1,
  chainDecay: 0.75,
  startGrace: 3,
  background: 1,
};

export const COLLISION = {
  CELL: 2.5,
  /** stumble chance per contact EVENT: base + k * impact speed (m/s) */
  STUMBLE_BASE: 0.01,
  STUMBLE_PER_IMPACT: 0.05,
  STUMBLE_PER_NEIGHBOR: 0.004,
  STUMBLE_MAX: 0.5,
  /** contacts softer than this (m/s) never unsettle an upright horse */
  STUMBLE_MIN_IMPACT: 0.8,
  /** stumbling horse gets hit again hard enough -> fall */
  STUMBLE_TO_FALL: 0.35,
  /** running into a fallen horse (per contact event) */
  TRIP_BASE: 0.6,
  TRIP_PER_IMPACT: 0.04,
  /** layer B horses are less likely to trip (they are simulated more coarsely) */
  TRIP_MULT_B: 0.6,
  /**
   * spontaneous misstep hazard for A/B NPCs (per second, × (density/ref)² × accident scale):
   * footing / clipping heels. A share of them go straight down => seeds local chains.
   */
  MISSTEP_HAZARD: 0.003,
  MISSTEP_FALL_SHARE: 0.35,
  /**
   * fairness window (design §4): no NEW spontaneous/scripted accident starts within
   * max(SAFE_AHEAD_MIN, speed × SAFE_SECONDS) in front of the player (±SAFE_SIDE).
   * Existing piles and chain reactions are NOT suppressed.
   */
  SAFE_SECONDS: 1.0,
  SAFE_AHEAD_MIN: 15,
  SAFE_SIDE: 3,
  /** per-second chance (× skill) that an NPC right in front of a faster player moves aside */
  YIELD_RATE: 0.25,
  /** landing a jump onto a downed horse */
  LANDING_FAIL: 0.85,
  LANDING_FAIL_NPC: 0.45,
  /** after an accident roll a horse is not rolled again for this long (s) */
  EVENT_COOLDOWN: 0.6,
  /** forward perception for AVOID (layers A and B) */
  LOOKAHEAD: 8,
  /** layer B perceives every N ticks */
  B_PERCEIVE_PERIOD: 3,
  /** speed transfer (impulse) from a tumbling horse to neighbours */
  FALL_IMPULSE: 2.5,
  /** max positional correction per horse per tick (m); smaller just after leaving layer C */
  MAX_CORRECTION: 0.2,
  MAX_CORRECTION_FRESH: 0.1,
  FRESH_TICKS: 20,
} as const;

export const LOD = {
  /** budget-driven radii: the sim adapts radii so layer counts hover near these */
  TARGET_A: 64,
  TARGET_B: 600,
  RADIUS_A_MIN: 6,
  RADIUS_A_MAX: 45,
  RADIUS_B_MIN: 20,
  RADIUS_B_MAX: 260,
  /** layer C re-decides speed/lane every N ticks (staggered by id) */
  C_PERIOD: 6,
  /** layer C density grid cell (m) */
  DENSITY_CELL: 10,
  /** horses per density cell at starting-grid density */
  DENSITY_REF: 28,
  /**
   * car-following: lane width (m), min gap (m), gap-closing time constant (s), look distance (m),
   * and how much of the leader's ongoing acceleration a follower may anticipate (m/s) — without
   * it a tightly packed grid starts like a traffic jam (each row lags the one ahead).
   */
  LANE_WIDTH: 0.9,
  FOLLOW_MIN_GAP: 0.3,
  FOLLOW_HEADWAY: 0.25,
  FOLLOW_ANTICIPATE: 1.0,
  /** a follower is never capped more than this below its leader's speed (m/s) */
  FOLLOW_MAX_BRAKE: 2.5,
  /** ... and at most this much when already overlapping it (overlaps resolve sideways) */
  FOLLOW_OVERLAP_BRAKE: 0.5,
  /** near-field NPCs arriving at a downed horse hop over it with chance skill × this */
  NPC_HOP_CHANCE: 0.4,
  NPC_HOP_VY: 7.5,
  /** horses deeper than 2nd in a queue behind a downed horse keep at least this × target speed */
  QUEUE_MIN_SPEED: 0.5,
  /** a 1st/2nd horse in such a queue waits at most this long (s) before squeezing past */
  QUEUE_PATIENCE: 0.6,
  /** after this long stuck behind a downed horse an NPC may scramble over it */
  CLIMB_AFTER: 1.2,
  /** a lane change needs this much free length (m) ahead of and behind the horse */
  LANE_CHANGE_CLEAR: 3,
  /** lateral easing (m/tick) for far-field horses overlapping side by side */
  SIDE_NUDGE: 0.04,
  FOLLOW_DIST: 10,
  /** group fall hazard per C decision, scaled by (density / DENSITY_REF)² */
  C_FALL_HAZARD: 0.000008,
  /** per far-field decision on/near a turn: chance to move one lane towards the inside */
  INWARD_DRIFT: 0.35,
  /** lateral step (m) of one inward squeeze, and the closest side-by-side spacing it allows */
  DRIFT_STEP: 0.8,
  DRIFT_MIN_SPACING: 0.98,
  /**
   * horses within DRIFT_REACH m of the inside rail drift in; the pull fades out linearly over
   * the outer DRIFT_FADE m of that reach, so the field thins gradually towards the outside
   * (no empty band where the drift stops)
   */
  DRIFT_REACH: 150,
  DRIFT_FADE: 110,
  /** ... starting this far before the turn (m) */
  INWARD_LEAD: 300,
  /** accident hazard multiplier near the inside rail on a turn (packed and jostling) */
  RAIL_HAZARD_MULT: 2,
  RAIL_BAND: 20,
  /** the leading LEAD_PACK horses get an extra accident hazard (per second) */
  LEAD_PACK: 300,
  LEAD_HAZARD: 0.003,
  C_FALL_CLUSTER_RADIUS: 4,
} as const;

/**
 * Scripted accidents (Phase 1 review M3: falls must be visible all race long). Seeded
 * times; each seeds a big fall in the densest spot AHEAD_MIN–AHEAD_MAX m ahead of the
 * player (never inside the fairness window), then local chain rules take over.
 */
export const DIRECTOR = {
  FIRST_MIN: 7.5,
  FIRST_MAX: 10,
  GAP_MIN: 9,
  GAP_MAX: 13,
  AHEAD_MIN: 32,
  AHEAD_MAX: 65,
  /** scripted piles stay down longer so the player actually reaches them (jump or go round) */
  DOWN_SCALE: 1.6,
  SIDE: 22,
  RADIUS: 8,
  CHANCE: 0.55,
  /** in-line events: wider and sparser (low, jumpable piles) */
  LINE_RADIUS: 9,
  LINE_CHANCE: 0.3,
  /** in-line events: horses up to SCATTER_AHEAD m beyond the pile within SCATTER_HALF m of the
   *  player's line bolt sideways (the far side of a jumpable pile opens up) */
  SCATTER_AHEAD: 30,
  SCATTER_HALF: 4,
  /** share of events placed across the player's own line */
  IN_LINE: 0.8,
} as const;

export const RACE = {
  /** rank / overtake recomputation every N ticks (30Hz / 3 = 10Hz) */
  RANK_PERIOD: 3,
  /** TODO(Phase 1): race timeout -> result screen with the current rank. Not used yet. */
  TIME_LIMIT: 150,
} as const;
