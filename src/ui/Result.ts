import { formatInt, formatTime, type RaceResult } from '../game/Race';
import type { BestRecord } from '../data/Storage';
import { CARD_SIZE, renderCard, type CardFormat } from '../share/CardRenderer';
import { cardFileName, cardModel, playUrl, shareText, shareTextWithUrl } from '../share/CardText';
import { canShareFiles, canvasToBlob, copyText, openXIntent, saveImage, shareImage } from '../share/Share';
import { button, h, show } from './dom';

export interface ResultCallbacks {
  onRetry(): void;
  onNewRace(): void;
  onTitle(): void;
}

/**
 * Result screen (Phase 3, design §6): preview of the result card and the share actions —
 * save PNG, OS share sheet (with the image), X Web Intent (text + URL), copy text / URL —
 * plus retry on the same course. Saving is one tap away from the result.
 *
 * Both card PNGs are rendered as soon as the result is shown, so every action can run
 * synchronously inside the tap (popup blockers, iOS share sheet).
 */
export class ResultScreen {
  readonly el: HTMLDivElement;
  private readonly summary: HTMLDivElement;
  private readonly preview: HTMLImageElement;
  private readonly status: HTMLDivElement;
  private readonly shareBtn: HTMLButtonElement;
  private readonly tabs: Record<CardFormat, HTMLButtonElement>;
  private format: CardFormat = 'landscape';
  private result: RaceResult | null = null;
  private blobs: Partial<Record<CardFormat, Blob>> = {};
  private urls: Partial<Record<CardFormat, string>> = {};
  private renderToken = 0;
  private statusTimer = 0;

  constructor(parent: HTMLElement, private readonly cb: ResultCallbacks) {
    this.summary = h('div', { class: 'result-summary' });
    this.preview = h('img', { class: 'card-preview', alt: '結果カード' });
    this.status = h('div', { class: 'result-status', role: 'status' });
    this.tabs = {
      landscape: button('横長 1200×630', () => this.setFormat('landscape'), 'tab active'),
      portrait: button('縦長 1080×1350', () => this.setFormat('portrait'), 'tab'),
    };
    this.shareBtn = button('画像を共有', () => void this.onShare(), 'btn btn-share');
    this.el = h('div', { class: 'screen result hidden' }, [
      h('div', { class: 'panel result-panel' }, [
        this.summary,
        h('div', { class: 'result-layout' }, [
          h('div', { class: 'result-card' }, [h('div', { class: 'card-tabs' }, [this.tabs.landscape, this.tabs.portrait]), this.preview]),
          h('div', { class: 'result-actions' }, [
            h('div', { class: 'share-main' }, [
              button('結果画像を保存', () => void this.onSave(), 'btn btn-primary btn-save'),
              this.shareBtn,
              button('Xに投稿', () => this.onX(), 'btn btn-x'),
            ]),
            h('p', { class: 'share-hint', text: 'Xには「保存した画像」を添付して投稿してね' }),
            h('div', { class: 'share-sub' }, [
              button('投稿文をコピー', () => void this.onCopyText(), 'btn btn-small'),
              button('URLをコピー', () => void this.onCopyUrl(), 'btn btn-small'),
            ]),
            this.status,
            h('div', { class: 'result-buttons' }, [
              button('もう一度（同じコース）', () => this.cb.onRetry(), 'btn btn-retry'),
              button('新しいレース', () => this.cb.onNewRace(), 'btn'),
              button('タイトルへ', () => this.cb.onTitle(), 'btn btn-ghost'),
            ]),
            h('div', { class: 'result-note', text: '※ 記録はこの端末で計測した自己申告記録です（サーバー検証はありません）。' }),
          ]),
        ]),
      ]),
    ]);
    parent.appendChild(this.el);
  }

  show(r: RaceResult | null, best: BestRecord | null = null, newBest = false): void {
    document.body.classList.toggle('in-result', !!r);
    if (!r) {
      show(this.el, false);
      this.result = null;
      this.releaseImages();
      return;
    }
    this.result = r;
    const badge = r.perfect ? 'PERFECT' : r.win ? 'WIN!' : r.timedOut ? 'TIME UP' : 'FINISH';
    const badgeCls = r.perfect ? 'perfect' : r.win ? 'win' : r.timedOut ? 'timeup' : 'finish';
    this.summary.replaceChildren(
      h('span', { class: `result-badge ${badgeCls}`, text: badge }),
      h('span', { class: 'result-line' }, [
        h('b', { class: 'big', text: formatInt(r.rank) }),
        `位 / ${formatInt(r.field)}　`,
        r.timedOut ? 'タイムアップ' : formatTime(r.time),
        `　転倒 ${r.falls}回`,
      ]),
      h('span', {
        class: 'result-best',
        text: best ? `自己ベスト ${formatInt(best.rank)}位${newBest ? '（更新！）' : ''}　最大連続 ${formatInt(r.maxStreak)}頭` : '',
      }),
      ...(r.timedOut || r.rank > 1000
        ? [h('p', { class: 'result-hint', text: 'ヒント：左右に動いて馬群のすき間を抜けよう。倒れた馬はジャンプ、ダッシュは前が空いた所で！' })]
        : []),
    );
    show(this.shareBtn, canShareFiles());
    this.setStatus('');
    show(this.el, true);
    void this.renderImages(r);
  }

