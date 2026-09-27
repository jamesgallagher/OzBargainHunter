/**
 * Session-cookie selection (prompt 4.7).
 *
 * Pure: takes the cookie list the browser reports for the classifieds URL and
 * reduces it to the header the app should present on later polls, plus the
 * session's expiry. No I/O, no clock of its own — `nowMs` is injected.
 *
 * The list is what `context.cookies(classifiedsUrl)` returns: because the URL
 * is passed, the browser has already excluded `ozbuserhash` (its path is
 * `/user`), so this only has to drop Cloudflare, analytics, and expired
 * cookies.
 */

/** Cloudflare-managed cookie names: never ours to present. */
const CF_NAMES = /^(__cf|cf_)/i;
/** Analytics / ad-tracking cookie names: never ours to present. */
const ANALYTICS_NAMES = /^(_ga|_gid|_gat|_gcl_|_fbp)/i;

/**
 * Reduce a browser cookie list to the session header.
 *
 * @param {Array<{ name: string, value: string, expires?: number }>} cookies
 *   the cookies `context.cookies(url)` reported. `expires` is in seconds;
 *   `-1` means a session cookie (no expiry).
 * @param {number} nowMs the current time in milliseconds (injected `clock`)
 * @returns {{
 *   header: string,
 *   expiresAt: string|null,
 *   hasSession: boolean,
 *   keptNames: string[],
 *   droppedNames: string[],
 * }}
 * `header` is the kept cookies as `name=value` joined with `'; '` in the given
 * order. `expiresAt` is the `PHPSESSID` expiry as an ISO string when it has
 * one, else the earliest expiry among the kept cookies, else `null`.
 * `keptNames` / `droppedNames` are names only — no values.
 */
export function selectSessionCookies(cookies, nowMs) {
  const kept = [];
  const droppedNames = [];
  for (const cookie of cookies) {
    const { name, value, expires } = cookie;
    // `expires` is in seconds; `-1` (or absent) means a session cookie.
    const expired = typeof expires === 'number' && expires !== -1 && expires * 1000 < nowMs;
    if (CF_NAMES.test(name) || ANALYTICS_NAMES.test(name) || expired) {
      droppedNames.push(name);
      continue;
    }
    kept.push({ name, value, expires });
  }

  const header = kept.map((c) => `${c.name}=${c.value}`).join('; ');

  // Expiry: the session cookie's own expiry, else the earliest among the kept,
  // else null (a pure session with no expiring cookie has no expiry).
  const phpSession = kept.find((c) => c.name === 'PHPSESSID');
  let expiresAt = null;
  if (phpSession && typeof phpSession.expires === 'number' && phpSession.expires !== -1) {
    expiresAt = new Date(phpSession.expires * 1000).toISOString();
  } else {
    const expiries = kept
      .filter((c) => typeof c.expires === 'number' && c.expires !== -1)
      .map((c) => c.expires);
    if (expiries.length > 0) {
      expiresAt = new Date(Math.min(...expiries) * 1000).toISOString();
    }
  }

  return {
    header,
    expiresAt,
    hasSession: kept.some((c) => c.name === 'PHPSESSID'),
    keptNames: kept.map((c) => c.name),
    droppedNames,
  };
}
