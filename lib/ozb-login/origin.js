/**
 * Login-origin resolution (prompt 4.9).
 *
 * Pure: given the classifieds URL the app is pointed at, decide whether it is
 * an origin a login is allowed to run against. `performLogin` does not call
 * this — chunk 6's route does — but it is exported now so it can be tested
 * directly.
 *
 * Allowed origins: exactly the live `https://www.ozbargain.com.au`, or a
 * `http:` origin on loopback (`127.0.0.1`, `localhost`, `::1`). In dev mode
 * (`isDevMockTransport`) only loopback origins are allowed and the live origin
 * is refused, so a dev run can never drive a real login against the live site.
 */
import { isDevMockTransport } from '../dev-mode.js';

/** The one live origin a login may run against. */
const LIVE_ORIGIN = 'https://www.ozbargain.com.au';
/** The loopback hostnames a `http:` origin may use. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Resolve the origin a login should run against.
 *
 * @param {{ classifiedsUrl: string, env?: object }} params
 * @returns {{ ok: true, baseUrl: string } | { ok: false, reason: string }}
 *   `reason` is `origin_not_allowed` for a disallowed origin, or
 *   `dev_mode_live_origin` when dev mode is active and the live origin was
 *   presented.
 */
export function resolveLoginOrigin({ classifiedsUrl, env = process.env }) {
  let origin;
  try {
    origin = new URL(classifiedsUrl).origin;
  } catch {
    return { ok: false, reason: 'origin_not_allowed' };
  }

  const dev = isDevMockTransport(env);
  const isLoopback = origin.startsWith('http:') && LOOPBACK_HOSTS.has(new URL(origin).hostname);
  const isLive = origin === LIVE_ORIGIN;

  if (dev) {
    if (isLoopback) return { ok: true, baseUrl: origin };
    if (isLive) return { ok: false, reason: 'dev_mode_live_origin' };
    return { ok: false, reason: 'origin_not_allowed' };
  }

  if (isLoopback || isLive) return { ok: true, baseUrl: origin };
  return { ok: false, reason: 'origin_not_allowed' };
}
