/**
 * Classifieds session state (design 3.6).
 *
 * The authoritative session check is the `uid` embedded in the page's
 * `OzB_vars` object, not the status code: `uid == 0` means anonymous, any
 * non-zero value means authenticated. States are distinguished and handled
 * differently by the caller:
 *
 *   valid           — uid != 0 and /classified returned 200. Proceed.
 *   expired         — uid == 0, or the application permission-denial page.
 *                     Stop polling classifieds, latch off, raise a visible
 *                     alert. Clearing the latch is a deliberate UI act
 *                     (card 4), never automatic. Never retry in a loop.
 *   cloudflare_block— the Cloudflare block class. Stop all OzBargain
 *                     requests, long backoff, loud alert.
 *   unchanged       — a 304 (not_modified). The page did not change, so the
 *                     session is "as it was"; the caller resolves it from
 *                     the last known uid. Not an error, never latches.
 *
 * A 500 (transient), 429 (rate_limited) or 404 (not_found) is NOT a session
 * signal: the session is unknown for this response, so it is reported as
 * `unknown` and the caller must not latch or alert on it (design 3.5: the
 * classes are distinct and must not be conflated).
 *
 * There is no login flow (open item O21): v1 takes the session cookie from
 * settings. This module only classifies; it never logs in.
 */

/**
 * @param {{ class: string, uid: number, status?: number }} args
 * @returns {{ state: 'valid' | 'expired' | 'cloudflare_block' | 'unchanged' | 'unknown' }}
 */
export function classifySession(args) {
  const { class: responseClass, uid } = args;

  // A non-finite uid (NaN, from a corrupt `classifieds_last_uid` setting, or
  // Infinity) is not a known uid: `uid === 0` is false for NaN, so without
  // this guard a corrupt setting would read a dead session as `valid` on a
  // later 304. Treat it as uid 0 (unknown/expired) so it resolves to
  // `expired` on a 304 and `expired` on a 200 — never `valid`.
  const effectiveUid = Number.isFinite(uid) ? uid : 0;

  // A Cloudflare block outranks everything: it stops all requests, not just
  // classifieds. It is identified from the response class (3.5), never the
  // status code.
  if (responseClass === 'cloudflare_block') {
    return { state: 'cloudflare_block' };
  }

  // A 304 is "no change, not an error": the session is as it was. Resolve
  // it from the uid the caller supplies (the last known uid, read from the
  // last 200). A non-zero uid keeps it valid; a zero/unknown uid is expired
  // (or, if no uid is known at all, `unchanged` — the caller keeps its
  // previous state).
  if (responseClass === 'not_modified') {
    if (uid === undefined || uid === null) {
      return { state: 'unchanged' };
    }
    if (effectiveUid === 0) {
      return { state: 'expired' };
    }
    return { state: 'valid' };
  }

  // The application permission-denial page is an invalid session regardless of
  // uid (on /classified it means the session is not entitled).
  if (responseClass === 'permission_denied') {
    return { state: 'expired' };
  }

  // A non-200 class that is not a session signal (transient 5xx, 429, 404):
  // the session is unknown for this response. Never latch or alert on it.
  if (responseClass !== 'ok') {
    return { state: 'unknown' };
  }

  // The authoritative check on a 200: uid == 0 is anonymous (expired),
  // non-zero is authenticated (valid). This holds even on a 200 — a 200 with
  // uid 0 is expired, which is the trap the anon fixture exercises.
  if (effectiveUid === 0) {
    return { state: 'expired' };
  }

  return { state: 'valid' };
}
