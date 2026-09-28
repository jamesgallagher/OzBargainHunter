/**
 * The `performLogin` matrix (prompt section 5). Every row runs the *real*
 * module against a *real* headless Chromium (Playwright) pointed at the
 * fixture server on loopback, with a *real* gate on a *real* temporary store.
 * The waits come from an injected instant `pause`, the jitter from
 * `seededRandom(1)`, every timestamp from a `fixedClock` pinned at the real
 * "now" (so the fixture's 90-day `PHPSESSID` is never seen as expired by
 * `selectSessionCookies`), and the log is captured. Nothing here ever points
 * at a non-loopback host: the browser's allowlist aborts every non-base-host
 * request, and the `no-network` guard (armed by the test command) blocks any
 * non-loopback egress from the Node process itself.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import '../support/browser.js'; // side-effect: pins PLAYWRIGHT_BROWSERS_PATH
import { createFixtureServer } from '../../scripts/fixture-server.mjs';
import { createGate } from '../../lib/gate/index.js';
import { fixedClock } from '../../lib/clock.js';
import { seededRandom } from '../../lib/random.js';
import { openTempStore } from '../support/integration.js';
import { performLogin } from '../../lib/ozb-login/index.js';
import { LAUNCH_ARGS } from '../../lib/ozb-login/identity.js';

const SENTINEL_USER = 'SENTINEL_USER_5d1c';
const SENTINEL_PASS = 'SENTINEL_PASS_8e2f';
const SENTINEL_COOKIE = 'SENTINEL_COOKIE_3a9b';

/** The two error-path stimuli the hygiene and shape tests share. */
const forcedPause = async () => {
  throw new Error('forced');
};
const rejectingLaunch = async () => {
  throw new Error('launch failed');
};

/**
 * Run one `performLogin` scenario end to end and return the context a test
 * asserts on. A dedicated fixture server is started per scenario (so the
 * recorded request sequence is exactly this scenario's), the gate is real on a
 * real temporary store, and the browser is launched through a wrapper that
 * records the options `performLogin` passed and the browser it got, so a test
 * can assert the launch options and that the browser was closed.
 *
 * @param {string} scenario the fixture server's login scenario
 * @param {object} [opts]
 * @param {string} [opts.password] the credential the client submits (default `SENTINEL_PASS`)
 * @param {number} [opts.timeoutMs] the hard timeout (default 45000)
 * @param {(ms: number) => Promise<void>} [opts.pause] the injected pause (default instant)
 * @param {(options: object) => Promise<object>} [opts.launchBrowser] a custom launcher
 * @param {boolean} [opts.preStopGate] stop the gate (B1) before the call
 * @param {(ctx: object) => Promise<void>} [opts.inspect] run before cleanup (the db is still readable)
 * @returns {Promise<object>} the context; on success the store stays open and
 *   `ctx.close()` must be called by the test (via `t.after`) to remove the
 *   temp directory. On any failure the server and store are already closed.
 */
