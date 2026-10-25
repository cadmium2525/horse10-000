import { Course } from '../data/Course';
import { World } from '../render/World';
import { QualityManager, type QualityState } from '../render/Quality';
import { DebugOverlay, type DebugStats } from '../ui/DebugOverlay';
import { FIELD, RACE, SIM } from './Config';
import { HorseSimulation, HorseState, STATE_NAMES } from './HorseSimulation';
import { Input } from './Input';
import { PlayerController } from './PlayerController';
import { OvertakeTracker, computeRank } from './Race';

export interface GameOptions {
  seed: number;
  debug: boolean;
  autoplay: boolean;
  /** fixed pixel ratio (disables auto quality) */
  pixelRatio?: number;
  /** initial render LOD level 0..3 */
  quality?: number;
  /** debug: fast-forward the simulation this many seconds before the first frame */
  fastForward?: number;
}

export type GamePhase = 'countdown' | 'racing' | 'finished';

/**
 * Owns the race session: simulation, rendering, input, race statistics, and the
 * fixed-timestep loop.
 *
 * Loop: real time accumulates; the simulation advances in fixed 1/30 s steps (max
 * SIM.MAX_STEPS_PER_FRAME per frame); rendering happens once per animation frame and
 * interpolates between the last two sim states with alpha = accumulator / DT.
 */
export class Game {
  readonly course: Course;
  sim: HorseSimulation;
  readonly world: World;
  readonly input: Input;
  controller: PlayerController;
  readonly overtakes: OvertakeTracker;
  readonly quality: QualityManager;
  private readonly debug: DebugOverlay | null;

  phase: GamePhase = 'countdown';
  rank: number = FIELD.HORSES;
  private acc = 0;
  private last = -1;
  private raf = 0;
  private running = false;

  // timing statistics (exponentially smoothed)
  readonly timing = { simMsPerTick: 0, ticksPerFrame: 1, fps: 0, frameMs: 16, prepMs: 0, drawMs: 0 };

  constructor(
    container: HTMLElement,
    private readonly opts: GameOptions,
  ) {
    this.course = new Course(opts.seed);
    this.sim = new HorseSimulation(this.course, opts.seed);
    this.world = new World(container, this.sim, this.course);
    this.input = new Input(container);
    this.controller = new PlayerController(this.input, opts.autoplay);
    this.overtakes = new OvertakeTracker(this.sim.n, FIELD.PLAYER);
    this.overtakes.update(this.sim);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.quality = new QualityManager(
      {
        targetMs: 1000 / 55,
        maxPixelRatio: opts.pixelRatio ?? dpr,
        minPixelRatio: Math.min(dpr, 0.6),
        fixed: opts.pixelRatio !== undefined,
        initialLevel: opts.quality,
      },
      (q: QualityState) => this.world.applyQuality(q),
    );
    this.debug = opts.debug ? new DebugOverlay(container) : null;

    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
    if (opts.fastForward) this.fastForward(opts.fastForward);
  }

