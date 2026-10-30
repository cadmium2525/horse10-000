/**
 * Share actions for the result card (design §6). Static site, no server: the PNG is made on
 * the device; the OS share sheet gets the file + text where the browser supports it, otherwise
 * Web Intents (X / LINE / Facebook) get text + URL (an image cannot be attached that way).
 *
 * Popup blockers / iOS require window.open and navigator.share to run inside the tap
 * handler, so callers pre-render the PNG blobs before the buttons are shown.
 */
import { facebookIntentUrl, lineIntentUrl, xIntentUrl, type ShareOutcome } from './CardText';

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
  });
}

export function isIOS(): boolean {
  const ua = navigator.userAgent;
  // iPadOS reports a Mac UA but has touch
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function canShareFiles(file?: File): boolean {
  try {
    const probe = file ?? new File([new Blob(['x'], { type: 'image/png' })], 'probe.png', { type: 'image/png' });
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

export type SaveOutcome = 'downloaded' | 'share-sheet' | 'opened' | 'failed';

/**
 * Save the PNG. Desktop / Android: <a download>. iOS Safari ignores download for blobs in a
 * useful way, so there the share sheet ("画像を保存") is used, or failing that the image is
 * opened in a new tab for long-press saving.
 */
export async function saveImage(blob: Blob, fileName: string): Promise<SaveOutcome> {
  if (isIOS()) {
    const file = new File([blob], fileName, { type: 'image/png' });
    if (canShareFiles(file)) {
      try {
        await navigator.share({ files: [file] });
        return 'share-sheet';
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return 'share-sheet';
      }
    }
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return win ? 'opened' : 'failed';
  }
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return 'downloaded';
  } catch {
    return 'failed';
  }
}

/**
 * OS share sheet with the image file and the post text. The play URL goes inside the text, not
 * the separate `url` field: on iOS, apps such as X keep only `url` and drop `text` when both are
 * passed, losing the message and hashtags.
 */
export async function shareImage(blob: Blob, fileName: string, text: string, url: string): Promise<ShareOutcome> {
  const file = new File([blob], fileName, { type: 'image/png' });
  if (!canShareFiles(file)) return 'unsupported';
  try {
    await navigator.share({ files: [file], text: `${text}\n${url}` });
    return 'shared';
  } catch (e) {
    return (e as DOMException)?.name === 'AbortError' ? 'cancelled' : 'failed';
  }
}

export type IntentTarget = 'x' | 'line' | 'facebook';

/** Web Intent in a new tab (text + URL pre-filled; intents cannot carry an image) */
export function openIntent(target: IntentTarget, text: string, url: string): void {
  const href = target === 'x' ? xIntentUrl(text, url) : target === 'line' ? lineIntentUrl(text, url) : facebookIntentUrl(text, url);
  // no 'noopener' feature: with it window.open always returns null, which would look like a
  // blocked popup and navigate the game tab away. Detach the opener by hand instead.
  const win = window.open(href, '_blank');
  if (win) win.opener = null;
  else location.href = href; // popup blocked: navigate this tab instead
}

/** clipboard with an execCommand fallback (older iOS / insecure contexts) */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.fontSize = '16px'; // no iOS focus zoom
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
