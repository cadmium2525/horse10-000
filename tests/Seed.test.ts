import { describe, expect, it } from 'vitest';
import { Rng, deriveSeed, hashString, parseSeed } from '../src/data/Seed';
import { Course } from '../src/data/Course';

describe('Rng', () => {
  it('is reproducible for the same seed', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it('differs for different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.next() === b.next()) same++;
    expect(same).toBeLessThan(3);
  });

  it('stays in [0,1) and is roughly uniform', () => {
    const r = new Rng(99);
    let sum = 0;
    for (let i = 0; i < 20000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      sum += v;
    }
    expect(sum / 20000).toBeCloseTo(0.5, 1);
  });

  it('int() is inclusive', () => {
    const r = new Rng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(r.int(1, 3));
    expect([...seen].sort()).toEqual([1, 2, 3]);
  });
});

describe('seed helpers', () => {
  it('hashString is stable', () => {
    expect(hashString('horse')).toBe(hashString('horse'));
    expect(hashString('horse')).not.toBe(hashString('horses'));
  });
  it('deriveSeed separates streams', () => {
    expect(deriveSeed(1, 'a')).not.toBe(deriveSeed(1, 'b'));
  });
  it('parseSeed accepts numbers and strings', () => {
    expect(parseSeed('12345')).toBe(12345);
    expect(parseSeed('abc')).toBe(hashString('abc'));
    expect(parseSeed('')).toBeNull();
    expect(parseSeed(null)).toBeNull();
  });
});

describe('Course (oval)', () => {
  it('is the same for the same seed', () => {
    const a = new Course(42);
    const b = new Course(42);
    const pa = [0, 0, 0];
    const pb = [0, 0, 0];
    a.toWorld(10, 800, pa);
    b.toWorld(10, 800, pb);
    expect(pa).toEqual(pb);
  });

  it('is a closed loop with bounded curvature, finishing on the home straight', () => {
    const c = new Course(1);
    const p0 = [0, 0, 0];
    const p1 = [0, 0, 0];
    c.toWorld(0, c.sMin, p0);
    c.toWorld(0, c.sMax, p1);
    expect(Math.hypot(p0[0] - p1[0], p0[1] - p1[1])).toBeLessThan(3);
    for (let s = c.sMin; s < c.sMax; s += 5) expect(c.curvatureAt(s)).toBeLessThanOrEqual(1 / 350 + 1e-9);
    // race is less than one lap, finish line on the home straight (curvature 0, heading π)
    expect(c.length - c.sMin).toBeLessThan(c.lap);
    expect(c.curvatureAt(c.length)).toBe(0);
    expect(c.headingAt(c.length)).toBeCloseTo(Math.PI, 6);
    // the whole grid fits on the back straight
    expect(c.sMin).toBeLessThanOrEqual(-290);
    // inside/outside distance factor stays sane
    const k = 1 / c.radius;
    expect(1 - k * (c.width / 2)).toBeGreaterThan(0.75);
  });

  it('places s=0 at the world origin', () => {
    const c = new Course(5);
    const out = [0, 0, 0];
    c.toWorld(0, 0, out);
    expect(Math.abs(out[0])).toBeLessThan(1e-6);
    expect(Math.abs(out[1])).toBeLessThan(1e-6);
  });

  it('turns are left-handed: the infield is on the −x side', () => {
    const c = new Course(5);
    const centre = [0, 0];
    c.infieldCenter(centre);
    const inner = [0, 0, 0];
    const outer = [0, 0, 0];
    c.toWorld(-50, 600, inner);
    c.toWorld(50, 600, outer);
    expect(Math.hypot(inner[0] - centre[0], inner[1] - centre[1])).toBeLessThan(Math.hypot(outer[0] - centre[0], outer[1] - centre[1]));
  });
});
