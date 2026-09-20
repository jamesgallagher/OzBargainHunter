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
const CSRF_SECRET = 'csrf-secret-for-tests';

/**
 * Build the env the gate reads: point the JWKS at the loopback server and set
 * the CSRF secret.
 * @param {string} jwksUrl
 * @returns {object}
 */
function envFor(jwksUrl) {
  return {
    CF_JWKS_URL: jwksUrl,
    CF_ACCESS_AUD: AUD,
    CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    OZB_CSRF_SECRET: CSRF_SECRET,
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
    const token = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: TEAM_DOMAIN });
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

  test('requireAuthenticated: a valid JWT but no CSRF token is rejected with 403 (independent checks)', async () => {
    const token = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: TEAM_DOMAIN });
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
    const jwt = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: TEAM_DOMAIN });
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