async function runScenario(scenario, opts = {}) {
  const login = { username: SENTINEL_USER, password: SENTINEL_PASS, scenario };
  if (scenario === 'ok') login.sessionCookieValue = SENTINEL_COOKIE;
  const server = createFixtureServer({ login });
  await server.start();
  const temp = openTempStore();
  const clock = fixedClock(new Date().toISOString());
  const logLines = [];
  const logLine = (line) => logLines.push(line);
  const gate = createGate({ store: temp.store, clock, config: {}, log: logLine });
  if (opts.preStopGate) gate.recordResponse({ class: 'cloudflare_block', surface: 'deals' });
  const calls = [];
  const browsers = [];
  const defaultLaunch = async (options) => {
    calls.push(options);
    const { chromium } = await import('playwright');
    const browser = await chromium.launch(options);
    browsers.push(browser);
    return browser;
  };
  const startedAt = Date.now();
  let ctx;
  let failed = false;
  try {
    const result = await performLogin({
      launchBrowser: opts.launchBrowser ?? defaultLaunch,
      baseUrl: server.origin,
      classifiedsUrl: `${server.origin}/classified`,
      username: SENTINEL_USER,
      password: opts.password ?? SENTINEL_PASS,
      gate,
      store: temp.store,
      clock,
      pause: opts.pause ?? (async () => {}),
      random: seededRandom(1),
      log: opts.log ?? logLine,
      platform: process.platform,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    ctx = {
      result,
      gate,
      store: temp.store,
      dbPath: temp.dbPath,
      logLines,
      server,
      clock,
      elapsedMs: Date.now() - startedAt,
      calls,
      browsers,
    };
    if (opts.inspect) await opts.inspect(ctx);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    await server.close();
    if (failed) temp.close();
  }
  // On success the store stays open for the test body's assertions; the test
  // closes it (via `t.after`) so the temp directory is removed.
  ctx.close = () => temp.close();
  return ctx;
}

/** The login request sequence the fixture server recorded, in order. */
function loginSequence(server) {
  return server.requests
    .filter((e) => e.scenario !== undefined)
    .map((e) => [e.method, e.url, e.status]);
}

/** The database bytes (the main file plus the WAL, if present). */
function dbBytes(dbPath) {
  let bytes = readFileSync(dbPath, 'utf8');
  const wal = `${dbPath}-wal`;
  if (existsSync(wal)) bytes += readFileSync(wal, 'utf8');
  return bytes;
}

/** Assert the shared `cloudflare_block` outcome: the gate row, one event, one failures row. */
function assertChallenge(ctx, stepName) {
  assert.equal(ctx.result.outcome, 'cloudflare_block');
  const row = ctx.gate.read();
  assert.equal(row.state, 'stopped');
  assert.equal(row.rule, 'B1');
  assert.equal(row.reason, 'cloudflare_block on login');
  assert.ok(
    Math.abs(Date.parse(row.min_resume_at) - (ctx.clock.now().getTime() + 24 * 3600 * 1000)) < 60000,
    `min_resume_at ~ now + 24h (got ${row.min_resume_at})`,
  );
  const events = ctx.gate.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].rule, 'B1');
  assert.equal(events[0].to_state, 'stopped');
  const failures = ctx.store.getFailures();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].response_class, 'cloudflare_block');
  assert.equal(failures[0].body, `login: Cloudflare challenge at ${stepName}`);
}

