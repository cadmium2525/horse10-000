import { formatInt, formatTime, type RaceResult } from '../game/Race';
import type { BestRecord } from '../data/Storage';
import { button, h, show } from './dom';

export interface ResultCallbacks {
  onRetry(): void;
  onNewRace(): void;
  onTitle(): void;
}

/**
 * Provisional result screen (Phase 1). Renders purely from a RaceResult, so the Phase 3
 * share card (CardRenderer / Share) can replace or extend it without touching the game.
 */
export class ResultScreen {
  readonly el: HTMLDivElement;
  private readonly body: HTMLDivElement;

  constructor(parent: HTMLElement, private readonly cb: ResultCallbacks) {
    this.body = h('div', { class: 'result-body' });
    this.el = h('div', { class: 'screen result hidden' }, [
      h('div', { class: 'panel result-panel' }, [
        this.body,
        h('div', { class: 'result-buttons' }, [
          button('同じコースで再挑戦', () => this.cb.onRetry(), 'btn btn-primary'),
          button('新しいレース', () => this.cb.onNewRace(), 'btn'),
          button('タイトルへ', () => this.cb.onTitle(), 'btn btn-ghost'),
        ]),
        h('div', { class: 'result-note', text: '※ 記録はこの端末で計測した自己申告記録です。' }),
      ]),
    ]);
    parent.appendChild(this.el);
  }

  show(r: RaceResult | null, best: BestRecord | null = null, newBest = false): void {
    if (!r) {
      show(this.el, false);
      return;
    }
    const badge = r.perfect ? 'PERFECT' : r.win ? 'WIN!' : r.timedOut ? 'TIME UP' : 'FINISH';
    const badgeCls = r.perfect ? 'perfect' : r.win ? 'win' : r.timedOut ? 'timeup' : 'finish';
    this.body.replaceChildren(
      h('div', { class: `result-badge ${badgeCls}`, text: badge }),
      h('div', { class: 'result-rank' }, [
        h('span', { class: 'label', text: '順位' }),
        h('span', { class: 'big', text: formatInt(r.rank) }),
        h('span', { class: 'of', text: ` / ${formatInt(r.field)}` }),
      ]),
      h('div', { class: 'result-grid' }, [
        stat('タイム', r.timedOut ? 'タイムアップ' : formatTime(r.time)),
        stat('追い抜き', `${formatInt(r.overtakes)} 頭`),
        stat('転倒', `${r.falls} 回`),
        stat('最大連続追い抜き', `${formatInt(r.maxStreak)} 頭`),
        stat('シード', String(r.seed)),
        stat('自己ベスト', best ? `${formatInt(best.rank)}位${newBest ? '（更新！）' : ''}` : '-'),
      ]),
      ...(r.timedOut || r.rank > 1000
        ? [h('p', { class: 'result-hint', text: 'ヒント：左右に動いて馬群のすき間を抜けよう。倒れた馬はジャンプ、ダッシュは前が空いた所で！' })]
        : []),
    );
    show(this.el, true);
  }
}

function stat(label: string, value: string): HTMLDivElement {
  return h('div', { class: 'stat' }, [h('span', { class: 'label', text: label }), h('span', { class: 'value', text: value })]);
}
