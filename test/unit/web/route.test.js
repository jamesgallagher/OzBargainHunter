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
import { POST as deletePost } from '../../../app/rules/[id]/delete/route.js';
import { POST as savePost } from '../../../app/rules/[id]/save/route.js';
import { POST as createPost } from '../../../app/rules/new/create/route.js';

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

  test('a delete without explicit confirmation is rejected without removing the rule', async () => {
    const jwt = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: `https://${TEAM_DOMAIN}` });
    const csrf = await generateCsrfToken(CSRF_SECRET);
    const res = await deletePost(
      new Request('https://app.example.com/rules/1/delete', {
        method: 'POST',
        headers: { 'Cf-Access-Jwt-Assertion': jwt, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrf }),
      }),
      { params: { id: '1' } },
    );
    assert.equal(res.status, 400, 'a delete without confirm is refused');
    assert.notEqual(store.getRule(1), null, 'the rule remains after an unconfirmed delete request');
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

// M2: the remaining state-changing routes re-gate a directly-driven request
// (11.3.6) and apply their state change only when both the access and CSRF
// checks pass. The mute route (including mute-without-confirm) is covered
// above; these cover save, create, snooze, and enable.
describe('route: /rules/<id>/save, /rules/new/create, snooze, enable re-gate (11.3.6, M2)', () => {
  let jwks;
  let store;
  let dir;
  before(async () => {
    jwks = await startJwksServer();
    process.env.CF_JWKS_URL = jwks.url;
    dir = mkdtempSync(join(tmpdir(), 'ozb-route-m2-'));
    store = openStore({ path: join(dir, 'test.db'), clock: fixedClock('2026-09-19T07:30:00Z') });
    // A rule to edit / snooze / re-enable.
    const now = '2026-09-19T06:20:00Z';
    store.insertRule({
      id: 1,
      type: 'contains',
      parameters: JSON.stringify({ term: 'original' }),
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

  async function authedRequest(url, body) {
    const jwt = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: `https://${TEAM_DOMAIN}` });
    const csrf = await generateCsrfToken(CSRF_SECRET);
    return new Request(url, {
      method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': jwt, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('save: an unauthenticated mutation is rejected with 401 (the route re-gates)', async () => {
    const res = await savePost(new Request('https://app.example.com/rules/1/save', { method: 'POST' }), { params: { id: '1' } });
    assert.equal(res.status, 401, 'no token -> access check fails');
    assert.equal(store.getRule(1).parameters.term, 'original', 'the rule is not mutated on a failed gate');
  });

  test('save: a valid JWT but no CSRF token is rejected with 403 (independent checks)', async () => {
    const jwt = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: `https://${TEAM_DOMAIN}` });
    const res = await savePost(
      new Request('https://app.example.com/rules/1/save', { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': jwt } }),
      { params: { id: '1' } },
    );
    assert.equal(res.status, 403, 'passes access, fails CSRF');
  });

  test('save: a valid JWT + a valid CSRF token updates the term', async () => {
    const res = await savePost(await authedRequest('https://app.example.com/rules/1/save', { term: 'updated' }), { params: { id: '1' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.saved, true);
    assert.equal(store.getRule(1).parameters.term, 'updated', 'the term is updated');
  });

  test('save: an unknown rule id is rejected with 404', async () => {
    const res = await savePost(await authedRequest('https://app.example.com/rules/999/save', { term: 'x' }), { params: { id: '999' } });
    assert.equal(res.status, 404, 'unknown rule -> 404');
  });

  test('create: an unauthenticated mutation is rejected with 401 (the route re-gates)', async () => {
    const before = store.nextRuleId();
    const res = await createPost(new Request('https://app.example.com/rules/new/create', { method: 'POST' }));
    assert.equal(res.status, 401, 'no token -> access check fails');
    assert.equal(store.nextRuleId(), before, 'no rule is created on a failed gate');
  });

  test('create: a valid JWT + a valid CSRF token creates a rule with id = MAX(id)+1', async () => {
    const before = store.nextRuleId();
    const res = await createPost(await authedRequest('https://app.example.com/rules/new/create', { type: 'match', term: 'newrule' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.created, true);
    assert.equal(body.id, before, 'the new id is MAX(id)+1');
    assert.equal(store.getRule(body.id).parameters.term, 'newrule', 'the created rule carries the term');
    assert.equal(store.getRule(body.id).state, 'enabled', 'the created rule is enabled');
  });

  test('snooze24: a valid JWT + a valid CSRF token snoozes the rule 24 hours (state=snoozed, snooze_until set)', async () => {
    store.setRuleState(1, 'enabled', '2026-09-19T06:20:00Z');
    const res = await mutePost(await authedRequest('https://app.example.com/rules/1/mute', { action: 'snooze24' }), { params: { id: '1' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'snoozed');
    assert.equal(store.getRule(1).state, 'snoozed', 'the rule is snoozed');
    const until = store.getSetting('snooze_until_1');
    assert.ok(until, 'a snooze_until instant is recorded');
    // The instant is ~24 hours in the future (within a generous bound).
    const deltaMs = Date.parse(until) - Date.now();
    assert.ok(deltaMs > 23 * 60 * 60 * 1000 && deltaMs < 25 * 60 * 60 * 1000, 'the snooze instant is ~24h out');
  });

  test('snooze7: a valid JWT + a valid CSRF token snoozes the rule 7 days (state=snoozed, snooze_until set)', async () => {
    store.setRuleState(1, 'enabled', '2026-09-19T06:20:00Z');
    const res = await mutePost(await authedRequest('https://app.example.com/rules/1/mute', { action: 'snooze7' }), { params: { id: '1' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'snoozed');
    assert.equal(store.getRule(1).state, 'snoozed', 'the rule is snoozed');
    const until = store.getSetting('snooze_until_1');
    assert.ok(until, 'a snooze_until instant is recorded');
    const deltaMs = Date.parse(until) - Date.now();
    assert.ok(deltaMs > 6 * 24 * 60 * 60 * 1000 && deltaMs < 8 * 24 * 60 * 60 * 1000, 'the snooze instant is ~7d out');
  });

  test('enable: a valid JWT + a valid CSRF token re-enables the rule and clears the snooze instant', async () => {
    // Snooze first so there is a snooze instant to clear.
    store.setRuleState(1, 'snoozed', '2026-09-19T06:20:00Z');
    store.setSetting('snooze_until_1', '2026-09-21T07:30:00Z');
    assert.equal(store.getSetting('snooze_until_1'), '2026-09-21T07:30:00Z', 'a snooze instant is present before the re-enable');
    const res = await mutePost(await authedRequest('https://app.example.com/rules/1/mute', { action: 'enable' }), { params: { id: '1' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'enabled');
    assert.equal(store.getRule(1).state, 'enabled', 'the rule is re-enabled');
    assert.equal(store.getSetting('snooze_until_1'), null, 'the snooze instant is cleared');
  });

  test('enable: an unauthenticated mutation is rejected with 401 (the route re-gates)', async () => {
    store.setRuleState(1, 'snoozed', '2026-09-19T06:20:00Z');
    store.setSetting('snooze_until_1', '2026-09-21T07:30:00Z');
    const res = await mutePost(new Request('https://app.example.com/rules/1/mute', { method: 'POST' }), { params: { id: '1' } });
    assert.equal(res.status, 401, 'no token -> access check fails');
    assert.equal(store.getRule(1).state, 'snoozed', 'the rule is not re-enabled on a failed gate');
    assert.equal(store.getSetting('snooze_until_1'), '2026-09-21T07:30:00Z', 'the snooze instant is not cleared on a failed gate');
  });
});

// X6 / M2(c): create-after-delete must take MAX(id)+1 over the whole table.
// `insertRule` is `ON CONFLICT(id) DO UPDATE`, so a COUNT(*)+1 id after a
// delete (delete 2 from [1,2,3] -> count 2 -> new id 3) silently overwrites
// the surviving rule 3. This test seeds the gap a delete leaves and drives
// the real create handler. Rule 3 is seeded 'snoozed' (the state the mute
// route writes) so any id source that filters the table is also caught: with
// the gap, the enabled rows are {1} only, so `MAX(id) ... WHERE state =
// 'enabled'` is 1 and the new id is 2 — not 4. The test fails under both the
// COUNT(*)+1 mutant (id 3, overwriting rule 3) and the filtered-MAX mutant
// (id 2), and asserts no rule is lost under either.
describe('route: create-after-delete takes MAX(id)+1, never COUNT(*)+1 (X6, M2)', () => {
  let jwks;
  let store;
  let dir;
  before(async () => {
    jwks = await startJwksServer();
    process.env.CF_JWKS_URL = jwks.url;
    dir = mkdtempSync(join(tmpdir(), 'ozb-create-after-delete-'));
    store = openStore({ path: join(dir, 'test.db'), clock: fixedClock('2026-09-19T07:30:00Z') });
    // Seed a contiguous run 1..3, then delete the middle one: the gap shape.
    // Rule 3 is seeded 'snoozed' — the state the mute route writes — so an id
    // source filtered to `state = 'enabled'` sees only {1} and returns 2, not 4.
    const now = '2026-09-19T06:20:00Z';
    for (const [id, term, state] of [[1, 'term1', 'enabled'], [2, 'term2', 'enabled'], [3, 'term3', 'snoozed']]) {
      store.insertRule({
        id,
        type: 'contains',
        parameters: JSON.stringify({ term }),
        state,
        surfaces: 'deals',
        cooldown_seconds: 86400,
        pinned_slug: null,
        created_at: now,
        modified_at: now,
      });
    }
    assert.equal(store.deleteRule(2), 1, 'the middle rule is deleted, leaving the gap [1,_,3]');
    assert.equal(store.countRules(), 2, 'two rules survive the delete');
    assert.equal(store.getRule(3).state, 'snoozed', 'rule 3 is snoozed (the mute route writes this state)');
    setStoreForTest(store);
  });
  after(async () => {
    setStoreForTest(null);
    delete process.env.CF_JWKS_URL;
    store.close();
    rmSync(dir, { recursive: true, force: true });
    await jwks.close();
  });

  test('create after delete assigns the literal id 4 (MAX(id)+1) and does not overwrite the surviving rule', async () => {
    const jwt = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: `https://${TEAM_DOMAIN}` });
    const csrf = await generateCsrfToken(CSRF_SECRET);
    const res = await createPost(
      new Request('https://app.example.com/rules/new/create', {
        method: 'POST',
        headers: { 'Cf-Access-Jwt-Assertion': jwt, 'x-csrf-token': csrf, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'match', term: 'term4' }),
      }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.created, true);
    // The literal expected value: MAX(id)+1 over the whole table = 4.
    // Under the COUNT(*)+1 mutant this is 3 (overwriting rule 3); under the
    // filtered-MAX mutant (WHERE state = 'enabled', enabled rows = {1}) it is 2.
    assert.equal(body.id, 4, 'the new id is MAX(id)+1 = 4 over the whole table, not COUNT(*)+1 = 3 or MAX(id over enabled)+1 = 2');
    // No-loss: the create must not have overwritten or consumed any existing
    // rule — three rules exist after it (1, 3 surviving + the new one).
    assert.equal(store.countRules(), 3, 'no rule is lost: three rules exist after the create');
    // The surviving rule 3 keeps its original term and its original state
    // (snoozed) — neither is clobbered by the insert.
    assert.equal(store.getRule(3).parameters.term, 'term3', 'the surviving rule 3 is not overwritten');
    assert.equal(store.getRule(3).state, 'snoozed', 'the surviving rule 3 keeps its snoozed state');
    // The new rule carries its own term at the returned id.
    assert.equal(store.getRule(body.id).parameters.term, 'term4', 'the new rule carries its own term at the returned id');
    assert.equal(store.getRule(4).parameters.term, 'term4', 'the new rule is at id 4');
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

  // D7: the configured healthcheck secret is normalized (surrounding
  // whitespace stripped) at the route boundary. A padded configured value must
  // behave exactly like the unpadded value; a whitespace-only value normalizes
  // to empty and fails closed.
  test('a padded configured secret behaves like the unpadded value (D7)', async () => {
    process.env.OZB_HEALTHCHECK_SECRET = '  healthcheck-secret-for-tests\t\n';
    try {
      const { GET } = await import('../../../app/healthz/route.js');
      const res = await GET(
        new Request('https://app.example.com/healthz', { headers: { 'x-healthcheck-secret': 'healthcheck-secret-for-tests' } }),
      );
      // 401 would mean the normalized secret did not match the presented
      // header; anything else (503 here, since no poll state is set yet)
      // proves the secret gate passed.
      assert.notEqual(res.status, 401, 'a padded configured secret matches the unpadded header (secret gate passes)');
    } finally {
      process.env.OZB_HEALTHCHECK_SECRET = 'healthcheck-secret-for-tests';
    }
  });

  test('a whitespace-only configured secret fails closed (D7)', async () => {
    process.env.OZB_HEALTHCHECK_SECRET = '   \t\n';
    try {
      const { GET } = await import('../../../app/healthz/route.js');
      const res = await GET(
        new Request('https://app.example.com/healthz', { headers: { 'x-healthcheck-secret': 'healthcheck-secret-for-tests' } }),
      );
      assert.equal(res.status, 401, 'a whitespace-only configured secret normalizes to empty and rejects');
    } finally {
      process.env.OZB_HEALTHCHECK_SECRET = 'healthcheck-secret-for-tests';
    }
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

  // G9: while the access gate is not open (cooling / stopped / probing),
  // /healthz reports 503 backing_off carrying the gate's state — ahead of
  // the last-success age check. The gate is driven through the shared
  // store; the route re-reads it on every call.
  test('a stopped gate is 503 backing_off with the gate state (G9)', async () => {
    const { GET } = await import('../../../app/healthz/route.js');
    store.applyGateTransition(
      {
        state: 'stopped',
        rule: 'B1',
        tier: 0,
        reason: 'cloudflare_block on deals',
        since: '2026-09-19T07:30:00Z',
        until_at: null,
        min_resume_at: '2026-09-20T07:30:00Z',
        consecutive_b2: 0,
        failing_cycles: 0,
        b5_tier: 0,
        probe_used: 0,
      },
      [],
    );
    const res = await GET(
      new Request('https://app.example.com/healthz', { headers: { 'x-healthcheck-secret': 'healthcheck-secret-for-tests' } }),
    );
    assert.equal(res.status, 503, 'a stopped gate is 503');
    const body = await res.json();
    assert.equal(body.status, 'backing_off');
    assert.equal(body.gate.state, 'stopped');
    assert.equal(body.gate.rule, 'B1');
    assert.equal(body.gate.tier, 0);
    assert.equal(body.gate.since, '2026-09-19T07:30:00Z');
    assert.equal(body.gate.until_at, null);
    assert.equal(body.gate.min_resume_at, '2026-09-20T07:30:00Z');
  });

  test('a cooling gate is 503 backing_off with until_at (G9)', async () => {
    const { GET } = await import('../../../app/healthz/route.js');
    // until_at far in the future: the route's gate (system clock) stays
    // cooling — no lazy transition to probing on read.
    store.applyGateTransition(
      {
        state: 'cooling',
        rule: 'B2',
        tier: 2,
        reason: 'rate_limited on deals',
        since: '2026-09-19T07:30:00Z',
        until_at: '2027-01-01T00:00:00Z',
        min_resume_at: null,
        consecutive_b2: 2,
        failing_cycles: 0,
        b5_tier: 0,
        probe_used: 0,
      },
      [],
    );
    const res = await GET(
      new Request('https://app.example.com/healthz', { headers: { 'x-healthcheck-secret': 'healthcheck-secret-for-tests' } }),
    );
    assert.equal(res.status, 503, 'a cooling gate is 503');
    const body = await res.json();
    assert.equal(body.status, 'backing_off');
    assert.equal(body.gate.state, 'cooling');
    assert.equal(body.gate.rule, 'B2');
    assert.equal(body.gate.until_at, '2027-01-01T00:00:00Z');
    assert.equal(body.gate.min_resume_at, null);
  });
});

// X1 / 11.3.6: /failures/clear is a state-changing route in its own segment.
// It re-applies the access and CSRF gates itself, so a directly-driven request
// must be rejected without clearing anything, and only a request that passes
// both gates AND carries the `confirm: 'delete'` field deletes the stored
// failures.
describe('route: /failures/clear re-gates and clears the stored failures (11.3.6)', () => {
  let jwks;
  let store;
  let dir;
  before(async () => {
    jwks = await startJwksServer();
    process.env.CF_JWKS_URL = jwks.url;
    dir = mkdtempSync(join(tmpdir(), 'ozb-clear-failures-'));
    store = openStore({ path: join(dir, 'test.db'), clock: fixedClock('2026-09-19T07:30:00Z') });
    // Three stored failures to clear.
    for (let i = 1; i <= 3; i += 1) {
      store.insertFailure({
        failed_at: `2026-09-19T08:${String(i).padStart(2, '0')}:00Z`,
        response_class: `fail-${i}`,
        body: `failure body ${i}`,
      });
    }
    assert.equal(store.getFailures().length, 3, 'three failures are stored before any request');
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
    const { POST } = await import('../../../app/failures/clear/route.js');
    const res = await POST(new Request('https://app.example.com/failures/clear', { method: 'POST' }));
    assert.equal(res.status, 401, 'no token -> access check fails');
    assert.equal(store.getFailures().length, 3, 'the failures are not cleared on a failed gate');
  });

  test('a valid JWT but no CSRF token is rejected with 403 (independent checks)', async () => {
    const { POST } = await import('../../../app/failures/clear/route.js');
    const jwt = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: `https://${TEAM_DOMAIN}` });
    const res = await POST(
      new Request('https://app.example.com/failures/clear', {
        method: 'POST',
        headers: { 'Cf-Access-Jwt-Assertion': jwt },
      }),
    );
    assert.equal(res.status, 403, 'passes access, fails CSRF');
    assert.equal(store.getFailures().length, 3, 'the failures are not cleared on a failed gate');
  });

  test('a valid JWT + a valid CSRF token without the confirmation is rejected with 400 (X4)', async () => {
    const { POST } = await import('../../../app/failures/clear/route.js');
    const jwt = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: `https://${TEAM_DOMAIN}` });
    const csrf = await generateCsrfToken(CSRF_SECRET);
    const res = await POST(
      new Request('https://app.example.com/failures/clear', {
        method: 'POST',
        headers: { 'Cf-Access-Jwt-Assertion': jwt, 'x-csrf-token': csrf, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    assert.equal(res.status, 400, 'a clear without confirm is refused');
    assert.equal(store.getFailures().length, 3, 'the failures are not cleared without confirm');
  });

  test('a valid JWT + a valid CSRF token + the confirmation clears the failures', async () => {
    const { POST } = await import('../../../app/failures/clear/route.js');
    const jwt = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: `https://${TEAM_DOMAIN}` });
    const csrf = await generateCsrfToken(CSRF_SECRET);
    const res = await POST(
      new Request('https://app.example.com/failures/clear', {
        method: 'POST',
        headers: { 'Cf-Access-Jwt-Assertion': jwt, 'x-csrf-token': csrf, 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: 'delete' }),
      }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cleared, true);
    assert.equal(body.deleted, 3, 'all three stored failures are deleted');
    assert.equal(store.getFailures().length, 0, 'the failures are cleared');
  });
});
