/**
 * CSRF protection via a signed double-submit token (design 8.6, D33).
 *
 * Access authenticates the *visitor*, not the *origin* of the request, and the
 * `SameSite` behaviour of the Access cookie is not relied upon. So every
 * state-changing request (POST, PUT, PATCH, DELETE) carries a token the server
 * re-checks. The token is `value.signature`, where `signature` is an
 * HMAC-SHA256 of `value` under a server secret. A cross-site request that can
 * read a victim's token cannot forge a matching signature without the secret,
 * so the check is independent of the Access JWT (the two checks are separate).
 *
 * Web Crypto only — no dependency, no Node `crypto` (the middleware and the
 * route handlers run on the edge runtime, where Node's `crypto` module is not
 * available).
 */

const enc = new TextEncoder();

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
 * Generate a fresh CSRF token `value.signature` under `secret`.
 * @param {string} secret the server secret (e.g. `OZB_CSRF_SECRET`)
 * @returns {Promise<string>}
 */
export async function generateCsrfToken(secret) {
  const raw = crypto.getRandomValues(new Uint8Array(24));
  const value = [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
  const sig = await hmacHex(value, secret);
  return `${value}.${sig}`;
}

/**
 * Verify a `value.signature` token against `secret`. Constant-time compare of
 * the recomputed signature.
 * @param {string} token `value.signature`
 * @param {string} secret the server secret
 * @returns {Promise<boolean>}
 */
export async function verifyCsrfToken(token, secret) {
  if (!token || typeof token !== 'string') return false;
  const idx = token.lastIndexOf('.');
  if (idx <= 0 || idx === token.length - 1) return false;
  const value = token.slice(0, idx);
  const presented = token.slice(idx + 1);
  const expected = await hmacHex(value, secret);
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
