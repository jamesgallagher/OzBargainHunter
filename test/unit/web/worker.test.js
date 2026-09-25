import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { startWorker, installShutdown } from '../../../worker/main.js';
import { openStore } from '../../../lib/store/index.js';
import { createFixtureTransport } from '../../support/fixtureTransport.js';
import { fixedClock } from '../../../lib/clock.js';
import { seededRandom } from '../../../lib/random.js';
import { makeProvider } from '../../../lib/notify/provider.js';

// The four fixture routes the deal poll asks for, plus the classifieds page.
const ROUTES = {
  'https://www.ozbargain.com.au/deals/feed?page=0': { status: 200, fixture: 'http/r0.xml' },
  'https://www.ozbargain.com.au/deals/feed?page=1': { status: 200, fixture: 'http/r1.xml' },
  'https://www.ozbargain.com.au/feed': { status: 200, fixture: 'http/feed_feed.xml' },
  'https://www.ozbargain.com.au/classified': { status: 200, fixture: 'http/classifieds-page.html' },
};

function insertRule(store, { id, type, parameters, state = 'enabled', surfaces = 'deals', cooldownSeconds = 86400, pinnedSlug = null }) {
  const now = '2026-09-19T06:20:00Z';
  store.insertRule({
    id,
    type,
    parameters: JSON.stringify(parameters),
    state,
    surfaces,
    cooldown_seconds: cooldownSeconds,
    pinned_slug: pinnedSlug,
    created_at: now,
    modified_at: now,
  });
}

/**
 * Start a worker against a temp store, a fixture transport, a fixed clock and
 * a single fake provider that records what it is sent. The real schedulers are
 * stopped immediately so the test drives the exposed task functions directly
 * (the schedulers use real timers; the wheel itself is covered in
 * scheduler.test.js).
 */
