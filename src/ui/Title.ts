import { formatInt, formatTime } from '../game/Race';
import type { BestRecord, Settings } from '../data/Storage';
import { button, h, show } from './dom';

export interface TitleCallbacks {
  onStart(): void;
  onToggleSound(): void;
  onToggleMotion(): void;
}

/** Title screen over the attract-mode race running in the background (design §3-1). */
export class TitleScreen {
  readonly el: HTMLDivElement;
  private readonly howto: HTMLDivElement;
  private readonly settingsPanel: HTMLDivElement;
  private readonly soundBtn: HTMLButtonElement;
  private readonly motionBtn: HTMLButtonElement;
  private readonly bestEl: HTMLDivElement;

  constructor(parent: HTMLElement, private readonly cb: TitleCallbacks) {
    this.soundBtn = button('', () => this.cb.onToggleSound(), 'btn btn-toggle');
    this.motionBtn = button('', () => this.cb.onToggleMotion(), 'btn btn-toggle');
    this.bestEl = h('div', { class: 'title-best' });
    this.howto = h('div', { class: 'panel howto hidden' }, [
      h('h2', { text: '遊び方' }),
      h('p', {}, ['最後方の1頭（', h('b', { class: 'pink', text: 'ピンクの騎手' }), '）を操作して、9,999頭を抜いて1位を目指そう。']),
      h('ul', {}, [
        h('li', {}, [h('b', { text: '左右移動' }), '：A / D・← / →（スマホ：画面左をドラッグ）']),
        h('li', {}, [h('b', { text: 'ジャンプ' }), '：Space（スマホ：右の大ボタン）。倒れた馬や低い「馬の山」を跳び越えられる。']),
        h('li', {}, [
          h('b', { text: 'ダッシュ' }),
          '：Shift（スマホ：右の小ボタン）。押すたびに発動、ゲージを使い切ると息切れ。前が詰まっていると効かず、ダッシュ中は転びやすい。ゲージは「倒れた馬を跳び越える」「すり抜け」「追い抜き」で回復。',
        ]),
        h('li', {}, [h('b', { text: 'ポーズ' }), '：Esc（スマホ：上のボタン）']),
      ]),
      h('p', {}, [
        '地面の',
        h('b', { class: 'yellow', text: '黄色いマーク' }),
        'は跳べる低い山、',
        h('b', { class: 'red', text: '赤いマーク' }),
        'は高すぎる山。着地点に倒れた馬がいると転倒するので注意！',
      ]),
      h('p', {}, [
        '楕円コースのカーブは',
        h('b', { text: '内側ほど距離が短い' }),
        'けれど混みやすい。集団の中にある',
        h('b', { text: '空いた「筋」' }),
        'を見つけて抜けよう。',
      ]),
      h('p', {}, ['1位かつ転倒0回で ', h('b', { class: 'gold', text: 'PERFECT' }), '！']),
      button('とじる', () => show(this.howto, false)),
    ]);
    this.settingsPanel = h('div', { class: 'panel settings hidden' }, [
      h('h2', { text: '設定' }),
      h('div', { class: 'row' }, [h('span', { text: '音' }), this.soundBtn]),
      h('div', { class: 'row' }, [h('span', { text: '画面の揺れ・点滅を減らす' }), this.motionBtn]),
      button('とじる', () => show(this.settingsPanel, false)),
    ]);
    this.el = h('div', { class: 'screen title' }, [
      h('div', { class: 'title-logo' }, [
        h('div', { class: 'logo-num', text: '10,000' }),
        h('div', { class: 'logo-sub', text: 'HORSE RACE' }),
        h('div', { class: 'logo-copy', text: '9,999頭を抜け。馬の山を跳び越えろ。' }),
      ]),
      h('div', { class: 'title-buttons' }, [
        button('レース開始', () => this.cb.onStart(), 'btn btn-primary btn-start'),
        h('div', { class: 'title-row' }, [
          button('遊び方', () => show(this.howto, true)),
          button('音・設定', () => show(this.settingsPanel, true)),
        ]),
      ]),
      this.bestEl,
      this.howto,
      this.settingsPanel,
    ]);
    parent.appendChild(this.el);
  }

  update(settings: Settings, best: BestRecord | null): void {
    this.soundBtn.textContent = settings.sound ? 'ON' : 'OFF';
    this.soundBtn.classList.toggle('on', settings.sound);
    this.motionBtn.textContent = settings.reduceMotion ? 'ON' : 'OFF';
    this.motionBtn.classList.toggle('on', settings.reduceMotion);
    this.bestEl.textContent = best
      ? `自己ベスト：${formatInt(best.rank)}位 / 10,000頭${best.time !== null ? `　${formatTime(best.time)}` : ''}${best.perfect ? '　PERFECT' : ''}`
      : '';
  }

  show(on: boolean): void {
    show(this.el, on);
    if (!on) {
      show(this.howto, false);
      show(this.settingsPanel, false);
    }
  }
}
