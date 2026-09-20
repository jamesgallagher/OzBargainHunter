import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startWorker } from '../../../worker/main.js';
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
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
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
});
