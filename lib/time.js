/**
 * Time helpers for the acquisition layer.
 *
 * `melbourneToUtc` converts Australia/Melbourne wall time to UTC and is
 * daylight-saving aware: the offset is read from the IANA zone data via
 * `Intl.DateTimeFormat` (long offset name) at the candidate instant, then
 * corrected. A fixed +10:00 offset is not used — the corpus contains a
 * January 2023 listing at AEDT (+11:00) that a fixed offset gets wrong by
 * an hour.
 */

const MELBOURNE_OFFSET_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Australia/Melbourne',
  timeZoneName: 'longOffset',
});

/**
 * Read the UTC offset (in minutes) that applies at a given instant, as
 * determined by the Australia/Melbourne zone.
 * @param {number} ms epoch milliseconds
 * @returns {number} offset in minutes east of UTC
 */
function melbourneOffsetMinutes(ms) {
  const parts = MELBOURNE_OFFSET_FORMAT.formatToParts(new Date(ms));
  const part = parts.find((p) => p.type === 'timeZoneName');
  // longOffset renders as "GMT+10:30" or "GMT-5".
  const match = /^GMT([+-])(\d{2})(?::(\d{2}))?$/.exec(part?.value ?? '');
  if (!match) {
    throw new Error(`melbourneToUtc: unrecognised zone offset "${part?.value}"`);
  }
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number.parseInt(match[2], 10) * 60 + Number.parseInt(match[3] ?? '0', 10));
}

/**
 * Convert Australia/Melbourne wall time to a UTC instant.
 * @param {number} day 1-31
 * @param {number} month 1-12
 * @param {number} year e.g. 2026
 * @param {number} hour 0-23
 * @param {number} minute 0-59
 * @returns {string} the UTC instant, ISO-8601, `Z`-suffixed, second precision
 */
export function melbourneToUtc(day, month, year, hour, minute) {
  // The target UTC instant T satisfies T + offset(T) = wall, i.e.
  // T = wall - offset(T). `wall` is the wall time read as if it were UTC.
  // The offset is a step function (+10:00 AEST / +11:00 AEDT), so the
  // fixed point is reached in at most two iterations: the first step lands
  // on the true instant, and the second confirms it (offset is read at the
  // landed instant, which is the same Melbourne local time as `wall`).
  // This mirrors `datetime(..., tzinfo=ZoneInfo("Australia/Melbourne"))
  // .astimezone(utc)` in the reference derivation.
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = wallMs;
  for (let i = 0; i < 3; i += 1) {
    const offset = melbourneOffsetMinutes(candidate);
    const next = wallMs - offset * 60000;
    if (next === candidate) break;
    candidate = next;
  }
  // Strip the millisecond fraction without a regex (toISOString yields
  // "YYYY-MM-DDTHH:mm:ss.sssZ").
  return new Date(candidate).toISOString().slice(0, 19) + 'Z';
}

/**
 * Format a UTC instant (an ISO-8601 `Z` string) as a human-readable date and
 * time in Australia/Melbourne. The absolute instant is unchanged; only the
 * displayed wall time is shifted to the Melbourne zone (DST-aware via the IANA
 * zone data). This is the display-side counterpart to `melbourneToUtc`:
 * storage keeps UTC (spec §4.3) and Melbourne is a display concern only.
 *
 * Because `Intl.DateTimeFormat` with a fixed `timeZone` runs identically on the
 * server (Node, full ICU) and in the browser, the same helper drives both the
 * server render and the post-hydration client render — there is no raw-ISO
 * fallback and no flash.
 *
 * @param {string} value a UTC instant (ISO-8601 `Z`), or a sentinel such as
 *   `"never"`
 * @returns {string} the Melbourne-formatted date/time, or the input verbatim
 *   when it is empty or not a parseable date
 */
export function formatMelbourne(value) {
  if (!value) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  try {
    return new Intl.DateTimeFormat('en-AU', {
      dateStyle: 'medium',
      timeStyle: 'medium',
      timeZone: 'Australia/Melbourne',
    }).format(d);
  } catch {
    return value;
  }
}

const RELATIVE_UNITS_MS = {
  week: 7 * 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  min: 60 * 1000,
  minute: 60 * 1000,
  second: 1000,
};

/**
 * Resolve a relative age phrase (e.g. `1 hour 41 min ago`, `2 days 3 hours
 * ago`, `1 week 2 days ago`) against a `now` instant.
 * @param {string} phrase the age phrase, with or without the trailing `ago`
 * @param {Date | string} now the reference instant
 * @returns {string} the resulting UTC instant, ISO-8601, `Z`-suffixed
 */
export function resolveRelativeAge(phrase, now) {
  const nowMs = typeof now === 'string' ? Date.parse(now) : now.getTime();
  if (Number.isNaN(nowMs)) {
    throw new Error(`resolveRelativeAge: invalid "now" ${now}`);
  }
  const text = String(phrase).trim().replace(/\s+ago\s*$/i, '');
  const parts = text.match(/\d+\s+(weeks?|days?|hours?|min(?:ute)?s?|seconds?)/gi);
  if (!parts) {
    throw new Error(`resolveRelativeAge: no recognisable age parts in "${phrase}"`);
  }
  let totalMs = 0;
  for (const part of parts) {
    const [raw, unit] = part.trim().split(/\s+/);
    const key = unit.toLowerCase().replace(/s$/, '');
    const unitMs = RELATIVE_UNITS_MS[key];
    if (unitMs === undefined) {
      throw new Error(`resolveRelativeAge: unknown unit "${unit}"`);
    }
    totalMs += Number.parseInt(raw, 10) * unitMs;
  }
  return new Date(nowMs - totalMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const RFC822_MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Convert the feed's RFC 822 `pubDate` (e.g. `Sat, 19 Sep 2026 17:25:16
 * +1000`) to a UTC instant.
 * @param {string} value the RFC 822 date string
 * @returns {string} the UTC instant, ISO-8601, `Z`-suffixed, second precision
 */
export function rfc822ToUtc(value) {
  const match = String(value)
    .trim()
    .match(
      /^[A-Z][a-z]{2},\s+(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-])(\d{2})(\d{2})$/,
    );
  if (!match) {
    throw new Error(`rfc822ToUtc: unrecognised date "${value}"`);
  }
  const [, day, monthName, year, hour, minute, second, sign, offH, offM] = match;
  const month = RFC822_MONTHS[monthName.toLowerCase()];
  if (month === undefined) {
    throw new Error(`rfc822ToUtc: unknown month "${monthName}"`);
  }
  const offsetMinutes =
    (Number.parseInt(offH, 10) * 60 + Number.parseInt(offM, 10)) * (sign === '-' ? -1 : 1);
  const ms = Date.UTC(Number.parseInt(year, 10), month, Number.parseInt(day, 10),
    Number.parseInt(hour, 10), Number.parseInt(minute, 10), Number.parseInt(second, 10))
    - offsetMinutes * 60000;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