async function makeWorker({ clockIso = '2026-09-19T07:30:00Z', rules = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-worker-'));
  const clock = fixedClock(clockIso);
  const store = openStore({ path: join(dir, 'test.db'), clock });
  for (const r of rules) insertRule(store, r);

  const transport = createFixtureTransport(ROUTES);
  const sent = [];
  const fakeProvider = makeProvider('test', (n) => {
    sent.push(n);
  });
  // Register the provider in the store so fanout finds it selected and
  // enabled (fanout re-checks the store row for every send).
  store.upsertProvider('test', JSON.stringify({}), true);

  const worker = await startWorker({
    store,
    transport,
    clock,
    random: seededRandom(1),
    config: {
      OZB_POLL_INTERVAL_SECONDS: 1,
      OZB_CLASSIFIEDS_INTERVAL_SECONDS: 1,
      OZB_SNAPSHOT_PATH: join(dir, 'snapshot.json'),
      OZB_USER_AGENT: 'test',
    },
    providers: [fakeProvider],
    log: () => {},
  });

  // Cancel the real schedulers so the test drives the tasks directly.
  await worker.stop();

  return {
    worker,
    store,
    transport,
    sent,
    clock,
    snapshotPath: join(dir, 'snapshot.json'),
    close: async () => {
      // A test may already have closed the store (the shutdown test does).
      if (store.getDb().isOpen) store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Drive the persisted gate to a given state by writing the full row and one
 * event through the store. The worker's gate re-reads the store on every
 * `read()` (design 3.7: the gate is the single persisted source of truth),
 * so a direct write is immediately visible to the worker without touching
 * the worker's own gate object.
 */
function setGateState(store, state, extra = {}) {
  const row = {
    state,
    rule: null,
    tier: 0,
    reason: null,
    since: '2026-09-19T07:30:00Z',
    until_at: null,
    min_resume_at: null,
    consecutive_b2: 0,
    failing_cycles: 0,
    b5_tier: 0,
    probe_used: 0,
    ...extra,
  };
  store.applyGateTransition(row, [
    {
      at: row.since,
      from_state: 'open',
      to_state: state,
      rule: row.rule,
      tier: row.tier,
      reason: row.reason,
      until_at: row.until_at,
      min_resume_at: row.min_resume_at,
    },
  ]);
}

/**
 * G1: build a worker on a temp store with a caller-supplied routes object.
 * Returns the handles (including the dir and db path) so the caller can
 * close the store, reopen a second store on the same file, and clean up.
 * The real schedulers are stopped immediately, as in makeWorker. When
 * `dir`/`dbPath` are supplied they are reused (the restart case); otherwise
 * a fresh temp dir is created.
 */
async function makeGateWorker({ clockIso = '2026-09-19T07:30:00Z', routes, rules = [], dir, dbPath } = {}) {
  const realDir = dir ?? mkdtempSync(join(tmpdir(), 'ozb-worker-gate-'));
  const realDbPath = dbPath ?? join(realDir, 'test.db');
  const clock = fixedClock(clockIso);
  const store = openStore({ path: realDbPath, clock });
  for (const r of rules) insertRule(store, r);

  const transport = createFixtureTransport(routes);
  const sent = [];
  const fakeProvider = makeProvider('test', (n) => {
    sent.push(n);
  });
  store.upsertProvider('test', JSON.stringify({}), true);

  const worker = await startWorker({
    store,
    transport,
    clock,
    random: seededRandom(1),
    config: {
      OZB_POLL_INTERVAL_SECONDS: 1,
      OZB_CLASSIFIEDS_INTERVAL_SECONDS: 1,
      OZB_SNAPSHOT_PATH: join(realDir, 'snapshot.json'),
      OZB_USER_AGENT: 'test',
    },
    providers: [fakeProvider],
    log: () => {},
  });

  await worker.stop();
  return { dir: realDir, dbPath: realDbPath, clock, store, transport, sent, worker };
}

describe('worker: composition root', () => {
  test('cold start seeds the ledger silently and sends zero notifications', async () => {
    const { worker, store, sent, close } = await makeWorker({
      rules: [{ id: 1, type: 'match', parameters: { term: 'weber' }, surfaces: 'deals' }],
    });
    try {
      // The first deal poll is a cold start (empty database): it seeds the
      // ledger for the matching deal and sends nothing.
      await worker.tasks.dealPoll();
      const ledgerRows = store.getLedgerForRule(1);
      assert.ok(ledgerRows.length >= 1, 'cold start seeded the ledger for the matching deal');
      assert.equal(sent.length, 0, 'cold start sent zero notifications');
    } finally {
      await close();
    }
  });

  test('a matching deal on a non-cold-start poll fans out through the provider', async () => {
    const { worker, store, sent, close } = await makeWorker({
      rules: [{ id: 1, type: 'match', parameters: { term: 'weber' }, surfaces: 'deals' }],
    });
    try {
      // Pre-seed the store with a deal and one observation so the first
      // poll is not a cold start (wasEmpty is false). The matching deal
      // then alerts and fans out through the provider on the first poll.
      store.upsertDeal({
        node_id: 1,
        title: 'Seed deal',
        url: 'https://www.ozbargain.com.au/node/1',
        author: 'seed',
        posted_at: '2026-09-19T07:00:00Z',
        categories: [],
      });
      store.insertObservation({
        deal_id: 1,
        votes_pos: 0,
        votes_neg: 0,
        comment_count: 0,
        click_count: 0,
        observed_at: '2026-09-19T07:20:00Z',
      });
      await worker.tasks.dealPoll();
      assert.ok(sent.length >= 1, 'the matching deal fanned out through the provider');
      assert.ok(sent.some((n) => n.title?.toLowerCase().includes('weber')), 'the notification names the matched term');
    } finally {
      await close();
    }
  });

  test('the dead-man switch fires when there is no successful poll', async () => {
    const { worker, store, sent, close } = await makeWorker({});
    try {
      // No successful poll has ever happened, so the dead-man's first
      // notification is due immediately on the first check.
      await worker.tasks.deadmanCheck();
      const deadmanSent = sent.filter((n) => n.tags?.includes('deadman'));
      assert.ok(deadmanSent.length >= 1, 'the dead-man switch sent a notification');
      const state = JSON.parse(store.getSetting('deadman_state'));
      assert.ok(state.lastNotificationAt, 'the dead-man state recorded the notification');
      assert.equal(state.step, '2h', 'the schedule advanced to the next step');
    } finally {
      await close();
    }
  });

  test('the nightly job prunes and snapshots when the hour matches', async () => {
    const { worker, snapshotPath, close } = await makeWorker({ clockIso: '2026-09-19T03:00:00Z' });
    try {
      // The clock is at 03:00 UTC, so the nightly job runs.
      await worker.tasks.nightly();
      assert.ok(existsSync(snapshotPath), 'the snapshot file was written');
    } finally {
      await close();
    }
  });

  test('the nightly job is a no-op when the hour does not match', async () => {
    const { worker, snapshotPath, close } = await makeWorker({ clockIso: '2026-09-19T12:00:00Z' });
    try {
      await worker.tasks.nightly();
      assert.ok(!existsSync(snapshotPath), 'no snapshot when the hour does not match');
    } finally {
      await close();
    }
  });

  test('stop() resolves and the store can be closed', async () => {
    const { worker, store, close } = await makeWorker({});
    try {
      await worker.stop();
      // The store is still open and can be closed cleanly.
      store.close();
    } finally {
      await close().catch(() => {});
    }
  });

  // The global enable/disable gate: turning classifieds off must make ZERO
  // classifieds requests (even with a cookie stored) while leaving the deals
  // poll — and the shared one-request-at-a-time safeguard — untouched.
  test('turning classifieds off makes zero classifieds requests but does not affect deals polling', async () => {
    const { worker, store, transport, close } = await makeWorker({});
    try {
      store.setSetting('classifieds_enabled', '0');
      store.setSetting('ozb_account_cookie', 'test-session=authenticated');
      await worker.tasks.classifiedsPoll();
      assert.equal(
        transport.requestLog.filter((r) => r.url === 'https://www.ozbargain.com.au/classified').length,
        0,
        'disabled classifieds makes zero classifieds requests',
      );
      await worker.tasks.dealPoll();
      assert.ok(
        transport.requestLog.filter((r) => r.url.includes('/deals/feed')).length > 0,
        'deals polling still makes requests when classifieds is disabled',
      );
    } finally {
      await close();
    }
  });

  // G1: the back-off survives a restart. A Cloudflare block on the front
  // feed stops the gate (B1); closing the store and reopening a second
  // store/worker on the same database file must find the persisted stopped
  // state, and every OzBargain request (deals tick, classifieds tick) is
  // refused before it reaches the transport.
  test('a back-off survives a restart: a stopped gate makes zero requests in a fresh process', async () => {
    const routes = {
      'https://www.ozbargain.com.au/deals/feed?page=0': { status: 200, fixture: 'http/r0.xml' },
      'https://www.ozbargain.com.au/deals/feed?page=1': { status: 200, fixture: 'http/r1.xml' },
      'https://www.ozbargain.com.au/feed': { status: 403, body: 'error code: 1010' },
      'https://www.ozbargain.com.au/classified': { status: 200, fixture: 'http/classifieds-page.html' },
    };
    const first = await makeGateWorker({ routes });
    let second;
    try {
      await first.worker.tasks.dealPoll();
      assert.equal(first.store.getGate().state, 'stopped', 'the front-feed Cloudflare block stopped the gate (B1)');
      first.store.close();
      second = await makeGateWorker({ routes, dir: first.dir, dbPath: first.dbPath });
      assert.equal(second.store.getGate().state, 'stopped', 'the restarted store reads the persisted stopped state');
      second.store.setSetting('classifieds_enabled', '1');
      second.store.setSetting('ozb_account_cookie', 'test-session=authenticated');
      await second.worker.tasks.dealPoll();
      await second.worker.tasks.classifiedsPoll();
      assert.equal(second.transport.calls, 0, 'the restarted worker made zero transport calls while the gate is stopped');
    } finally {
      try { first.store.close(); } catch {}
      if (second) { try { second.store.close(); } catch {} }
      rmSync(first.dir, { recursive: true, force: true });
    }
  });

  // F1: a stuck probe is a liveness bug. The probe is granted (probe_used =
  // 1, probe_granted_at stamped) but never answered — the process died
  // mid-probe. The 10-minute liveness window must expire the probe: on the
  // next read the gate re-cools (the B5 tier climbs), and once that cool-off
  // runs out the poll resumes and a 200 probe reopens the gate. Without the
  // window the gate would sit in `probing` forever with the probe consumed,
  // and no request would ever go out again.
  test('a stuck probe expires after 10 minutes, re-cools, and the poll resumes (F1 liveness)', async () => {
    const routes = {
      'https://www.ozbargain.com.au/deals/feed?page=0': { status: 200, fixture: 'http/r0.xml' },
      'https://www.ozbargain.com.au/deals/feed?page=1': { status: 200, fixture: 'http/r1.xml' },
      'https://www.ozbargain.com.au/feed': { status: 200, fixture: 'http/feed_feed.xml' },
      'https://www.ozbargain.com.au/classified': { status: 200, fixture: 'http/classifieds-page.html' },
    };
    const first = await makeGateWorker({ routes });
    let second;
    try {
      // Cool the gate at B5 tier 1 until 07:45, then let it expire so the
      // gate is probing when the probe is granted.
      setGateState(first.store, 'cooling', {
        rule: 'B5',
        tier: 1,
        reason: 'failing deals cycles',
        until_at: '2026-09-19T07:45:00Z',
        failing_cycles: 3,
        b5_tier: 1,
      });
      await first.clock.advance(15 * 60 * 1000); // -> 07:45
      // Grant the probe without making the request: check() consumes the
      // probe (probe_used = 1) and stamps probe_granted_at in the same
      // transaction. This is the "stuck" probe — the process dies here.
      const verdict = first.worker.gate.check('https://www.ozbargain.com.au/deals/feed?page=0');
      assert.equal(verdict.allowed, true, 'the probe is granted');
      const granted = first.store.getGate();
      assert.equal(granted.state, 'probing', 'the gate is probing');
      assert.equal(granted.probe_used, 1, 'the probe is consumed');
      assert.equal(granted.probe_granted_at, '2026-09-19T07:45:00.000Z', 'the grant instant is stamped');
      first.store.close();

      // Restart on the same database file; the clock starts at the grant
      // instant (07:45) so a 10-minute advance reaches the expiry (07:55).
      second = await makeGateWorker({ routes, dir: first.dir, dbPath: first.dbPath, clockIso: '2026-09-19T07:45:00Z' });
      assert.equal(second.store.getGate().state, 'probing', 'the restarted store reads the persisted probing state');
      assert.equal(second.store.getGate().probe_used, 1, 'the consumed probe is persisted across the restart');

      // 07:54 is within the 10-minute window: a read must NOT expire the
      // probe, so the poll stays a no-op and the probe stays consumed.
      await second.clock.advance(9 * 60 * 1000); // -> 07:54
      await second.worker.tasks.dealPoll();
      assert.equal(second.store.getGate().state, 'probing', 'the probe is not expired before 10 minutes');

      // At 07:55 the probe has been unanswered for 10 minutes: the next
      // read expires it and the gate re-cools at the next B5 tier.
      await second.clock.advance(60 * 1000); // -> 07:55
      await second.worker.tasks.dealPoll();
      const g = second.store.getGate();
      assert.equal(g.state, 'cooling', 'an expired probe re-cools the gate');
      assert.equal(g.rule, 'B5', 'the re-cool is a B5 cool-off');
      assert.equal(g.b5_tier, 2, 'the B5 tier climbs to 2');
      assert.equal(g.until_at, '2026-09-19T07:55:04.000Z', 'the cool-off is 4x the poll interval (4 s)');

      // Once the cool-off runs out the poll resumes: a 200 probe reopens
      // the gate and exactly one request goes out.
      await second.clock.advance(4 * 1000); // -> 07:55:04
      const callsBefore = second.transport.calls;
      await second.worker.tasks.dealPoll();
      assert.equal(second.store.getGate().state, 'open', 'a 200 probe reopens the gate');
      assert.equal(second.transport.calls, callsBefore + 1, 'the resumed poll made exactly one (probe) request');
    } finally {
      try { first.store.close(); } catch {}
      if (second) { try { second.store.close(); } catch {} }
      rmSync(first.dir, { recursive: true, force: true });
    }
  });

  // G8: the dead-man's switch is suppressed while the gate is closed —
  // even when the last success was days ago — and resumes once the gate
  // opens. Nothing is sent and deadman_state is not written while closed.
  test('the dead-man switch is suppressed while the gate is closed and resumes when it opens', async () => {
    const { worker, store, sent, close } = await makeWorker({});
    try {
      // Last success four days before the fixed clock, no prior
      // deadman_state: a dead-man notification is due (step 30min) as soon
      // as the gate is open.
      store.setPollState({
        lastSuccessAt: '2026-09-15T07:30:00Z',
        lastResponseClass: 'ok',
        backoffSeconds: 0,
        consecutiveFailures: 0,
      });
      const before = store.getSetting('deadman_state');
      for (const state of ['cooling', 'stopped', 'probing']) {
        setGateState(store, state, state === 'cooling' ? { until_at: '2027-01-01T00:00:00Z' } : {});
        await worker.tasks.deadmanCheck();
        assert.equal(sent.length, 0, `the dead-man sent nothing while the gate is ${state}`);
        assert.equal(store.getSetting('deadman_state'), before, `deadman_state is unchanged while the gate is ${state}`);
      }
      setGateState(store, 'open');
      await worker.tasks.deadmanCheck();
      const deadmanSent = sent.filter((n) => n.tags?.includes('deadman'));
      assert.ok(deadmanSent.length >= 1, 'the dead-man sent the due notification once the gate reopened');
    } finally {
      await close();
    }
  });

  // G6: a closed gate makes zero requests and records no failures rows —
  // no catch-up. Both the deals poll and the classifieds poll early-return
  // without touching the transport.
  test('a closed gate makes zero requests and records no failures (no catch-up)', async () => {
    const { worker, store, transport, close } = await makeWorker({});
    try {
      // until_at far in the future so the gate stays cooling (no lazy
      // transition to probing on read).
      setGateState(store, 'cooling', { until_at: '2027-01-01T00:00:00Z' });
      await worker.tasks.dealPoll();
      const dealsCalls = transport.requestLog.filter(
        (r) => r.url.includes('/deals/feed') || r.url === 'https://www.ozbargain.com.au/feed',
      );
      assert.equal(dealsCalls.length, 0, 'a closed gate makes zero deals requests');
      assert.equal(store.getFailures().length, 0, 'a closed gate records no failures rows');
      store.setSetting('classifieds_enabled', '1');
      store.setSetting('ozb_account_cookie', 'test-session=authenticated');
      await worker.tasks.classifiedsPoll();
      const classifiedsCalls = transport.requestLog.filter((r) => r.url === 'https://www.ozbargain.com.au/classified');
      assert.equal(classifiedsCalls.length, 0, 'a closed gate makes zero classifieds requests');
    } finally {
      await close();
    }
  });

  // X8: "on SIGTERM exits 0 with the database closed cleanly". The handler is
  // driven in-process through a fake process object: a real OS signal cannot
  // be delivered gracefully on every platform, and spawning a real worker
  // escaped the in-process network guard. Container signal forwarding is
  // covered by the packaging entrypoint tests.
  test('SIGTERM stops the schedulers, closes the database and exits 0; a second signal is ignored', async () => {
    const { worker, store, close } = await makeWorker();
    try {
      const proc = new EventEmitter();
      const exits = [];
      const lines = [];
      let stops = 0;
      const shutdown = installShutdown({
        worker: { stop: async () => { stops += 1; await worker.stop(); } },
        store,
        proc,
        exit: (code) => exits.push(code),
        log: (line) => lines.push(line),
        logError: (line) => lines.push(line),
      });

      proc.emit('SIGTERM');
      proc.emit('SIGINT');
      await shutdown('SIGTERM');

      assert.deepEqual(exits, [0], 'exactly one exit, with code 0');
      assert.equal(stops, 1, 'the schedulers are stopped once');
      assert.ok(lines.includes('worker stopped cleanly, database closed'), 'the clean-close log line is written');
      assert.throws(() => store.getPollState(), 'the database is closed');
    } finally {
      await close().catch(() => {});
    }
  });

  test('a failing shutdown exits 1 and reports the error', async () => {
    const proc = new EventEmitter();
    const exits = [];
    const errors = [];
    const shutdown = installShutdown({
      worker: { stop: async () => { throw new Error('stop failed'); } },
      store: { close() {} },
      proc,
      exit: (code) => exits.push(code),
      log: () => {},
      logError: (line) => errors.push(line),
    });

    proc.emit('SIGINT');
    await shutdown('SIGINT');

    assert.deepEqual(exits, [1]);
    assert.match(errors[0], /shutdown error: stop failed/);
  });
});
