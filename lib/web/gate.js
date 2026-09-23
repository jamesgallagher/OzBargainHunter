/**
 * The per-request access and CSRF gate, shared by the middleware (8.2) and the
 * mutation route handlers (8.6, D33).
 *
 * The two checks are **independent** (acceptance 11.3.6):
 * - **Access** — verify the Access JWT (signature, audience, issuer, expiry).
 *   Identity is the verified `email` claim.
 * - **CSRF** — verify the signed double-submit token on every state-changing
 *   request.
 *
 * A request that carries a valid JWT but no CSRF token is rejected by the CSRF
 * check (not the access check), and an unauthenticated request is rejected by
 * the access check. The middleware applies the access check to *every* request
 * (8.2); the route handlers re-apply it so a route driven directly (as in the
 * acceptance test) still rejects an unauthenticated mutation, and they add the
 * CSRF check on top.
 *
 * Web Crypto / jose only — no Node `crypto` (the edge runtime does not expose
 * it).
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { verifyCsrfToken } from '../csrf.js';
import { normalizeAppSecret } from '../env-secret.js';
import { isDevAccessBypass } from './dev-bypass.js';

/** The header a state-changing request carries the CSRF token in. */
export const CSRF_HEADER = 'x-csrf-token';

/**
 * A request body that is not valid JSON (for an `application/json` body).
 * Thrown by `parseBody` (M-m1) so a route handler can convert it to a clean
 * 400 instead of a `SyntaxError` escaping to a framework 500.
 */
export class MalformedBodyError extends Error {}

/**
 * Parse a request body that may be urlencoded (an HTML form) or JSON. Returns
 * a plain object: urlencoded is decoded via `URLSearchParams`, JSON via
 * `JSON.parse`, and an empty body is `{}`. This is what lets a plain HTML form
 * (which posts urlencoded and cannot set a custom header) drive a mutation
 * handler (X5). A JSON body that is not valid JSON throws
 * `MalformedBodyError` (M-m1) rather than a raw `SyntaxError`, so a route
 * handler can return a clean 400.
 * @param {Request} request
 * @returns {Promise<object>}
 */
export async function parseBody(request) {
  const text = await request.text().catch(() => '');
  if (!text) return {};
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (type.includes('application/json')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // M-m1: a malformed JSON body is a client error (400), not a server
      // error. Throw a typed error the route handler converts to a 400.
      throw new MalformedBodyError('request body is not valid JSON');
    }
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  }
  const params = new URLSearchParams(text);
  const out = {};
  for (const [key, value] of params) out[key] = value;
  return out;
}

/**
 * Parse a request body, converting a `MalformedBodyError` (M-m1) into a clean
 * 400 `Response` rather than letting it escape the handler as a framework 500.
 * Returns `{ body }` on success or `{ error }` (the 400 `Response`) on a
 * malformed JSON body. A route handler does:
 *   const { body, error } = await parseBodyOr400(request);
 *   if (error) return error;
 * @param {Request} request
 * @returns {Promise<{ body?: object, error?: Response }>}
 */
export async function parseBodyOr400(request) {
  try {
    return { body: await parseBody(request) };
  } catch (e) {
    if (e instanceof MalformedBodyError) {
      return { error: new Response('malformed request body', { status: 400 }) };
    }
    throw e;
  }
}

/**
 * The JWKS verifier, cached per JWKS URL so the keys are fetched once (and
 * cached by `createRemoteJWKSet`), not on every request.
 * @param {string} jwksUrl
 * @returns {Promise<ReturnType<typeof createRemoteJWKSet>>}
 */
const verifierCache = new Map();
async function getVerifier(jwksUrl) {
  if (!verifierCache.has(jwksUrl)) {
    verifierCache.set(jwksUrl, createRemoteJWKSet(new URL(jwksUrl)));
  }
  return verifierCache.get(jwksUrl);
}

/**
 * Read the gate configuration from the environment at call time, so a test can
 * point `CF_JWKS_URL` at a loopback server and set the secrets before invoking
 * a route handler.
 * @param {object} [env] the environment map (defaults to `process.env`)
 * @returns {object}
 */
export function readConfig(env = process.env) {
  const teamDomain = String(env.CF_ACCESS_TEAM_DOMAIN ?? '');
  const jwksUrl = String(
    env.CF_JWKS_URL ?? (teamDomain ? `https://${teamDomain}/cdn-cgi/access/certs` : ''),
  );
  return {
    teamDomain,
    aud: String(env.CF_ACCESS_AUD ?? ''),
    jwksUrl,
    csrfSecret: normalizeAppSecret(env.OZB_CSRF_SECRET),
    healthcheckSecret: normalizeAppSecret(env.OZB_HEALTHCHECK_SECRET),
    iconRoutePublic: /^(1|true|yes|on)$/i.test(String(env.OZB_ICON_ROUTE_PUBLIC ?? '')),
  };
}

/**
 * Read a cookie value from the `Cookie` header.
 * @param {Request} request
 * @param {string} name
 * @returns {string|null}
 */
