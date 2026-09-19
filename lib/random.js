/**
 * Random seam. No module in this repository calls Math.random() for
 * behaviour — they receive a random source, so backoff jitter is
 * deterministic under test.
 */

/** @returns {{ next(): number }} a random source backed by Math.random */
export function systemRandom() {
  return {
    next() {
      return Math.random();
    },
  };
}

/**
 * Deterministic PRNG (mulberry32). The same seed always produces the same
 * sequence of values in the half-open unit interval [0, 1).
 * @param {number} seed
 * @returns {{ next(): number }}
 */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}
