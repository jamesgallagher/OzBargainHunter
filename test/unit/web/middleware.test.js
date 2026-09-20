import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { middleware } from '../../../middleware.js';
import { startJwksServer } from '../../support/jwks.js';

const AUD = 'test-audience';
const TEAM_DOMAIN = 'team.cloudflareaccess.org';

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
    const token = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: TEAM_DOMAIN });
    const res = await middleware(
      new Request('https://app.example.com/rules', {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      }),
      envFor(jwks.url),
    );
    assert.equal(res.status, 200, 'a valid token passes');
  });

  test('a valid token in the CF_Authorization cookie passes', async () => {
    const token = await jwks.sign({ email: 'cookie@example.com' }, { aud: AUD, iss: TEAM_DOMAIN });
    const res = await middleware(
      new Request('https://app.example.com/rules', {
        headers: { cookie: `CF_Authorization=${token}` },
      }),
      envFor(jwks.url),
    );
    assert.equal(res.status, 200);
  });

  test('a right signature but wrong audience is rejected', async () => {
    const token = await jwks.sign({ email: 'user@example.com' }, { aud: 'wrong-audience', iss: TEAM_DOMAIN });
    const res = await middleware(
      new Request('https://app.example.com/rules', {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      }),
      envFor(jwks.url),
    );
    assert.notEqual(res.status, 200);
  });

  test('a right signature but wrong issuer is rejected', async () => {
    const token = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: 'other.team.example' });
    const res = await middleware(
      new Request('https://app.example.com/rules', {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      }),
      envFor(jwks.url),
    );
    assert.notEqual(res.status, 200);
  });

  test('an expired token is rejected', async () => {
    const token = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: TEAM_DOMAIN, exp: Math.floor(Date.now() / 1000) - 3600 });
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
});