export function cookieValue(request, name) {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Verify the Access JWT on a request. The token is read from the
 * `Cf-Access-Jwt-Assertion` header or the `CF_Authorization` cookie. The
 * request is never inferred to have come through Access from the network path.
 * @param {Request} request
 * @param {object} [env] the environment map
 * @returns {Promise<{ ok: boolean, email: string }>}
 */
export async function verifyAccess(request, env = process.env) {
  // DEV-ONLY: when the dev bypass is active (OZB_DEV_BYPASS_ACCESS set, and
  // NODE_ENV is not production), treat the request as authenticated as
  // dev@local and skip the Access JWT check. Inert in production. The CSRF
  // check in requireAuthenticated still applies on top.
  if (isDevAccessBypass(env)) {
    return { ok: true, email: 'dev@local' };
  }
  const cfg = readConfig(env);
  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') ?? cookieValue(request, 'CF_Authorization');
  if (!token || !cfg.jwksUrl) return { ok: false, email: '' };
  try {
    const verifier = await getVerifier(cfg.jwksUrl);
    const { payload } = await jwtVerify(token, verifier, {
      audience: cfg.aud,
      // X3: the Access token `iss` is the full host, https://<team>.cloudflareaccess.com —
      // not a bare host.
      issuer: cfg.teamDomain ? `https://${cfg.teamDomain}` : '',
    });
    return { ok: true, email: payload.email ?? '' };
  } catch {
    return { ok: false, email: '' };
  }
}

/**
 * The body field names a form may carry the CSRF token in, in priority order.
 * The token is read from the `x-csrf-token` header first, then from the parsed
 * body (X5): a plain HTML form posts urlencoded and cannot set a custom header,
 * so the token travels in a hidden input.
 */
const CSRF_BODY_FIELDS = ['csrf_token', '_csrf', 'csrf'];

/**
 * Extract the CSRF token from a request and its (already-parsed) body: the
 * `x-csrf-token` header wins, then the named body fields.
 * @param {Request} request
 * @param {object} [body] the parsed request body
 * @returns {string}
 */
function csrfTokenFrom(request, body) {
  const header = request.headers.get(CSRF_HEADER);
  if (header) return header;
  if (body && typeof body === 'object') {
    for (const field of CSRF_BODY_FIELDS) {
      const v = body[field];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return '';
}

/**
 * Verify the CSRF token on a state-changing request, bound to `bind` (the
 * verified `email` claim, m3) and checked at instant `now` (defaults to
 * `Date.now()`, for testability). The token is read from the
 * `x-csrf-token` header or the parsed body (X5).
 * @param {Request} request
 * @param {object} [env] the environment map
 * @param {object} [body] the parsed request body (the token may live here)
 * @param {number|Date} [now] the current time in ms (defaults to `Date.now()`)
 * @param {string} [bind] the identity the token must be bound to
 * @returns {Promise<boolean>}
 */
export async function requireCsrf(request, env = process.env, body, now = Date.now(), bind = '') {
  const cfg = readConfig(env);
  // X5: when the caller does not supply a parsed body, parse it here so the
  // CSRF token can be read from a plain HTML form (urlencoded, no custom
  // header). `verifyAccess` only reads headers, so the body stream is still
  // intact at this point.
  const parsedBody = body !== undefined ? body : await parseBody(request);
  const token = csrfTokenFrom(request, parsedBody);
  return verifyCsrfToken(token, cfg.csrfSecret, now, bind);
}

/**
 * Gate a state-changing request on both independent checks (acceptance 11.3.6).
 * The access check runs first; a request that fails it is rejected with 401
 * without the CSRF check running. A request that passes access but lacks a
 * valid CSRF token is rejected with 403. The two are independent: a valid JWT
 * with no CSRF token still fails, and an unauthenticated request fails before
 * the CSRF check is even reached. The CSRF token is read from the header or
 * the parsed body (X5) and bound to the verified email (m3).
 * @param {Request} request
 * @param {object} [env] the environment map
 * @param {object} [body] the parsed request body (the token may live here)
 * @returns {Promise<{ ok: boolean, email: string, response: Response|null }>}
 */
export async function requireAuthenticated(request, env = process.env, body) {
  // The route handlers re-verify the Access JWT themselves rather than trusting
  // the `x-access-email` header the middleware sets. The header is a
  // convenience for downstream code, not a trust signal: a request that
  // reaches a route directly (or a LAN request that sets the header itself)
  // must still present a valid JWT. The access check is load-bearing here,
  // exactly as it is in the middleware (8.2).
  const access = await verifyAccess(request, env);
  if (!access.ok) {
    return { ok: false, email: '', response: new Response('unauthorized', { status: 401 }) };
  }
  // X5: when the caller does not supply a parsed body, parse it here so the
  // CSRF token can be read from a plain HTML form (urlencoded, no custom
  // header). `verifyAccess` only reads headers, so the body stream is still
  // intact at this point.
  const parsedBody = body !== undefined ? body : await parseBody(request);
  // The token is verified with an unbound identity (bind=''): the production
  // wiring relies on the token's TTL (m3) rather than email binding, so a form
  // can mint a token without reading the request headers. The binding capability
  // is still available on `requireCsrf`/`verifyCsrfToken` and is exercised by a
  // test.
  const csrfOk = await requireCsrf(request, env, parsedBody);
  if (!csrfOk) {
    return { ok: false, email: access.email, response: new Response('csrf', { status: 403 }) };
  }
  return { ok: true, email: access.email, response: null };
}
