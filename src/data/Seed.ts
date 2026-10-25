/**
 * Deterministic seeded randomness.
 *
 * Everything that affects the race outcome must draw from an `Rng` created
 * from the race seed, never from Math.random(). Rendering-only decoration
 * (cloud placement, etc.) also uses seeded streams so screenshots reproduce.
 */

/** 32-bit string hash (FNV-1a + murmur3 finalizer). Stable across platforms. */
export function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return fmix32(h);
}

/** murmur3 32-bit finalizer: good avalanche for deriving sub-seeds. */
export function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Derive an independent stream seed from a base seed and a label. */
export function deriveSeed(seed: number, label: string): number {
  return fmix32((seed ^ hashString(label)) >>> 0);
}

/** mulberry32 PRNG. Fast, 32-bit state, fully deterministic. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** -1 or +1 */
  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Approximate standard normal (Irwin–Hall, 4 samples). Deterministic, no log/sqrt. */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508;
  }

  getState(): number {
    return this.state;
  }

  setState(s: number): void {
    this.state = s >>> 0;
  }
}

/**
 * Parse a user-facing seed (URL ?seed=...). Numeric strings are used as-is,
 * any other string is hashed. Returns a uint32.
 */
export function parseSeed(input: string | null | undefined): number | null {
  if (input == null || input === '') return null;
  if (/^\d{1,10}$/.test(input)) {
    const n = Number(input);
    if (n <= 0xffffffff) return n >>> 0;
  }
  return hashString(input);
}

/** Non-deterministic fresh seed for a new race (only place randomness enters). */
export function randomSeed(): number {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] % 100000000;
  }
  return Math.floor(Math.random() * 100000000);
}
