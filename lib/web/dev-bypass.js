/**
 * DEV-ONLY access gate bypass.
 *
 * When `OZB_DEV_BYPASS_ACCESS` is set to a truthy value (1/true/yes/on) and
 * `NODE_ENV` is not `production`, the Cloudflare Access JWT check is skipped
 * and the request is treated as authenticated as `dev@local`. This lets a
 * local `next dev` + worker setup be exercised without a Cloudflare Access
 * token.
 *
 * It is inert in production: the container sets `NODE_ENV=production`, so the
 * flag never takes effect there. In the dev server `NODE_ENV=development`, so
 * the flag is active. The check is deliberately a plain environment read — no
 * Node `crypto`, no I/O — so it is safe on the edge runtime (the middleware)
 * and the Node runtime (the route handlers) alike.
 *
 * Remove the flag from `.env` (or set it to false) to restore the full Access
 * gate. The flag is a convenience, not a security control: it is only ever
 * honoured outside production.
 */

/** The set of values that enable the dev bypass. */
const TRUTHY = /^(1|true|yes|on)$/i;

/**
 * Whether the dev-only access bypass is active for this environment.
 * @param {object} [env] the environment map (defaults to `process.env`)
 * @returns {boolean}
 */
export function isDevAccessBypass(env = process.env) {
  const flag = String(env.OZB_DEV_BYPASS_ACCESS ?? '');
  if (!TRUTHY.test(flag)) return false;
  // Inert in production: the flag only applies outside the production runtime.
  if (String(env.NODE_ENV ?? '') === 'production') return false;
  return true;
}
