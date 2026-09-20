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
 * **Configuration is read statically** (X2). In the built edge runtime,
 * `process.env.X` (a static member read) is inlined by the build, but a dynamic
 * `env[name]` read of a default-parameter `env = process.env` is not — so the
 * production path reads each key as a direct `process.env.X` property. An
 * explicitly supplied `env` map (the test seam) is read dynamically, which is
 * fine because that path is only taken in tests, never in the built edge
 * runtime.
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
 * Read the middleware configuration. When `env` is supplied (the test seam) it
 * is read dynamically; otherwise each key is read as a **static** `process.env`
 * property so the edge build inlines the real values (X2).
 * @param {object} [env] the environment map (the test seam)
 * @returns {object}
 */
function readConfig(env) {
  const teamDomain = env ? String(env.CF_ACCESS_TEAM_DOMAIN ?? '') : String(process.env.CF_ACCESS_TEAM_DOMAIN ?? '');
  const aud = env ? String(env.CF_ACCESS_AUD ?? '') : String(process.env.CF_ACCESS_AUD ?? '');
  const jwksUrlOverride = env ? env.CF_JWKS_URL : process.env.CF_JWKS_URL;
  const healthcheckSecret = env ? String(env.OZB_HEALTHCHECK_SECRET ?? '') : String(process.env.OZB_HEALTHCHECK_SECRET ?? '');
  const iconRoutePublic = env ? String(env.OZB_ICON_ROUTE_PUBLIC ?? '') : String(process.env.OZB_ICON_ROUTE_PUBLIC ?? '');
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
 * The middleware. Called by Next.js with the incoming `Request`; also called
 * directly by the tests with a hand-built `Request` and (optionally) an explicit
 * env map (the test seam). When no env is supplied it reads `process.env`
 * statically (the production edge path).
 * @param {Request} request
 * @param {object} [env] the environment map (the test seam; omit to read process.env)
 * @returns {Promise<Response>}
 */
export async function middleware(request, env) {
  const cfg = readConfig(env);
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
