import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { middleware, config } from '../../../middleware.js';
import { startJwksServer } from '../../support/jwks.js';

const AUD = 'test-audience';
const TEAM_DOMAIN = 'team.cloudflareaccess.org';
// X3: Cloudflare documents the token `iss` as the full host,
// https://<team>.cloudflareaccess.com — not a bare host.
const ISS = `https://${TEAM_DOMAIN}`;

/**
 * Build the env the middleware reads: point the JWKS at the loopback server.
 * @param {string} jwksUrl
 * @param {object} [extra]
 * @returns {object}
 */
function envFor(jwksUrl, extra = {}) {
  return {
    CF_JWKS_URL: jwksUrl,
    CF_ACCESS_AUD: AUD,
    CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ...extra,
  };
}

describe('middleware: Cloudflare Access verification', () => {
  let jwks;
  before(async () => {
    jwks = await startJwksServer();
  });
  after(async () => {
    await jwks.close();
  });

  test('a request with no token is rejected (not 200)', async () => {
    const res = await middleware(
      new Request('https://app.example.com/rules'),
      envFor(jwks.url),
    );
    assert.notEqual(res.status, 200, 'no token must not be a 200');
    assert.equal(res.status, 401);
  });

  test('a valid token passes and the verified email is available downstream', async () => {
    const token = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: ISS });
    const res = await middleware(
      new Request('https://app.example.com/rules', {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      }),
      envFor(jwks.url),
    );
    assert.equal(res.status, 200, 'a valid token passes');
    // m4: the verified email claim is actually placed downstream.
    assert.equal(res.headers.get('x-access-email'), 'user@example.com');
  });

  test('a valid token in the CF_Authorization cookie passes', async () => {
    const token = await jwks.sign({ email: 'cookie@example.com' }, { aud: AUD, iss: ISS });
    const res = await middleware(
      new Request('https://app.example.com/rules', {
        headers: { cookie: `CF_Authorization=${token}` },
      }),
      envFor(jwks.url),
    );
    assert.equal(res.status, 200);
  });

  test('a right signature but wrong audience is rejected', async () => {
    const token = await jwks.sign({ email: 'user@example.com' }, { aud: 'wrong-audience', iss: ISS });
    const res = await middleware(
      new Request('https://app.example.com/rules', {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      }),
      envFor(jwks.url),
    );
    assert.notEqual(res.status, 200);
  });

  test('a right signature but wrong issuer is rejected', async () => {
    const token = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: 'https://other.team.example' });
    const res = await middleware(
      new Request('https://app.example.com/rules', {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      }),
      envFor(jwks.url),
    );
    assert.notEqual(res.status, 200);
  });

  test('a token signed for the bare host (not the full host) is rejected', async () => {
    // X3: the issuer must be the full host. A token signed for the bare host
    // must not pass.
    const token = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: TEAM_DOMAIN });
    const res = await middleware(
      new Request('https://app.example.com/rules', {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      }),
      envFor(jwks.url),
    );
    assert.notEqual(res.status, 200, 'a bare-host issuer must be rejected');
  });

  test('an expired token is rejected', async () => {
    const token = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: ISS, exp: Math.floor(Date.now() / 1000) - 3600 });
    const res = await middleware(
      new Request('https://app.example.com/rules', {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      }),
      envFor(jwks.url),
    );
    assert.notEqual(res.status, 200);
  });

  test('a static asset with no token is not a 200 (11.2.4)', async () => {
    const res = await middleware(
      new Request('https://app.example.com/_next/static/anything.js'),
      envFor(jwks.url),
    );
    assert.notEqual(res.status, 200, 'the matcher must not exclude /_next/static');
    assert.equal(res.status, 401);
  });

  test('/healthz with the correct secret header is allowed', async () => {
    const res = await middleware(
      new Request('https://app.example.com/healthz', {
        headers: { 'x-healthcheck-secret': 'the-secret' },
      }),
      envFor(jwks.url, { OZB_HEALTHCHECK_SECRET: 'the-secret' }),
    );
    assert.equal(res.status, 200);
  });

  test('/healthz without the secret is rejected', async () => {
    const res = await middleware(
      new Request('https://app.example.com/healthz'),
      envFor(jwks.url, { OZB_HEALTHCHECK_SECRET: 'the-secret' }),
    );
    assert.notEqual(res.status, 200);
    assert.equal(res.status, 401);
  });

  test('/healthz with a wrong secret is rejected', async () => {
    const res = await middleware(
      new Request('https://app.example.com/healthz', {
        headers: { 'x-healthcheck-secret': 'wrong' },
      }),
      envFor(jwks.url, { OZB_HEALTHCHECK_SECRET: 'the-secret' }),
    );
    assert.notEqual(res.status, 200);
  });

  test('the icon route is exempt only when OZB_ICON_ROUTE_PUBLIC is set', async () => {
    // Without the flag: rejected like any other path.
    const rejected = await middleware(
      new Request('https://app.example.com/icon.svg'),
      envFor(jwks.url),
    );
    assert.notEqual(rejected.status, 200, 'icon route gated when OZB_ICON_ROUTE_PUBLIC is not set');

    // With the flag: exempt (200) without a token.
    const allowed = await middleware(
      new Request('https://app.example.com/icon.svg'),
      envFor(jwks.url, { OZB_ICON_ROUTE_PUBLIC: '1' }),
    );
    assert.equal(allowed.status, 200, 'icon route exempt when OZB_ICON_ROUTE_PUBLIC is set');
  });

  test('the matcher matches every path, including /_next/static (11.2.4)', () => {
    // m5: pin the matcher to "match everything". A negative lookahead such as
    // '/((?!_next/static).*)' would exclude /_next/static and this test would
    // catch it (the old test only called middleware() directly, which never
    // consults the matcher, so it could not).
    assert.deepEqual(config.matcher, ['/(.*)']);
  });

  test('the production path reads process.env (no env arg) — 200 with token, 401 without', async () => {
    // X2: in the built edge runtime the config must come from process.env via
    // static reads. This test exercises that exact path: it sets the real
    // process.env vars and calls middleware() with NO env argument, so the
    // middleware reads process.env directly (not an injected map). A valid
    // token must pass and a tokenless request must 401.
    const saved = {
      CF_JWKS_URL: process.env.CF_JWKS_URL,
      CF_ACCESS_AUD: process.env.CF_ACCESS_AUD,
      CF_ACCESS_TEAM_DOMAIN: process.env.CF_ACCESS_TEAM_DOMAIN,
      OZB_HEALTHCHECK_SECRET: process.env.OZB_HEALTHCHECK_SECRET,
    };
    process.env.CF_JWKS_URL = jwks.url;
    process.env.CF_ACCESS_AUD = AUD;
    process.env.CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
    try {
      const token = await jwks.sign({ email: 'prod@example.com' }, { aud: AUD, iss: ISS });
      const withToken = await middleware(
        new Request('https://app.example.com/rules', {
          headers: { 'Cf-Access-Jwt-Assertion': token },
        }),
      );
      assert.equal(withToken.status, 200, 'a valid token passes on the production path');
      assert.equal(withToken.headers.get('x-access-email'), 'prod@example.com');

      const withoutToken = await middleware(new Request('https://app.example.com/rules'));
      assert.equal(withoutToken.status, 401, 'a tokenless request is rejected on the production path');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
