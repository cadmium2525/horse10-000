import { describe, expect, it } from 'vitest';
import { Course } from '../src/data/Course';
import { HorseSimulation, type PlayerIntent } from '../src/game/HorseSimulation';
import { AutoBot } from '../src/game/PlayerController';
import { FixedStepper } from '../src/game/Loop';

describe('input log replay', () => {
  it('replaying the recorded intents through an irregular frame loop reproduces the race', () => {
    const seed = 4242;
    const live = new HorseSimulation(new Course(seed), seed);
    const bot = new AutoBot();
    const log: PlayerIntent[] = [];
    const stepper = new FixedStepper();
    // irregular frame times incl. hitches that hit the per-frame step cap
    let r = 1;
    const frame = () => ((r = (r * 48271) % 2147483647) / 2147483647) * 0.06 + (r % 37 === 0 ? 0.2 : 0);
    while (stepper.ticks < 450) {
      stepper.advance(frame(), () => {
        const intent = bot.decide(live);
        log.push(intent);
        live.step(intent);
      });
    }
    expect(stepper.dropped).toBeGreaterThan(0); // the cap was exercised
    expect(log.length).toBe(live.tick);

    const replay = new HorseSimulation(new Course(seed), seed);
    for (const intent of log) replay.step(intent);
    expect(replay.checksum()).toBe(live.checksum());
    expect(replay.fallsTotal).toBe(live.fallsTotal);
  }, 60000);
});

describe('FixedStepper', () => {
  it('runs whole ticks, caps steps per frame and reports alpha in [0,1)', () => {
    const s = new FixedStepper(1 / 30, 4);
    let n = 0;
    const a = s.advance(0.05, () => n++);
    expect(a.steps).toBe(1);
    expect(a.alpha).toBeGreaterThanOrEqual(0);
    expect(a.alpha).toBeLessThan(1);
    const b = s.advance(0.25, () => n++);
    expect(b.steps).toBe(4);
    expect(s.dropped).toBeGreaterThan(0);
    expect(n).toBe(5);
  });
});
