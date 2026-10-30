import type { RaceResult } from '../game/Race';

/**
 * localStorage persistence (settings, personal best, recent seeds). Every access is
 * guarded: private mode / blocked storage simply falls back to defaults.
 */
export interface Settings {
  sound: boolean;
  /** reduce camera shake / flashes (design §3) */
  reduceMotion: boolean;
}

export interface BestRecord {
  rank: number;
  time: number | null;
  seed: number;
  perfect: boolean;
  date: string;
}

const KEY_SETTINGS = 'h10k.settings.v1';
const KEY_BEST = 'h10k.best.v1';
const KEY_SEEDS = 'h10k.seeds.v1';

export const DEFAULT_SETTINGS: Settings = { sound: true, reduceMotion: false };

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: keep running */
  }
}

export function loadSettings(): Settings {
  const s = read<Partial<Settings>>(KEY_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(s ?? {}) };
}

export function saveSettings(s: Settings): void {
  write(KEY_SETTINGS, s);
}

export function loadBest(): BestRecord | null {
  return read<BestRecord>(KEY_BEST);
}

/** true if `r` beats `best` (lower rank, then faster time). */
export function isBetter(r: Pick<RaceResult, 'rank' | 'time'>, best: Pick<BestRecord, 'rank' | 'time'> | null): boolean {
  if (!best) return true;
  if (r.rank !== best.rank) return r.rank < best.rank;
  if (r.time === null) return false;
  if (best.time === null) return true;
  return r.time < best.time;
}

/** Saves the result if it is a new personal best. Returns true when it was. */
export function submitResult(r: RaceResult): boolean {
  const best = loadBest();
  const seeds = read<number[]>(KEY_SEEDS) ?? [];
  write(KEY_SEEDS, [r.seed, ...seeds.filter((s) => s !== r.seed)].slice(0, 10));
  // a timed-out run (idle / stuck) is not a record: it never becomes the personal best
  if (r.timedOut || !isBetter(r, best)) return false;
  write(KEY_BEST, { rank: r.rank, time: r.time, seed: r.seed, perfect: r.perfect, date: r.date } satisfies BestRecord);
  return true;
}

export function recentSeeds(): number[] {
  return read<number[]>(KEY_SEEDS) ?? [];
}
