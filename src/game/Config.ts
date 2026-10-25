/**
 * Tunable constants. Everything here is a starting point for Phase 1/2 tuning;
 * keep gameplay numbers in this one place so balancing does not require
 * touching logic.
 */
export const SIM = {
  /** fixed simulation rate */
  HZ: 30,
  DT: 1 / 30,
  /** max sim steps per rendered frame (prevents spiral of death) */
  MAX_STEPS_PER_FRAME: 4,
} as const;

export const FIELD = {
  HORSES: 10000, // player + 9,999 NPC
  PLAYER: 0, // player index == player id
  /** starting grid */
  GRID_LATERAL_SPACING: 1.45,
  GRID_ROW_SPACING: 2.7,
  GRID_HALF_WIDTH: 114,
  GRID_JITTER: 0.25,
  /** player starts this far behind the last row */
  PLAYER_BEHIND_LAST_ROW: 3.5,
  /** seconds before the gates open */
  START_DELAY: 1.5,
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

  NPC_SPEED_MIN: 15.2,
  NPC_SPEED_MAX: 17.4,
  ACCEL: 4.5,
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

  /** run-out speed after finishing */
  FINISH_SPEED: 9,
} as const;

export const PLAYER = {
  CRUISE_SPEED: 17.8,
  DASH_SPEED: 22.5,
  ACCEL: 6,
  LATERAL_MAX: 7.5,
  LATERAL_ACCEL: 30,
  JUMP_VY: 8,
  JUMP_COOLDOWN: 0.35,
  DASH_DRAIN: 0.5, // gauge / s (full gauge = 2 s)
  DASH_REGEN: 0.14,
  DASH_MIN_TO_START: 0.2,
  /** probability multiplier on accidental stumbles (player-friendly) */
  STUMBLE_MULT: 0.6,
} as const;

export const COLLISION = {
  CELL: 2.5,
  /** stumble chance per contact tick: base + k * impact speed (m/s) */
  STUMBLE_BASE: 0.004,
  STUMBLE_PER_IMPACT: 0.02,
  STUMBLE_PER_NEIGHBOR: 0.004,
  STUMBLE_MAX: 0.5,
  /** stumbling horse gets hit again hard enough -> fall */
  STUMBLE_TO_FALL: 0.4,
  /** running into a fallen horse */
  TRIP_BASE: 0.42,
  TRIP_PER_IMPACT: 0.06,
  /** forward perception for AVOID (layer A) */
  LOOKAHEAD: 8,
  /** speed transfer (impulse) from a tumbling horse to neighbours */
  FALL_IMPULSE: 2.5,
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
  /** group fall hazard per C decision, scaled by local density */
  C_FALL_HAZARD: 0.000004,
  C_FALL_CLUSTER_RADIUS: 4,
} as const;

export const RACE = {
  /** rank / overtake recomputation every N ticks (30Hz / 3 = 10Hz) */
  RANK_PERIOD: 3,
  TIME_LIMIT: 150,
} as const;
