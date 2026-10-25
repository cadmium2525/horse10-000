import { formatInt, formatTime } from '../game/Race';
import { button, h, show } from './dom';

export interface HudState {
  rank: number;
  field: number;
  /** remaining metres to the finish (player) */
  remaining: number;
  /** race seconds (negative during the start sequence) */
  raceTime: number;
  /** 0..1 player progress along the course */
  progress: number;
  /** 0..1 progress of the leading horse */
  leaderProgress: number;
  dash: number;
  dashing: boolean;
  /** 0..1, 1 = jump available */
  jumpReady: number;
  /** size of the last completed pass burst and its sequence number (real tracker data) */
  lastBurst: number;
  burstSeq: number;
  /** final stretch: rank becomes the focus */
  finalStretch: boolean;
  /** false after the finish line (no more callouts) */
  racing: boolean;
  /** dash state details */
  winded: boolean;
  dashBlocked: boolean;
}

/**
 * In-race HUD (design §3): rank top-left, distance/time top-right, progress bar top
 * centre, dash gauge bottom, "+N 頭抜き！" callouts, start sequence and banners.
 */
export class Hud {
  readonly el: HTMLDivElement;
  private readonly rankEl: HTMLSpanElement;
  private readonly remainEl: HTMLDivElement;
  private readonly timeEl: HTMLDivElement;
  private readonly barFill: HTMLDivElement;
  private readonly barPlayer: HTMLDivElement;
  private readonly barLeader: HTMLDivElement;
  private readonly dashFill: HTMLDivElement;
  private readonly dashEl: HTMLDivElement;
  private readonly burstEl: HTMLDivElement;
  private readonly introEl: HTMLDivElement;
  private readonly countEl: HTMLDivElement;
  private readonly bannerEl: HTMLDivElement;
  private readonly finalEl: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;
  private toastHold = 0;
  private lastRank = -1;
  /** last burst sequence number seen */
  private lastBurst = -1;
  private burstHold = 0;
  private bannerTimer = 0;
  private lastCount = '';
  private lastBumpAt = 0;

  constructor(parent: HTMLElement, onPause: () => void) {
    this.rankEl = h('span', { class: 'rank-num' });
    this.remainEl = h('div', { class: 'hud-remain' });
    this.timeEl = h('div', { class: 'hud-time' });
    this.barFill = h('div', { class: 'bar-fill' });
    this.barPlayer = h('div', { class: 'bar-player' });
    this.barLeader = h('div', { class: 'bar-leader' });
    this.dashFill = h('div', { class: 'dash-fill' });
    this.dashEl = h('div', { class: 'hud-dash' }, [h('span', { class: 'dash-label', text: 'DASH' }), h('div', { class: 'dash-bar' }, [this.dashFill])]);
    this.burstEl = h('div', { class: 'hud-burst hidden' });
    this.introEl = h('div', { class: 'hud-intro hidden' }, [
      h('div', { class: 'intro-rank' }, ['10,000', h('small', { text: '位' }), ' / 10,000', h('small', { text: '頭' })]),
      h('div', { class: 'intro-copy', text: '9,999頭を抜け！' }),
    ]);
    this.countEl = h('div', { class: 'hud-count hidden' });
    this.bannerEl = h('div', { class: 'hud-banner hidden' });
    this.finalEl = h('div', { class: 'hud-final hidden', text: 'ラストスパート！' });
    this.toastEl = h('div', { class: 'hud-toast hidden' });
    this.el = h('div', { class: 'hud hidden' }, [
      h('div', { class: 'hud-rank' }, [this.rankEl, h('span', { class: 'rank-total', text: ' / 10,000' })]),
      h('div', { class: 'hud-right' }, [this.remainEl, this.timeEl]),
      h('div', { class: 'hud-bar' }, [this.barFill, this.barLeader, this.barPlayer, h('div', { class: 'bar-goal', text: 'GOAL' })]),
      button('II', onPause, 'btn btn-pause'),
      this.dashEl,
      this.burstEl,
      this.finalEl,
      this.toastEl,
      this.introEl,
      this.countEl,
      this.bannerEl,
    ]);
    parent.appendChild(this.el);
  }

