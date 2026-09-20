import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from '../../../lib/store/index.js';
import { fixedClock } from '../../../lib/clock.js';
import { setStoreForTest, getStore } from '../../../lib/web/db.js';
import { generateCsrfToken } from '../../../lib/csrf.js';
import { startJwksServer } from '../../support/jwks.js';
import { POST as mutePost } from '../../../app/rules/[id]/mute/route.js';

const AUD = 'test-audience';
const TEAM_DOMAIN = 'team.cloudflareaccess.org';
const CSRF_SECRET = 'csrf-secret-for-tests';

// The route calls requireAuthenticated(request) with no env argument, so the
// gate reads process.env. Set the vars there.
process.env.CF_ACCESS_AUD = AUD;
process.env.CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
process.env.OZB_CSRF_SECRET = CSRF_SECRET;

/**
 * Drive the mute route directly (bypassing the middleware, exactly as the
 * acceptance test does) against a temp store. The route re-applies the access
 * and CSRF gates itself, so an unauthenticated mutation must be rejected here.
 */
describe('route: /rules/<id>/mute re-gates a directly-driven request (11.3.6)', () => {
  let jwks;
  let store;
  let dir;
  before(async () => {
    jwks = await startJwksServer();
    process.env.CF_JWKS_URL = jwks.url;
    dir = mkdtempSync(join(tmpdir(), 'ozb-route-'));
    store = openStore({ path: join(dir, 'test.db'), clock: fixedClock('2026-09-19T07:30:00Z') });
    // A rule to mute.
    const now = '2026-09-19T06:20:00Z';
    store.insertRule({
      id: 1,
      type: 'contains',
      parameters: JSON.stringify({ term: 'test' }),
      state: 'enabled',
      surfaces: 'deals',
      cooldown_seconds: 86400,
      pinned_slug: null,
      created_at: now,
      modified_at: now,
    });
    setStoreForTest(store);
  });
  after(async () => {
    setStoreForTest(null);
    delete process.env.CF_JWKS_URL;
    store.close();
    rmSync(dir, { recursive: true, force: true });
    await jwks.close();
  });

  test('an unauthenticated mutation is rejected with 401 (the route re-gates)', async () => {
    const res = await mutePost(
      new Request('https://app.example.com/rules/1/mute', { method: 'POST' }),
      { params: { id: '1' } },
    );
    assert.equal(res.status, 401, 'no token -> access check fails');
    // The rule must not have been mutated.
    assert.equal(store.getRule(1).state, 'enabled');
  });

  test('a valid JWT but no CSRF token is rejected with 403 (independent checks)', async () => {
    const token = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: TEAM_DOMAIN });
    const res = await mutePost(
      new Request('https://app.example.com/rules/1/mute', {
        method: 'POST',
        headers: { 'Cf-Access-Jwt-Assertion': token },
      }),
      { params: { id: '1' } },
    );
    assert.equal(res.status, 403, 'passes access, fails CSRF');
    assert.equal(store.getRule(1).state, 'enabled', 'the rule is not mutated on a failed gate');
  });

  test('a forged x-access-email header without a JWT is rejected with 401', async () => {
    const res = await mutePost(
      new Request('https://app.example.com/rules/1/mute', {
        method: 'POST',
        headers: { 'x-access-email': 'attacker@example.com' },
      }),
      { params: { id: '1' } },
    );
    assert.equal(res.status, 401, 'the header alone must not authenticate');
  });

  test('a valid JWT + a valid CSRF token mutes the rule', async () => {
    const jwt = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: TEAM_DOMAIN });
    const csrf = await generateCsrfToken(CSRF_SECRET);
    const res = await mutePost(
      new Request('https://app.example.com/rules/1/mute', {
        method: 'POST',
        headers: { 'Cf-Access-Jwt-Assertion': jwt, 'x-csrf-token': csrf },
        body: JSON.stringify({ action: 'mute' }),
      }),
      { params: { id: '1' } },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'muted');
    assert.equal(store.getRule(1).state, 'muted', 'the rule is muted');
  });
});
