import { Sound } from '../audio/Sound';
import { Course } from '../data/Course';
import { randomSeed } from '../data/Seed';
import { loadBest, loadSettings, saveSettings, submitResult, type Settings } from '../data/Storage';
import { QualityManager } from '../render/Quality';
import { World } from '../render/World';
import { DebugOverlay, type DebugStats } from '../ui/DebugOverlay';
import { button, h } from '../ui/dom';
import { Hud } from '../ui/Hud';
import { PauseMenu } from '../ui/PauseMenu';
import { ResultScreen } from '../ui/Result';
import { CARD_SIZE, PHOTO_SHOT, type CardFormat } from '../share/CardRenderer';
import { TitleScreen } from '../ui/Title';
import { TouchControls } from '../ui/TouchControls';
import { FIELD, PLAYER, RACE, SIM } from './Config';
import { HorseSimulation, HorseState, Layer, STATE_NAMES } from './HorseSimulation';
import { Input } from './Input';
import { FixedStepper } from './Loop';
import { AutoBot, PlayerController } from './PlayerController';
import { chooseInitialLevel, estimateFullTickMs } from './StartupBench';
import { RaceStats, computeRank, makeResult, type RaceResult } from './Race';

export interface GameOptions {
  seed: number;
  debug: boolean;
  /** bot drives the player (verification / demo) */
  autoplay: boolean;
  /** skip the title screen and start the race immediately */
  autostart: boolean;
  /** fixed pixel ratio (disables auto quality) */
  pixelRatio?: number;
  /** initial render LOD level 0..3 */
  quality?: number;
  /** debug: fast-forward the race this many seconds after it starts */
  fastForward?: number;
}

/**
 * title  : attract-mode race in the background, title menu
 * intro  : start sequence (sim START_DELAY): ultra-wide shot -> chase cam, 3-2-1-GO
 * racing : the race
 * finished: banner (WIN / PERFECT / rank / TIME UP) while the camera orbits
 * result : provisional result screen (Phase 3 replaces it with the share card)
 */
export type GamePhase = 'title' | 'intro' | 'racing' | 'finished' | 'result';

const FINAL_STRETCH_M = 200;
const FINISH_BANNER_S = 3.5;

/**
 * Owns the session: simulation, rendering, input, UI, sound, race statistics and the
 * fixed-timestep loop (sim at 30 Hz, rendering interpolates with alpha).
 */
export class Game {
  course: Course;
  sim: HorseSimulation;
  readonly world: World;
  readonly input: Input;
  controller: PlayerController;
  readonly stats: RaceStats;
  readonly quality: QualityManager;
  readonly sound: Sound;
  settings: Settings;
  private readonly debug: DebugOverlay | null;
  private readonly ui: HTMLDivElement;
  private readonly title: TitleScreen;
  private readonly hud: Hud;
  private readonly resultScreen: ResultScreen;
  private readonly pauseMenu: PauseMenu;
  private readonly touch: TouchControls;
  private readonly isTouch: boolean;

  phase: GamePhase = 'title';
  paused = false;
  /** debug / screenshots: hold the simulation but keep rendering (camera keeps moving) */
  freezeSim = false;
  seed: number;
  rank: number = FIELD.HORSES;
  leaderProgress = 0;
  result: RaceResult | null = null;
  private cardPhotos: Record<string, HTMLCanvasElement> = {};
  private finishTimer = 0;
  private resultShownAt = 0;
  /** player's progress at the gate (progress bar origin) */
  private raceStartProgress = 0;
  private last = -1;
  private raf = 0;
  private running = false;
  private readonly stepper = new FixedStepper();
  // event detection
  private prevPlayerY = 0;
  private prevPlayerFalls = 0;
  private prevFallsTotal = 0;
  private prevDashing = false;
  private prevJumpsCleared = 0;
  private prevNearMisses = 0;
  private prevWinded = false;
  private warmSim: HorseSimulation | null = null;
  private warmBot: AutoBot | null = null;

