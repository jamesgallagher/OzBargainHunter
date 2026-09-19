/**
 * Clock seam. No module in this repository calls Date.now() or new Date()
 * for behaviour — they receive a clock.
 */

/** @returns {{ now(): Date }} a clock that reads the system time */
export function systemClock() {
  return {
    now() {
      return new Date();
    },
  };
}

/**
 * @param {string} isoString a fixed instant, ISO-8601
 * @returns {{ now(): Date }} a clock frozen at that instant
 */
export function fixedClock(isoString) {
  const frozen = new Date(isoString);
  if (Number.isNaN(frozen.getTime())) {
    throw new Error(`fixedClock: invalid ISO-8601 instant "${isoString}"`);
  }
  return {
    now() {
      return new Date(frozen.getTime());
    },
  };
}