  show(on: boolean): void {
    show(this.el, on);
    if (on) {
      this.lastRank = -1;
      this.lastBurst = -1;
      this.burstHold = 0;
      this.bannerTimer = 0;
      show(this.bannerEl, false);
      show(this.burstEl, false);
    }
  }

  /** big banner (WIN / PERFECT / TIME UP ...). `seconds` 0 = keep until hidden. */
  banner(text: string, cls: string, seconds = 0): void {
    this.bannerEl.className = `hud-banner ${cls}`;
    this.bannerEl.textContent = text;
    this.bannerTimer = seconds;
  }

  update(s: HudState, dt: number): void {
    const rank = Math.round(s.rank);
    if (rank !== this.lastRank) {
      this.rankEl.textContent = formatInt(rank);
      // a small pulse at most every 400 ms (the rank changes at 10 Hz while passing)
      const now = performance.now();
      if (this.lastRank > 0 && rank < this.lastRank && now - this.lastBumpAt > 400) {
        this.lastBumpAt = now;
        this.rankEl.classList.remove('bump');
        void this.rankEl.offsetWidth; // restart the CSS animation
        this.rankEl.classList.add('bump');
      }
      this.lastRank = rank;
    }
    this.remainEl.textContent = `残り ${Math.max(0, Math.ceil(s.remaining)).toLocaleString('en-US')} m`;
    this.timeEl.textContent = formatTime(Math.max(0, s.raceTime));
    const pct = (v: number) => `${(Math.max(0, Math.min(1, v)) * 100).toFixed(2)}%`;
    this.barFill.style.width = pct(s.progress);
    this.barPlayer.style.left = pct(s.progress);
    this.barLeader.style.left = pct(s.leaderProgress);
    this.dashFill.style.width = pct(s.dash);
    this.dashEl.classList.toggle('active', s.dashing);
    this.dashEl.classList.toggle('low', s.dash < 0.25);
    this.dashEl.classList.toggle('winded', s.winded);
    this.dashEl.classList.toggle('blocked', s.dashBlocked);
    this.el.classList.toggle('final', s.finalStretch);
    show(this.finalEl, s.finalStretch && s.remaining > 30);

    // "+N 頭抜き！" — shown while a burst is in progress, held briefly afterwards
    if (s.burstSeq !== this.lastBurst) {
      this.lastBurst = s.burstSeq;
      if (s.lastBurst >= 15 && s.raceTime > 0 && s.racing) {
        this.burstEl.textContent = `+${formatInt(s.lastBurst)} 頭抜き！`;
        this.burstEl.classList.toggle('big', s.lastBurst >= 100);
        this.burstEl.classList.remove('again');
        void this.burstEl.offsetWidth;
        this.burstEl.classList.add('again');
        show(this.burstEl, true);
        this.burstHold = 1.4;
      }
    }
    if (this.burstHold > 0) {
      this.burstHold -= dt;
      if (this.burstHold <= 0) show(this.burstEl, false);
    }

    // start sequence: big field size, then 3-2-1-GO
    const t = s.raceTime;
    show(this.introEl, t < -0.6);
    let count = '';
    if (t < 0 && t >= -2) count = String(Math.ceil(-t));
    else if (t >= 0 && t < 0.8) count = 'GO!';
    if (count !== this.lastCount) {
      this.countEl.textContent = count;
      this.countEl.classList.toggle('go', count === 'GO!');
      this.countEl.classList.remove('pop');
      void this.countEl.offsetWidth;
      this.countEl.classList.add('pop');
      this.lastCount = count;
    }
    show(this.countEl, count !== '');

    if (this.toastHold > 0) {
      this.toastHold -= dt;
      if (this.toastHold <= 0) show(this.toastEl, false);
    }
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) show(this.bannerEl, false);
    }
  }

  /** short feedback line (nice jump, near miss, out of breath ...) */
  toast(text: string, cls = ''): void {
    this.toastEl.className = `hud-toast ${cls}`;
    this.toastEl.textContent = text;
    this.toastHold = 1.1;
  }

  hideBanner(): void {
    show(this.bannerEl, false);
  }

  /** hide transient callouts (finish) */
  clearCallouts(): void {
    show(this.burstEl, false);
    show(this.finalEl, false);
    this.burstHold = 0;
  }
}
