/**
 * The `POST /classifieds-session/login` route, end to end (card AC 5, chunk 6).
 *
 * One real application process (the built standalone server) drives one real
 * Chromium against a loopback fixture that plays the OzBargain login page.
 * Every outcome the route can return is exercised against the shared database
 * the application reads and writes, and the credential sentinel — a username,
 * a password, and a session cookie that stand in for the user's real
 * secrets — is asserted absent from every surface it must not reach: the
 * response, the application's own output, and the database bytes. The
 * sentinel cookie is additionally asserted present, and only present, in the
 * `ok` outcome, where it is the stored session.
 *
 * The scenarios run in a fixed order against one application instance. The
 * fixture is a dedicated server per scenario, bound to the same loopback
 * port: the previous scenario's fixture is closed before the next is bound,
 * so the application's fixed `OZB_CLASSIFIEDS_URL` always points at the
 * scenario's fixture. The gate, the failures table, and the login-attempt and
 * session settings are reset between scenarios so each outcome is judged on
 * its own; the gate-event table is not clearable, so its assertions are the
 * delta across a scenario and the most recent event's fields.
 *
 * Time assertions compare against the real clock at assertion time with a
 * tolerance, not the test store's fixed clock: the application's throttle,
 * gate, and cookie-expiry math all run on `systemClock()` over the shared
 * database.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import '../support/browser.js'; // side effect: pins PLAYWRIGHT_BROWSERS_PATH
import { createFixtureServer } from '../../scripts/fixture-server.mjs';
import { startJwksServer } from '../support/jwks.js';
import { generateCsrfToken } from '../../lib/csrf.js';
import { openTempStore } from '../support/integration.js';
import { ensureBuild, freePort, startAppServer } from '../support/app-server.js';

const SENTINEL_USER = 'SENTINEL_USER_5d1c';
const SENTINEL_PASS = 'SENTINEL_PASS_8e2f';
const SENTINEL_COOKIE = 'SENTINEL_COOKIE_3a9b';
const TEAM_DOMAIN = 'login-e2e.cloudflareaccess.com';
const AUD = 'login-e2e-aud';
const EMAIL = 'james@example.com';
const HEALTHCHECK_SECRET = 'login-e2e-healthcheck-secret';
const CSRF_SECRET = 'login-e2e-csrf-secret';
// A private copy of the store's default gate row: it is not exported, and the
// reset writes it verbatim.
const OPEN_GATE_ROW = {
  id: 1,
  state: 'open',
  rule: null,
  tier: 0,
  reason: null,
  since: null,
  until_at: null,
  min_resume_at: null,
  consecutive_b2: 0,
  failing_cycles: 0,
  b5_tier: 0,
  probe_used: 0,
  probe_granted_at: null,
};
// The fixture's PHPSESSID Max-Age, 90 days, in ms.
const COOKIE_MAX_AGE_MS = 7_776_000 * 1000;
// The application and the test process are separate processes on the real
// clock; a generous tolerance absorbs their skew.
const TIME_TOLERANCE_MS = 60_000;

describe('integration: POST /classifieds-session/login (end to end)', () => {
  let fixturePort;
  let jwks;
  let temp;
  let app;
  let token;
  let csrf;

  before(async () => {
    fixturePort = await freePort();
    jwks = await startJwksServer({ kid: 'login-e2e' });
    temp = openTempStore('ozb-login-e2e-');

    const env = {
      OZB_DB_PATH: temp.dbPath,
      OZB_SNAPSHOT_PATH: join(temp.dir, 'snapshot.db'),
      OZB_HEALTHCHECK_SECRET: HEALTHCHECK_SECRET,
      OZB_CSRF_SECRET: CSRF_SECRET,
      CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      CF_ACCESS_AUD: AUD,
      CF_JWKS_URL: jwks.url,
      OZB_CLASSIFIEDS_URL: `http://127.0.0.1:${fixturePort}/classified`,
      OZB_PUBLIC_URL: 'http://127.0.0.1:1',
      OZB_POLL_INTERVAL_SECONDS: '300',
    };

    await ensureBuild();
    app = await startAppServer({ env });
    token = await jwks.sign({ email: EMAIL }, { aud: AUD, iss: `https://${TEAM_DOMAIN}`, exp: '2h' });
    csrf = await generateCsrfToken(CSRF_SECRET);
  });

  after(async () => {
    await app?.stop();
    temp?.close();
    await jwks.close();
  });

  /**
   * Reset the shared database to a clean slate for the next scenario: the
   * login-attempt record (the application's throttle and B6 math run on the
   * real clock, so a stale record would leak across scenarios), the session
   * settings, the failures table, and the gate row.
   */
  function resetState() {
    temp.store.deleteSetting('ozb_login_attempts');
    temp.store.deleteSetting('ozb_account_cookie');
    temp.store.deleteSetting('ozb_account_cookie_set_at');
    temp.store.deleteSetting('ozb_account_cookie_expires_at');
    temp.store.deleteSetting('classifieds_last_uid');
    temp.store.deleteSetting('classifieds_last_confirmed_at');
    temp.store.clearFailures();
    temp.store.mutateGate(() => ({ gate: { ...OPEN_GATE_ROW }, events: [] }));
  }

  /**
   * Run `fn` against a dedicated fixture for `scenario`, bound to the fixed
   * loopback port. The previous scenario's fixture is closed before this one
   * binds, so the application's fixed `OZB_CLASSIFIEDS_URL` always reaches
   * the current scenario's fixture.
   */
  async function withFixture(scenario, fn) {
    const login = { username: SENTINEL_USER, password: SENTINEL_PASS, scenario };
    if (scenario === 'ok') login.sessionCookieValue = SENTINEL_COOKIE;
    const server = createFixtureServer({ login, port: fixturePort });
    await server.start();
    try {
      return await fn(server);
    } finally {
      await server.close();
    }
  }

  /**
   * The login requests a fixture served, in order: method, path, status.
   * Timeline (non-login) entries carry no `scenario` field, so filtering on
   * it isolates the login flow.
   */
  function loginSequence(server) {
    return server.requests
      .filter((e) => e.scenario !== undefined)
      .map((e) => [e.method, e.url, e.status]);
  }

  /**
   * Drive the route the way the UI does: a urlencoded body with the CSRF
   * token in a `_csrf` field and the Access JWT in the assertion header.
   * Returns the status, the raw text, and the parsed JSON (null for the
   * plain-text 401/403/400 responses).
   */
  async function postLogin({
    username = SENTINEL_USER,
    password = SENTINEL_PASS,
    jwt = token,
    csrfToken = csrf,
  } = {}) {
    const body = new URLSearchParams();
    body.set('username', username);
    body.set('password', password);
    if (csrfToken) body.set('_csrf', csrfToken);
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    if (jwt) headers['Cf-Access-Jwt-Assertion'] = jwt;
    const res = await fetch(`${app.origin}/classifieds-session/login`, {
      method: 'POST',
      headers,
      body: body.toString(),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // a plain-text 401/403/400 response
    }
    return { status: res.status, text, json, headers: res.headers };
  }

  /** The bytes of a database file and its WAL and SHM sidecars, if present. */
  function dbFileBytes(path) {
    let bytes = '';
    for (const suffix of ['', '-wal', '-shm']) {
      const p = path + suffix;
      if (existsSync(p)) bytes += readFileSync(p, 'utf8');
    }
    return bytes;
  }

  /**
   * The database bytes: the main file, the WAL, and the SHM, for both the
   * main store and the snapshot store (a deleted setting's bytes may linger
   * in any of them).
   */
  function dbBytes() {
    return dbFileBytes(temp.dbPath) + dbFileBytes(join(temp.dir, 'snapshot.db'));
  }

  /** The gate-event count, for a delta assertion across a scenario. */
  function gateEventCount() {
    return temp.store.getGateEvents({ limit: 1000 }).length;
  }

  /** Assert two real-clock instants agree within the tolerance. */
  function assertNear(actualMs, expectedMs, what) {
    assert.ok(
      Math.abs(actualMs - expectedMs) <= TIME_TOLERANCE_MS,
      `${what}: expected ${new Date(expectedMs).toISOString()} ± ${TIME_TOLERANCE_MS}ms, got ${new Date(actualMs).toISOString()}`,
    );
  }

  /**
   * Assert the credential sentinel never reached a surface it must not. The
   * username and password are byte-checked in the response, the application
   * output, and the database in every scenario (the attempt record carries no
   * credentials, so the database check is safe everywhere); when `headers` is
   * given they are also byte-checked in the response headers. The cookie is
   * byte-checked in the response and the application output in every
   * scenario (and in the headers when given); in the database it is asserted
   * present and only present in the `ok` outcome, and only its logical
   * absence (the setting is null) in the others, since a deleted setting's
   * bytes may linger in the WAL or SHM sidecar of either the main store or
   * the snapshot store.
   */
  function assertHygiene(text, { expectCookieInDb = false, headers = null } = {}) {
    const sources = [
      ['the response', text],
      ['the application output', app.output()],
      ['the database', dbBytes()],
    ];
    for (const [name, content] of sources) {
      assert.ok(!content.includes(SENTINEL_USER), `the username sentinel leaked into ${name}`);
      assert.ok(!content.includes(SENTINEL_PASS), `the password sentinel leaked into ${name}`);
    }
    assert.ok(!text.includes(SENTINEL_COOKIE), 'the cookie sentinel leaked into the response');
    assert.ok(!app.output().includes(SENTINEL_COOKIE), 'the cookie sentinel leaked into the application output');
    if (headers) {
      const headerDump = [...headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
      assert.ok(!headerDump.includes(SENTINEL_USER), 'the username sentinel leaked into the response headers');
      assert.ok(!headerDump.includes(SENTINEL_PASS), 'the password sentinel leaked into the response headers');
      assert.ok(!headerDump.includes(SENTINEL_COOKIE), 'the cookie sentinel leaked into the response headers');
    }
    if (expectCookieInDb) {
      assert.equal(
        temp.store.getSetting('ozb_account_cookie'),
        `PHPSESSID=${SENTINEL_COOKIE}`,
        'the session cookie is stored under ozb_account_cookie (the full name=value header)',
      );
      assert.ok(dbBytes().includes(SENTINEL_COOKIE), 'the stored cookie is visible in the database');
    } else {
      assert.equal(
        temp.store.getSetting('ozb_account_cookie'),
        null,
        'no session cookie is stored',
      );
    }
  }

  it('rejects an unauthenticated request with 401 before the CSRF check', async () => {
    resetState();
    const gateEvents = gateEventCount();
    const res = await postLogin({ jwt: null });
    assert.equal(res.status, 401);
    // The middleware rejects before the route's CSRF check; the body is JSON.
    assert.deepEqual(res.json, { error: 'unauthorized' });
    assert.equal(temp.store.getGate().state, 'open');
    assert.equal(gateEventCount(), gateEvents, 'no gate event');
    assertHygiene(res.text);
  });

  it('rejects an authenticated request with no CSRF token with 403', async () => {
    resetState();
    const gateEvents = gateEventCount();
    const res = await postLogin({ csrfToken: null });
    assert.equal(res.status, 403);
    assert.equal(res.text, 'csrf');
    assert.equal(res.json, null);
    assert.equal(temp.store.getGate().state, 'open');
    assert.equal(gateEventCount(), gateEvents, 'no gate event');
    assertHygiene(res.text);
  });

  it('rejects invalid input with 400 before the browser is launched', async () => {
    resetState();
    const gateEvents = gateEventCount();
    const cases = [
      [{ username: '', password: 'x' }, 'Username and password are required.'],
      [{ username: 'x', password: '' }, 'Username and password are required.'],
      [{ username: 'a'.repeat(61), password: 'x' }, 'Username is too long.'],
      [{ username: 'user@example.com', password: 'x' }, 'Use your OzBargain username, not your email address.'],
      [{ username: `${SENTINEL_USER}@x`, password: 'x' }, 'Use your OzBargain username, not your email address.'],
      [{ username: 'x', password: 'p'.repeat(257) }, 'Password is too long.'],
    ];
    for (const [body, message] of cases) {
      const res = await postLogin({ ...body });
      assert.equal(res.status, 400, message);
      assert.equal(res.text, message);
      assertHygiene(res.text, { headers: res.headers });
    }
    assert.equal(temp.store.getGate().state, 'open');
    assert.equal(gateEventCount(), gateEvents, 'no gate event');
  });

  it('logs in end to end and stores the session (outcome ok)', async () => {
    resetState();
    const gateEvents = gateEventCount();
    const { res, server } = await withFixture('ok', async (server) => ({
      res: await postLogin(),
      server,
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ['expiresAt', 'outcome', 'uid']);
    assert.equal(res.json.outcome, 'ok');
    assert.equal(res.json.uid, 226301);
    assertNear(new Date(res.json.expiresAt).getTime(), Date.now() + COOKIE_MAX_AGE_MS, 'expiresAt');
    assert.deepEqual(
      loginSequence(server),
      [
        ['GET', '/user/login', 200],
        ['POST', '/user/login', 302],
        ['GET', '/user/login', 302],
        ['GET', '/user/226301', 200],
        ['GET', '/classified', 200],
      ],
      'the login flow walked the form, the submit, the profile, and the classifieds page',
    );
    assert.equal(temp.store.getGate().state, 'open');
    assert.equal(gateEventCount(), gateEvents, 'no gate event');
    assert.equal(temp.store.getFailures().length, 0, 'no failures row');
    assert.equal(temp.store.getSetting('ozb_account_cookie'), `PHPSESSID=${SENTINEL_COOKIE}`);
    assert.equal(temp.store.getSetting('classifieds_last_uid'), '226301');
    assert.ok(temp.store.getSetting('ozb_account_cookie_set_at'), 'the cookie-set timestamp is stored');
    assert.ok(temp.store.getSetting('classifieds_last_confirmed_at'), 'the confirmation timestamp is stored');
    const expiresAtSetting = temp.store.getSetting('ozb_account_cookie_expires_at');
    assert.ok(expiresAtSetting, 'the cookie expiry is stored');
    assertNear(
      new Date(expiresAtSetting).getTime(),
      Date.now() + COOKIE_MAX_AGE_MS,
      'ozb_account_cookie_expires_at',
    );
    assertHygiene(res.text, { expectCookieInDb: true });
  });

  it('reports a wrong password as bad_credentials without feeding the gate', async () => {
    resetState();
    const gateEvents = gateEventCount();
    const { res, server } = await withFixture('ok', async (server) => ({
      res: await postLogin({ password: 'SENTINEL_WRONG_PASS' }),
      server,
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { outcome: 'bad_credentials' });
    assert.deepEqual(
      loginSequence(server),
      [
        ['GET', '/user/login', 200],
        ['POST', '/user/login', 200],
      ],
      'the form loaded and the submit answered an in-page error',
    );
    assert.equal(temp.store.getGate().state, 'open');
    assert.equal(gateEventCount(), gateEvents, 'no gate event');
    assert.equal(temp.store.getFailures().length, 0, 'no failures row');
    assertHygiene(res.text);
  });

  it('reports a token-invalid submit as validation_error without feeding the gate', async () => {
    resetState();
    const gateEvents = gateEventCount();
    const { res, server } = await withFixture('validation_error', async (server) => ({
      res: await postLogin(),
      server,
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { outcome: 'validation_error' });
    assert.deepEqual(
      loginSequence(server),
      [
        ['GET', '/user/login', 200],
        ['POST', '/user/login', 200],
      ],
      'the form loaded and the submit answered an in-page error',
    );
    assert.equal(temp.store.getGate().state, 'open');
    assert.equal(gateEventCount(), gateEvents, 'no gate event');
    assertHygiene(res.text);
  });

  it('stops the gate on a challenge at the login page and sends the gate email', async () => {
    resetState();
    const gateEvents = gateEventCount();
    const { res, server } = await withFixture('challenge_login_page', async (server) => ({
      res: await postLogin(),
      server,
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { outcome: 'cloudflare_block' });
    assert.deepEqual(
      loginSequence(server),
      [['GET', '/user/login', 403]],
      'the login page itself was the challenge',
    );
    const gate = temp.store.getGate();
    assert.equal(gate.state, 'stopped');
    assert.equal(gate.rule, 'B1');
    assertNear(new Date(gate.min_resume_at).getTime(), Date.now() + 24 * 3600 * 1000, 'min_resume_at');
    assert.equal(gateEventCount(), gateEvents + 1, 'one gate event');
    const event = temp.store.getGateEvents({ limit: 1000 })[0];
    assert.equal(event.rule, 'B1');
    assert.equal(event.to_state, 'stopped');
    assert.equal(event.email_status, 'not_configured', 'the gate email ran with no provider configured');
    const failures = temp.store.getFailures();
    assert.equal(failures.length, 1, 'one failures row');
    assert.equal(failures[0].response_class, 'cloudflare_block');
    assert.match(failures[0].body, /login: Cloudflare challenge at login_form/);
    assertHygiene(res.text);
  });

  it('cools the gate on a rate limit at the login page and runs the gate-email sweep (tier 1 is policy-skipped)', async () => {
    resetState();
    const gateEvents = gateEventCount();
    const { res, server } = await withFixture('rate_limit_login_page', async (server) => ({
      res: await postLogin(),
      server,
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { outcome: 'rate_limited' });
    assert.deepEqual(
      loginSequence(server),
      [['GET', '/user/login', 429]],
      'the login page itself was the rate limit',
    );
    const gate = temp.store.getGate();
    assert.equal(gate.state, 'cooling');
    assert.equal(gate.rule, 'B2');
    assert.equal(gate.tier, 1);
    assertNear(new Date(gate.until_at).getTime(), Date.now() + 900 * 1000, 'until_at');
    assert.equal(gateEventCount(), gateEvents + 1, 'one gate event');
    const event = temp.store.getGateEvents({ limit: 1000 })[0];
    // A cool (B2) is transient and auto-resolving, so `shouldNotify` is false
    // and the email is skipped (unlike a B1 stop, which is always notified).
    assert.equal(event.email_status, 'skipped', 'a cool is not notifiable, so the email is skipped');
    assert.equal(temp.store.getFailures().length, 0, 'no failures row');
    assertHygiene(res.text);
  });

  it('refuses a login while the gate is stopped, with the resume time (gate_closed)', async () => {
    resetState();
    const gateEvents = gateEventCount();
    const minResumeAtIso = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    temp.store.mutateGate(() => ({
      gate: {
        ...OPEN_GATE_ROW,
        state: 'stopped',
        rule: 'B1',
        reason: 'cloudflare_block on login',
        since: new Date().toISOString(),
        min_resume_at: minResumeAtIso,
      },
      events: [],
    }));
    const res = await postLogin();
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), ['outcome', 'retryAt']);
    assert.equal(res.json.outcome, 'gate_closed');
    assert.equal(res.json.retryAt, minResumeAtIso, 'retryAt is the gate min_resume_at');
    assert.equal(gateEventCount(), gateEvents, 'no gate event (a row-only write)');
    assertHygiene(res.text);
  });

  it('reports a submit that never answers as a timeout', async () => {
    resetState();
    const gateEvents = gateEventCount();
    const { res, server } = await withFixture('hang_submit', async (server) => ({
      res: await postLogin(),
      server,
    }));
    assert.equal(res.status, 200);
    // Playwright's `waitForResponse` (30 s default) fires before the app's
    // 45 s hard timeout; that step timeout is reported as a timeout.
    assert.deepEqual(res.json, { outcome: 'timeout' });
    assert.deepEqual(
      loginSequence(server),
      [
        ['GET', '/user/login', 200],
        ['POST', '/user/login', 0],
      ],
      'the form loaded and the submit never answered',
    );
    assert.equal(temp.store.getGate().state, 'open');
    assert.equal(gateEventCount(), gateEvents, 'no gate event');
    assert.equal(temp.store.getFailures().length, 0, 'no failures row');
    assertHygiene(res.text);
  });

  it('reports a logged-in session that cannot see the classifieds page as not_entitled', async () => {
    resetState();
    const gateEvents = gateEventCount();
    const { res, server } = await withFixture('not_entitled', async (server) => ({
      res: await postLogin(),
      server,
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { outcome: 'not_entitled' });
    assert.deepEqual(
      loginSequence(server),
      [
        ['GET', '/user/login', 200],
        ['POST', '/user/login', 302],
        ['GET', '/user/login', 302],
        ['GET', '/user/226301', 200],
        ['GET', '/classified', 403],
      ],
      'the login succeeded but the classifieds page refused the session',
    );
    assert.equal(temp.store.getGate().state, 'open');
    assert.equal(gateEventCount(), gateEvents, 'no gate event');
    assertHygiene(res.text);
  });

  it('reports a 500 on the submit as transient', async () => {
    resetState();
    const gateEvents = gateEventCount();
    const { res, server } = await withFixture('server_error_submit', async (server) => ({
      res: await postLogin(),
      server,
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { outcome: 'transient' });
    assert.deepEqual(
      loginSequence(server),
      [
        ['GET', '/user/login', 200],
        ['POST', '/user/login', 500],
      ],
      'the form loaded and the submit answered a server error',
    );
    assert.equal(temp.store.getGate().state, 'open');
    assert.equal(gateEventCount(), gateEvents, 'no gate event');
    assertHygiene(res.text);
  });

  it('reports a successful login with no usable session cookie as login_failed', async () => {
    resetState();
    const gateEvents = gateEventCount();
    const { res, server } = await withFixture('no_session_cookie', async (server) => ({
      res: await postLogin(),
      server,
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { outcome: 'login_failed' });
    assert.deepEqual(
      loginSequence(server),
      [
        ['GET', '/user/login', 200],
        ['POST', '/user/login', 302],
        ['GET', '/user/login', 302],
        ['GET', '/user/226301', 200],
        ['GET', '/classified', 200],
      ],
      'the page loaded; the session-cookie selection is what failed',
    );
    assert.equal(temp.store.getGate().state, 'open');
    assert.equal(gateEventCount(), gateEvents, 'no gate event');
    assertHygiene(res.text);
  });
});
