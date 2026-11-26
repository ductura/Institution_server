// Seeded pseudo-random numbers for the invented works generator (DAN-1566).
// Pure and platform independent: 32-bit integer arithmetic only, so the same
// seed gives the same numbers on every Node version. Not for security.

export type Random = {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], both included. */
  int(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** A fresh array in a seeded order (Fisher-Yates). */
  shuffle<T>(items: readonly T[]): T[];
};

/** xmur3: a 32-bit hash of the seed text, used as the generator state. */
function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32 over the hash of `seed`. */
export function createRandom(seed: string): Random {
  let state = hashSeed(seed);
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    chance: (probability) => next() < probability,
    pick: (items) => {
      if (items.length === 0) throw new Error("invented-works: pick from an empty list");
      return items[int(0, items.length - 1)]!;
    },
    shuffle: (items) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}

/** A UUID-shaped v4 id drawn from the generator (not a random UUID). */
export function randomUuid(random: Random): string {
  const hex = (length: number): string =>
    Array.from({ length }, () => random.int(0, 15).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[random.int(0, 3)]}${hex(3)}-${hex(12)}`;
}
