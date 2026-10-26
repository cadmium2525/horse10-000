import { describe, expect, it } from 'vitest';
import { LOD_LEVELS, QualityManager, snapRefresh } from '../src/render/Quality';
import { buildHorseFar, buildHorseMid, buildHorseNear, triangleCount } from '../src/render/HorseGeometry';

function run(q: QualityManager, seconds: number, intervalMs: number, cpuMs: number): number {
  let changes = 0;
  for (let t = 0; t < seconds * 1000; t += intervalMs) {
    q.sample({ intervalMs, cpuMs });
    if (q.takePending()) changes++;
  }
  return changes;
}

const opts = { maxPixelRatio: 2, minPixelRatio: 0.6, initialLevel: 2 };

describe('M3: quality decisions use CPU time and the real refresh rate', () => {
  it('snaps refresh estimates to common rates', () => {
    expect(snapRefresh(16.4)).toBeCloseTo(1000 / 60, 3);
    expect(snapRefresh(33.9)).toBeCloseTo(1000 / 30, 3);
    expect(snapRefresh(8.5)).toBeCloseTo(1000 / 120, 3);
    expect(snapRefresh(50)).toBeCloseTo(1000 / 30, 3);
  });

  it('a 30 Hz-locked display (low-power mode) with light CPU load is NOT degraded', () => {
    const q = new QualityManager(opts);
    run(q, 30, 1000 / 30, 5);
    expect(q.state.level).toBe(2);
    expect(q.state.pixelRatio).toBe(2);
  });

  it('GPU-bound (20 fps on a 60 Hz display, CPU fine): pixel ratio drops first', () => {
    const q = new QualityManager(opts);
    run(q, 2, 1000 / 60, 4); // learn the refresh rate
    run(q, 6, 50, 4);
    expect(q.state.pixelRatio).toBeLessThan(2);
    expect(q.state.level).toBe(2);
  });

  it('CPU-bound: LOD level drops directly (pixel ratio would not help)', () => {
    const q = new QualityManager(opts);
    run(q, 2, 1000 / 60, 4);
    run(q, 4, 1000 / 60, 15);
    expect(q.state.level).toBeLessThan(2);
    expect(q.state.pixelRatio).toBe(2);
  });

  it('keeps degrading down to the floor on a hopeless device, never below', () => {
    const q = new QualityManager(opts);
    run(q, 120, 120, 40);
    expect(q.state.level).toBe(0);
    expect(q.state.pixelRatio).toBeCloseTo(0.6, 5);
  });

  it('upgrades after sustained headroom and backs off after a failed upgrade', () => {
    const q = new QualityManager({ ...opts, initialLevel: 0 });
    run(q, 2, 1000 / 60, 2);
    expect(run(q, 8, 1000 / 60, 2)).toBeGreaterThan(0);
    expect(q.state.level).toBeGreaterThan(0);
  });

  it('fixed mode never changes anything', () => {
    const q = new QualityManager({ ...opts, fixed: true });
    expect(run(q, 20, 120, 40)).toBe(0);
  });

  it('floor level stays within ~200k triangles and ≤ 3,000 instances', () => {
    const l0 = LOD_LEVELS[0];
    const tris =
      l0.nearCap * triangleCount(buildHorseNear()) +
      l0.midCap * triangleCount(buildHorseMid()) +
      l0.farCap * triangleCount(buildHorseFar());
    expect(tris).toBeLessThanOrEqual(200_000);
    expect(l0.nearCap + l0.midCap + l0.farCap).toBeLessThanOrEqual(3000);
    expect(l0.farKeep).toBeLessThan(1);
  });
});

describe('M4: quality changes are deferred to the next frame', () => {
  it('sample() never applies synchronously; takePending() hands each change over once', () => {
    const q = new QualityManager(opts);
    let pending = null;
    for (let k = 0; k < 400 && !pending; k++) {
      q.sample({ intervalMs: 120, cpuMs: 40 });
      pending = q.takePending();
    }
    expect(pending).not.toBeNull();
    expect(q.takePending()).toBeNull();
    // the handed-over state is a snapshot, not the live object
    expect(pending).not.toBe(q.state);
  });
});

describe('startup benchmark → initial quality (design §5)', () => {
  it('maps the estimated full-field tick to a starting LOD level', async () => {
    const { chooseInitialLevel } = await import('../src/game/StartupBench');
    expect(chooseInitialLevel(2, false)).toBe(2);
    expect(chooseInitialLevel(9, false)).toBe(1);
    expect(chooseInitialLevel(20, false)).toBe(0);
    expect(chooseInitialLevel(3, true)).toBe(2);
    expect(chooseInitialLevel(8, true)).toBe(1);
    expect(chooseInitialLevel(15, true)).toBe(0);
    expect(chooseInitialLevel(NaN, true)).toBe(1);
  });
  it('the probe itself is cheap and finite', async () => {
    const { estimateFullTickMs } = await import('../src/game/StartupBench');
    const t0 = performance.now();
    const est = estimateFullTickMs();
    expect(Number.isFinite(est)).toBe(true);
    expect(est).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
