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
import { POST as savePost } from '../../../app/delivery/save/route.js';
import { POST as deletePost } from '../../../app/delivery/delete/route.js';

const AUD = 'test-audience';
const TEAM_DOMAIN = 'team.cloudflareaccess.org';
const CSRF_SECRET = 'csrf-secret-for-tests';

// The delivery routes call requireAuthenticated(request, undefined, body), so
// the gate reads process.env. Set the vars there.
process.env.CF_ACCESS_AUD = AUD;
process.env.CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
process.env.OZB_CSRF_SECRET = CSRF_SECRET;

/**
 * Drive the delivery save and delete routes directly (bypassing the
 * middleware) against a temp store. The routes re-apply the access and CSRF
 * gates themselves, so an unauthenticated or un-CSRF'd mutation must be
 * rejected here. The save route assembles a provider's config from the
 * mechanism's field definitions; the delete route is confirm-gated.
 */
describe('route: /delivery/save and /delivery/delete re-gate and apply their changes (11.3.6)', () => {
  let jwks;
  let store;
  let dir;
  before(async () => {
    jwks = await startJwksServer();
    process.env.CF_JWKS_URL = jwks.url;
    dir = mkdtempSync(join(tmpdir(), 'ozb-delivery-route-'));
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

  // --- save: the gate ---

  test('save: an unauthenticated mutation is rejected with 401 (the route re-gates)', async () => {
    const res = await savePost(
      new Request('https://app.example.com/delivery/save', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ kind: 'brevo_smtp', login: 'a@example.com' }).toString(),
      }),
    );
    assert.equal(res.status, 401, 'no token -> access check fails');
    assert.equal(store.getProvider('brevo_smtp'), null, 'no provider is saved on a failed gate');
  });

  test('save: a valid JWT but no CSRF token is rejected with 403 (independent checks)', async () => {
    const res = await savePost(await accessOnlyRequest('https://app.example.com/delivery/save', { kind: 'brevo_smtp' }));
    assert.equal(res.status, 403, 'passes access, fails CSRF');
  });

  // --- save: config assembly from the mechanism's fields ---

  test('save: a valid JWT + CSRF assembles the brevo config from its fields and persists it', async () => {
    const res = await savePost(
      await authedFormRequest('https://app.example.com/delivery/save', {
        kind: 'brevo_smtp',
        login: 'alerts@example.com',
        apiKey: 'xkeys-secret',
        mailFrom: 'alerts@example.com',
        mailFromName: 'OzBargainHunter',
        recipient: 'you@example.com',
        selected: '1',
      }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.saved, true);
    assert.equal(body.kind, 'brevo_smtp');
    assert.equal(body.selected, true);
    const row = store.getProvider('brevo_smtp');
    assert.ok(row, 'the provider row is persisted');
    assert.deepEqual(JSON.parse(row.config), {
      login: 'alerts@example.com',
      apiKey: 'xkeys-secret',
      mailFrom: 'alerts@example.com',
      mailFromName: 'OzBargainHunter',
      recipient: 'you@example.com',
    });
    assert.equal(!!row.selected, true, 'selected is persisted');
  });

  test('save: a blank required field is rejected with 400 and nothing is written', async () => {
    // A prior test persisted a brevo_smtp row; clear it so the "nothing is
    // written" assertion is meaningful (the store is shared across tests).
    store.deleteProvider('brevo_smtp');
    const res = await savePost(
      await authedFormRequest('https://app.example.com/delivery/save', {
        kind: 'brevo_smtp',
        login: 'alerts@example.com',
        apiKey: '', // blank required field
        mailFrom: 'alerts@example.com',
        recipient: 'you@example.com',
      }),
    );
    assert.equal(res.status, 400, 'a blank required field is refused');
    assert.equal(store.getProvider('brevo_smtp'), null, 'nothing is written on a rejected save');
  });

  test('save: an unknown kind falls back to the raw config JSON', async () => {
    const res = await savePost(
      await authedFormRequest('https://app.example.com/delivery/save', {
        kind: 'custom',
        config: '{"a":1,"b":"two"}',
      }),
    );
    assert.equal(res.status, 200);
    const row = store.getProvider('custom');
    assert.ok(row, 'the unknown-kind provider is persisted');
    assert.deepEqual(JSON.parse(row.config), { a: 1, b: 'two' });
  });

  test('save: an unknown kind with a blank config persists an empty object', async () => {
    const res = await savePost(
      await authedFormRequest('https://app.example.com/delivery/save', { kind: 'custom' }),
    );
    assert.equal(res.status, 200);
    const row = store.getProvider('custom');
    assert.deepEqual(JSON.parse(row.config), {});
  });

  test('save: an unknown kind with invalid JSON config is rejected with 400', async () => {
    const res = await savePost(
      await authedFormRequest('https://app.example.com/delivery/save', {
        kind: 'custom',
        config: '{not json',
      }),
    );
    assert.equal(res.status, 400, 'invalid JSON config is refused');
  });

  test('save: a missing kind is rejected with 400', async () => {
    const res = await savePost(await authedFormRequest('https://app.example.com/delivery/save', {}));
    assert.equal(res.status, 400, 'no kind -> 400');
  });

  // --- delete: the gate and the confirm ---

  test('delete: an unauthenticated mutation is rejected with 401 (the route re-gates)', async () => {
    store.upsertProvider('ntfy', JSON.stringify({ url: 'http://127.0.0.1:8080', topic: 'alerts' }), true);
    const res = await deletePost(
      new Request('https://app.example.com/delivery/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ confirm: 'delete', kind: 'ntfy' }).toString(),
      }),
    );
    assert.equal(res.status, 401, 'no token -> access check fails');
    assert.ok(store.getProvider('ntfy'), 'the provider is not deleted on a failed gate');
  });

  test('delete: a valid JWT but no CSRF token is rejected with 403 (independent checks)', async () => {
    store.upsertProvider('ntfy', JSON.stringify({ url: 'http://127.0.0.1:8080', topic: 'alerts' }), true);
    const res = await deletePost(await accessOnlyRequest('https://app.example.com/delivery/delete', { confirm: 'delete', kind: 'ntfy' }));
    assert.equal(res.status, 403, 'passes access, fails CSRF');
    assert.ok(store.getProvider('ntfy'), 'the provider is not deleted on a failed gate');
  });

  test('delete: a request without the confirm field is rejected with 400', async () => {
    store.upsertProvider('ntfy', JSON.stringify({ url: 'http://127.0.0.1:8080', topic: 'alerts' }), true);
    const res = await deletePost(await authedFormRequest('https://app.example.com/delivery/delete', { kind: 'ntfy' }));
    assert.equal(res.status, 400, 'a delete without confirm is refused');
    assert.ok(store.getProvider('ntfy'), 'the provider is not deleted without confirm');
  });

  test('delete: an unknown kind is rejected with 404', async () => {
    const res = await deletePost(
      await authedFormRequest('https://app.example.com/delivery/delete', { confirm: 'delete', kind: 'does-not-exist' }),
    );
    assert.equal(res.status, 404, 'unknown kind -> 404');
  });

  test('delete: a valid JWT + CSRF + confirm removes the provider', async () => {
    store.upsertProvider('ntfy', JSON.stringify({ url: 'http://127.0.0.1:8080', topic: 'alerts' }), true);
    assert.ok(store.getProvider('ntfy'), 'the provider is present before the delete');
    const res = await deletePost(
      await authedFormRequest('https://app.example.com/delivery/delete', { confirm: 'delete', kind: 'ntfy' }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.deleted, true);
    assert.equal(body.kind, 'ntfy');
    assert.equal(store.getProvider('ntfy'), null, 'the provider is deleted');
  });
});
