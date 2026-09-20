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

/** The header a state-changing request carries the CSRF token in. */
export const CSRF_HEADER = 'x-csrf-token';

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
    csrfSecret: String(env.OZB_CSRF_SECRET ?? ''),
    healthcheckSecret: String(env.OZB_HEALTHCHECK_SECRET ?? ''),
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
  const cfg = readConfig(env);
  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') ?? cookieValue(request, 'CF_Authorization');
  if (!token || !cfg.jwksUrl) return { ok: false, email: '' };
  try {
    const verifier = await getVerifier(cfg.jwksUrl);
    const { payload } = await jwtVerify(token, verifier, {
      audience: cfg.aud,
      issuer: cfg.teamDomain,
    });
    return { ok: true, email: payload.email ?? '' };
  } catch {
    return { ok: false, email: '' };
  }
}

/**
 * Verify the CSRF token on a state-changing request.
 * @param {Request} request
 * @param {object} [env] the environment map
 * @returns {Promise<boolean>}
 */
export async function requireCsrf(request, env = process.env) {
  const cfg = readConfig(env);
  const token = request.headers.get(CSRF_HEADER) ?? '';
  return verifyCsrfToken(token, cfg.csrfSecret);
}

/**
 * Gate a state-changing request on both independent checks (acceptance 11.3.6).
 * The access check runs first; a request that fails it is rejected with 401
 * without the CSRF check running. A request that passes access but lacks a
 * valid CSRF token is rejected with 403. The two are independent: a valid JWT
 * with no CSRF token still fails, and an unauthenticated request fails before
 * the CSRF check is even reached.
 * @param {Request} request
 * @param {object} [env] the environment map
 * @returns {Promise<{ ok: boolean, email: string, response: Response|null }>}
 */
export async function requireAuthenticated(request, env = process.env) {
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
  const csrfOk = await requireCsrf(request, env);
  if (!csrfOk) {
    return { ok: false, email: access.email, response: new Response('csrf', { status: 403 }) };
  }
  return { ok: true, email: access.email, response: null };
}