  // timing statistics (exponentially smoothed)
  readonly timing = { simMsPerTick: 0, ticksPerFrame: 1, fps: 0, frameMs: 16, prepMs: 0, drawMs: 0, cpuMs: 0 };

  constructor(
    container: HTMLElement,
    private readonly opts: GameOptions,
  ) {
    this.settings = loadSettings();
    this.sound = new Sound(this.settings.sound);
    this.seed = opts.seed;
    this.course = new Course(this.seed);
    this.sim = new HorseSimulation(this.course, this.seed);
    this.world = new World(container, this.sim, this.course);
    this.world.reduceMotion = this.settings.reduceMotion;
    this.input = new Input();
    this.input.onAnyInput = () => this.sound.unlock();
    this.controller = new PlayerController(this.input, true, 0.6);
    this.stats = new RaceStats(this.sim.n, FIELD.PLAYER);

    this.isTouch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    document.body.classList.toggle('touch', this.isTouch);
    this.ui = h('div', { class: 'ui' });
    container.appendChild(this.ui);
    this.title = new TitleScreen(this.ui, {
      onStart: () => this.startRace(this.seed),
      onToggleSound: () => this.updateSettings({ sound: !this.settings.sound }),
      onToggleMotion: () => this.updateSettings({ reduceMotion: !this.settings.reduceMotion }),
    });
    this.hud = new Hud(this.ui, () => this.setPaused(true));
    this.touch = new TouchControls(this.ui, this.input);
    this.resultScreen = new ResultScreen(this.ui, {
      onRetry: () => this.startRace(this.seed),
      onNewRace: () => this.startRace(randomSeed()),
      onTitle: () => this.enterTitle(),
    });
    this.pauseMenu = new PauseMenu(this.ui, {
      onResume: () => this.setPaused(false),
      onRestart: () => this.startRace(this.seed),
      onTitle: () => this.enterTitle(),
    });
    this.buildChrome();

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.quality = new QualityManager({
      maxPixelRatio: opts.pixelRatio ?? dpr,
      minPixelRatio: Math.min(dpr, 0.6),
      fixed: opts.pixelRatio !== undefined,
      initialLevel: opts.quality ?? chooseInitialLevel(estimateFullTickMs(), this.isTouch),
      minBudgetHz: this.isTouch ? undefined : 60,
    });
    this.world.applyQuality(this.quality.state);
    this.debug = opts.debug ? new DebugOverlay(container) : null;

    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);

