/**
 * The sign-in throttle and the B6 lock, as pure functions over the recorded
 * login attempts (prompt 4.3).
 *
 * The attempts live in the `ozb_login_attempts` setting as a JSON array of
 * `{ at: ISO, outcome }` entries, oldest first. Every login attempt — including
 * the `pending` record written before the browser runs — is recorded there.
 *
 * Two independent rules, checked in this order (B6 outranks the throttle):
 *
 * **B6 (lock)** — two `validation_error` outcomes, or five `bad_credentials`
 * outcomes, inside any 24-hour span lock sign-in for 24 hours. The lock lasts
 * until the threshold-reaching attempt + 24 hours (the latest of several
 * qualifying spans wins). Only `validation_error` and `bad_credentials` count
 * toward B6; `pending` (and every other outcome) does not.
 *
 * **Throttle** — a new attempt is refused while (a) the most recent attempt
 * (of any outcome, `pending` included) is less than 30 seconds old, or (b)
 * three or more attempts (of any outcome) fall inside the last 15 minutes
 * (the attempt exactly 15 minutes old is not in the window).
 *
 * All functions are pure: they take the attempt list and a `now` (a `Date` or
 * a millisecond number) and return plain objects. Nothing here reads the store
 * or the clock, so the tests can pin every boundary without sleeping.
 */

/** Minimum seconds between two login attempts (the short-term throttle). */
export const LOGIN_MIN_GAP_SECONDS = 30;
/** Maximum login attempts inside the trailing 15-minute window. */
export const LOGIN_MAX_ATTEMPTS_15_MIN = 3;
/** `validation_error` outcomes inside 24 hours that trigger the B6 lock. */
export const B6_VALIDATION_LIMIT = 2;
/** `bad_credentials` outcomes inside 24 hours that trigger the B6 lock. */
export const B6_BAD_CREDENTIALS_LIMIT = 5;
/** Hours a B6 lock lasts after the threshold-reaching attempt. */
export const B6_LOCK_HOURS = 24;

const MIN_GAP_MS = LOGIN_MIN_GAP_SECONDS * 1000;
const WINDOW_15_MIN_MS = 15 * 60 * 1000;
const WINDOW_24_H_MS = B6_LOCK_HOURS * 60 * 60 * 1000;

/**
 * Normalize a `now` that may be a `Date` or a millisecond number.
 * @param {Date|number} now
 * @returns {number} milliseconds since the epoch
 */
function toMs(now) {
  return now instanceof Date ? now.getTime() : Number(now);
}

/**
 * Read the attempts setting (a JSON array string) into a list of
 * `{ at: string, outcome: string }` entries. A missing value, an unparsable
 * string, a non-array value, or malformed entries all degrade to `[]` (or are
 * dropped), never a throw.
 * @param {string|null|undefined} raw the setting value
 * @returns {Array<{ at: string, outcome: string }>}
 */
export function readAttempts(raw) {
  if (raw === null || raw === undefined) return [];
  let parsed;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  } else if (Array.isArray(raw)) {
    parsed = raw;
  } else {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (e) =>
        e !== null &&
        typeof e === 'object' &&
        typeof e.at === 'string' &&
        !Number.isNaN(Date.parse(e.at)) &&
        typeof e.outcome === 'string',
    )
    .map((e) => ({ at: e.at, outcome: e.outcome }));
}

/**
 * Write the attempts list back to the setting value: prune entries strictly
 * older than 24 hours (an entry exactly 24 hours old is kept), sort oldest
 * first, and return the JSON string to store.
 * @param {Array<{ at: string, outcome: string }>} list
 * @param {Date|number} now
 * @returns {string} the pruned, sorted list as JSON
 */
export function writeAttempts(list, now) {
  const nowMs = toMs(now);
  const kept = list.filter((e) => Date.parse(e.at) >= nowMs - WINDOW_24_H_MS);
  kept.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return JSON.stringify(kept);
}

/**
 * The B6 lock candidate: the latest `lockedUntil` over every qualifying 24h
 * span, or `null` when no span reaches its limit. For one outcome type, a
 * span starting at the i-th attempt (times sorted ascending) contains every
 * attempt in `[t_i, t_i + 24h)` (the end is exclusive, so two attempts exactly
 * 24 hours apart are not in the same span); when the count reaches the limit,
 * the span's `lockedUntil` is the threshold-reaching attempt + 24h.
 * @param {number[]} times ascending attempt times in ms
 * @param {number} limit the B6 limit for the outcome type
 * @returns {number|null} the latest `lockedUntil` in ms, or `null`
 */
