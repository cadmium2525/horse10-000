import { Rng } from '../data/Seed';
import { TIER_COLORS, type CardModel } from './CardText';

/**
 * Result card (design §6): drawn on a dedicated 2D canvas — a toy horse running towards the
 * camera in front of an enormous field, and the big rank number. No DOM screenshots, no
 * WebGL read-back, system fonts only (awaited via document.fonts.ready by the caller).
 *
 *  - landscape 1200×630 (share / OGP size), portrait 1080×1350 (save / stories)
 *  - everything is a function of (model, seed): the same result gives the same image
 */
export type CardFormat = 'landscape' | 'portrait';

export const CARD_SIZE: Record<CardFormat, { w: number; h: number }> = {
  landscape: { w: 1200, h: 630 },
  portrait: { w: 1080, h: 1350 },
};

const FONT = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", "Meiryo", system-ui, sans-serif';
const INK = '#1d2433';
const COATS = ['#8a5a3b', '#5c3a26', '#c99a6b', '#efe7da', '#3b2a22', '#a8743f', '#d8c3a5'];
const SILKS = ['#ff4f8b', '#2fb7ff', '#ffd23f', '#7bd389', '#a66bff', '#ff8c42', '#ffffff', '#ff5c5c', '#3ee0c5'];

type Ctx = CanvasRenderingContext2D;

/** where the player's horse sits in the card photo (fraction of width / height) and how far the camera is */
export const PHOTO_SHOT: Record<CardFormat, { focus: { x: number; y: number }; dist: number }> = {
  landscape: { focus: { x: 0.24, y: 0.6 }, dist: 6 },
  portrait: { focus: { x: 0.5, y: 0.4 }, dist: 10.5 },
};

/**
 * `photo` = a render of the game's own 3D scene (World.captureCard) used as the background;
 * without it the card falls back to the flat 2D scene (WebGL unavailable / tests).
 */
export function renderCard(
  model: CardModel,
  format: CardFormat,
  seed: number,
  canvas?: HTMLCanvasElement,
  photo?: CanvasImageSource | null,
): HTMLCanvasElement {
  const { w, h } = CARD_SIZE[format];
  const c = canvas ?? document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  const rng = new Rng((seed ^ 0x9e3779b9) >>> 0);
  if (photo) {
    ctx.drawImage(photo, 0, 0, w, h);
    if (model.tier !== 'normal') tierGlow(ctx, w, h, format, model.tier);
  } else {
    const horizon = format === 'landscape' ? h * 0.42 : h * 0.3;
    drawScene(ctx, w, h, horizon, rng);
    if (format === 'landscape') drawHero(ctx, w * 0.2, h * 0.97, h * 0.0088, model.tier);
    else drawHero(ctx, w * 0.5, 600, 3.4, model.tier);
  }
  if (format === 'landscape') drawTextLandscape(ctx, model, w, h);
  else drawTextPortrait(ctx, model, w, h);
  return c;
}

