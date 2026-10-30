import { formatInt, formatTime, type RaceResult } from '../game/Race';

/** public game URL (GitHub Pages project site) */
export const GAME_URL = 'https://cadmium2525.github.io/horse10-000/';
export const HASHTAGS = ['#10000HorseRace', '#10000頭競馬'] as const;

export type CardTier = 'perfect' | 'win' | 'normal';

/** design §6 colour coding: PERFECT gold / 1st blue / everything else white */
export const TIER_COLORS: Record<CardTier, { main: string; accent: string; ink: string }> = {
  perfect: { main: '#ffd23f', accent: '#ff9f1c', ink: '#3a2600' },
  win: { main: '#3fa7ff', accent: '#1d6fd1', ink: '#ffffff' },
  normal: { main: '#ffffff', accent: '#cfd8e6', ink: '#1d2433' },
};

export function cardTier(r: Pick<RaceResult, 'perfect' | 'win'>): CardTier {
  return r.perfect ? 'perfect' : r.win ? 'win' : 'normal';
}

/** play URL for a seed: anyone opening it races the same course */
export function playUrl(seed: number, base: string = GAME_URL): string {
  return `${base}?seed=${seed >>> 0}`;
}

/** short form shown on the card (no scheme) */
export function shortUrl(seed: number, base: string = GAME_URL): string {
  return playUrl(seed, base).replace(/^https?:\/\//, '');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** YYYY/MM/DD in the device's local time */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

export interface CardModel {
  tier: CardTier;
  title: string;
  tagline: string;
  /** big number */
  rank: string;
  /** "/ 10,000" */
  field: string;
  rankLine: string;
  overtakes: string;
  time: string;
  falls: string;
  badge: 'PERFECT' | 'WIN!' | 'TIME UP' | null;
  date: string;
  seed: string;
  url: string;
  cta: string;
  note: string;
}

/** Every text on the card, derived only from the RaceResult (tests pin it to the game result). */
export function cardModel(r: RaceResult, base: string = GAME_URL): CardModel {
  const tier = cardTier(r);
  return {
    tier,
    title: '10,000 HORSE RACE',
    tagline: `${formatInt(r.field - 1)}頭を抜け！`,
    rank: formatInt(r.rank),
    field: `/ ${formatInt(r.field)}`,
    rankLine: `順位 ${formatInt(r.rank)} / ${formatInt(r.field)}`,
    overtakes: `追い抜き ${formatInt(r.overtakes)}頭`,
    time: r.timedOut || r.time === null ? 'タイム —' : `タイム ${formatTime(r.time)}`,
    falls: `転倒 ${r.falls}回`,
    badge: r.perfect ? 'PERFECT' : r.win ? 'WIN!' : r.timedOut ? 'TIME UP' : null,
    date: formatDate(r.date),
    seed: `SEED ${r.seed >>> 0}`,
    url: shortUrl(r.seed, base),
    cta: '挑戦してみる ▶',
    note: '※ この端末で計測した自己申告記録です',
  };
}

/** design §6 suggested post text (hashtags included; the play URL is passed separately) */
export function shareText(r: RaceResult): string {
  return [
    '🐎 10,000頭競馬に挑戦！',
    `🏆 ${formatInt(r.rank)}位 / ${formatInt(r.field)}頭`,
    `💥 追い抜き${formatInt(r.overtakes)}頭・転倒${r.falls}回`,
    ...(r.perfect ? ['✨ 転倒ゼロでPERFECT達成！'] : r.win ? ['🎉 1位ゴール！'] : []),
    HASHTAGS.join(' '),
  ].join('\n');
}

/** full post text for "copy" (the intents pass the URL separately) */
export function shareTextWithUrl(r: RaceResult, base: string = GAME_URL): string {
  return `${shareText(r)}\n${playUrl(r.seed, base)}`;
}

/** X (Twitter) Web Intent: pre-filled text + URL (an image cannot be attached this way) */
export function xIntentUrl(text: string, url: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
}

/** LINE share: text + URL (no image) */
export function lineIntentUrl(text: string, url: string): string {
  return `https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}

/** Facebook sharer: URL only (the quote parameter carries the text) */
export function facebookIntentUrl(text: string, url: string): string {
  return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}&quote=${encodeURIComponent(text)}`;
}

export type SharePath = 'os-sheet' | 'chooser';

/** the single share button: OS share sheet when it can carry the image file, else our own sheet */
export function chooseSharePath(caps: { canShareFiles: boolean }): SharePath {
  return caps.canShareFiles ? 'os-sheet' : 'chooser';
}

export type ShareOutcome = 'shared' | 'cancelled' | 'unsupported' | 'failed';

/** what to do after navigator.share settled: cancel is silent, errors fall back to the sheet */
export function afterShare(outcome: ShareOutcome): 'done' | 'silent' | 'chooser' {
  return outcome === 'shared' ? 'done' : outcome === 'cancelled' ? 'silent' : 'chooser';
}

export function cardFileName(r: RaceResult, format: 'landscape' | 'portrait'): string {
  const d = formatDate(r.date).replace(/\//g, '');
  return `10000horserace_${d}_rank${r.rank}_${format === 'landscape' ? '1200x630' : '1080x1350'}.png`;
}
