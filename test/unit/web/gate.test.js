import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  verifyAccess,
  requireCsrf,
  requireAuthenticated,
  CSRF_HEADER,
} from '../../../lib/web/gate.js';
import { generateCsrfToken } from '../../../lib/csrf.js';
import { startJwksServer } from '../../support/jwks.js';

const AUD = 'test-audience';
const TEAM_DOMAIN = 'team.cloudflareaccess.org';
// X3: the Access token `iss` is the full host, not a bare host.
const ISS = `https://${TEAM_DOMAIN}`;
const CSRF_SECRET = 'csrf-secret-for-tests';

/**
 * Build the env the gate reads: point the JWKS at the loopback server and set
 * the CSRF secret.
 * @param {string} jwksUrl
 * @param {object} [extra]
 * @returns {object}
 */
function envFor(jwksUrl, extra = {}) {
  return {
    CF_JWKS_URL: jwksUrl,
    CF_ACCESS_AUD: AUD,
    CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    OZB_CSRF_SECRET: CSRF_SECRET,
    ...extra,
  };
}

describe('gate: independent access + CSRF checks (11.3.6)', () => {
  let jwks;
  before(async () => {
    jwks = await startJwksServer();
  });
  after(async () => {
    await jwks.close();
  });

  test('verifyAccess: a valid JWT is accepted with the email claim', async () => {
    const token = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: ISS });
    const res = await verifyAccess(
      new Request('https://app.example.com/x', {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      }),
      envFor(jwks.url),
    );
    assert.equal(res.ok, true);
    assert.equal(res.email, 'user@example.com');
  });

  test('verifyAccess: no token is rejected', async () => {
    const res = await verifyAccess(new Request('https://app.example.com/x'), envFor(jwks.url));
    assert.equal(res.ok, false);
  });

  test('verifyAccess: a bare-host issuer is rejected (X3)', async () => {
    const token = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: TEAM_DOMAIN });
    const res = await verifyAccess(
      new Request('https://app.example.com/x', {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      }),
      envFor(jwks.url),
    );
    assert.equal(res.ok, false, 'the issuer must be the full host');
  });

  test('requireCsrf: a valid token passes, a missing one fails', async () => {
    const token = await generateCsrfToken(CSRF_SECRET);
    const ok = await requireCsrf(
      new Request('https://app.example.com/x', { headers: { [CSRF_HEADER]: token } }),
      envFor(jwks.url),
    );
    assert.equal(ok, true);

    const missing = await requireCsrf(
      new Request('https://app.example.com/x'),
      envFor(jwks.url),
    );
    assert.equal(missing, false);
  });

  test('requireCsrf: a token in the urlencoded body is accepted (X5)', async () => {
    const token = await generateCsrfToken(CSRF_SECRET);
    const body = new URLSearchParams({ _csrf: token, action: 'mute' }).toString();
    const ok = await requireCsrf(
      new Request('https://app.example.com/x', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      }),
      envFor(jwks.url),
    );
    assert.equal(ok, true, 'a form token in the body is accepted');
  });

  test('requireCsrf: a token in the JSON body is accepted (X5)', async () => {
    const token = await generateCsrfToken(CSRF_SECRET);
    const ok = await requireCsrf(
      new Request('https://app.example.com/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ _csrf: token }),
      }),
      envFor(jwks.url),
    );
    assert.equal(ok, true, 'a JSON token in the body is accepted');
  });

  test('requireCsrf: a wrong body token is rejected (X5)', async () => {
    const token = await generateCsrfToken(CSRF_SECRET);
    const ok = await requireCsrf(
      new Request('https://app.example.com/x', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: 'not-a-real-token' }).toString(),
      }),
      envFor(jwks.url),
    );
    assert.equal(ok, false);
  });

  test('requireCsrf: an empty secret is rejected (X10)', async () => {
    const token = await generateCsrfToken(CSRF_SECRET);
    const ok = await requireCsrf(
      new Request('https://app.example.com/x', { headers: { [CSRF_HEADER]: token } }),
      envFor(jwks.url, { OZB_CSRF_SECRET: '' }),
    );
    assert.equal(ok, false, 'an empty CSRF secret must not verify');
  });

  test('requireCsrf: a token signed under a different secret is rejected (X10)', async () => {
    const token = await generateCsrfToken(CSRF_SECRET);
    const ok = await requireCsrf(
      new Request('https://app.example.com/x', { headers: { [CSRF_HEADER]: token } }),
      envFor(jwks.url, { OZB_CSRF_SECRET: 'a-different-secret' }),
    );
    assert.equal(ok, false);
  });

  test('requireCsrf: an expired token is rejected (m3)', async () => {
    // Mint a token, then verify with a clock advanced past the 15-minute expiry.
    const token = await generateCsrfToken(CSRF_SECRET);
    const now = Date.now();
    const future = new Date(now + 16 * 60 * 1000);
    const ok = await requireCsrf(
      new Request('https://app.example.com/x', { headers: { [CSRF_HEADER]: token } }),
      envFor(jwks.url),
      undefined,
      future,
    );
    assert.equal(ok, false, 'a token older than 15 minutes is rejected');
  });

  test('requireCsrf: a fresh token passes (m3)', async () => {
    const token = await generateCsrfToken(CSRF_SECRET);
    const ok = await requireCsrf(
      new Request('https://app.example.com/x', { headers: { [CSRF_HEADER]: token } }),
      envFor(jwks.url),
      undefined,
      new Date(Date.now() + 5 * 60 * 1000),
    );
    assert.equal(ok, true);
  });

  test('requireCsrf: a token bound to another email is rejected (m3 binding)', async () => {
    const token = await generateCsrfToken(CSRF_SECRET, 'bound@example.com');
    const ok = await requireCsrf(
      new Request('https://app.example.com/x', { headers: { [CSRF_HEADER]: token } }),
      envFor(jwks.url),
      undefined,
      undefined,
      'someone-else@example.com',
    );
    assert.equal(ok, false, 'a token bound to another email is rejected');
  });

  test('requireCsrf: a token bound to the same email is accepted (m3 binding)', async () => {
    const token = await generateCsrfToken(CSRF_SECRET, 'bound@example.com');
    const ok = await requireCsrf(
      new Request('https://app.example.com/x', { headers: { [CSRF_HEADER]: token } }),
      envFor(jwks.url),
      undefined,
      undefined,
      'bound@example.com',
    );
    assert.equal(ok, true, 'a token bound to the same email is accepted');
  });

  test('requireCsrf: a token with no binding is accepted for any email (m3 binding)', async () => {
    const token = await generateCsrfToken(CSRF_SECRET);
    const ok = await requireCsrf(
      new Request('https://app.example.com/x', { headers: { [CSRF_HEADER]: token } }),
      envFor(jwks.url),
      undefined,
      undefined,
      'anyone@example.com',
    );
    assert.equal(ok, true, 'an unbound token is accepted');
  });

  test('requireAuthenticated: a valid JWT but no CSRF token is rejected with 403 (independent checks)', async () => {
    const token = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: ISS });
    const res = await requireAuthenticated(
      new Request('https://app.example.com/rules', {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      }),
      envFor(jwks.url),
    );
    assert.equal(res.ok, false);
    assert.equal(res.response.status, 403, 'fails the CSRF check, not the access check');
  });

  test('requireAuthenticated: an unauthenticated request is rejected with 401 before CSRF', async () => {
    const res = await requireAuthenticated(
      new Request('https://app.example.com/rules'),
      envFor(jwks.url),
    );
    assert.equal(res.ok, false);
    assert.equal(res.response.status, 401, 'fails the access check first');
  });

  test('requireAuthenticated: a valid JWT + a valid CSRF token passes', async () => {
    const jwt = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: ISS });
    const csrf = await generateCsrfToken(CSRF_SECRET);
    const res = await requireAuthenticated(
      new Request('https://app.example.com/rules', {
        headers: { 'Cf-Access-Jwt-Assertion': jwt, [CSRF_HEADER]: csrf },
      }),
      envFor(jwks.url),
    );
    assert.equal(res.ok, true);
    assert.equal(res.email, 'user@example.com');
    assert.equal(res.response, null);
  });

  test('requireAuthenticated: a valid JWT + a CSRF token in the body passes (X5)', async () => {
    const jwt = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: ISS });
    const csrf = await generateCsrfToken(CSRF_SECRET);
    const res = await requireAuthenticated(
      new Request('https://app.example.com/rules', {
        method: 'POST',
        headers: { 'Cf-Access-Jwt-Assertion': jwt, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrf }).toString(),
      }),
      envFor(jwks.url),
    );
    assert.equal(res.ok, true, 'a body token passes the independent checks');
  });

  test('requireAuthenticated: a forged x-access-email header without a JWT is rejected (header is not a trust signal)', async () => {
    const res = await requireAuthenticated(
      new Request('https://app.example.com/rules', {
        headers: { 'x-access-email': 'attacker@example.com' },
      }),
      envFor(jwks.url),
    );
    assert.equal(res.ok, false);
    assert.equal(res.response.status, 401, 'the header alone must not authenticate');
  });
});