/** PERFECT gold / WIN blue light behind the player's horse */
function tierGlow(ctx: Ctx, w: number, h: number, format: CardFormat, tier: CardModel['tier']): void {
  const f = PHOTO_SHOT[format].focus;
  const col = tier === 'perfect' ? '255,210,63' : '63,167,255';
  const g = ctx.createRadialGradient(f.x * w, f.y * h, 0, f.x * w, f.y * h, Math.min(w, h) * 0.55);
  g.addColorStop(0, `rgba(${col},0.38)`);
  g.addColorStop(1, `rgba(${col},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = `rgba(${col},0.95)`;
  ctx.lineWidth = 14;
  ctx.strokeRect(7, 7, w - 14, h - 14);
}

/** fixed OGP image (no personal result): title, copy and the crowd */
export function renderOgp(canvas?: HTMLCanvasElement): HTMLCanvasElement {
  const { w, h } = CARD_SIZE.landscape;
  const c = canvas ?? document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  drawScene(ctx, w, h, h * 0.42, new Rng(10000));
  drawHero(ctx, w * 0.24, h * 0.98, h * 0.0105, 'normal');
  const x = w * 0.47;
  panel(ctx, x - 30, 40, w - x - 10, h - 80, 0.55);
  ctx.textBaseline = 'alphabetic';
  text(ctx, '10,000', x, 200, 150, '#ffd23f', 900, INK, 10);
  text(ctx, 'HORSE RACE', x + 6, 280, 76, '#ffffff', 900, INK, 8);
  text(ctx, '9,999頭を抜け！', x + 6, 375, 62, '#ffffff', 900, INK, 8);
  text(ctx, '1万頭が同時に走るコミカル競馬', x + 8, 450, 34, '#ffffff', 800, INK, 5);
  text(ctx, '転倒の山を跳び越えて 1位を目指せ', x + 8, 500, 34, '#ffffff', 800, INK, 5);
  text(ctx, 'cadmium2525.github.io/horse10-000', x + 8, 560, 28, '#cfe6f7', 700, INK, 4);
  return c;
}

// ---------------------------------------------------------------------------------------
// scene
// ---------------------------------------------------------------------------------------

function drawScene(ctx: Ctx, w: number, h: number, horizon: number, rng: Rng): void {
  // sky
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, '#4f9fea');
  sky.addColorStop(1, '#cfe6f7');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, horizon + 2);
  // low-poly hills and clouds
  ctx.fillStyle = '#9cc79a';
  ctx.beginPath();
  ctx.moveTo(0, horizon);
  for (let k = 0; k <= 8; k++) ctx.lineTo((k / 8) * w, horizon - (0.04 + 0.05 * rng.next()) * h);
  ctx.lineTo(w, horizon);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  for (let k = 0; k < 5; k++) {
    const cx = rng.range(0, w);
    const cy = rng.range(0.05, 0.6) * horizon;
    const s = rng.range(0.04, 0.08) * w;
    for (let j = 0; j < 4; j++) {
      ctx.beginPath();
      ctx.ellipse(cx + (j - 1.5) * s * 0.55, cy + (j % 2) * s * 0.08, s * 0.42, s * 0.24, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // turf with mowing stripes converging to the horizon
  const turf = ctx.createLinearGradient(0, horizon, 0, h);
  turf.addColorStop(0, '#7fbf5f');
  turf.addColorStop(1, '#4f9d3a');
  ctx.fillStyle = turf;
  ctx.fillRect(0, horizon, w, h - horizon);
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  const vx = w * 0.5;
  for (let k = -12; k < 12; k += 2) {
    ctx.beginPath();
    ctx.moveTo(vx + k * 4, horizon);
    ctx.lineTo(vx + (k + 1) * 4, horizon);
    ctx.lineTo(vx + (k + 1) * w * 0.12, h);
    ctx.lineTo(vx + k * w * 0.12, h);
    ctx.closePath();
    ctx.fill();
  }
  // the field: thousands of horses receding to the horizon (far = coloured dots, near = toys)
  drawCrowd(ctx, w, h, horizon, rng);
}

function drawCrowd(ctx: Ctx, w: number, h: number, horizon: number, rng: Rng): void {
  // depth z in (0, 1]: 0 = horizon, 1 = foreground; screen y and scale follow perspective
  const rows = 70;
  for (let r = 0; r < rows; r++) {
    const z = 0.04 + (r / rows) ** 1.7 * 0.62;
    const y = horizon + (h - horizon) * z * 0.95;
    const scale = (h / 630) * (0.6 + z * 9);
    const count = Math.round(w / (scale * 9 + 2));
    for (let k = 0; k < count; k++) {
      if (rng.next() < 0.12) continue; // natural gaps
      const x = (k + rng.range(-0.4, 0.4)) * (w / count);
      const silk = SILKS[rng.int(0, SILKS.length - 1)];
      if (scale < 2.2) {
        ctx.fillStyle = COATS[rng.int(0, COATS.length - 1)];
        ctx.fillRect(x - scale, y - scale * 1.4, scale * 2.2, scale * 1.4);
        ctx.fillStyle = silk;
        ctx.fillRect(x - scale * 0.4, y - scale * 2.6, scale * 0.9, scale * 1.2);
      } else {
        drawHorse(ctx, x, y, scale * 0.42, COATS[rng.int(0, COATS.length - 1)], silk, rng.next() * 6, true);
      }
    }
  }
}

/** a toy horse seen from behind-ish / three-quarter: body, legs mid-gallop, rider */
function drawHorse(ctx: Ctx, x: number, y: number, s: number, coat: string, silk: string, phase: number, fromBehind: boolean): void {
  ctx.save();
  ctx.translate(x, y);
  const legSwing = Math.sin(phase) * 0.35;
  ctx.fillStyle = shade(coat, -0.25);
  // legs
  for (const [dx, sw] of [
    [-3, legSwing],
    [3, -legSwing],
  ] as const) {
    ctx.save();
    ctx.translate(dx * s, -7 * s);
    ctx.rotate(sw);
    ctx.fillRect(-1.1 * s, 0, 2.2 * s, 7 * s);
    ctx.restore();
  }
  // body (rump towards the camera when seen from behind)
  ctx.fillStyle = coat;
  roundRect(ctx, -5.5 * s, -14 * s, 11 * s, 8.5 * s, 3 * s);
  ctx.fill();
  if (!fromBehind) {
    ctx.beginPath();
    ctx.ellipse(0, -17 * s, 2.6 * s, 3.2 * s, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // tail
  ctx.fillStyle = shade(coat, -0.4);
  roundRect(ctx, -1 * s, -12 * s, 2 * s, 5.5 * s, 1 * s);
  ctx.fill();
  // saddle cloth + rider
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, -5 * s, -15.5 * s, 10 * s, 3 * s, 1 * s);
  ctx.fill();
  ctx.fillStyle = silk;
  roundRect(ctx, -3.2 * s, -22 * s, 6.4 * s, 7.5 * s, 2.5 * s);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, -24 * s, 2.4 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** the player's horse galloping at the camera: big, side-on, pink/gold silks */
function drawHero(ctx: Ctx, x: number, y: number, s: number, tier: CardModel['tier']): void {
  const silk = tier === 'perfect' ? '#ffd23f' : tier === 'win' ? '#3fa7ff' : '#ff4f8b';
  const coat = '#f4efe6';
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.lineJoin = 'round';
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.ellipse(0, -2, 26, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  const outline = (draw: () => void, fill: string) => {
    ctx.fillStyle = fill;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.6;
    draw();
    ctx.fill();
    ctx.stroke();
  };
  // legs mid-gallop (far pair darker)
  const leg = (lx: number, ly: number, ang: number, col: string) =>
    outline(() => {
      ctx.save();
      ctx.translate(lx, ly);
      ctx.rotate(ang);
      roundRect(ctx, -2.2, 0, 4.4, 20, 2);
      ctx.restore();
    }, col);
  leg(-14, -30, 0.7, shade(coat, -0.2));
  leg(14, -30, -0.6, shade(coat, -0.2));
  leg(-10, -30, 0.25, coat);
  leg(17, -30, -1.0, coat);
  // body
  outline(() => roundRect(ctx, -22, -46, 46, 20, 9), coat);
  // neck + head (stretched forward = to the right)
  outline(() => {
    ctx.beginPath();
    ctx.moveTo(14, -44);
    ctx.lineTo(28, -62);
    ctx.lineTo(36, -58);
    ctx.lineTo(26, -36);
    ctx.closePath();
  }, coat);
  outline(() => roundRect(ctx, 26, -66, 18, 9, 4), coat);
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(34, -63, 1.2, 0, Math.PI * 2);
  ctx.fill();
  // mane + tail flying
  outline(() => {
    ctx.beginPath();
    ctx.moveTo(-22, -42);
    ctx.quadraticCurveTo(-36, -46, -42, -36);
    ctx.quadraticCurveTo(-32, -38, -22, -34);
    ctx.closePath();
  }, '#6b4a2f');
  // saddle cloth, number and jockey
  outline(() => roundRect(ctx, -8, -50, 16, 12, 2), '#ffffff');
  ctx.fillStyle = INK;
  ctx.font = `900 8px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('1', 0, -41);
  outline(() => roundRect(ctx, -6, -68, 14, 18, 6), silk);
  outline(() => {
    ctx.beginPath();
    ctx.arc(4, -73, 6, 0, Math.PI * 2);
  }, silk);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(-2, -78, 12, 2);
  // speed lines
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 2;
  for (let k = 0; k < 4; k++) {
    ctx.beginPath();
    ctx.moveTo(-34 - k * 4, -56 + k * 9);
    ctx.lineTo(-54 - k * 6, -56 + k * 9);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------------------

function drawTextLandscape(ctx: Ctx, m: CardModel, w: number, h: number): void {
  const col = TIER_COLORS[m.tier];
  const x = w * 0.47;
  const right = w - 36;
  panel(ctx, x - 30, 24, w - x + 6, h - 48, 0.55);
  text(ctx, m.title, x, 70, 34, '#ffffff', 900, INK, 6);
  text(ctx, m.tagline, x + 2, 110, 26, '#ffe48a', 800, INK, 4);
  if (m.badge) badge(ctx, m.badge, right, 62, 28, col, 'right');
  // big rank: number + 位 + / 10,000 must fit the panel
  const avail = right - x;
  const unit = 60;
  let big = 220;
  while (big > 80 && measure(ctx, m.rank, big, 900) + measure(ctx, '位', unit, 900) + measure(ctx, m.field, 42, 900) + 22 > avail) big -= 6;
  const bigW = measure(ctx, m.rank, big, 900);
  text(ctx, m.rank, x - 4, 318, big, col.main, 900, INK, 12);
  text(ctx, '位', x + bigW + 6, 318, unit, col.main, 900, INK, 7);
  text(ctx, m.field, x + bigW + 6 + measure(ctx, '位', unit, 900) + 10, 318, 42, '#ffffff', 900, INK, 6);
  // stats
  text(ctx, m.overtakes, x, 386, 38, '#ffffff', 900, INK, 6);
  text(ctx, `${m.time}　${m.falls}`, x, 434, 32, '#ffffff', 800, INK, 5);
  // footer: date / seed, call to action + play URL, self-reported note
  text(ctx, `${m.date}　${m.seed}`, x, 484, 22, '#dce9f5', 700, INK, 4);
  text(ctx, m.cta, x, 526, 30, '#ffd23f', 900, INK, 5);
  fitText(ctx, m.url, x, 560, 24, avail, '#ffffff', 700, INK, 4);
  text(ctx, m.note, x, 592, 17, '#dce9f5', 600, INK, 3);
}

function drawTextPortrait(ctx: Ctx, m: CardModel, w: number, h: number): void {
  const col = TIER_COLORS[m.tier];
  const cx = w / 2;
  // top: title; middle stays free for the photo; bottom: the numbers
  panel(ctx, 40, 30, w - 80, 172, 0.5);
  center(ctx, m.title, cx, 112, 72, '#ffffff', 900, INK, 9);
  center(ctx, m.tagline, cx, 176, 46, '#ffe48a', 900, INK, 7);
  panel(ctx, 40, 730, w - 80, 416, 0.8);
  if (m.badge) badge(ctx, m.badge, cx, 786, 44, col, 'center');
  let big = 200;
  while (big > 90 && measure(ctx, m.rank, big, 900) + measure(ctx, '位', 70, 900) + 8 > w - 160) big -= 6;
  const bigW = measure(ctx, m.rank, big, 900);
  const unitW = measure(ctx, '位', 70, 900);
  const left = cx - (bigW + unitW + 8) / 2;
  text(ctx, m.rank, left, 950, big, col.main, 900, INK, 14);
  text(ctx, '位', left + bigW + 8, 950, 70, col.main, 900, INK, 8);
  center(ctx, `${m.field}頭`, cx, 1012, 46, '#ffffff', 900, INK, 9);
  center(ctx, m.overtakes, cx, 1073, 44, '#ffffff', 900, INK, 9);
  center(ctx, `${m.time}　${m.falls}`, cx, 1124, 36, '#ffffff', 800, INK, 8);
  // footer band
  panel(ctx, 0, h - 196, w, 196, 0.82);
  center(ctx, `${m.date}　${m.seed}`, cx, h - 150, 30, '#ffffff', 700, INK, 6);
  center(ctx, m.cta, cx, h - 104, 38, '#ffd23f', 900, INK, 5);
  const urlSize = Math.min(32, fitSize(ctx, m.url, 32, w - 80, 700));
  center(ctx, m.url, cx, h - 62, urlSize, '#ffffff', 700, INK, 6);
  center(ctx, m.note, cx, h - 22, 24, '#ffffff', 600, INK, 5);
}

function fitSize(ctx: Ctx, s: string, size: number, maxWidth: number, weight: number): number {
  while (size > 12 && measure(ctx, s, size, weight) > maxWidth) size -= 1;
  return size;
}

function fitText(ctx: Ctx, s: string, x: number, y: number, size: number, maxWidth: number, fill: string, weight: number, stroke: string, sw: number): void {
  text(ctx, s, x, y, fitSize(ctx, s, size, maxWidth, weight), fill, weight, stroke, sw);
}

function measure(ctx: Ctx, s: string, size: number, weight: number): number {
  ctx.font = `${weight} ${size}px ${FONT}`;
  return ctx.measureText(s).width;
}

function text(ctx: Ctx, s: string, x: number, y: number, size: number, fill: string, weight: number, stroke: string, sw: number): void {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = stroke;
  ctx.lineWidth = sw;
  ctx.strokeText(s, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(s, x, y);
}

function center(ctx: Ctx, s: string, cx: number, y: number, size: number, fill: string, weight: number, stroke: string, sw: number): void {
  text(ctx, s, cx - measure(ctx, s, size, weight) / 2, y, size, fill, weight, stroke, sw);
}

function badge(ctx: Ctx, label: string, x: number, y: number, size: number, col: { main: string; accent: string; ink: string }, align: 'right' | 'center'): void {
  const tw = measure(ctx, label, size, 900);
  const bw = tw + size * 1.2;
  const bh = size * 1.5;
  const left = align === 'right' ? x - bw : x - bw / 2;
  ctx.fillStyle = col.accent;
  roundRect(ctx, left + 4, y - bh / 2 + 5, bw, bh, bh / 2);
  ctx.fill();
  ctx.fillStyle = col.main;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4;
  roundRect(ctx, left, y - bh / 2, bw, bh, bh / 2);
  ctx.fill();
  ctx.stroke();
  ctx.font = `900 ${size}px ${FONT}`;
  ctx.fillStyle = col.ink === '#ffffff' ? '#ffffff' : INK;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(label, left + (bw - tw) / 2, y + 2);
  ctx.textBaseline = 'alphabetic';
}

function panel(ctx: Ctx, x: number, y: number, w: number, h: number, alpha: number): void {
  ctx.fillStyle = `rgba(29,36,51,${alpha})`;
  roundRect(ctx, x, y, w, h, 28);
  ctx.fill();
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c + c * amt)));
  const r = f((n >> 16) & 255);
  const g = f((n >> 8) & 255);
  const b = f(n & 255);
  return `rgb(${r},${g},${b})`;
}
