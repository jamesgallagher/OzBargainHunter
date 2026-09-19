/**
 * Clock seam. No module in this repository calls Date.now() or new Date()
 * for behaviour — they receive a clock.
 *
 * The clock also exposes advance(ms): the wait seam. Pacing, backoff and
 * Retry-After waits are taken from the clock rather than by sleeping in
 * tests: systemClock advances by a real sleep (the production path);
 * fixedClock moves the frozen instant forward, so time is deterministic
 * under test.
 */

/** @returns {{ now(): Date, advance(ms: number): Promise<void> }} a clock that reads the system time */
export function systemClock() {
  return {
    now() {
      return new Date();
    },
    advance(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}

/**
 * @param {string} isoString a fixed instant, ISO-8601
 * @returns {{ now(): Date, advance(ms: number): Promise<void> }} a clock frozen at that instant
 */
export function fixedClock(isoString) {
  const frozen = new Date(isoString);
  if (Number.isNaN(frozen.getTime())) {
    throw new Error(`fixedClock: invalid ISO-8601 instant "${isoString}"`);
  }
  let t = frozen.getTime();
  return {
    now() {
      return new Date(t);
    },
    advance(ms) {
      t += ms;
      return Promise.resolve();
    },
  };
}
