/**
 * CSRF protection via a signed double-submit token (design 8.6, D33).
 *
 * Access authenticates the *visitor*, not the *origin* of the request, and the
 * `SameSite` behaviour of the Access cookie is not relied upon. So every
 * state-changing request (POST, PUT, PATCH, DELETE) carries a token the server
 * re-checks. The token is `value.exp.signature`, where `value` is
 * `<random>:<bound-email>:<exp-ms>` and `signature` is an HMAC-SHA256 of
 * `value` under a server secret. A cross-site request that can read a victim's
 * token cannot forge a matching signature without the secret, so the check is
 * independent of the Access JWT (the two checks are separate).
 *
 * The token is **bound to the verified `email` claim** and carries a **TTL**
 * (10 minutes by default): a token minted for one identity cannot be replayed
 * by another, and it does not verify forever (m3).
 *
 * Web Crypto only — no dependency, no Node `crypto` (the middleware and the
 * route handlers run on the edge runtime, where Node's `crypto` module is not
 * available).
 */

const enc = new TextEncoder();

/** The default token time-to-live: 15 minutes. */
export const CSRF_TTL_MS = 15 * 60 * 1000;

/**
 * A SHA-256 HMAC of `data` under `secret`, hex-encoded.
 * @param {string} data
 * @param {string} secret
 * @returns {Promise<string>}
 */
export async function hmacHex(data, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: { name: 'SHA-256' } },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign({ name: 'HMAC', hash: { name: 'SHA-256' } }, key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a fresh CSRF token `value.exp.signature` under `secret`, bound to
 * `bind` (the verified `email` claim, or '' when unbound) and expiring
 * `ttlMs` (default 10 minutes) from now.
 * @param {string} secret the server secret (e.g. `OZB_CSRF_SECRET`)
 * @param {string} [bind] the identity the token is bound to (the verified email)
 * @param {number} [ttlMs] the time-to-live in milliseconds (default 10 minutes)
 * @returns {Promise<string>}
 */
export async function generateCsrfToken(secret, bind = '', ttlMs = CSRF_TTL_MS) {
  const raw = crypto.getRandomValues(new Uint8Array(24));
  const value = [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
  const exp = Date.now() + ttlMs;
  const data = `${value}:${bind}:${exp}`;
  const sig = await hmacHex(data, secret);
  return `${value}.${exp}.${sig}`;
}

/**
 * Verify a `value.exp.signature` token against `secret`, at instant `now`
 * (defaults to `Date.now()`, for testability), bound to `bind`.
 *
 * **An empty secret fails closed** (X10): it returns `false` rather than
 * throwing, so an unset `OZB_CSRF_SECRET` denies every state-changing request
 * instead of 500-ing. Constant-time compare of the recomputed signature.
 *
 * **An unbound token is a wildcard** (m3): a token minted with no identity
 * (`bind=''`) verifies for any `bind`, while a token minted for a specific
 * identity verifies only for that identity. The token verifies if its
 * signature matches either the HMAC computed with the given `bind` or the HMAC
 * computed with an empty bind.
 * @param {string} token `value.exp.signature`
 * @param {string} secret the server secret
 * @param {number|Date} [now] the current time in ms (defaults to `Date.now()`)
 * @param {string} [bind] the identity the token must be bound to (the verified email)
 * @returns {Promise<boolean>}
 */
export async function verifyCsrfToken(token, secret, now = Date.now(), bind = '') {
  // An empty secret fails closed (X10): never throw, never accept.
  if (!secret || typeof secret !== 'string') return false;
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [value, expStr, presented] = parts;
  if (!value || !expStr || !presented) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return false;
  if (now > exp) return false; // expired (m3)
  // The token verifies if it was signed with the given `bind` OR signed
  // unbound (bind=''): an unbound token is a wildcard (m3), a bound token
  // verifies only for its identity.
  const candidates = [`${value}:${bind}:${exp}`, `${value}::${exp}`];
  for (const data of candidates) {
    const expected = await hmacHex(data, secret);
    if (presented.length !== expected.length) continue;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    if (diff === 0) return true;
  }
  return false;
}
