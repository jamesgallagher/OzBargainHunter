import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from '../../../lib/store/index.js';
import { fixedClock } from '../../../lib/clock.js';
import { setStoreForTest } from '../../../lib/web/db.js';
import { setLoginDepsForTest, handleLoginRequest } from '../../../lib/web/classifieds-login.js';
import { generateCsrfToken } from '../../../lib/csrf.js';
import { startJwksServer } from '../../support/jwks.js';
import { POST as loginPost } from '../../../app/classifieds-session/login/route.js';

const AUD = 'test-audience';
const TEAM_DOMAIN = 'team.cloudflareaccess.org';
const CSRF_SECRET = 'csrf-secret-for-tests';
// A loopback classifieds URL: an allowed login origin (prompt 4.9).
const LOOPBACK_CLASSIFIEDS_URL = 'http://127.0.0.1:54321/classified';
const LIVE_CLASSIFIEDS_URL = 'https://www.ozbargain.com.au/classified';
const ATTEMPTS_KEY = 'ozb_login_attempts';

// The login route calls requireAuthenticated(request, undefined, body), so
// the gate reads process.env. Set the vars there.
process.env.CF_ACCESS_AUD = AUD;
process.env.CF_ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
process.env.OZB_CSRF_SECRET = CSRF_SECRET;
process.env.OZB_CLASSIFIEDS_URL = LOOPBACK_CLASSIFIEDS_URL;

/**
 * Drive the /classifieds-session/login route directly (bypassing the
 * middleware) against a temp store, with `setLoginDepsForTest` fakes so the
 * real login module (and Playwright) is never loaded.
 */
