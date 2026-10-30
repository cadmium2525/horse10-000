import { formatInt, formatTime, type RaceResult } from '../game/Race';
import type { BestRecord } from '../data/Storage';
import { CARD_SIZE, renderCard, type CardFormat } from '../share/CardRenderer';
import { afterShare, cardFileName, cardModel, chooseSharePath, playUrl, shareText, shareTextWithUrl } from '../share/CardText';
import { canShareFiles, canvasToBlob, copyText, openIntent, saveImage, shareImage, type IntentTarget } from '../share/Share';
import { button, h, show } from './dom';

export interface ResultCallbacks {
  onRetry(): void;
  onNewRace(): void;
  onTitle(): void;
}

/**
 * Result screen (design §6): preview of the result card and ONE share button.
 *  - the OS share sheet (image + text + URL) when the browser can share files (phones)
 *  - otherwise a small sheet: X / LINE / Facebook / save the image. Web Intents cannot carry
 *    an image, so choosing an SNS also downloads the PNG and tells the user to attach it.
 * The card background is a photo of the game's 3D scene (taken at the goal by the Game).
 *
 * Both card PNGs are rendered as soon as the result is shown, so the share runs synchronously
 * inside the tap (popup blockers, iOS user activation).
 */
export type CardPhotos = Partial<Record<CardFormat, CanvasImageSource>>;

export class ResultScreen {
  readonly el: HTMLDivElement;
  private readonly summary: HTMLDivElement;
  private readonly preview: HTMLImageElement;
  private readonly status: HTMLDivElement;
  private readonly sheet: HTMLDivElement;
  private readonly sheetNote: HTMLDivElement;
  private photos: CardPhotos = {};
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
    this.sheetNote = h('div', { class: 'sheet-note', role: 'status' });
    const sns = (label: string, cls: string, t: IntentTarget) => button(label, () => this.onIntent(t), `btn sheet-btn ${cls}`);
    this.sheet = h('div', { class: 'share-sheet hidden', role: 'dialog', 'aria-label': '共有先を選ぶ' }, [
      h('div', { class: 'sheet-box' }, [
        h('div', { class: 'sheet-title', text: '共有先を選ぶ' }),
        sns('X に投稿', 'sheet-x', 'x'),
        sns('LINE で送る', 'sheet-line', 'line'),
        sns('Facebook に投稿', 'sheet-fb', 'facebook'),
        button('画像を保存', () => void this.onSave(), 'btn sheet-btn sheet-save'),
        h('div', { class: 'sheet-hint', text: 'SNS の投稿画面には画像を付けられないため、選ぶと画像を保存します。保存した画像を投稿画面で添付してね。' }),
        this.sheetNote,
        h('div', { class: 'sheet-foot' }, [
          button('テキストをコピー', () => void this.onCopyText(), 'btn btn-small'),
          button('閉じる', () => this.closeSheet(), 'btn btn-small btn-ghost'),
        ]),
      ]),
    ]);
    this.el = h('div', { class: 'screen result hidden' }, [
      h('div', { class: 'panel result-panel' }, [
        this.summary,
        h('div', { class: 'result-layout' }, [
          h('div', { class: 'result-card' }, [
            h('div', { class: 'card-tabs' }, [this.tabs.landscape, this.tabs.portrait]),
            this.preview,
            h('div', { class: 'card-placeholder', text: '画像を作っています…' }),
          ]),
          h('div', { class: 'result-actions' }, [
            button('スコアを共有する', () => void this.onShare(), 'btn btn-primary btn-share'),
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
      this.sheet,
    ]);
    parent.appendChild(this.el);
  }

  show(r: RaceResult | null, best: BestRecord | null = null, newBest: 'first' | 'new' | null = null, photos: CardPhotos = {}): void {
    document.body.classList.toggle('in-result', !!r);
    this.closeSheet();
    if (!r) {
      show(this.el, false);
      this.result = null;
      this.photos = {};
      this.renderToken++;
      this.releaseImages();
      return;
    }
    this.result = r;
    this.photos = photos;
    const badge = r.perfect ? 'PERFECT' : r.win ? 'WIN!' : r.timedOut ? 'TIME UP' : 'FINISH';
    const badgeCls = r.perfect ? 'perfect' : r.win ? 'win' : r.timedOut ? 'timeup' : 'finish';
    this.summary.replaceChildren(
      h('span', { class: `result-badge ${badgeCls}`, text: badge }),
      h('span', { class: 'result-line' }, [
        h('b', { class: 'big', text: formatInt(r.rank) }),
        `位 / ${formatInt(r.field)}　`,
        r.timedOut ? 'タイム —' : formatTime(r.time),
        `　転倒 ${r.falls}回`,
      ]),
      h('span', {
        class: 'result-best',
        text: best
          ? `自己ベスト ${formatInt(best.rank)}位${newBest === 'new' ? '（更新！）' : newBest === 'first' ? '（初記録）' : ''}　最大連続 ${formatInt(r.maxStreak)}頭`
          : `最大連続 ${formatInt(r.maxStreak)}頭`,
      }),
      ...(r.timedOut || r.rank > 1000
        ? [h('p', { class: 'result-hint', text: 'ヒント：左右に動いて馬群のすき間を抜けよう。倒れた馬はジャンプ、ダッシュは前が空いた所で！' })]
        : []),
    );
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
        const canvas = renderCard(model, f, r.seed, undefined, this.photos[f]);
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
    const msg =
      out === 'downloaded'
        ? '画像を保存しました'
        : out === 'opened'
          ? '新しいタブの画像を長押しして保存してね'
          : out === 'share-sheet'
            ? '共有メニューから「画像を保存」を選んでね'
            : '保存できませんでした';
    this.setStatus(msg);
    this.setSheetNote(msg);
  }

  /** the one share button */
  private async onShare(): Promise<void> {
    const x = this.ready();
    if (!x) return;
    if (chooseSharePath({ canShareFiles: canShareFiles() }) === 'chooser') {
      this.openSheet();
      return;
    }
    const out = await shareImage(x.blob, cardFileName(x.r, this.format), shareText(x.r), playUrl(x.r.seed));
    const next = afterShare(out);
    if (next === 'chooser') this.openSheet();
    else if (next === 'done') this.setStatus('共有しました');
  }

  /** SNS chosen in the sheet: the image goes to the downloads, the intent opens text + URL */
  private onIntent(t: IntentTarget): void {
    const x = this.ready();
    if (!x) return;
    // both run synchronously inside the tap (the download first, then the popup)
    void saveImage(x.blob, cardFileName(x.r, this.format));
    openIntent(t, shareText(x.r), playUrl(x.r.seed));
    this.setSheetNote('画像を保存しました。投稿画面で添付してください');
    this.setStatus('画像を保存しました。投稿画面で添付してください');
  }

  private openSheet(): void {
    this.setSheetNote('');
    show(this.sheet, true);
  }

  private closeSheet(): void {
    show(this.sheet, false);
  }

  private setSheetNote(s: string): void {
    this.sheetNote.textContent = s;
  }

  private async onCopyText(): Promise<void> {
    const r = this.result;
    if (!r) return;
    const msg = (await copyText(shareTextWithUrl(r))) ? 'テキストをコピーしました' : 'コピーできませんでした';
    this.setStatus(msg);
    this.setSheetNote(msg);
  }

  private setStatus(s: string): void {
    this.status.textContent = s;
    clearTimeout(this.statusTimer);
    if (s) this.statusTimer = window.setTimeout(() => (this.status.textContent = ''), 4000);
  }
}
