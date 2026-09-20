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
    const token = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: `https://${TEAM_DOMAIN}` });
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

  test('a valid JWT + a valid CSRF token mutes the rule (with the 6.4 confirmation)', async () => {
    const jwt = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: `https://${TEAM_DOMAIN}` });
    const csrf = await generateCsrfToken(CSRF_SECRET);
    const res = await mutePost(
      new Request('https://app.example.com/rules/1/mute', {
        method: 'POST',
        headers: { 'Cf-Access-Jwt-Assertion': jwt, 'x-csrf-token': csrf, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'mute', confirm: '1' }),
      }),
      { params: { id: '1' } },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'muted');
    assert.equal(store.getRule(1).state, 'muted', 'the rule is muted');
  });

  test('a mute without the 6.4 confirmation is rejected with 400 (X4)', async () => {
    // Reset to a known state so the assertion is about the rejected mute, not
    // the prior test's side effect.
    store.setRuleState(1, 'enabled', '2026-09-19T06:20:00Z');
    const jwt = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: `https://${TEAM_DOMAIN}` });
    const csrf = await generateCsrfToken(CSRF_SECRET);
    const res = await mutePost(
      new Request('https://app.example.com/rules/1/mute', {
        method: 'POST',
        headers: { 'Cf-Access-Jwt-Assertion': jwt, 'x-csrf-token': csrf, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'mute' }),
      }),
      { params: { id: '1' } },
    );
    assert.equal(res.status, 400, 'a mute without confirm is refused');
    assert.equal(store.getRule(1).state, 'enabled', 'the rule is not muted without confirm');
  });

  // X8: muting suppresses that rule's already-queued rows in `pending_alerts`.
  // Seed two queued alerts for the rule, mute it, and assert they are gone
  // while the rule is kept (state='muted') — mute, never delete.
  test('muting removes that rule\'s rows from pending_alerts (X8)', async () => {
    const now = '2026-09-19T07:20:00Z';
    store.setRuleState(1, 'enabled', now);
    // Two already-queued alerts for rule 1.
    store.insertPendingAlert({ rule_id: 1, node_id: 101, payload: JSON.stringify({ title: 'queued one' }), created_at: now });
    store.insertPendingAlert({ rule_id: 1, node_id: 102, payload: JSON.stringify({ title: 'queued two' }), created_at: now });
    assert.equal(store.getPendingAlerts().length, 2, 'two alerts are queued before the mute');

    const jwt = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: `https://${TEAM_DOMAIN}` });
    const csrf = await generateCsrfToken(CSRF_SECRET);
    const res = await mutePost(
      new Request('https://app.example.com/rules/1/mute', {
        method: 'POST',
        headers: { 'Cf-Access-Jwt-Assertion': jwt, 'x-csrf-token': csrf, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'mute', confirm: '1' }),
      }),
      { params: { id: '1' } },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'muted');
    assert.equal(store.getRule(1).state, 'muted', 'the rule is muted (kept, not deleted)');
    assert.equal(store.getPendingAlerts().length, 0, 'the mute cleared the rule\'s queued alerts');
  });
});

// X8: /healthz in both states. The handler reads `process.env` directly (it is
// a state-reading route; the access check is the middleware's job). The
// healthcheck-secret check gates it when called directly.
describe('route: /healthz reports acquisition health (3.7)', () => {
  let store;
  let dir;
  before(() => {
    process.env.OZB_HEALTHCHECK_SECRET = 'healthcheck-secret-for-tests';
    process.env.OZB_POLL_INTERVAL_SECONDS = '300';
    dir = mkdtempSync(join(tmpdir(), 'ozb-healthz-'));
    store = openStore({ path: join(dir, 'test.db'), clock: fixedClock('2026-09-19T07:30:00Z') });
    setStoreForTest(store);
  });
  after(() => {
    setStoreForTest(null);
    delete process.env.OZB_HEALTHCHECK_SECRET;
    delete process.env.OZB_POLL_INTERVAL_SECONDS;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a request without the healthcheck secret is rejected with 401', async () => {
    const { GET } = await import('../../../app/healthz/route.js');
    const res = await GET(new Request('https://app.example.com/healthz'));
    assert.equal(res.status, 401, 'no secret -> 401 (fail closed)');
  });

  test('a request with the wrong secret is rejected with 401', async () => {
    const { GET } = await import('../../../app/healthz/route.js');
    const res = await GET(
      new Request('https://app.example.com/healthz', { headers: { 'x-healthcheck-secret': 'wrong' } }),
    );
    assert.equal(res.status, 401, 'wrong secret -> 401');
  });

  test('a successful poll within three intervals is healthy (200)', async () => {
    const { GET } = await import('../../../app/healthz/route.js');
    // Two intervals ago: within the three-interval threshold.
    const twoIntervalsAgo = new Date(Date.now() - 2 * 300 * 1000).toISOString();
    store.setPollState({
      lastSuccessAt: twoIntervalsAgo,
      lastResponseClass: 'ok',
      backoffSeconds: 0,
      consecutiveFailures: 0,
    });
    const res = await GET(
      new Request('https://app.example.com/healthz', { headers: { 'x-healthcheck-secret': 'healthcheck-secret-for-tests' } }),
    );
    assert.equal(res.status, 200, 'a fresh poll is healthy');
    const body = await res.json();
    assert.equal(body.status, 'healthy');
  });

  test('a poll older than three intervals plus one second is unhealthy (503)', async () => {
    const { GET } = await import('../../../app/healthz/route.js');
    // Three intervals plus one second: past the threshold.
    const stale = new Date(Date.now() - (3 * 300 + 1) * 1000).toISOString();
    store.setPollState({
      lastSuccessAt: stale,
      lastResponseClass: 'ok',
      backoffSeconds: 0,
      consecutiveFailures: 0,
    });
    const res = await GET(
      new Request('https://app.example.com/healthz', { headers: { 'x-healthcheck-secret': 'healthcheck-secret-for-tests' } }),
    );
    assert.equal(res.status, 503, 'a stale poll is unhealthy');
    const body = await res.json();
    assert.equal(body.status, 'unhealthy');
  });
});