describe('route: /classifieds-session/login (faked performLogin)', () => {
  let jwks;
  let store;
  let dir;
  // The fakes.
  let performLoginCalls;
  let launchBrowserCalls;
  let sendGateEventsCalls;
  let performLoginResult;
  let performLoginError;
  let performLoginGate; // a promise gate to hold a login in flight (busy test)
  let originalDeps; // the shared fake, restored after a test swaps in its own

  before(async () => {
    jwks = await startJwksServer();
    process.env.CF_JWKS_URL = jwks.url;
    dir = mkdtempSync(join(tmpdir(), 'ozb-classifieds-login-'));
    store = openStore({ path: join(dir, 'test.db'), clock: fixedClock('2026-09-19T07:30:00Z') });
    setStoreForTest(store);
    performLoginCalls = [];
    launchBrowserCalls = [];
    sendGateEventsCalls = [];
    performLoginResult = null;
    performLoginError = null;
    performLoginGate = null;
    originalDeps = {
      performLogin: async (params) => {
        performLoginCalls.push(params);
        if (performLoginGate) await performLoginGate;
        if (performLoginError) throw performLoginError;
        return performLoginResult ?? { outcome: 'bad_credentials' };
      },
      launchBrowser: async () => {
        launchBrowserCalls.push(true);
        return { close: async () => {} };
      },
      sendGateEvents: async () => {
        sendGateEventsCalls.push(true);
      },
    };
    setLoginDepsForTest(originalDeps);
  });
  // The route's short-term throttle reads the attempt record at the real
  // clock, so a login that completes in one test (writing an attempt at
  // `now`) would 30-second-gap the next test: clear the record before
  // every test.
  beforeEach(() => {
    store.deleteSetting(ATTEMPTS_KEY);
  });

  after(async () => {
    setLoginDepsForTest(null);
    setStoreForTest(null);
    delete process.env.CF_JWKS_URL;
    delete process.env.OZB_CLASSIFIEDS_URL;
    delete process.env.OZB_DEV_MOCK_TRANSPORT;
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

  const URL = 'https://app.example.com/classifieds-session/login';

  test('an unauthenticated mutation is rejected with 401 (the route re-gates)', async () => {
    const res = await loginPost(
      new Request(URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'u', password: 'p' }).toString(),
      }),
    );
    assert.equal(res.status, 401);
    assert.equal(performLoginCalls.length, 0, 'a failed gate never reaches the login');
  });

  test('a valid JWT but no CSRF token is rejected with 403 (independent checks)', async () => {
    const res = await loginPost(await accessOnlyRequest(URL, { username: 'u', password: 'p' }));
    assert.equal(res.status, 403);
    assert.equal(performLoginCalls.length, 0, 'a failed gate never reaches the login');
  });

  test('each input-validation failure is a plain-text 400 and never echoes the input', async () => {
    const cases = [
      [{ username: '', password: 'p' }, 'Username and password are required.'],
      [{ username: 'u', password: '' }, 'Username and password are required.'],
      [{ username: 'x'.repeat(61), password: 'p' }, 'Username is too long.'],
      [{ username: 'user@example.com', password: 'p' }, 'Use your OzBargain username, not your email address.'],
      [{ username: 'u', password: 'x'.repeat(257) }, 'Password is too long.'],
    ];
    for (const [params, message] of cases) {
      const res = await loginPost(await authedFormRequest(URL, params));
      assert.equal(res.status, 400, `400 for ${message}`);
      const text = await res.text();
      assert.equal(text, message, `fixed message for ${message}`);
      for (const value of Object.values(params)) {
        if (value.length > 3) assert.ok(!text.includes(value), 'the submitted value is not echoed');
      }
    }
    assert.equal(performLoginCalls.length, 0, 'validation failures never reach the login');
  });

  test('a non-string field is refused with the fixed required message, not coerced', async () => {
    // The route's body comes from urlencoded parsing (always strings), so the
    // non-string case is exercised by calling `handleLoginRequest` directly:
    // input validation is step 1, so it returns `inputError` before the
    // origin check, the lock, or the gate.
    const cases = [
      { username: 42, password: 'p' },
      { username: 'u', password: null },
      { username: { toString() { return 'u'; } }, password: 'p' },
      { username: undefined, password: 'p' },
    ];
    for (const body of cases) {
      const result = await handleLoginRequest({ body, store, config: {}, env: {}, now: new Date() });
      assert.equal(result.inputError, 'Username and password are required.', `refused: ${JSON.stringify(body)}`);
      assert.ok(!('outcome' in result), 'an input refusal has no outcome');
    }
    assert.equal(performLoginCalls.length, 0, 'non-string fields never reach the login');
  });

  test('an unallowed classifieds URL is an unavailable 200 (origin_not_allowed)', async () => {
    process.env.OZB_CLASSIFIEDS_URL = 'https://evil.example.com/classified';
    const res = await loginPost(await authedFormRequest(URL, { username: 'u', password: 'p' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { outcome: 'unavailable', reason: 'origin_not_allowed' });
    assert.equal(performLoginCalls.length, 0, 'a refused origin never reaches the login');
    assert.equal(store.getSetting(ATTEMPTS_KEY), null, 'a refusal records no attempt');
    process.env.OZB_CLASSIFIEDS_URL = LOOPBACK_CLASSIFIEDS_URL;
  });

  test('the live origin in dev mode is an unavailable 200 (dev_mode_live_origin)', async () => {
    process.env.OZB_CLASSIFIEDS_URL = LIVE_CLASSIFIEDS_URL;
    process.env.OZB_DEV_MOCK_TRANSPORT = '1';
    process.env.NODE_ENV = 'development';
    const res = await loginPost(await authedFormRequest(URL, { username: 'u', password: 'p' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { outcome: 'unavailable', reason: 'dev_mode_live_origin' });
    assert.equal(performLoginCalls.length, 0, 'a refused origin never reaches the login');
    delete process.env.OZB_DEV_MOCK_TRANSPORT;
    delete process.env.NODE_ENV;
    process.env.OZB_CLASSIFIEDS_URL = LOOPBACK_CLASSIFIEDS_URL;
  });

  test('a login already in flight is refused with busy (the single-login lock)', async () => {
    let releaseGate;
    performLoginGate = new Promise((resolve) => { releaseGate = resolve; }); // holds the first login in flight
    performLoginResult = { outcome: 'ok', cookie: 'PHPSESSID=fake', uid: 226301, expiresAt: null };
    const first = loginPost(await authedFormRequest(URL, { username: 'u', password: 'p' }));
    // Wait until the first request is inside the fake performLogin.
    for (let i = 0; i < 100 && performLoginCalls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(performLoginCalls.length, 1, 'the first login is in flight');
    const res = await loginPost(await authedFormRequest(URL, { username: 'u', password: 'p' }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { outcome: 'busy' });
    assert.equal(performLoginCalls.length, 1, 'the second request never reaches the login');
    releaseGate(); // release the first login
    await first;
    // The first login completed: clear its shared state so later tests start
    // from a clean store (the fake's call count, the attempt record, and the
    // settings a successful login saves).
    performLoginCalls.length = 0;
    performLoginGate = null;
    store.deleteSetting(ATTEMPTS_KEY);
    store.deleteSetting('ozb_account_cookie');
    store.deleteSetting('ozb_account_cookie_set_at');
    store.deleteSetting('ozb_account_cookie_expires_at');
    store.deleteSetting('classifieds_last_uid');
    store.deleteSetting('classifieds_last_confirmed_at');
    store.setFeedState(LOOPBACK_CLASSIFIEDS_URL, null, null);
  });

  test('a stopped gate is refused with gate_closed and retryAt = min_resume_at', async () => {
    const minResumeAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    store.mutateGate((row) => ({ gate: { ...row, state: 'stopped', min_resume_at: minResumeAt }, events: [] }));
    const res = await loginPost(await authedFormRequest(URL, { username: 'u', password: 'p' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { outcome: 'gate_closed', retryAt: minResumeAt });
    assert.equal(performLoginCalls.length, 0, 'a closed gate never reaches the login');
    assert.equal(store.getSetting(ATTEMPTS_KEY), null, 'a refusal records no attempt');
    store.mutateGate((row) => ({ gate: { ...row, state: 'open', min_resume_at: null }, events: [] }));
  });

  test('a cooling gate is refused with gate_closed and retryAt = until_at', async () => {
    const untilAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    store.mutateGate((row) => ({ gate: { ...row, state: 'cooling', until_at: untilAt }, events: [] }));
    const res = await loginPost(await authedFormRequest(URL, { username: 'u', password: 'p' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { outcome: 'gate_closed', retryAt: untilAt });
    store.mutateGate((row) => ({ gate: { ...row, state: 'open', until_at: null }, events: [] }));
  });

  test('a B6-locked account is refused with locked and the lock end', async () => {
    // Two validation_error outcomes inside 24 hours: the B6 lock.
    const a = new Date(Date.now() - 1000).toISOString();
    const b = new Date(Date.now() - 2000).toISOString();
    store.setSetting(ATTEMPTS_KEY, JSON.stringify([{ at: a, outcome: 'validation_error' }, { at: b, outcome: 'validation_error' }]));
    const res = await loginPost(await authedFormRequest(URL, { username: 'u', password: 'p' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.outcome, 'locked');
    assert.equal(body.retryAt, new Date(Date.parse(a) + 24 * 60 * 60 * 1000).toISOString());
    assert.equal(performLoginCalls.length, 0, 'a locked account never reaches the login');
    store.deleteSetting(ATTEMPTS_KEY);
  });

  test('a throttled account is refused with throttled and the gap end', async () => {
    const at = new Date(Date.now() - 10 * 1000).toISOString();
    store.setSetting(ATTEMPTS_KEY, JSON.stringify([{ at, outcome: 'pending' }]));
    const res = await loginPost(await authedFormRequest(URL, { username: 'u', password: 'p' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.outcome, 'throttled');
    assert.equal(body.retryAt, new Date(Date.parse(at) + 30 * 1000).toISOString());
    assert.equal(performLoginCalls.length, 0, 'a throttled account never reaches the login');
    store.deleteSetting(ATTEMPTS_KEY);
  });

  test('an ok login saves exactly the step-10 settings and nothing else', async () => {
    performLoginResult = {
      outcome: 'ok',
      cookie: 'PHPSESSID=okcookie',
      uid: 226301,
      expiresAt: '2026-10-19T00:00:00.000Z',
    };
    store.setFeedState(LOOPBACK_CLASSIFIEDS_URL, '"old-etag"', 'old-modified');
    const before = store.getSettings();
    const res = await loginPost(await authedFormRequest(URL, { username: 'u', password: 'p' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['expiresAt', 'outcome', 'uid']);
    assert.equal(body.outcome, 'ok');
    assert.equal(body.uid, 226301);
    assert.equal(body.expiresAt, '2026-10-19T00:00:00.000Z');

    const after = store.getSettings();
    const changed = Object.keys(after).filter((k) => !(k in before) || before[k] !== after[k]);
    assert.deepEqual(
      changed.sort(),
      [
        'classifieds_last_confirmed_at',
        'classifieds_last_uid',
        'ozb_account_cookie',
        'ozb_account_cookie_expires_at',
        'ozb_account_cookie_set_at',
        ATTEMPTS_KEY,
      ],
      'only the step-10 settings (and the attempt record) change',
    );
    assert.equal(after.ozb_account_cookie, 'PHPSESSID=okcookie');
    assert.equal(after.classifieds_last_uid, '226301');
    assert.equal(after.ozb_account_cookie_expires_at, '2026-10-19T00:00:00.000Z');
    assert.ok(!Number.isNaN(Date.parse(after.ozb_account_cookie_set_at)), 'set_at is a timestamp');
    assert.ok(!Number.isNaN(Date.parse(after.classifieds_last_confirmed_at)), 'confirmed_at is a timestamp');
    const feedState = store.getFeedState(LOOPBACK_CLASSIFIEDS_URL);
    assert.equal(feedState.etag, null, 'the cached validator is re-armed');
    const attempts = JSON.parse(after[ATTEMPTS_KEY]);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].outcome, 'ok', 'the pending record is updated to the final outcome');
  });

  test('an ok login with no expiresAt deletes the expiry setting', async () => {
    performLoginResult = { outcome: 'ok', cookie: 'PHPSESSID=okcookie2', uid: 226301, expiresAt: null };
    store.setSetting('ozb_account_cookie_expires_at', '2026-10-19T00:00:00.000Z');
    const res = await loginPost(await authedFormRequest(URL, { username: 'u', password: 'p' }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.expiresAt, null);
    assert.equal(store.getSetting('ozb_account_cookie_expires_at'), null, 'the expiry is deleted');
  });

  test('a non-ok login writes only the attempt record', async () => {
    performLoginResult = { outcome: 'bad_credentials' };
    const before = store.getSettings();
    const res = await loginPost(await authedFormRequest(URL, { username: 'u', password: 'p' }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { outcome: 'bad_credentials' });
    const after = store.getSettings();
    const changed = Object.keys(after).filter((k) => !(k in before) || before[k] !== after[k]);
    assert.deepEqual(changed, [ATTEMPTS_KEY], 'only the attempt record changes');
    const attempts = JSON.parse(after[ATTEMPTS_KEY]);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].outcome, 'bad_credentials');
  });

  test('a pending record is written before the browser runs and updated after', async () => {
    let seenDuringLogin = null;
    performLoginResult = null;
    performLoginError = null;
    // A fake that inspects the attempt record while it is in flight; the
    // shared fake is restored when the test ends (even on assertion failure).
    setLoginDepsForTest({
      performLogin: async () => {
        seenDuringLogin = JSON.parse(store.getSetting(ATTEMPTS_KEY));
        return { outcome: 'validation_error' };
      },
      launchBrowser: async () => ({ close: async () => {} }),
      sendGateEvents: async () => {},
    });
    try {
      const res = await loginPost(await authedFormRequest(URL, { username: 'u', password: 'p' }));
      assert.equal(res.status, 200);
      assert.equal(seenDuringLogin.length, 1, 'the pending record exists while the browser runs');
      assert.equal(seenDuringLogin[0].outcome, 'pending');
      const after = JSON.parse(store.getSetting(ATTEMPTS_KEY));
      assert.equal(after[0].outcome, 'validation_error', 'the record is updated after the browser resolves');
    } finally {
      setLoginDepsForTest(originalDeps);
    }
  });

  test('cloudflare_block and rate_limited each send the gate email exactly once', async () => {
    for (const outcome of ['cloudflare_block', 'rate_limited']) {
      performLoginResult = { outcome };
      sendGateEventsCalls.length = 0;
      // The first iteration's attempt would 30-second-gap the second.
      store.deleteSetting(ATTEMPTS_KEY);
      const res = await loginPost(await authedFormRequest(URL, { username: 'u', password: 'p' }));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { outcome });
      assert.equal(sendGateEventsCalls.length, 1, `${outcome} sends the gate email once`);
    }
  });

  test('other outcomes never send the gate email', async () => {
    performLoginResult = { outcome: 'transient' };
    sendGateEventsCalls.length = 0;
    const res = await loginPost(await authedFormRequest(URL, { username: 'u', password: 'p' }));
    assert.equal(res.status, 200);
    assert.equal(sendGateEventsCalls.length, 0, 'transient sends no gate email');
  });

  test('a throwing login is a browser_error and the log carries err.name only', async () => {
    performLoginError = new Error('SECRET-LOGIN-DETAILS-MUST-NOT-LEAK');
    const lines = [];
    const original = console.log;
    console.log = (line) => lines.push(String(line));
    try {
      const res = await loginPost(await authedFormRequest(URL, { username: 'u', password: 'p' }));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { outcome: 'browser_error' });
    } finally {
      console.log = original;
    }
    assert.ok(lines.some((l) => l.includes('Error')), 'the log carries err.name');
    assert.ok(!lines.some((l) => l.includes('SECRET-LOGIN-DETAILS-MUST-NOT-LEAK')), 'the log never carries err.message');
    const attempts = JSON.parse(store.getSetting(ATTEMPTS_KEY));
    assert.equal(attempts[attempts.length - 1].outcome, 'browser_error', 'the attempt is recorded');
  });

  test('the performLogin call carries the fixed arguments (prompt 4.2 step 8)', async () => {
    performLoginResult = { outcome: 'login_failed' };
    performLoginCalls.length = 0;
    await loginPost(await authedFormRequest(URL, { username: 'u', password: 'p' }));
    assert.equal(performLoginCalls.length, 1);
    const params = performLoginCalls[0];
    assert.equal(params.baseUrl, 'http://127.0.0.1:54321');
    assert.equal(params.classifiedsUrl, LOOPBACK_CLASSIFIEDS_URL);
    assert.equal(params.username, 'u');
    assert.equal(params.password, 'p');
    assert.equal(typeof params.launchBrowser, 'function');
    assert.equal(typeof params.pause, 'function');
    assert.equal(typeof params.random.next, 'function');
    assert.equal(typeof params.log, 'function');
    assert.equal(params.platform, process.platform);
    assert.ok(params.gate, 'the gate is passed');
    assert.ok(params.store, 'the store is passed');
    assert.ok(params.clock, 'the clock is passed');
  });
});