  /** for tests / automation: the rendered PNG of a format (after render) */
  blob(format: CardFormat): Blob | undefined {
    return this.blobs[format];
  }

  private async renderImages(r: RaceResult): Promise<void> {
    const token = ++this.renderToken;
    this.releaseImages();
    this.el.classList.add('rendering');
    try {
      // system fonts only, but wait for them so the first frame is not a fallback face
      if (document.fonts?.ready) await document.fonts.ready;
      const model = cardModel(r);
      for (const f of ['landscape', 'portrait'] as const) {
        const canvas = renderCard(model, f, r.seed);
        const blob = await canvasToBlob(canvas);
        if (token !== this.renderToken) return;
        this.blobs[f] = blob;
        this.urls[f] = URL.createObjectURL(blob);
      }
      this.setFormat(this.format);
    } catch (e) {
      this.setStatus('カード画像を作れませんでした');
      console.warn(e);
    } finally {
      if (token === this.renderToken) this.el.classList.remove('rendering');
    }
  }

  private releaseImages(): void {
    for (const u of Object.values(this.urls)) if (u) URL.revokeObjectURL(u);
    this.urls = {};
    this.blobs = {};
  }

  private setFormat(f: CardFormat): void {
    this.format = f;
    for (const k of ['landscape', 'portrait'] as const) this.tabs[k].classList.toggle('active', k === f);
    const url = this.urls[f];
    if (url) this.preview.src = url;
    const { w, h: hh } = CARD_SIZE[f];
    this.preview.width = w;
    this.preview.height = hh;
    this.preview.classList.toggle('portrait', f === 'portrait');
  }

  private ready(): { r: RaceResult; blob: Blob } | null {
    const r = this.result;
    const blob = this.blobs[this.format];
    if (!r || !blob) {
      this.setStatus('画像を準備中です…');
      return null;
    }
    return { r, blob };
  }

  private async onSave(): Promise<void> {
    const x = this.ready();
    if (!x) return;
    const out = await saveImage(x.blob, cardFileName(x.r, this.format));
    this.setStatus(
      out === 'downloaded'
        ? '画像を保存しました'
        : out === 'opened'
          ? '新しいタブの画像を長押しして保存してね'
          : out === 'share-sheet'
            ? '共有メニューから「画像を保存」を選んでね'
            : '保存できませんでした',
    );
  }

  private async onShare(): Promise<void> {
    const x = this.ready();
    if (!x) return;
    const out = await shareImage(x.blob, cardFileName(x.r, this.format), shareText(x.r), playUrl(x.r.seed));
    if (out === 'unsupported' || out === 'failed') {
      // fallback (design §6): save the image + copy the text
      await saveImage(x.blob, cardFileName(x.r, this.format));
      const ok = await copyText(shareTextWithUrl(x.r));
      this.setStatus(ok ? '画像を保存し、投稿文をコピーしました' : '画像を保存しました');
    } else if (out === 'shared') {
      this.setStatus('共有しました');
    }
  }

  private onX(): void {
    const r = this.result;
    if (!r) return;
    openXIntent(shareText(r), playUrl(r.seed));
    this.setStatus('Xの投稿画面を開きました。保存した画像を添付してね');
  }

  private async onCopyText(): Promise<void> {
    const r = this.result;
    if (!r) return;
    this.setStatus((await copyText(shareTextWithUrl(r))) ? '投稿文をコピーしました' : 'コピーできませんでした');
  }

  private async onCopyUrl(): Promise<void> {
    const r = this.result;
    if (!r) return;
    this.setStatus((await copyText(playUrl(r.seed))) ? 'URLをコピーしました' : 'コピーできませんでした');
  }

  private setStatus(s: string): void {
    this.status.textContent = s;
    clearTimeout(this.statusTimer);
    if (s) this.statusTimer = window.setTimeout(() => (this.status.textContent = ''), 4000);
  }
}
