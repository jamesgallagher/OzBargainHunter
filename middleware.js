/**
 * Cloudflare Access verification on every request (design 8.2, 8.3, D63).
 *
 * The application verifies the Access JWT on every request, without exception.
 * Middleware is the right home: one file, applied to every route by default, is
 * the only placement that makes "without exception" structurally true rather
 * than a rule each new route handler has to remember.
 *
 * Binding constraints:
 * - **jose**, not Node `crypto` (middleware runs on the edge runtime, where
 *   Node's `crypto` module is not available). `createRemoteJWKSet` verifies
 *   RS256 against Cloudflare's remote JWKS and caches the fetched keys — the
 *   JWKS is fetched once, not on every request.
 * - The **audience** is checked against `CF_ACCESS_AUD` and the **issuer**
 *   against `CF_ACCESS_TEAM_DOMAIN`. Identity is the verified `email` claim.
 * - The token is read from the `Cf-Access-Jwt-Assertion` header **or** the
 *   `CF_Authorization` cookie.
 * - The request is **never** inferred to have come through Access from the
 *   network path. The LAN path exists by design; this verification is what
 *   makes it harmless. It is load-bearing, not defence in depth.
 * - The matcher does **not** exclude `/_next/static` (acceptance 11.2.4: a
 *   static asset with no session is not a 200).
 * - Exactly two exemptions (8.3, D62): the **icon route**, exempt only when
 *   `OZB_ICON_ROUTE_PUBLIC` is set (O15), and **`/healthz`**, which
 *   authenticates with the container-local `OZB_HEALTHCHECK_SECRET` in a
 *   header. `/healthz` is therefore not an unauthenticated path.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { NextResponse } from 'next/server.js';

/** The header the container health check sends the shared secret in. */
export const HEALTHCHECK_HEADER = 'x-healthcheck-secret';

/** The header the verified `email` claim is placed in for downstream routes. */
export const EMAIL_HEADER = 'x-access-email';

/** The paths that constitute "the icon route" (O15). */
export const ICON_ROUTE_PATHS = ['/icon.svg', '/favicon.ico', '/icon-256.png', '/icon-512.png'];

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
 * Read the middleware configuration from the environment. Read at call time so
 * a test can set the vars (pointing `CF_JWKS_URL` at a loopback server) before
 * invoking `middleware`.
 * @param {object} [env] the environment map (defaults to `process.env`)
 */
function readConfig(env = process.env) {
  const teamDomain = String(env.CF_ACCESS_TEAM_DOMAIN ?? '');
  const jwksUrl = String(env.CF_JWKS_URL ?? (teamDomain ? `https://${teamDomain}/cdn-cgi/...` : ''));
  return {
    teamDomain,
    aud: String(env.CF_ACCESS_AUD ?? ''),
    jwksUrl,
    healthcheckSecret: String(env.OZB_HEALTHCHECK_SECRET ?? ''),
    iconRoutePublic: /^(1|true|yes|on)$/i.test(String(env.OZB_ICON_ROUTE_PUBLIC ?? '')),
  };
}

/**
 * The middleware. Called by Next.js with the incoming `Request`; also called
 * directly by the tests with a hand-built `Request`.
 * @param {Request} request
 * @param {object} [env] the environment map (defaults to `process.env`)
 * @returns {Promise<Response>}
 */
export async function middleware(request, env = process.env) {
  const cfg = readConfig(env);
  const url = new URL(request.url);
  const path = url.pathname;

  // Exemption 1: the icon route, only when OZB_ICON_ROUTE_PUBLIC is set.
  if (ICON_ROUTE_PATHS.includes(path) && cfg.iconRoutePublic) {
    return NextResponse.next();
  }

  // Exemption 2: /healthz — authenticated with the container-local secret.
  // Not an unauthenticated path: a LAN request without the secret is rejected
  // exactly like any other.
  if (path === '/healthz') {
    const presented = request.headers.get(HEALTHCHECK_HEADER) ?? '';
    if (cfg.healthcheckSecret && presented === cfg.healthcheckSecret) {
      return NextResponse.next();
    }
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Every other path requires a verified Access JWT.
  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') ??
    cookieValue(request, 'CF_Authorization');

  if (!token) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const verifier = await getVerifier(cfg.jwksUrl);
    const { payload } = await jwtVerify(token, verifier, {
      audience: cfg.aud,
      issuer: cfg.teamDomain,
    });
    const email = payload.email ?? '';
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(EMAIL_HEADER, email);
    return NextResponse.next({ request: { headers: requestHeaders } });
  } catch {
    // Wrong signature, wrong audience, wrong issuer, or expired — all reject.
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
}

/**
 * Read a cookie value from the `Cookie` header.
 * @param {Request} request
 * @param {string} name
 * @returns {string|null}
 */
function cookieValue(request, name) {
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
 * The Next.js middleware matcher. It must **not** exclude `/_next/static`
 * (acceptance 11.2.4). It matches every path.
 */
export const config = {
  matcher: ['/(.*)'],
};
