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
import { POST as freebiePost } from '../../../app/thresholds/freebie/route.js';
import { POST as freebieDealsPost } from '../../../app/thresholds/freebie-deals/route.js';

const AUD = 'test-audience';
const TEAM_DOMAIN = 'team.cloudflareaccess.org';
const CSRF_SECRET = 'csrf-secret-for-tests';

// The routes call requireAuthenticated(request, undefined, body), so the gate
// reads process.env. Set the vars there.
process.env.CF_ACCESS_AUD = AUD;
process.env.CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
process.env.OZB_CSRF_SECRET = CSRF_SECRET;

/**
 * Drive the /thresholds/freebie (classifieds) and /thresholds/freebie-deals
 * (deals) routes directly (bypassing the middleware) against a temp store.
 * Each route re-applies the access and CSRF gates itself, so an unauthenticated
 * or un-CSRF'd mutation must be rejected. Each route writes only its own
 * setting key: /thresholds/freebie writes `always_notify_freebie`, and
 * /thresholds/freebie-deals writes `always_notify_deal_freebie`.
 */
describe('route: /thresholds/freebie and /thresholds/freebie-deals re-gate and write only their own key', () => {
  let jwks;
  let store;
  let dir;
  before(async () => {
    jwks = await startJwksServer();
    process.env.CF_JWKS_URL = jwks.url;
    dir = mkdtempSync(join(tmpdir(), 'ozb-freebie-route-'));
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

  test('an unauthenticated mutation is rejected with 401 (both routes re-gate)', async () => {
    const res = await freebiePost(
      new Request('https://app.example.com/thresholds/freebie', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ freebie: '1' }).toString(),
      }),
    );
    assert.equal(res.status, 401, 'no token -> access check fails');
    assert.equal(store.getSetting('always_notify_freebie'), null, 'no setting is written on a failed gate');

    const res2 = await freebieDealsPost(
      new Request('https://app.example.com/thresholds/freebie-deals', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ freebie_deals: '1' }).toString(),
      }),
    );
    assert.equal(res2.status, 401, 'no token -> access check fails');
    assert.equal(store.getSetting('always_notify_deal_freebie'), null, 'no setting is written on a failed gate');
  });

  test('a valid JWT but no CSRF token is rejected with 403 (both routes, independent checks)', async () => {
    const res = await freebiePost(await accessOnlyRequest('https://app.example.com/thresholds/freebie', { freebie: '1' }));
    assert.equal(res.status, 403, 'passes access, fails CSRF');
    assert.equal(store.getSetting('always_notify_freebie'), null, 'no setting is written on a failed gate');

    const res2 = await freebieDealsPost(await accessOnlyRequest('https://app.example.com/thresholds/freebie-deals', { freebie_deals: '1' }));
    assert.equal(res2.status, 403, 'passes access, fails CSRF');
    assert.equal(store.getSetting('always_notify_deal_freebie'), null, 'no setting is written on a failed gate');
  });

  test('a valid JWT + CSRF on /thresholds/freebie writes only always_notify_freebie', async () => {
    store.deleteSetting('always_notify_freebie');
    store.deleteSetting('always_notify_deal_freebie');
    const res = await freebiePost(await authedFormRequest('https://app.example.com/thresholds/freebie', { freebie: '1' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.freebie, true);
    assert.equal(store.getSetting('always_notify_freebie'), '1', 'the classifieds freebie setting is persisted on');
    assert.equal(store.getSetting('always_notify_deal_freebie'), null, 'the deals freebie setting is untouched');
  });

  test('a valid JWT + CSRF on /thresholds/freebie-deals writes only always_notify_deal_freebie', async () => {
    store.deleteSetting('always_notify_freebie');
    store.deleteSetting('always_notify_deal_freebie');
    const res = await freebieDealsPost(await authedFormRequest('https://app.example.com/thresholds/freebie-deals', { freebie_deals: '1' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.freebie_deals, true);
    assert.equal(store.getSetting('always_notify_deal_freebie'), '1', 'the deals freebie setting is persisted on');
    assert.equal(store.getSetting('always_notify_freebie'), null, 'the classifieds freebie setting is untouched');
  });

  test('a valid JWT + CSRF unchecking writes the setting off', async () => {
    store.deleteSetting('always_notify_freebie');
    store.deleteSetting('always_notify_deal_freebie');
    const res = await freebiePost(await authedFormRequest('https://app.example.com/thresholds/freebie', {}));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.freebie, false);
    assert.equal(store.getSetting('always_notify_freebie'), '0', 'the classifieds freebie setting is persisted off');

    const res2 = await freebieDealsPost(await authedFormRequest('https://app.example.com/thresholds/freebie-deals', {}));
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.freebie_deals, false);
    assert.equal(store.getSetting('always_notify_deal_freebie'), '0', 'the deals freebie setting is persisted off');
  });
});