describe('integration: performLogin (prompt section 5)', () => {
  it('ok: the full flow returns the session cookie and the exact request sequence', async (t) => {
    const ctx = await runScenario('ok');
    t.after(() => ctx.close());
    assert.equal(ctx.result.outcome, 'ok');
    assert.equal(ctx.result.uid, 226301);
    assert.match(ctx.result.cookie, /PHPSESSID=SENTINEL_COOKIE_3a9b/);
    assert.ok(!ctx.result.cookie.includes('ozbuserhash'));
    assert.ok(!ctx.result.cookie.includes('_ga'));
    assert.ok(!ctx.result.cookie.includes('__cf_bm'));
    assert.ok(ctx.result.expiresAt, 'expiresAt is present for ok');
    assert.ok(
      Math.abs(Date.parse(ctx.result.expiresAt) - (ctx.clock.now().getTime() + 7776000 * 1000)) < 60000,
      `expiresAt ~ now + 90 days (got ${ctx.result.expiresAt})`,
    );
    assert.deepStrictEqual(loginSequence(ctx.server), [
      ['GET', '/user/login', 200],
      ['POST', '/user/login', 302],
      ['GET', '/user/login', 302],
      ['GET', '/user/226301', 200],
      ['GET', '/classified', 200],
    ]);
    assert.ok(!loginSequence(ctx.server).some((r) => r[1] === '/search/node'), 'no /search/node request');
    assert.ok(!ctx.server.requests.some((e) => e.reason === 'decoy-submit'), 'no decoy submit');
    const classifiedEntry = ctx.server.requests.find((e) => e.scenario !== undefined && e.url === '/classified');
    assert.equal(classifiedEntry.hadSession, true, 'the /classified request carried the session cookie');
    assert.equal(ctx.gate.read().state, 'open');
    assert.equal(ctx.store.getGateEvents().length, 0);
    assert.equal(ctx.calls.length, 1);
    assert.deepStrictEqual(ctx.calls[0], { headless: true, args: LAUNCH_ARGS });
    assert.equal(ctx.browsers[0].isConnected(), false);
    const finalLine = ctx.logLines.find((l) => l.startsWith('login: outcome=ok'));
    assert.ok(finalLine, 'the final ok log line is present');
    const match = finalLine.match(/^login: outcome=ok blockedRequests=(\d+)$/);
    assert.ok(match, `final log line format: ${finalLine}`);
    assert.ok(Number(match[1]) >= 1, `blockedRequests >= 1 (got ${match[1]})`);
  });

  it('bad_credentials: a wrong password is a bad_credentials with no /classified request', async (t) => {
    const ctx = await runScenario('ok', { password: 'SENTINEL_WRONG_PASS' });
    t.after(() => ctx.close());
    assert.equal(ctx.result.outcome, 'bad_credentials');
    assert.ok(!loginSequence(ctx.server).some((r) => r[1] === '/classified'), 'no /classified request');
    assert.equal(ctx.gate.read().state, 'open');
    assert.equal(ctx.store.getGateEvents().length, 0);
  });

  it('validation_error: a broken form token is a validation_error', async (t) => {
    const ctx = await runScenario('validation_error');
    t.after(() => ctx.close());
    assert.equal(ctx.result.outcome, 'validation_error');
    assert.equal(ctx.gate.read().state, 'open');
    assert.equal(ctx.store.getGateEvents().length, 0);
  });

  it('not_entitled: a 403 on /classified is a not_entitled that does not touch the gate', async (t) => {
    const ctx = await runScenario('not_entitled');
    t.after(() => ctx.close());
    assert.equal(ctx.result.outcome, 'not_entitled');
    const classified = loginSequence(ctx.server).find((r) => r[1] === '/classified');
    assert.ok(classified, 'the /classified request was made');
    assert.equal(classified[2], 403);
    assert.equal(ctx.gate.read().state, 'open');
    assert.equal(ctx.store.getGateEvents().length, 0);
  });

  it('challenge_login_page: a challenge on the form stops the gate and records one failure', async (t) => {
    const ctx = await runScenario('challenge_login_page');
    t.after(() => ctx.close());
    assertChallenge(ctx, 'login_form');
    assert.deepStrictEqual(loginSequence(ctx.server), [['GET', '/user/login', 403]]);
  });

  it('challenge_submit: a challenge on the submit stops the gate, with no request after it', async (t) => {
    const ctx = await runScenario('challenge_submit');
    t.after(() => ctx.close());
    assertChallenge(ctx, 'login_submit');
    assert.deepStrictEqual(loginSequence(ctx.server), [
      ['GET', '/user/login', 200],
      ['POST', '/user/login', 403],
    ]);
  });

  it('challenge_classified: a challenge on /classified stops the gate', async (t) => {
    const ctx = await runScenario('challenge_classified');
    t.after(() => ctx.close());
    assertChallenge(ctx, 'classified');
    assert.deepStrictEqual(loginSequence(ctx.server), [
      ['GET', '/user/login', 200],
      ['POST', '/user/login', 302],
      ['GET', '/user/login', 302],
      ['GET', '/user/226301', 200],
      ['GET', '/classified', 403],
    ]);
  });

  it('rate_limit_login_page: a 429 on the form cools the gate (B2) with no failures row', async (t) => {
    const ctx = await runScenario('rate_limit_login_page');
    t.after(() => ctx.close());
    assert.equal(ctx.result.outcome, 'rate_limited');
    const row = ctx.gate.read();
    assert.equal(row.state, 'cooling');
    assert.equal(row.rule, 'B2');
    assert.equal(row.tier, 1);
    assert.ok(
      Math.abs(Date.parse(row.until_at) - (ctx.clock.now().getTime() + 900 * 1000)) < 60000,
      `until_at ~ now + 900s (got ${row.until_at})`,
    );
    assert.equal(ctx.store.getFailures().length, 0);
  });

  it('server_error_submit: a 500 on the submit is a transient that leaves the gate unchanged', async (t) => {
    const ctx = await runScenario('server_error_submit');
    t.after(() => ctx.close());
    assert.equal(ctx.result.outcome, 'transient');
    assert.equal(ctx.gate.read().state, 'open');
    assert.equal(ctx.store.getGateEvents().length, 0);
  });

  it('hang_submit: a hung submit ends on the hard timeout, with the browser closed', async (t) => {
    const ctx = await runScenario('hang_submit', { timeoutMs: 3000 });
    t.after(() => ctx.close());
    assert.equal(ctx.result.outcome, 'timeout');
    assert.ok(ctx.elapsedMs < 15000, `resolved within the hard timeout (got ${ctx.elapsedMs}ms)`);
    const seq = loginSequence(ctx.server);
    assert.equal(seq[seq.length - 1][2], 0, 'the last fixture entry is the hung POST (status 0)');
    assert.equal(ctx.browsers[0].isConnected(), false);
  });

  it('a timeout during launch: the late browser is closed and no request is made', async (t) => {
    const lateBrowsers = [];
    const ctx = await runScenario('ok', {
      timeoutMs: 500,
      launchBrowser: async (options) => {
        // The launch outlives the hard timeout: it returns a browser the
        // timer's exit could not close (it ran while the launch was pending).
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const { chromium } = await import('playwright');
        const browser = await chromium.launch(options);
        lateBrowsers.push(browser);
        return browser;
      },
    });
    t.after(() => ctx.close());
    assert.equal(ctx.result.outcome, 'timeout');
    assert.ok(ctx.elapsedMs < 2000, `resolved at the hard timeout (got ${ctx.elapsedMs}ms)`);
    // The launch returns ~1500ms after the call resolved; the guard after it
    // closes the browser. Poll for that (no fixed sleep).
    const deadline = Date.now() + 10000;
    while (lateBrowsers.length === 0 || lateBrowsers[0].isConnected()) {
      assert.ok(Date.now() < deadline, 'the late browser was closed');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ctx.browsers.length, 0, 'the default launcher was never used');
    assert.equal(loginSequence(ctx.server).length, 0, 'no request reached the fixture');
  });

  it('no_session_cookie: a cleared PHPSESSID is a login_failed (the page still loads)', async (t) => {
    const ctx = await runScenario('no_session_cookie');
    t.after(() => ctx.close());
    assert.equal(ctx.result.outcome, 'login_failed');
    assert.deepStrictEqual(loginSequence(ctx.server), [
      ['GET', '/user/login', 200],
      ['POST', '/user/login', 302],
      ['GET', '/user/login', 302],
      ['GET', '/user/226301', 200],
      ['GET', '/classified', 200],
    ]);
    assert.equal(ctx.gate.read().state, 'open');
  });

  it('gate closed before the call: a gate_closed with the browser never launched', async (t) => {
    const ctx = await runScenario('ok', { preStopGate: true });
    t.after(() => ctx.close());
    assert.equal(ctx.result.outcome, 'gate_closed');
    assert.equal(ctx.calls.length, 0, 'launchBrowser was never called');
    assert.equal(ctx.browsers.length, 0);
    assert.equal(ctx.gate.read().state, 'stopped');
  });

  it('launchBrowser rejects: a browser_error, with nothing thrown out', async (t) => {
    const ctx = await runScenario('ok', {
      launchBrowser: async () => {
        throw new Error('launch failed');
      },
    });
    t.after(() => ctx.close());
    assert.equal(ctx.result.outcome, 'browser_error');
    assert.ok(ctx.logLines.some((l) => l.includes('browser_error')), 'the log names the browser_error');
  });

  it('a forced exception is a browser_error, with the browser closed', async (t) => {
    const ctx = await runScenario('ok', {
      pause: async () => {
        throw new Error('forced');
      },
    });
    t.after(() => ctx.close());
    assert.equal(ctx.result.outcome, 'browser_error');
    assert.equal(ctx.browsers[0].isConnected(), false);
  });

  it('a waitForResponse TimeoutError is a timeout, not a browser_error', async (t) => {
    const ctx = await runScenario('ok', {
      launchBrowser: async () => {
        // A fake page that gets through the form and fills the fields, then
        // lets the submit's `waitForResponse` time out on its own (Playwright's
        // default 30 s timeout) — before the hard timeout — with a
        // `TimeoutError`.
        const fakeResponse = {
          status: () => 200,
          headers: () => ({}),
          text: async () => '',
        };
        let evaluateCalls = 0;
        const page = {
          goto: async () => fakeResponse,
          // Call 1 is the challenge-title check (classifyStep); call 2 is the
          // form-present check.
          evaluate: async () => {
            evaluateCalls += 1;
            return evaluateCalls === 2;
          },
          locator: () => ({
            fill: async () => {},
            first: () => ({ click: async () => {} }),
            click: async () => {},
          }),
          waitForResponse: async () => {
            const err = new Error('Timeout 30000ms exceeded.');
            err.name = 'TimeoutError';
            throw err;
          },
          waitForLoadState: async () => {},
        };
        const context = {
          route: async () => {},
          newPage: async () => page,
        };
        return {
          version: () => '123.0.0.0',
          newContext: async () => context,
          close: async () => {},
          isConnected: () => false,
        };
      },
    });
    t.after(() => ctx.close());
    assert.equal(ctx.result.outcome, 'timeout');
    assert.ok(
      ctx.logLines.some((l) => l.includes('timeout (TimeoutError)')),
      'the log names the timeout and the error name',
    );
  });

  it('a throwing log sink still produces a resolved outcome, with the browser closed', async (t) => {
    const ctx = await runScenario('ok', {
      log: () => {
        throw new Error('log sink broken');
      },
    });
    t.after(() => ctx.close());
    assert.equal(ctx.result.outcome, 'ok');
    assert.equal(ctx.browsers[0].isConnected(), false);
  });

  it('the browser is always closed: the headless process count is unchanged (linux only)', {
    skip: process.platform !== 'linux',
  }, async (t) => {
    // Count only processes descending from this test process, so an unrelated
    // chrome on the host (a developer's browser) cannot skew the comparison.
    const isDescendant = (pid) => {
      let current = pid;
      for (let hops = 0; hops < 64; hops += 1) {
        let stat;
        try {
          stat = readFileSync(join('/proc', String(current), 'stat'), 'utf8');
        } catch {
          return false;
        }
        // The comm field (index 1) may contain spaces and parentheses, so
        // parse from after the last ')': fields[0] is state, fields[1] is ppid.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        current = Number(fields[1]);
        if (current === process.pid) return true;
        if (current <= 1) return false;
      }
      return false;
    };
    const countChrome = () => {
      let count = 0;
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        let cmdline = '';
        try {
          cmdline = readFileSync(join('/proc', entry, 'cmdline'), 'utf8');
        } catch {
          continue;
        }
        if (/headless_shell|chrome/.test(cmdline) && isDescendant(Number(entry))) count += 1;
      }
      return count;
    };
    const before = countChrome();
    const ctx = await runScenario('ok');
    t.after(() => ctx.close());
    const after = countChrome();
    assert.equal(after, before, `the headless process count is unchanged (${before} -> ${after})`);
  });

  it('secret hygiene: no credential or cookie sentinel leaks into the result, log, or database', async (t) => {
    const scenarios = [
      ['ok'],
      ['ok', { password: 'SENTINEL_WRONG_PASS' }],
      ['validation_error'],
      ['challenge_login_page'],
      ['challenge_submit'],
      ['challenge_classified'],
      ['rate_limit_login_page'],
      ['server_error_submit'],
      ['not_entitled'],
      ['no_session_cookie'],
      ['hang_submit', { timeoutMs: 3000 }],
      ['ok', { pause: forcedPause }],
      ['ok', { launchBrowser: rejectingLaunch }],
      ['ok', { preStopGate: true }],
    ];
    let okResult;
    for (const [scenario, opts = {}] of scenarios) {
      const ctx = await runScenario(scenario, {
        ...opts,
        inspect: async (c) => {
          const bytes = dbBytes(c.dbPath);
          const resultStr = JSON.stringify(c.result);
          const logStr = c.logLines.join('\n');
          for (const secret of [SENTINEL_USER, SENTINEL_PASS]) {
            assert.ok(!resultStr.includes(secret), `credential in result (${scenario})`);
            assert.ok(!logStr.includes(secret), `credential in log (${scenario})`);
            assert.ok(!bytes.includes(secret), `credential in database (${scenario})`);
          }
          assert.ok(!logStr.includes(SENTINEL_COOKIE), `cookie sentinel in log (${scenario})`);
          assert.ok(!bytes.includes(SENTINEL_COOKIE), `cookie sentinel in database (${scenario})`);
          if (scenario === 'ok' && Object.keys(opts).length === 0) {
            assert.ok(resultStr.includes(SENTINEL_COOKIE), 'the ok result carries the cookie sentinel');
            okResult = c.result;
          } else {
            assert.ok(!resultStr.includes(SENTINEL_COOKIE), `cookie sentinel in result (${scenario})`);
          }
        },
      });
      t.after(() => ctx.close());
    }
    assert.ok(okResult, 'the ok scenario ran');
    assert.match(okResult.cookie, new RegExp(SENTINEL_COOKIE));
  });

  it('the returned shape is exactly the documented keys per outcome', async (t) => {
    const cases = [
      [['ok'], ['outcome', 'cookie', 'uid', 'expiresAt']],
      [['ok', { password: 'SENTINEL_WRONG_PASS' }], ['outcome']],
      [['validation_error'], ['outcome']],
      [['challenge_login_page'], ['outcome']],
      [['rate_limit_login_page'], ['outcome']],
      [['server_error_submit'], ['outcome']],
      [['not_entitled'], ['outcome']],
      [['no_session_cookie'], ['outcome']],
      [['ok', { preStopGate: true }], ['outcome']],
      [['hang_submit', { timeoutMs: 3000 }], ['outcome']],
      [['ok', { pause: forcedPause }], ['outcome']],
      [['ok', { launchBrowser: rejectingLaunch }], ['outcome']],
    ];
    for (const [[scenario, opts], expectedKeys] of cases) {
      const ctx = await runScenario(scenario, opts ?? {});
      t.after(() => ctx.close());
      assert.deepStrictEqual(
        Object.keys(ctx.result).sort(),
        [...expectedKeys].sort(),
        `the ${scenario} result shape`,
      );
    }
  });
});
