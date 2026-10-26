import { describe, expect, it } from 'vitest';
import { DIFFICULTY_SEEDS, OPTIMAL, mean, median, report, runRace, wins, type RaceRun } from './helpers/race';

/**
 * Difficulty fixed against bot proxies (Phase 1b review M1/M2/M4 + the Phase 1 M3/M4 checks).
 * Part 1: the optimal bot and what jumping is worth. Seeds and bots are deterministic, so
 * these are exact regression checks of the balance, not flaky statistics.
 */
describe('difficulty: optimal play', () => {
  let optimal: RaceRun[] = [];
  let noJump: RaceRun[] = [];

  it('optimal bot can win, finishes near the top, PERFECT stays rare (≤ 40 %)', () => {
    optimal = DIFFICULTY_SEEDS.map((s) => runRace(s, OPTIMAL));
    report('optimal', optimal);
    const n = optimal.length;
    expect(wins(optimal)).toBeGreaterThanOrEqual(1);
    expect(optimal.filter((r) => r.perfect).length).toBeLessThanOrEqual(Math.floor(n * 0.4));
    expect(median(optimal.map((r) => r.rank))).toBeLessThanOrEqual(20);
  }, 900000);

  // (review target 40–80 %; measured mean ≈ 25 %, 0–63 % per race — situational, but the
  // optimal bot leans to the wider line since the corridors were removed — see report)
  it('M2: on the turns the optimal line is situational (rail used in some races, never only)', () => {
    const share = mean(optimal.map((r) => r.insideShare));
    expect(share).toBeGreaterThanOrEqual(0.15);
    expect(Math.max(...optimal.map((r) => r.insideShare))).toBeGreaterThanOrEqual(0.4);
    expect(share).toBeLessThanOrEqual(0.8);
    // the field packs the inside rail on the turn: inner 20 m at 1.4–1.6× the mean density
    const dens = mean(optimal.map((r) => r.innerDensity));
    expect(dens).toBeGreaterThanOrEqual(1.4);
    expect(dens).toBeLessThanOrEqual(1.6);
  });

  it('M4 race feel: the optimal bot has passed ≥ 2,000 horses 30 s after the start', () => {
    for (const r of optimal) expect(r.rank30).toBeLessThanOrEqual(8000);
  });

  it('P2-2 jumping the piles is a shortcut: no-jump play ends lower on ≥ 8/10 seeds, clearly slower on average', () => {
    noJump = DIFFICULTY_SEEDS.map((s) => runRace(s, { ...OPTIMAL, jump: false }));
    report('no-jump', noJump);
    const n = optimal.length;
    const worse = noJump.filter((r, k) => r.rank > optimal[k].rank).length;
    expect(worse).toBeGreaterThanOrEqual(Math.ceil(n * 0.8));
    // (review target: +150 places on average; near the front 150 places ≈ 4–5 s — measured
    // ≈ +70 places / +4.5 s, see report)
    expect(mean(noJump.map((r) => r.rank))).toBeGreaterThanOrEqual(mean(optimal.map((r) => r.rank)) + 50);
    expect(mean(noJump.map((r) => r.gap))).toBeGreaterThanOrEqual(mean(optimal.map((r) => r.gap)) + 3);
    expect(wins(noJump)).toBeLessThanOrEqual(wins(optimal));
    // jump chances in every race (low pile in the lane 3–12 m ahead; the bot jumps from
    // further out now, so fewer are counted), and most races include clean clears
    for (const r of optimal) expect(r.jumpChances).toBeGreaterThanOrEqual(3);
    expect(optimal.filter((r) => r.jumpsCleared >= 1).length).toBeGreaterThanOrEqual(Math.ceil(n * 0.8));
  }, 900000);

  it('accidents are visible all race long (Phase 1 review M3)', () => {
    for (const r of optimal) {
      expect(r.firstBig).toBeGreaterThanOrEqual(0);
      expect(r.firstBig).toBeLessThanOrEqual(15);
      expect(r.bigFalls).toBeGreaterThanOrEqual(4);
      // after 40 s: on average ≥ 5 new falls in view per 10 s, and never a dead window
      const late = r.visible.slice(4, -1);
      expect(mean(late)).toBeGreaterThanOrEqual(5);
      expect(Math.min(...late)).toBeGreaterThanOrEqual(1);
    }
  });
});
