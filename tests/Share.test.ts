import { describe, expect, it } from 'vitest';
import { Course } from '../src/data/Course';
import { parseSeed } from '../src/data/Seed';
import { HorseSimulation } from '../src/game/HorseSimulation';
import { makeResult, type RaceResult } from '../src/game/Race';
import {
  GAME_URL,
  HASHTAG,
  TIER_COLORS,
  cardFileName,
  cardModel,
  cardTier,
  formatDate,
  playUrl,
  shareText,
  shareTextWithUrl,
  shortUrl,
  xIntentUrl,
} from '../src/share/CardText';

/** Phase 3: the card and the post show exactly the game result (design §6). */
function result(over: Partial<Parameters<typeof makeResult>[0]> = {}): RaceResult {
  return makeResult({
    seed: 4321,
    rank: 1248,
    field: 10000,
    time: 72.34,
    timedOut: false,
    overtakes: 8751,
    falls: 2,
    maxStreak: 3120,
    date: '2026-10-26T09:30:00.000Z',
    ...over,
  });
}

describe('card text = game result', () => {
  it('every number on the card comes from the RaceResult', () => {
    const r = result();
    const m = cardModel(r);
    expect(m.title).toBe('10,000 HORSE RACE');
    expect(m.tagline).toBe('9,999頭を抜け！');
    expect(m.rank).toBe('1,248');
    expect(m.field).toBe('/ 10,000');
    expect(m.rankLine).toBe('順位 1,248 / 10,000');
    expect(m.overtakes).toBe('追い抜き 8,751頭');
    expect(m.time).toBe('タイム 01:12.34');
    expect(m.falls).toBe('転倒 2回');
    expect(m.seed).toBe('SEED 4321');
    expect(m.url).toBe('cadmium2525.github.io/horse10-000/?seed=4321');
    expect(m.cta).toContain('挑戦してみる');
    expect(m.note).toContain('自己申告');
    expect(m.date).toBe(formatDate(r.date));
    expect(m.date).toMatch(/^\d{4}\/\d{2}\/\d{2}$/);
    expect(m.badge).toBeNull();
  });

  it('1st place: PERFECT (gold) only with zero falls, otherwise WIN (blue); others white', () => {
    const perfect = result({ rank: 1, falls: 0, overtakes: 9999 });
    const win = result({ rank: 1, falls: 1, overtakes: 9999 });
    const second = result({ rank: 2, falls: 0 });
    expect(cardTier(perfect)).toBe('perfect');
    expect(cardTier(win)).toBe('win');
    expect(cardTier(second)).toBe('normal');
    expect(cardModel(perfect).badge).toBe('PERFECT');
    expect(cardModel(win).badge).toBe('WIN!');
    expect(cardModel(second).badge).toBeNull();
    expect(TIER_COLORS[cardModel(perfect).tier].main).toBe('#ffd23f');
    expect(TIER_COLORS[cardModel(win).tier].main).toBe('#3fa7ff');
    expect(TIER_COLORS[cardModel(second).tier].main).toBe('#ffffff');
    expect(cardModel(perfect).overtakes).toBe('追い抜き 9,999頭');
    expect(cardModel(perfect).rankLine).toBe('順位 1 / 10,000');
  });

  it('time-up: no win, time shown as タイムアップ, TIME UP badge', () => {
    const r = result({ rank: 1, time: null, timedOut: true, falls: 0 });
    expect(r.win).toBe(false);
    const m = cardModel(r);
    expect(m.tier).toBe('normal');
    expect(m.time).toBe('タイム タイムアップ');
    expect(m.badge).toBe('TIME UP');
  });

  it('file names carry the date, rank and size', () => {
    const r = result();
    expect(cardFileName(r, 'landscape')).toMatch(/^10000horserace_\d{8}_rank1248_1200x630\.png$/);
    expect(cardFileName(r, 'portrait')).toMatch(/_1080x1350\.png$/);
  });
});

describe('post text and X Web Intent', () => {
  it('post text follows the design §6 example', () => {
    const r = result();
    expect(shareText(r)).toBe(['🐎 10,000頭競馬に挑戦！', '🏆 1,248位 / 10,000頭', '💥 追い抜き8,751頭・転倒2回', HASHTAG].join('\n'));
    expect(shareText(result({ rank: 1, falls: 0 }))).toContain('🏆 1位 / 10,000頭（PERFECT）');
    expect(shareTextWithUrl(r)).toBe(`${shareText(r)}\n${GAME_URL}?seed=4321`);
  });

  it('intent URL encodes text and url (emoji, newlines, #, &) and decodes back exactly', () => {
    const r = result();
    const text = shareText(r) + ' & more';
    const url = playUrl(r.seed);
    const intent = xIntentUrl(text, url);
    expect(intent.startsWith('https://twitter.com/intent/tweet?text=')).toBe(true);
    expect(intent).not.toMatch(/[\n #🐎]/u);
    expect(intent).toContain('%23');
    const q = new URL(intent).searchParams;
    expect(q.get('text')).toBe(text);
    expect(q.get('url')).toBe(url);
  });
});

describe('?seed= play URL regenerates the same course', () => {
  it('seed round-trips through the play URL', () => {
    for (const seed of [1, 4321, 99999999, 0xffffffff]) {
      const url = playUrl(seed);
      expect(url.startsWith('https://cadmium2525.github.io/horse10-000/?seed=')).toBe(true);
      expect(parseSeed(new URL(url).searchParams.get('seed'))).toBe(seed >>> 0);
      expect(shortUrl(seed)).toBe(url.slice('https://'.length));
    }
    // non-numeric seeds are hashed deterministically
    expect(parseSeed('my-race')).toBe(parseSeed('my-race'));
  });

  it('same seed → identical course and identical race; another seed → a different race', () => {
    const seed = parseSeed(new URL(playUrl(4321)).searchParams.get('seed'))!;
    const a = new Course(seed);
    const b = new Course(seed);
    expect(a.length).toBe(b.length);
    expect(a.width).toBe(b.width);
    for (let s = a.sMin; s < a.sMax; s += 97) expect(a.curvatureAt(s)).toBe(b.curvatureAt(s));
    const run = (sd: number) => {
      const sim = new HorseSimulation(new Course(sd), sd);
      for (let t = 0; t < 30 * 6; t++) sim.step();
      return sim.checksum();
    };
    expect(run(seed)).toBe(run(seed));
    expect(run(seed)).not.toBe(run(seed + 1));
  }, 60000);
});
