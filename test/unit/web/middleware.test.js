import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { middleware, config, readConfig } from '../../../middleware.js';
import { startJwksServer } from '../../support/jwks.js';

const AUD = 'test-audience';
const TEAM_DOMAIN = 'team.cloudflareaccess.org';
// X3: Cloudflare documents the token `iss` as the full host,
// https://<team>.cloudflareaccess.com — not a bare host.
const ISS = `https://${TEAM_DOMAIN}`;

/**
 * The config keys the middleware reads from `process.env` (C1). A test sets
 * these on `process.env` (the production path) and restores them afterwards.
 */
const CONFIG_KEYS = [
  'CF_JWKS_URL',
  'CF_ACCESS_AUD',
  'CF_ACCESS_TEAM_DOMAIN',
  'OZB_HEALTHCHECK_SECRET',
  'OZB_ICON_ROUTE_PUBLIC',
];

/**
 * Run `fn` with the middleware's config set on `process.env` (the production
 * path, C1), restoring the prior values afterwards. `extra` overrides the
 * defaults.
 * @param {object} [extra]
 * @param {() => Promise<void>} fn
 */
async function withEnv(extra = {}, fn) {
  const saved = {};
  for (const key of CONFIG_KEYS) saved[key] = process.env[key];
  process.env.CF_JWKS_URL = jwksUrl;
  process.env.CF_ACCESS_AUD = AUD;
  process.env.CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
  delete process.env.OZB_HEALTHCHECK_SECRET;
  delete process.env.OZB_ICON_ROUTE_PUBLIC;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const key of CONFIG_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

let jwksUrl = '';

describe('middleware: Cloudflare Access verification', () => {
  let jwks;
  before(async () => {
    jwks = await startJwksServer();
    jwksUrl = jwks.url;
  });
  after(async () => {
    await jwks.close();
  });

  test('a request with no token is rejected (not 200)', async () => {
    await withEnv({}, async () => {
      const res = await middleware(new Request('https://app.example.com/rules'), { waitUntil() {} });
      assert.notEqual(res.status, 200, 'no token must not be a 200');
      assert.equal(res.status, 401);
    });
  });

  test('a valid token passes and the verified email is available downstream', async () => {
    await withEnv({}, async () => {
      const token = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: ISS });
      const res = await middleware(
        new Request('https://app.example.com/rules', {
          headers: { 'Cf-Access-Jwt-Assertion': token },
        }),
        { waitUntil() {} },
      );
      assert.equal(res.status, 200, 'a valid token passes');
      // m4: the verified email claim is actually placed downstream.
      assert.equal(res.headers.get('x-access-email'), 'user@example.com');
    });
  });

  test('a valid token in the CF_Authorization cookie passes', async () => {
    await withEnv({}, async () => {
      const token = await jwks.sign({ email: 'cookie@example.com' }, { aud: AUD, iss: ISS });
      const res = await middleware(
        new Request('https://app.example.com/rules', {
          headers: { cookie: `CF_Authorization=${token}` },
        }),
        { waitUntil() {} },
      );
      assert.equal(res.status, 200);
    });
  });

  test('a right signature but wrong audience is rejected', async () => {
    await withEnv({}, async () => {
      const token = await jwks.sign({ email: 'user@example.com' }, { aud: 'wrong-audience', iss: ISS });
      const res = await middleware(
        new Request('https://app.example.com/rules', {
          headers: { 'Cf-Access-Jwt-Assertion': token },
        }),
        { waitUntil() {} },
      );
      assert.notEqual(res.status, 200);
    });
  });

  test('a right signature but wrong issuer is rejected', async () => {
    await withEnv({}, async () => {
      const token = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: 'https://other.team.example' });
      const res = await middleware(
        new Request('https://app.example.com/rules', {
          headers: { 'Cf-Access-Jwt-Assertion': token },
        }),
        { waitUntil() {} },
      );
      assert.notEqual(res.status, 200);
    });
  });

  test('a token signed for the bare host (not the full host) is rejected', async () => {
    // X3: the issuer must be the full host. A token signed for the bare host
    // must not pass.
    await withEnv({}, async () => {
      const token = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: TEAM_DOMAIN });
      const res = await middleware(
        new Request('https://app.example.com/rules', {
          headers: { 'Cf-Access-Jwt-Assertion': token },
        }),
        { waitUntil() {} },
      );
      assert.notEqual(res.status, 200, 'a bare-host issuer must be rejected');
    });
  });

  test('an expired token is rejected', async () => {
    await withEnv({}, async () => {
      const token = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: ISS, exp: Math.floor(Date.now() / 1000) - 3600 });
      const res = await middleware(
        new Request('https://app.example.com/rules', {
          headers: { 'Cf-Access-Jwt-Assertion': token },
        }),
        { waitUntil() {} },
      );
      assert.notEqual(res.status, 200);
    });
  });

  test('a static asset with no token is not a 200 (11.2.4)', async () => {
    await withEnv({}, async () => {
      const res = await middleware(new Request('https://app.example.com/_next/static/anything.js'), { waitUntil() {} });
      assert.notEqual(res.status, 200, 'the matcher must not exclude /_next/static');
      assert.equal(res.status, 401);
    });
  });

  test('/healthz with the correct secret header is allowed', async () => {
    await withEnv({ OZB_HEALTHCHECK_SECRET: 'the-secret' }, async () => {
      const res = await middleware(
        new Request('https://app.example.com/healthz', {
          headers: { 'x-healthcheck-secret': 'the-secret' },
        }),
        { waitUntil() {} },
      );
      assert.equal(res.status, 200);
    });
  });

  test('/healthz without the secret is rejected', async () => {
    await withEnv({ OZB_HEALTHCHECK_SECRET: 'the-secret' }, async () => {
      const res = await middleware(new Request('https://app.example.com/healthz'), { waitUntil() {} });
      assert.notEqual(res.status, 200);
      assert.equal(res.status, 401);
    });
  });

  test('/healthz with a wrong secret is rejected', async () => {
    await withEnv({ OZB_HEALTHCHECK_SECRET: 'the-secret' }, async () => {
      const res = await middleware(
        new Request('https://app.example.com/healthz', {
          headers: { 'x-healthcheck-secret': 'wrong' },
        }),
        { waitUntil() {} },
      );
      assert.notEqual(res.status, 200);
    });
  });

  test('the icon route is exempt only when OZB_ICON_ROUTE_PUBLIC is set', async () => {
    // Without the flag: rejected like any other path.
    await withEnv({}, async () => {
      const rejected = await middleware(new Request('https://app.example.com/icon.svg'), { waitUntil() {} });
      assert.notEqual(rejected.status, 200, 'icon route gated when OZB_ICON_ROUTE_PUBLIC is not set');
    });
    // With the flag: exempt (200) without a token.
    await withEnv({ OZB_ICON_ROUTE_PUBLIC: '1' }, async () => {
      const allowed = await middleware(new Request('https://app.example.com/icon.svg'), { waitUntil() {} });
      assert.equal(allowed.status, 200, 'icon route exempt when OZB_ICON_ROUTE_PUBLIC is set');
    });
  });

  test('the matcher matches every path, including /_next/static (11.2.4)', () => {
    // m5: pin the matcher to "match everything". A negative lookahead such as
    // '/((?!_next/static).*)' would exclude /_next/static and this test would
    // catch it (the old test only called middleware() directly, which never
    // consults the matcher, so it could not).
    assert.deepEqual(config.matcher, ['/(.*)']);
  });

  test('C1: the framework call shape middleware(request, event) reads process.env', async () => {
    // C1: Next.js invokes middleware as middleware(request, event) — the second
    // argument is the NextFetchEvent, not an env map. This test exercises that
    // exact call shape: config is set on process.env, and a fake event is
    // passed as the second argument. A valid JWT must pass and /healthz with
    // the correct secret must return 200. (Before the C1 fix this 401'd,
    // because the handler read the event object for config.)
    await withEnv({ OZB_HEALTHCHECK_SECRET: 'the-secret' }, async () => {
      const token = await jwks.sign({ email: 'prod@example.com' }, { aud: AUD, iss: ISS });
      const withToken = await middleware(
        new Request('https://app.example.com/rules', {
          headers: { 'Cf-Access-Jwt-Assertion': token },
        }),
        { waitUntil() {} },
      );
      assert.equal(withToken.status, 200, 'a valid token passes on the framework call shape');
      assert.equal(withToken.headers.get('x-access-email'), 'prod@example.com');

      const healthz = await middleware(
        new Request('https://app.example.com/healthz', {
          headers: { 'x-healthcheck-secret': 'the-secret' },
        }),
        { waitUntil() {} },
      );
      assert.equal(healthz.status, 200, '/healthz + secret returns 200 on the framework call shape');

      const withoutToken = await middleware(new Request('https://app.example.com/rules'), { waitUntil() {} });
      assert.equal(withoutToken.status, 401, 'a tokenless request is rejected on the framework call shape');
    });
  });

  test('readConfig (the test seam) builds the JWKS URL and issuer from the env map', () => {
    // C1: the test seam is readConfig(env), exported and tested directly. A test
    // can point the JWKS at a loopback server and set the secrets without
    // touching the handler's signature.
    const cfg = readConfig({
      CF_JWKS_URL: 'http://127.0.0.1:1/certs',
      CF_ACCESS_AUD: AUD,
      CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      OZB_HEALTHCHECK_SECRET: 'the-secret',
      OZB_ICON_ROUTE_PUBLIC: '1',
    });
    assert.equal(cfg.jwksUrl, 'http://127.0.0.1:1/certs');
    assert.equal(cfg.issuer, ISS);
    assert.equal(cfg.aud, AUD);
    assert.equal(cfg.healthcheckSecret, 'the-secret');
    assert.equal(cfg.iconRoutePublic, true);
    // Without an override the JWKS URL is derived from the team domain.
    const derived = readConfig({ CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN });
    assert.equal(derived.jwksUrl, `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`);
  });
});