  /**
   * Debug/verification: advance the simulation synchronously by `seconds` using the
   * normal controller (bot or idle human input). Returns the average ms per tick.
   */
  fastForward(seconds: number): number {
    const ticks = Math.round(seconds / SIM.DT);
    const t0 = performance.now();
    for (let k = 0; k < ticks; k++) {
      this.sim.step(this.controller.sample(this.sim));
      this.afterTick();
    }
    this.acc = 0;
    return ticks > 0 ? (performance.now() - t0) / ticks : 0;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = -1;
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** Same seed => identical NPC behaviour for identical input. */
  restart(): void {
    this.sim = new HorseSimulation(this.course, this.opts.seed);
    this.world.setSimulation(this.sim);
    this.controller = new PlayerController(this.input, this.opts.autoplay);
    this.overtakes.reset();
    this.overtakes.update(this.sim);
    this.phase = 'countdown';
    this.rank = this.sim.n;
    this.acc = 0;
  }

  private readonly onResize = () => this.world.resize();
  private readonly onVisibility = () => {
    // drop accumulated time while hidden so we never fast-forward on return
    this.last = -1;
    this.acc = 0;
  };

  private readonly frame = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    if (this.last < 0) this.last = now;
    const frameMs = now - this.last;
    this.last = now;
    const dt = Math.min(frameMs / 1000, 0.25);

    if (this.input.restartRequested) {
      this.input.restartRequested = false;
      this.restart();
    }

    // ---- fixed-step simulation ----
    this.acc += dt;
    let steps = 0;
    let simMs = 0;
    while (this.acc >= SIM.DT && steps < SIM.MAX_STEPS_PER_FRAME) {
      const intent = this.controller.sample(this.sim);
      const t0 = performance.now();
      this.sim.step(intent);
      simMs += performance.now() - t0;
      this.afterTick();
      this.acc -= SIM.DT;
      steps++;
    }
    if (steps === SIM.MAX_STEPS_PER_FRAME && this.acc > SIM.DT) this.acc = SIM.DT * 0.999; // drop backlog
    const alpha = this.acc / SIM.DT;

    // ---- render ----
    this.world.render(alpha, dt);

    // ---- stats / quality ----
    const tm = this.timing;
    const k = 0.1;
    if (steps > 0) tm.simMsPerTick += (simMs / steps - tm.simMsPerTick) * k;
    tm.ticksPerFrame += (steps - tm.ticksPerFrame) * k;
    tm.frameMs += (frameMs - tm.frameMs) * k;
    tm.fps = 1000 / Math.max(1, tm.frameMs);
    tm.prepMs += (this.world.prepMs - tm.prepMs) * k;
    tm.drawMs += (this.world.drawMs - tm.drawMs) * k;
    if (frameMs > 0) this.quality.sample(frameMs, dt);
    if (this.debug) this.debug.update(this.collectStats(), dt);
  };

  private afterTick(): void {
    const sim = this.sim;
    if (this.phase === 'countdown' && sim.started) this.phase = 'racing';
    if (sim.tick % RACE.RANK_PERIOD === 0) {
      this.rank = computeRank(sim, FIELD.PLAYER);
      this.overtakes.update(sim);
    }
    if (this.phase === 'racing' && sim.finished[FIELD.PLAYER]) {
      this.phase = 'finished';
      this.rank = computeRank(sim, FIELD.PLAYER);
    }
  }

  collectStats(): DebugStats {
    const sim = this.sim;
    const p = FIELD.PLAYER;
    const hs = this.world.horses.stats;
    let down = 0;
    for (let i = 0; i < sim.n; i++) if (sim.state[i] === HorseState.FALL) down++;
    return {
      fps: this.timing.fps,
      frameMs: this.timing.frameMs,
      simMsPerTick: this.timing.simMsPerTick,
      simTicksPerFrame: this.timing.ticksPerFrame,
      prepMs: this.timing.prepMs,
      drawMs: this.timing.drawMs,
      layerA: sim.layerCounts[0],
      layerB: sim.layerCounts[1],
      layerC: sim.layerCounts[2],
      radiusA: sim.radiusA,
      radiusB: sim.radiusB,
      renderNear: hs.near,
      renderMid: hs.mid,
      renderFar: hs.far,
      renderCulled: hs.culled,
      renderNearR: this.world.horses.effectiveNear,
      renderMidR: this.world.horses.effectiveMid,
      triangles: hs.triangles,
      drawCalls: this.world.info.calls,
      pixelRatio: this.quality.state.pixelRatio,
      qualityLevel: this.quality.state.level,
      rank: this.rank,
      overtakes: this.overtakes.total,
      playerState: STATE_NAMES[sim.state[p]] + (sim.dashing ? '+DASH' : '') + (sim.y[p] > 0 ? '+AIR' : ''),
      speed: sim.speed[p],
      dash: sim.dashGauge,
      progress: sim.progress[p],
      remaining: Math.max(0, this.course.length - sim.progress[p]),
      raceTime: Math.max(0, sim.raceTime),
      contacts: sim.contactsThisTick,
      falls: sim.fallsTotal,
      down,
      seed: this.opts.seed,
    };
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.input.dispose();
    this.debug?.dispose();
    this.world.dispose();
  }
}
