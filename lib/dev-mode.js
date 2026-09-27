/**
 * The dev-mode flag (shared, web-allowed).
 *
 * Moved out of `lib/http/mock-transport.js` so code that the web app may
 * import (the chunk 6 login route, `lib/ozb-login/origin.js`) can read it
 * without importing from `lib/http/`, which the web app is barred from.
 * `mock-transport.js` re-exports it, so existing imports keep working.
 */

/** The set of values that enable the dev mock transport. */
const TRUTHY = /^(1|true|yes|on)$/i;

/**
 * Whether the dev-only mock transport is active for this environment.
 * @param {object} [env] the environment map (defaults to `process.env`)
 * @returns {boolean}
 */
export function isDevMockTransport(env = process.env) {
  const flag = String(env.OZB_DEV_MOCK_TRANSPORT ?? '');
  if (!TRUTHY.test(flag)) return false;
  // Inert in production: the flag only applies outside the production runtime.
  if (String(env.NODE_ENV ?? '') === 'production') return false;
  return true;
}