function b6LockedUntil(times, limit) {
  let latest = null;
  for (let i = 0; i < times.length; i++) {
    const end = times[i] + WINDOW_24_H_MS;
    let count = 0;
    for (let j = i; j < times.length; j++) {
      if (times[j] >= times[i] && times[j] < end) count++;
      else break;
    }
    if (count >= limit) {
      const until = times[i + limit - 1] + WINDOW_24_H_MS;
      if (latest === null || until > latest) latest = until;
    }
  }
  return latest;
}

/**
 * The B6 `lockedUntil` (ms) for the recorded attempts, or `null` when no B6
 * span qualifies. Only `validation_error` and `bad_credentials` count.
 * @param {Array<{ at: string, outcome: string }>} attempts
 * @returns {number|null}
 */
function b6Candidate(attempts) {
  const validation = attempts
    .filter((e) => e.outcome === 'validation_error')
    .map((e) => Date.parse(e.at))
    .sort((a, b) => a - b);
  const badCredentials = attempts
    .filter((e) => e.outcome === 'bad_credentials')
    .map((e) => Date.parse(e.at))
    .sort((a, b) => a - b);
  const candidates = [
    b6LockedUntil(validation, B6_VALIDATION_LIMIT),
    b6LockedUntil(badCredentials, B6_BAD_CREDENTIALS_LIMIT),
  ].filter((u) => u !== null);
  return candidates.length ? Math.max(...candidates) : null;
}

/**
 * Check whether a new login attempt is allowed at `now`.
 *
 * B6 is checked first (it outranks the throttle): while the B6 lock is in
 * effect the result is `{ ok: false, reason: 'locked', retryAt }` with
 * `retryAt` the lock's end. Otherwise the short-term throttle: the most
 * recent attempt (any outcome, `pending` included) less than 30 seconds old
 * refuses with `retryAt` = last attempt + 30s; three or more attempts inside
 * the trailing 15-minute window (the attempt exactly 15 minutes old is not in
 * the window) refuse with `retryAt` = oldest in window + 15min.
 *
 * @param {Array<{ at: string, outcome: string }>} attempts the recorded attempts
 * @param {Date|number} now
 * @returns {{ ok: true } | { ok: false, reason: 'throttled'|'locked', retryAt: string }}
 */
export function checkLoginAllowed(attempts, now) {
  const nowMs = toMs(now);

  const lockedUntil = b6Candidate(attempts);
  if (lockedUntil !== null && nowMs < lockedUntil) {
    return { ok: false, reason: 'locked', retryAt: new Date(lockedUntil).toISOString() };
  }

  const times = attempts.map((e) => Date.parse(e.at)).sort((a, b) => a - b);
  if (times.length) {
    const last = times[times.length - 1];
    if (nowMs - last < MIN_GAP_MS) {
      return { ok: false, reason: 'throttled', retryAt: new Date(last + MIN_GAP_MS).toISOString() };
    }
  }

  const inWindow = times.filter((t) => t > nowMs - WINDOW_15_MIN_MS && t <= nowMs);
  if (inWindow.length >= LOGIN_MAX_ATTEMPTS_15_MIN) {
    const oldest = inWindow[0];
    return { ok: false, reason: 'throttled', retryAt: new Date(oldest + WINDOW_15_MIN_MS).toISOString() };
  }

  return { ok: true };
}

/**
 * The lock/throttle view for the UI (prompt 4.5): whether sign-in is locked
 * by B6 right now, and the end of the current B6 lock and throttle window
 * (each computed independently; `null` when not in effect).
 *
 * @param {Array<{ at: string, outcome: string }>} attempts
 * @param {Date|number} now
 * @returns {{ locked: boolean, lockedUntil: string|null, throttledUntil: string|null }}
 */
export function loginLockView(attempts, now) {
  const nowMs = toMs(now);

  const lockedUntil = b6Candidate(attempts);
  const locked = lockedUntil !== null && nowMs < lockedUntil;
  const lockedUntilIso = locked ? new Date(lockedUntil).toISOString() : null;

  let throttledUntil = null;
  const times = attempts.map((e) => Date.parse(e.at)).sort((a, b) => a - b);
  if (times.length) {
    const last = times[times.length - 1];
    if (nowMs - last < MIN_GAP_MS) {
      throttledUntil = new Date(last + MIN_GAP_MS).toISOString();
    } else {
      const inWindow = times.filter((t) => t > nowMs - WINDOW_15_MIN_MS && t <= nowMs);
      if (inWindow.length >= LOGIN_MAX_ATTEMPTS_15_MIN) {
        throttledUntil = new Date(inWindow[0] + WINDOW_15_MIN_MS).toISOString();
      }
    }
  }

  return { locked: locked, lockedUntil: lockedUntilIso, throttledUntil };
}
