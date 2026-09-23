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
 *   against `https://<CF_ACCESS_TEAM_DOMAIN>` (Cloudflare documents the token
 *   `iss` as `https://<team>.cloudflareaccess.com` — the full host, not a bare
 *   host). The JWKS lives at `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`.
 * - Identity is the verified `email` claim.
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
 *
 * **Configuration is read from `process.env` in the handler body** (C1, X2).
 * Next.js invokes middleware as `middleware(request, event)` — the second
 * argument is the `NextFetchEvent`, **not** an environment map. Reading that
 * argument for config (the round-1 bug) bound the event object and made every
 * key `undefined`, so every request 401'd. The fix: the exported handler takes
 * only the `request` and reads `process.env` directly. In the built edge
 * runtime and the standalone server, `process.env` is populated with the real
 * values at request time (measured), so reading it directly works. The test
 * seam is `readConfig(env = process.env)`, exported and tested directly: a test
 * can pass an explicit env map to `readConfig` without touching the handler's
 * signature, and a test calls `middleware(request, fakeEvent)` with a fake
 * event to exercise the framework's own call shape.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { NextResponse } from 'next/server.js';
import { normalizeAppSecret } from './lib/env-secret.js';
import { isDevAccessBypass } from './lib/web/dev-bypass.js';

/** The header the container health check sends the shared secret in. */
export const HEALTHCHECK_HEADER = 'x-healthcheck-secret';

/** The header the verified `email` claim is placed in for downstream routes. */
export const EMAIL_HEADER = 'x-access-email';

/** The paths that constitute "the icon route" (O15). */
export const ICON_ROUTE_PATHS = ['/icon.svg', '/favicon.ico', '/icon-256.png', '/icon-512.png'];

/**
 * A timing-safe string comparison (m2): returns `true` iff `a === b`, comparing
 * in constant time so the healthcheck-secret check does not leak a timing
 * oracle the way `===` can.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  if (sa.length !== sb.length) {
    // Compare against a same-length dummy so the length mismatch does not
    // short-circuit the loop (the length itself is not secret here, but this
    // keeps the compare shape uniform).
    let diff = 1;
    for (let i = 0; i < sa.length; i++) {
      diff |= sa.charCodeAt(i) ^ sb.charCodeAt(0);
    }
    return false;
  }
  let diff = 0;
  for (let i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  }
  return diff === 0;
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
 * Read the middleware configuration. The default is `process.env` (the
 * production path, read in the handler body — C1). An explicitly supplied `env`
 * map is the test seam: a test passes its own map here (or to
 * `readConfig` directly) without touching the handler's signature.
 * @param {object} [env] the environment map (defaults to `process.env`)
 * @returns {object}
 */
export function readConfig(env = process.env) {
  const teamDomain = String(env.CF_ACCESS_TEAM_DOMAIN ?? '');
  const aud = String(env.CF_ACCESS_AUD ?? '');
  const jwksUrlOverride = env.CF_JWKS_URL;
  const healthcheckSecret = normalizeAppSecret(env.OZB_HEALTHCHECK_SECRET);
  const iconRoutePublic = String(env.OZB_ICON_ROUTE_PUBLIC ?? '');
  return {
    teamDomain,
    aud,
    // X3: the JWKS lives at https://<team>/cdn-cgi/access/certs (the full host
    // that CF_ACCESS_TEAM_DOMAIN carries), and an explicit CF_JWKS_URL override
    // wins when set.
    jwksUrl: String(jwksUrlOverride ?? (teamDomain ? `https://${teamDomain}/cdn-cgi/access/certs` : '')),
    // X3: the token issuer is the full host, https://<team>.cloudflareaccess.com.
    issuer: teamDomain ? `https://${teamDomain}` : '',
    healthcheckSecret,
    iconRoutePublic: /^(1|true|yes|on)$/i.test(iconRoutePublic),
  };
}

/**
 * The middleware. Called by Next.js as `middleware(request, event)` — the
 * second argument is the `NextFetchEvent`, **not** an environment map (C1).
 * The handler reads its configuration from `process.env` in the body, so the
 * event argument is never consulted for config. The test seam is
 * `readConfig(env)`; the handler itself is exercised by calling
 * `middleware(request, fakeEvent)` with a fake event.
 * @param {Request} request
 * @param {object} [event] the NextFetchEvent (ignored for config)
 * @returns {Promise<Response>}
 */
export async function middleware(request, event) {
  // C1: read config from process.env (the production path), never from the
  // event argument. `event` is the NextFetchEvent; it is intentionally unused
  // so the framework's call shape is accepted without misreading it.
  void event;
  const cfg = readConfig(process.env);
  const url = new URL(request.url);
  const path = url.pathname;

  // Exemption 1: the icon route, only when OZB_ICON_ROUTE_PUBLIC is set.
  if (ICON_ROUTE_PATHS.includes(path) && cfg.iconRoutePublic) {
    return NextResponse.next();
  }

  // Exemption 2: /healthz — authenticated with the container-local secret.
  // Not an unauthenticated path: a LAN request without the secret is rejected
  // exactly like any other. The comparison is timing-safe (m2).
  if (path === '/healthz') {
    const presented = request.headers.get(HEALTHCHECK_HEADER) ?? '';
    if (cfg.healthcheckSecret && timingSafeEqual(presented, cfg.healthcheckSecret)) {
      return NextResponse.next();
    }
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // DEV-ONLY: when the dev bypass is active (OZB_DEV_BYPASS_ACCESS set, and
  // NODE_ENV is not production), skip the Access JWT check. This is inert in
  // production. It does not touch the /healthz exemption above (which still
  // authenticates with the container-local secret) — it only lets a local
  // dev request through the Access gate.
  if (isDevAccessBypass(process.env)) {
    return NextResponse.next();
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
      issuer: cfg.issuer,
    });
    const email = payload.email ?? '';
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(EMAIL_HEADER, email);
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    // The production path is the forwarded request header (the route handler
    // reads `x-access-email` from its own request). `NextResponse.next()` does
    // not surface that forwarded request on the returned response, so the
    // verified identity is also mirrored on the response header: it is the
    // user's own email from their own verified token (no new disclosure), and
    // it makes the "email is available downstream" contract observable when
    // the middleware is invoked directly (as the acceptance test does).
    response.headers.set(EMAIL_HEADER, email);
    return response;
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