    if (opts.autostart) {
      this.startRace(this.seed);
      if (opts.fastForward) this.fastForward(opts.fastForward);
    } else {
      this.enterTitle();
    }
  }

  // ======================================================================================
  // flow
  // ======================================================================================

  enterTitle(): void {
    this.phase = 'title';
    this.setPaused(false);
    // attract mode: the same course, a mid-skill bot, already a few seconds into the race
    this.sim = new HorseSimulation(this.course, this.seed);
    this.world.setRace(this.sim, this.course);
    this.controller = new PlayerController(this.input, true, 0.6);
    this.stepper.reset();
    this.world.rig.setMode('title');
    this.title.update(this.settings, loadBest());
    this.title.show(true);
    this.hud.show(false);
    this.touch.show(false);
    this.resultScreen.show(null);
    this.releaseCardPhotos();
    this.pauseMenu.show(false);
  }

  startRace(seed: number): void {
    this.sound.unlock();
    this.input.reset();
    if (seed !== this.course.seed) {
      this.course = new Course(seed);
    }
    this.seed = seed;
    this.sim = new HorseSimulation(this.course, seed);
    this.world.setRace(this.sim, this.course);
    this.controller = new PlayerController(this.input, this.opts.autoplay);
    this.stats.reset();
    this.stats.update(this.sim, 0, 0);
    this.rank = this.sim.n;
    this.raceStartProgress = this.sim.progress[FIELD.PLAYER];
    this.result = null;
    this.phase = 'intro';
    // JIT warm-up for the gate-open spike: a small throwaway race (its own course/seed, so the
    // real race is untouched) runs through the start and the first seconds of racing during
    // the countdown, so the race-time code paths are compiled before the gates open
    this.warmSim = new HorseSimulation(new Course(seed ^ 0x5bd1e995), seed ^ 0x5bd1e995, 1200);
    this.warmBot = new AutoBot({ seed });
    this.finishTimer = 0;
    this.prevPlayerY = 0;
    this.prevPlayerFalls = 0;
    this.prevFallsTotal = 0;
    this.prevDashing = false;
    this.prevJumpsCleared = 0;
    this.prevNearMisses = 0;
    this.prevWinded = false;
    this.stepper.reset();
    this.world.rig.setMode('intro', FIELD.START_DELAY);
    this.title.show(false);
    this.resultScreen.show(null);
    this.releaseCardPhotos();
    this.setPaused(false);
    this.hud.show(true);
    this.touch.show(this.isTouch);
    // shareable URL for this course (Phase 3 builds on this)
    try {
      const url = new URL(location.href);
      url.searchParams.set('seed', String(seed));
      history.replaceState(null, '', url);
    } catch {
      /* ignore */
    }
  }

  setPaused(p: boolean): void {
    const canPause = this.phase === 'intro' || this.phase === 'racing';
    this.paused = p && canPause;
    this.pauseMenu.show(this.paused);
    this.sound.suspend(this.paused);
    if (!this.paused) {
      this.last = -1;
      this.stepper.reset();
    }
  }

  private finishRace(timedOut: boolean): void {
    const sim = this.sim;
    const p = FIELD.PLAYER;
    this.rank = computeRank(sim, p);
    const r = makeResult({
      seed: this.seed,
      rank: this.rank,
      field: sim.n,
      time: timedOut ? null : sim.finishTime[p],
      timedOut,
      overtakes: this.stats.total,
      falls: sim.fallCount[p],
      maxStreak: this.stats.maxStreak,
    });
    this.result = r;
    this.captureCardPhotos();
    this.phase = 'finished';
    this.finishTimer = FINISH_BANNER_S;
    if (r.perfect) this.hud.banner('PERFECT!!', 'perfect');
    else if (r.win) this.hud.banner('WIN!', 'win');
    else if (timedOut) this.hud.banner('TIME UP', 'timeup');
    else this.hud.banner(`${r.rank.toLocaleString('en-US')}位 FINISH`, 'finish');
    this.hud.clearCallouts();
    this.sound.fanfare(r.perfect ? 'perfect' : r.win ? 'win' : 'finish');
    if (timedOut) this.sound.timeUp();
    this.world.rig.setMode('finish');
    this.touch.show(false);
  }

  /** card backgrounds: the game's own 3D scene at the goal (kept until the next race) */
  private captureCardPhotos(): void {
    this.releaseCardPhotos();
    for (const f of ['landscape', 'portrait'] as CardFormat[]) {
      try {
        const { w, h } = CARD_SIZE[f];
        const shot = PHOTO_SHOT[f];
        this.cardPhotos[f] = this.world.captureCard(w, h, shot.focus, shot.dist);
      } catch (e) {
        console.warn('card photo failed', e); // the card falls back to the flat 2D scene
      }
    }
  }

  private releaseCardPhotos(): void {
    for (const c of Object.values(this.cardPhotos)) if (c) c.width = c.height = 0;
    this.cardPhotos = {};
  }

  private showResult(): void {
    if (!this.result) return;
    const hadBest = loadBest() !== null;
    const improved = submitResult(this.result);
    const newBest: 'first' | 'new' | null = improved ? (hadBest ? 'new' : 'first') : null;
    this.phase = 'result';
    this.resultShownAt = performance.now();
    this.input.confirmRequested = false;
    this.hud.show(false);
    this.resultScreen.show(this.result, loadBest(), newBest, this.cardPhotos);
  }

  private updateSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.settings);
    this.sound.setEnabled(this.settings.sound);
    this.world.reduceMotion = this.settings.reduceMotion;
    document.body.classList.toggle('reduce-motion', this.settings.reduceMotion);
    this.title.update(this.settings, loadBest());
  }

  /** fullscreen button + "rotate your phone" prompt */
  private buildChrome(): void {
    const fsSupported = !!document.documentElement.requestFullscreen;
    const fs = button(
      '全画面',
      () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else {
          void document.documentElement
            .requestFullscreen()
            .then(() => (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.('landscape'))
            .catch(() => undefined);
        }
      },
      'btn btn-fullscreen',
    );
    if (!fsSupported) fs.classList.add('hidden');
    const rotate = h('div', { class: 'rotate-prompt' }, [
      h('div', { class: 'rotate-icon', text: '📱↻' }),
      h('div', { class: 'rotate-text', text: '横にしてね' }),
      h('div', { class: 'rotate-sub', text: 'スマホは横持ちで遊ぶのがおすすめです' }),
      button('このまま遊ぶ', () => document.body.classList.add('rotate-dismissed'), 'btn btn-ghost'),
    ]);
    this.ui.append(fs, rotate);
    document.body.classList.toggle('reduce-motion', this.settings.reduceMotion);
  }

  // ======================================================================================
  // loop
  // ======================================================================================

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

  /** Debug/verification: advance the simulation synchronously. Returns ms per tick. */
  fastForward(seconds: number): number {
    const ticks = Math.round(seconds / SIM.DT);
    const t0 = performance.now();
    for (let k = 0; k < ticks; k++) this.tick();
    this.stepper.reset();
    return ticks > 0 ? (performance.now() - t0) / ticks : 0;
  }

  private readonly onResize = () => {
    this.world.resize();
    // the "rotate your phone" overlay covers the game: don't run the race behind it
    if ((this.phase === 'racing' || this.phase === 'intro') && !this.paused && this.rotatePromptVisible()) this.setPaused(true);
  };

  private rotatePromptVisible(): boolean {
    const b = document.body;
    return b.classList.contains('touch') && !b.classList.contains('rotate-dismissed') && window.matchMedia('(orientation: portrait)').matches;
  }
  private readonly onVisibility = () => {
    // drop accumulated time while hidden so we never fast-forward on return
    this.last = -1;
    this.stepper.reset();
    if (document.hidden && (this.phase === 'racing' || this.phase === 'intro')) this.setPaused(true);
  };

  private readonly frame = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    if (this.last < 0) this.last = now;
    const frameMs = now - this.last;
    this.last = now;
    const dt = Math.min(frameMs / 1000, 0.25);
    this.handleMenuInput();

    // apply quality changes decided last frame BEFORE rendering (resizing the canvas after
    // rendering would present an empty buffer for one frame)
    const pendingQ = this.quality.takePending();
    if (pendingQ) this.world.applyQuality(pendingQ);

    let simMs = 0;
    let steps = 0;
    let alpha = 0.999;
    if (!this.paused && !this.freezeSim) {
      const r = this.stepper.advance(dt, () => {
        const t0 = performance.now();
        this.tick();
        simMs += performance.now() - t0;
      });
      steps = r.steps;
      alpha = r.alpha;
    }

    if (this.phase === 'finished') {
      this.finishTimer -= dt;
      if (this.finishTimer <= 0) this.showResult();
    }

    this.world.render(alpha, this.paused ? 0 : dt, this.phase !== 'title');
    this.updateHud(dt);
    const near = Math.min(1, this.sim.layerCounts[0] / 64);
    this.sound.crowd(this.phase === 'title' ? near * 0.4 : near, this.sim.speed[FIELD.PLAYER]);

    // ---- stats / quality ----
    const tm = this.timing;
    const k = 0.1;
    if (steps > 0) tm.simMsPerTick += (simMs / steps - tm.simMsPerTick) * k;
    tm.ticksPerFrame += (steps - tm.ticksPerFrame) * k;
    tm.frameMs += (frameMs - tm.frameMs) * k;
    tm.fps = 1000 / Math.max(1, tm.frameMs);
    tm.prepMs += (this.world.prepMs - tm.prepMs) * k;
    tm.drawMs += (this.world.drawMs - tm.drawMs) * k;
    const cpuMs = simMs + this.world.prepMs + this.world.drawMs;
    tm.cpuMs += (cpuMs - tm.cpuMs) * k;
    if (frameMs > 0 && !this.paused) this.quality.sample({ intervalMs: frameMs, cpuMs });
    if (this.debug) this.debug.update(this.collectStats(), dt);
  };

  private handleMenuInput(): void {
    const inp = this.input;
    if (inp.pauseRequested) {
      inp.pauseRequested = false;
      if (this.phase === 'intro' || this.phase === 'racing') this.setPaused(!this.paused);
    }
    if (inp.restartRequested) {
      inp.restartRequested = false;
      if (this.phase !== 'title') this.startRace(this.seed);
    }
    if (inp.confirmRequested) {
      inp.confirmRequested = false;
      if (this.phase === 'title') this.startRace(this.seed);
      else if (this.phase === 'result' && performance.now() - this.resultShownAt > 900) this.startRace(this.seed);
    }
  }

  /** one fixed simulation step plus everything that reacts to it */
  private tick(): void {
    const intent = this.controller.sample(this.sim);
    this.sim.step(intent);
    if (this.phase !== 'title') this.afterTick();
  }

  private afterTick(): void {
    const sim = this.sim;
    const p = FIELD.PLAYER;
    const t = sim.raceTime;
    if (this.phase === 'intro') {
      const w = this.warmSim;
      if (w && this.warmBot) for (let k = 0; k < 3 && w.raceTime < FIELD.START_DELAY; k++) w.step(this.warmBot.decide(w));
      const prev = t - SIM.DT;
      for (const mark of [-2, -1, 0]) if (prev < mark && t >= mark) this.sound.countdown(-mark);
      if (sim.started) {
        this.warmSim = null;
        this.warmBot = null;
        this.phase = 'racing';
        this.world.rig.setMode('chase'); // eases in from wherever the intro shot is
      }
    }
    if (sim.tick % RACE.RANK_PERIOD === 0) {
      this.rank = computeRank(sim, p);
      this.leaderProgress = sim.progress[sim.order[0]];
      const seq = this.stats.burstSeq;
      this.stats.update(sim, sim.time, sim.fallCount[p]);
      // one chime per completed burst of passes (pitch grows with its size)
      if (this.stats.burstSeq !== seq && this.phase === 'racing' && this.stats.lastBurst >= 5) this.sound.pass(this.stats.lastBurst);
    }

    // ---- sound / camera events ----
    const y = sim.y[p];
    if (this.prevPlayerY <= 0 && y > 0 && sim.vy[p] > 0 && sim.state[p] !== HorseState.FALL) this.sound.jump();
    if (this.prevPlayerY > 0.2 && y <= 0 && sim.state[p] !== HorseState.FALL) {
      this.sound.land();
      this.world.rig.shake(0.06);
    }
    this.prevPlayerY = y;
    if (sim.fallCount[p] > this.prevPlayerFalls) {
      this.prevPlayerFalls = sim.fallCount[p];
      this.sound.boing(1);
      this.world.rig.shake(0.35);
    }
    if (sim.dashing && !this.prevDashing) this.sound.dash();
    this.prevDashing = sim.dashing;
    if (sim.jumpsCleared > this.prevJumpsCleared) {
      this.prevJumpsCleared = sim.jumpsCleared;
      this.hud.toast('ナイスジャンプ！ ダッシュ回復＋加速', 'good');
      this.sound.pass(400);
    } else if (sim.nearMisses > this.prevNearMisses + 2) {
      this.prevNearMisses = sim.nearMisses;
      this.hud.toast('すり抜け！', 'good');
    }
    const winded = sim.winded > 0;
    if (winded && !this.prevWinded) this.hud.toast('息切れ… ダッシュは使い切らないで', 'bad');
    this.prevWinded = winded;
    if (sim.fallsTotal > this.prevFallsTotal) {
      this.prevFallsTotal = sim.fallsTotal;
      // boing for fresh tumbles near the player
      let near = 0;
      for (let k = 0; k < sim.activeCount; k++) {
        const i = sim.active[k];
        if (i !== p && sim.state[i] === HorseState.FALL && sim.stateTime[i] < SIM.DT * 1.5 && sim.layer[i] === Layer.A) near++;
      }
      if (near > 0) {
        this.sound.boing(Math.min(1, 0.4 + near * 0.15));
        this.world.rig.shake(0.05 * Math.min(3, near));
      }
    }

    if (this.phase === 'racing') {
      if (sim.finished[p]) this.finishRace(false);
      else if (t >= RACE.TIME_LIMIT) this.finishRace(true);
    }
  }

  private updateHud(dt: number): void {
    if (this.phase !== 'intro' && this.phase !== 'racing' && this.phase !== 'finished') return;
    const sim = this.sim;
    const p = FIELD.PLAYER;
    const L = this.course.length;
    const total = L - this.startProgress();
    this.hud.update(
      {
        rank: this.rank,
        field: sim.n,
        remaining: L - sim.progress[p],
        raceTime: sim.finished[p] ? sim.finishTime[p] : sim.raceTime,
        progress: (sim.progress[p] - this.startProgress()) / total,
        leaderProgress: (this.leaderProgress - this.startProgress()) / total,
        dash: sim.dashGauge,
        dashing: sim.dashing,
        jumpReady: sim.jumpCooldown <= 0 && sim.dashGauge >= PLAYER.JUMP_COST ? 1 : 0,
        lastBurst: this.stats.lastBurst,
        burstSeq: this.stats.burstSeq,
        finalStretch: this.phase === 'racing' && L - sim.progress[p] < FINAL_STRETCH_M,
        racing: this.phase === 'racing',
        winded: sim.winded > 0,
        dashBlocked: sim.dashBlocked,
      },
      this.paused ? 0 : dt,
    );
    this.touch.setDashState(sim.dashGauge, sim.dashing);
  }

  private startProgress(): number {
    return this.raceStartProgress;
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
      renderFarR: this.world.horses.effectiveFar,
      instances: hs.instances,
      impostors: hs.impostors,
      cpuMs: this.timing.cpuMs,
      refreshMs: this.quality.estimatedRefreshMs,
      renderMidR: this.world.horses.effectiveMid,
      triangles: hs.triangles,
      drawCalls: this.world.info.calls,
      pixelRatio: this.quality.state.pixelRatio,
      qualityLevel: this.quality.state.level,
      rank: this.rank,
      overtakes: this.stats.total,
      playerState: STATE_NAMES[sim.state[p]] + (sim.dashing ? '+DASH' : '') + (sim.y[p] > 0 ? '+AIR' : ''),
      speed: sim.speed[p],
      dash: sim.dashGauge,
      progress: sim.progress[p],
      remaining: Math.max(0, this.course.length - sim.progress[p]),
      raceTime: Math.max(0, sim.raceTime),
      contacts: sim.contactsThisTick,
      falls: sim.fallsTotal,
      down,
      seed: this.seed,
      phase: this.phase,
    };
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.input.dispose();
    this.debug?.dispose();
    this.releaseCardPhotos();
    this.world.dispose();
    this.ui.remove();
  }
}
