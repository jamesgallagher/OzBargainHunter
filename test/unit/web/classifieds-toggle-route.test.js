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
import { POST as togglePost } from '../../../app/classifieds-session/toggle/route.js';

const AUD = 'test-audience';
const TEAM_DOMAIN = 'team.cloudflareaccess.org';
const CSRF_SECRET = 'csrf-secret-for-tests';
const CLASSIFIEDS_URL = 'https://www.ozbargain.com.au/classified';

// The toggle route calls requireAuthenticated(request, undefined, body), so
// the gate reads process.env. Set the vars there.
process.env.CF_ACCESS_AUD = AUD;
process.env.CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
process.env.OZB_CSRF_SECRET = CSRF_SECRET;

/**
 * Drive the /classifieds-session/toggle route directly (bypassing the
 * middleware) against a temp store. The route re-applies the access and CSRF
 * gates itself, so an unauthenticated or un-CSRF'd mutation must be rejected
 * here. When enabled it writes `classifieds_enabled='1'` and re-arms the
 * session (clears the stale expiry latch and cached validators); when
 * disabled it writes '0' and clears nothing.
 */
describe('route: /classifieds-session/toggle re-gates and applies its change', () => {
  let jwks;
  let store;
  let dir;
  before(async () => {
    jwks = await startJwksServer();
    process.env.CF_JWKS_URL = jwks.url;
    dir = mkdtempSync(join(tmpdir(), 'ozb-classifieds-toggle-'));
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

  test('an unauthenticated mutation is rejected with 401 (the route re-gates)', async () => {
    const res = await togglePost(
      new Request('https://app.example.com/classifieds-session/toggle', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ enabled: '1' }).toString(),
      }),
    );
    assert.equal(res.status, 401, 'no token -> access check fails');
    assert.equal(store.getSetting('classifieds_enabled'), null, 'no setting is written on a failed gate');
  });

  test('a valid JWT but no CSRF token is rejected with 403 (independent checks)', async () => {
    const res = await togglePost(await accessOnlyRequest('https://app.example.com/classifieds-session/toggle', { enabled: '1' }));
    assert.equal(res.status, 403, 'passes access, fails CSRF');
    assert.equal(store.getSetting('classifieds_enabled'), null, 'no setting is written on a failed gate');
  });

  test('a valid JWT + CSRF enabling re-arms the session and persists the setting', async () => {
    // Seed a stale expiry latch and a cached validator so the re-arm is
    // observable (the store is shared across tests).
    store.setSetting('classifieds_last_uid', '226301');
    store.setFeedState(CLASSIFIEDS_URL, '"some-etag"', 'some-modified');

    const res = await togglePost(await authedFormRequest('https://app.example.com/classifieds-session/toggle', { enabled: '1' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enabled, true);
    assert.equal(store.getSetting('classifieds_enabled'), '1', 'the setting is persisted on');
    assert.equal(store.getSetting('classifieds_last_uid'), null, 'the stale expiry latch is cleared');
    const feedState = store.getFeedState(CLASSIFIEDS_URL);
    assert.equal(feedState.etag, null, 'the cached validator is re-armed (etag cleared)');
  });

  test('a valid JWT + CSRF unchecking writes the setting off and clears nothing', async () => {
    // Seed a stale latch and a cached validator that must survive a turn-off
    // (turning off does not re-arm; a disabled poll makes zero requests).
    store.setSetting('classifieds_last_uid', '226301');
    store.setFeedState(CLASSIFIEDS_URL, '"some-etag"', 'some-modified');

    const res = await togglePost(await authedFormRequest('https://app.example.com/classifieds-session/toggle', {}));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enabled, false);
    assert.equal(store.getSetting('classifieds_enabled'), '0', 'the setting is persisted off');
    assert.equal(store.getSetting('classifieds_last_uid'), '226301', 'turning off does not clear the latch');
    const feedState = store.getFeedState(CLASSIFIEDS_URL);
    assert.equal(feedState.etag, '"some-etag"', 'turning off does not re-arm the validator');
  });
});
