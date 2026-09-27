import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from '../../../lib/store/index.js';
import { fixedClock } from '../../../lib/clock.js';
import { setStoreForTest } from '../../../lib/web/db.js';
import { generateCsrfToken } from '../../../lib/csrf.js';
import { startJwksServer } from '../../support/jwks.js';
import { POST as resumePost } from '../../../app/gate/resume/route.js';

const AUD = 'test-audience';
const TEAM_DOMAIN = 'team.cloudflareaccess.org';
const CSRF_SECRET = 'csrf-secret-for-tests';
const RESUME_URL = 'https://app.example.com/gate/resume';

// The resume route calls requireAuthenticated(request, undefined, body), so
// the gate reads process.env. Set the vars there.
process.env.CF_ACCESS_AUD = AUD;
process.env.CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
process.env.OZB_CSRF_SECRET = CSRF_SECRET;

/**
 * Drive the /gate/resume route directly (bypassing the middleware) against a
 * temp store. The route re-applies the access and CSRF gates itself, so an
 * unauthenticated or un-CSRF'd mutation must be rejected here. A successful
 * resume moves the gate from `stopped` to `probing` (one test request at the
 * next poll); it is refused before the earliest-resume instant.
 *
 * The route uses `systemClock()`, so the seeded `min_resume_at` instants are
 * real-time relative (past = allowed, future = too early).
 */
describe('route: /gate/resume re-gates and resumes the access gate', () => {
  let jwks;
  let store;
  let dir;
  before(async () => {
    jwks = await startJwksServer();
    process.env.CF_JWKS_URL = jwks.url;
    dir = mkdtempSync(join(tmpdir(), 'ozb-gate-resume-'));
    store = openStore({ path: join(dir, 'test.db'), clock: fixedClock('2026-09-19T07:30:00Z') });
    setStoreForTest(store);
  });
  after(async () => {
    setStoreForTest(null);
    delete process.env.CF_JWKS_URL;
    store.close();
    rmSync(dir, { recursive: true, force: true });
    await jwks.close();
  });

  async function authedFormRequest(url, params) {
    const jwt = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: `https://${TEAM_DOMAIN}` });
    const csrf = await generateCsrfToken(CSRF_SECRET);
    const body = new URLSearchParams({ _csrf: csrf, ...params });
    return new Request(url, {
      method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': jwt, 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  }

  // A valid JWT but no CSRF token (no header, no body field): passes access,
  // fails CSRF.
  async function accessOnlyRequest(url, params) {
    const jwt = await jwks.sign({ email: 'user@example.com' }, { aud: AUD, iss: `https://${TEAM_DOMAIN}` });
    const body = new URLSearchParams(params);
    return new Request(url, {
      method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': jwt, 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  }

  function seedGate(rowOverrides) {
    store.mutateGate((row) => ({ gate: { ...row, ...rowOverrides }, events: [] }));
  }

  test('an unauthenticated mutation is rejected with 401 (the route re-gates)', async () => {
    const res = await resumePost(
      new Request(RESUME_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ confirm: 'resume' }).toString(),
      }),
    );
    assert.equal(res.status, 401, 'no token -> access check fails');
    assert.equal(store.getGate().state, 'open', 'the gate row is untouched on a failed gate');
  });

  test('a valid JWT but no CSRF token is rejected with 403 (independent checks)', async () => {
    const res = await resumePost(await accessOnlyRequest(RESUME_URL, { confirm: 'resume' }));
    assert.equal(res.status, 403, 'passes access, fails CSRF');
    assert.equal(store.getGate().state, 'open', 'the gate row is untouched on a failed gate');
  });

  test('a valid JWT + CSRF without the confirm field is rejected with 400', async () => {
    const res = await resumePost(await authedFormRequest(RESUME_URL, {}));
    assert.equal(res.status, 400, 'the resume confirmation is required');
    assert.equal(await res.text(), 'resume confirmation required');
  });

  test('resuming a gate that is not stopped is refused with 409', async () => {
    // The migration-seeded row is `open`.
    const res = await resumePost(await authedFormRequest(RESUME_URL, { confirm: 'resume' }));
    assert.equal(res.status, 409);
    assert.equal(await res.text(), 'Access is not stopped.');
    assert.equal(store.getGate().state, 'open', 'the gate row is untouched');
  });

  test('resuming before the earliest-resume instant is refused with 409 (too early)', async () => {
    seedGate({
      state: 'stopped',
      rule: 'B1',
      reason: 'Cloudflare block',
      min_resume_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
    const res = await resumePost(await authedFormRequest(RESUME_URL, { confirm: 'resume' }));
    assert.equal(res.status, 409);
    assert.match(await res.text(), /Manual resume is not allowed before/);
    assert.equal(store.getGate().state, 'stopped', 'the gate row is untouched');
  });

  test('resuming a stopped gate past its earliest instant moves it to probing', async () => {
    seedGate({
      state: 'stopped',
      rule: 'B1',
      reason: 'Cloudflare block',
      min_resume_at: new Date(Date.now() - 3600 * 1000).toISOString(),
    });

    const res = await resumePost(await authedFormRequest(RESUME_URL, { confirm: 'resume' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { resumed: true, state: 'probing' });

    const gate = store.getGate();
    assert.equal(gate.state, 'probing');
    assert.equal(gate.rule, 'B5');
    assert.equal(gate.reason, 'manual resume');
    assert.equal(gate.tier, 0);
    assert.equal(gate.b5_tier, 0);

    const [lastEvent] = store.getGateEvents();
    assert.equal(lastEvent.from_state, 'stopped');
    assert.equal(lastEvent.to_state, 'probing');
    assert.equal(lastEvent.reason, 'manual resume');
  });
});
