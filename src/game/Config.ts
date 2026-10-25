/**
 * Tunable constants. Everything here is a starting point for Phase 1/2 tuning;
 * keep gameplay numbers in this one place so balancing does not require
 * touching logic.
 *
 * Balance invariants (enforced by tests/Balance.test.ts):
 *  - the leading NPC finishes in 60–90 s
 *  - an ideal player run (no contact, optimal dash) finishes ≥ 8 s before the leader
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
  HOME_TO_FINISH: 230,
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
  GRID_JITTER: 0,
  GRID_PROGRESS_JITTER: 0.15,
  /**
   * "streaks": empty lateral corridors through the mid/rear field (every CORRIDOR_SPACING m,
   * CORRIDOR_HALF m half-width, centred CORRIDOR_OFFSET m off the centre line so the player
   * does not start in one). NPC lane changes avoid them; a skilled player rides them.
   */
  CORRIDOR_SPACING: 25,
  CORRIDOR_HALF: 1.2,
  CORRIDOR_OFFSET: 12.5,
  CORRIDOR_FROM_ROW: 10,
  /** lateral speed (m/s) at which upright NPCs leave a corridor */
  CORRIDOR_EXIT_SPEED: 1.2,
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
  /** lying (fallen) collider */
  FALLEN_HALF_WIDTH: 0.95,
  FALLEN_HALF_LENGTH: 1.25,
  FALLEN_HEIGHT: 0.75,
  /** a horse falling onto downed horses rests this fraction of their height above them */
  PILE_STACK: 0.8,
  /** tallest pile (m): 3 layers. Player jump peak is 1.6 m => 0–1 layers are jumpable */
  PILE_MAX: 1.8,

  NPC_SPEED_MIN: 12.7,
  NPC_SPEED_MAX: 14.7,
  /** share of base speed decided by start row: front rows are faster, so the field fans
   *  out instead of locking into a solid block, and difficulty rises towards the front */
  FRONT_BIAS: 0.75,
  PACE_AMPLITUDE: 0.03,
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
  CRUISE_SPEED: 21.5,
  DASH_SPEED: 25,
  ACCEL: 6,
  LATERAL_MAX: 7.5,
  LATERAL_ACCEL: 30,
  JUMP_VY: 8,
  JUMP_COOLDOWN: 0.35,
  DASH_DRAIN: 0.5, // gauge / s (full gauge = 2 s)
  /** slow natural refill: jumps, near misses and passes are the real fuel (review M4) */
  DASH_REGEN: 0.08,
  DASH_MIN_TO_START: 0.25,
  /** running the gauge dry: winded for this long at cruise × factor */
  WINDED_TIME: 1.0,
  WINDED_FACTOR: 0.85,
  /** an upright horse this close ahead in the lane cancels the dash bonus (gauge still drains) */
  DASH_CLEAR_AHEAD: 6,
  /** accident multipliers while dashing (contact stumbles/trips, landing on a downed horse) */
  DASH_RISK: 1.9,
  DASH_LANDING_RISK: 1.3,
  /** gauge refills */
  JUMP_CLEAR_GAUGE: 0.35,
  NEAR_MISS_GAUGE: 0.05,
  PASS_GAUGE: 0.0012,
  /** clearing a downed horse / low pile gives a short burst */
  JUMP_BOOST: 4.5,
  JUMP_BOOST_TIME: 1.3,
  /** share of the closing speed the player loses when hitting an NPC from behind */
  SHOULDER_LOSS: 0.55,
  /** lateral shove (m/s) given to an NPC the player runs into */
  SHOULDER_SHOVE: 0.6,
  /** probability multiplier on accidental stumbles (player-friendly) */
  STUMBLE_MULT: 0.95,
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
}

export const DEFAULT_TUNING: Readonly<SimTuning> = {
  accidentRate: 1,
  avoidSkill: 1,
  chainDecay: 0.75,
  startGrace: 3,
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
  /** a lane change needs this much free length (m) ahead of and behind the horse */
  LANE_CHANGE_CLEAR: 3,
  /** lateral easing (m/tick) for far-field horses overlapping side by side */
  SIDE_NUDGE: 0.04,
  FOLLOW_DIST: 10,
  /** group fall hazard per C decision, scaled by (density / DENSITY_REF)² */
  C_FALL_HAZARD: 0.000008,
  /** per far-field decision on/near a turn: chance to move one lane towards the inside */
  INWARD_DRIFT: 0.02,
  /** the leading LEAD_PACK horses get an extra accident hazard (per second) */
  LEAD_PACK: 300,
  LEAD_HAZARD: 0.0015,
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
  DOWN_SCALE: 2.4,
  SIDE: 22,
  RADIUS: 6,
  CHANCE: 0.55,
  /** share of events placed across the player's own line */
  IN_LINE: 0.6,
} as const;

export const RACE = {
  /** rank / overtake recomputation every N ticks (30Hz / 3 = 10Hz) */
  RANK_PERIOD: 3,
  /** TODO(Phase 1): race timeout -> result screen with the current rank. Not used yet. */
  TIME_LIMIT: 150,
} as const;
