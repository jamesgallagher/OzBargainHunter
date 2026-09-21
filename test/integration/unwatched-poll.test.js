/**
 * The unwatched-poll assertion (card 5, design 2.2): polling is not
 * request-driven. This is the single most important assertion in the suite.
 *
 * It spawns **both** real processes — the Next.js server exactly as the image
 * runs it, and `worker/main.js` — against one temporary database and the
 * fixture server, with a one-second poll interval, and then makes **no HTTP
 * request to the application at all**. It waits on the *fixture* server's
 * request log and on the database file. When observations appear, they can only
 * have come from the worker's own schedule: nothing visited the UI.
 *
 * The mirror image is asserted too — the UI process is genuinely up (it reports
 * ready) while the poller ticks, so the test is not passing because the server
 * failed to start.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import { openTempStore, waitFor } from '../support/integration.js';
import { REPO_ROOT, startAppServer } from '../support/app-server.js';

describe('integration: polling happens with nobody watching', () => {
  let fx;
  let temp;
  let app;
  let worker;
  let workerLog = '';
  /** Every request this test made to the application. It must stay empty. */
  const applicationRequests = [];

  before(async () => {
    fx = await startFixtureServer();
    temp = openTempStore('ozb-unwatched-');

    const env = {
      NODE_ENV: 'test',
      OZB_DEALS_FEED_URL: `${fx.origin}/deals/feed`,
      OZB_FRONT_FEED_URL: `${fx.origin}/feed`,
      OZB_CLASSIFIEDS_URL: `${fx.origin}/classified`,
      OZB_DB_PATH: temp.dbPath,
      OZB_SNAPSHOT_PATH: join(temp.dir, 'snapshot.db'),
      OZB_USER_AGENT: 'ozbargain-hunter-integration-test',
      // The production minimum is five minutes (a deliberate floor). The
      // test-only override lets a test pin a short interval without lowering
      // that floor: it is honoured only when NODE_ENV is test.
      OZB_POLL_INTERVAL_SECONDS: '300',
      OZB_POLL_INTERVAL_SECONDS_TEST_OVERRIDE: '1',
      OZB_CLASSIFIEDS_INTERVAL_SECONDS: '3600',
      OZB_HEALTHCHECK_SECRET: 'unwatched-secret',
      OZB_CSRF_SECRET: 'unwatched-csrf-secret',
    };

    worker = spawn(process.execPath, [join(REPO_ROOT, 'worker/main.js')], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    worker.stdout.on('data', (d) => { workerLog += d; });
    worker.stderr.on('data', (d) => { workerLog += d; });

    // The UI process, started the same way the image starts it.
    app = await startAppServer({ env });
  });

  after(async () => {
    await app?.stop();
    if (worker && worker.exitCode === null) {
      const exited = new Promise((resolve) => worker.once('exit', resolve));
      worker.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (worker.exitCode === null) worker.kill('SIGKILL');
    }
    temp?.close();
    await fx.close();
  });

  it('gains observations after two poll intervals, with zero requests to the application', async () => {
    // Wait on the fixture server's own log: two full cycles is six requests
    // (three URLs per cycle, design 3.2). Nothing here touches the application.
    await waitFor(() => fx.requests.length >= 6, {
      timeoutMs: 120_000,
      intervalMs: 200,
      what: 'two deal-poll cycles to reach the fixture server',
    });

    assert.equal(
      applicationRequests.length,
      0,
      'the application was never asked to do anything — no request was made to it',
    );

    const observations = temp.store.countAllObservations();
    assert.ok(observations > 0, `observations were written by the worker alone (got ${observations})`);
    assert.ok(observations >= 60, 'two cycles have been served, so every poll-1 deal was observed');
    // Two full cycles have reached the fixture server, so the database holds
    // poll 1's 60 deals plus 975721, which only appears at poll 2.
    assert.ok(temp.store.countDeals() >= 60, `the corpus deals are stored (got ${temp.store.countDeals()})`);
    assert.ok(temp.store.getDeal(975704), '975704 is stored');

    const pollState = temp.store.getPollState();
    assert.ok(pollState?.last_success_at, 'the worker recorded a successful poll');

    // The UI process is up and served no request: a live UI and a live poller,
    // with the polling demonstrably independent of the UI.
    assert.equal(app.child.exitCode, null, 'the Next.js server is still running');
    assert.match(app.output(), /Ready in/, 'the Next.js server reported ready');
  });

  it('served the fixture server three URLs per cycle, in order, and never page 2', () => {
    const urls = fx.requests.map((r) => r.url);
    assert.ok(urls.length >= 6, 'at least two cycles were served');
    assert.ok(!urls.some((u) => u.includes('page=2')), 'the two-page cap holds');
    assert.match(urls[0], /\/deals\/feed\?page=0$/);
    assert.match(urls[1], /\/deals\/feed\?page=1$/);
    assert.match(urls[2], /\/feed$/);
  });

  it('the worker exited cleanly when it was asked to stop', async () => {
    // SIGTERM is the container's stop signal (10.6); the worker must close the
    // database and exit 0 rather than being killed.
    const exited = new Promise((resolve) => worker.once('exit', (code, signal) => resolve({ code, signal })));
    worker.kill('SIGTERM');
    const { code, signal } = await exited;
    assert.equal(signal, null, 'it exited on its own, not from the signal');
    assert.equal(code, 0, `clean exit (got ${code}); log:\n${workerLog}`);
    assert.match(workerLog, /stopped cleanly, database closed/);
  });
});

