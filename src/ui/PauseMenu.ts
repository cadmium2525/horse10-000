import { button, h, show } from './dom';

export class PauseMenu {
  readonly el: HTMLDivElement;
  constructor(parent: HTMLElement, cb: { onResume(): void; onRestart(): void; onTitle(): void }) {
    this.el = h('div', { class: 'screen pause hidden' }, [
      h('div', { class: 'panel' }, [
        h('h2', { text: 'ポーズ' }),
        button('再開', () => cb.onResume(), 'btn btn-primary'),
        button('最初からやり直す', () => cb.onRestart(), 'btn'),
        button('タイトルへ', () => cb.onTitle(), 'btn btn-ghost'),
      ]),
    ]);
    parent.appendChild(this.el);
  }
  show(on: boolean): void {
    show(this.el, on);
  }
}
