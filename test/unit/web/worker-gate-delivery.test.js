import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startWorker } from '../../../worker/main.js';
import { openStore } from '../../../lib/store/index.js';
import { createFixtureTransport } from '../../support/fixtureTransport.js';
import { fixedClock } from '../../../lib/clock.js';
import { seededRandom } from '../../../lib/random.js';
import { brevoProvider } from '../../../lib/notify/brevo.js';

// The four fixture routes the deal poll asks for, plus the classifieds page.
const ROUTES = {
  'https://www.ozbargain.com.au/deals/feed?page=0': { status: 200, fixture: 'http/r0.xml' },
  'https://www.ozbargain.com.au/deals/feed?page=1': { status: 200, fixture: 'http/r1.xml' },
  'https://www.ozbargain.com.au/feed': { status: 200, fixture: 'http/feed_feed.xml' },
  'https://www.ozbargain.com.au/classified': { status: 200, fixture: 'http/classifieds-page.html' },
};

const BREVO_CONFIG = JSON.stringify({ mailFrom: 'alerts@example.com', recipient: 'james@example.com' });

/**
 * Start a worker against a temp store, a fixture transport and a fixed clock,
 * with an injected fake Brevo factory (no real SMTP is ever built: the only
 * selected provider row is the injected one). The real schedulers are stopped
 * immediately so the test drives the exposed task functions directly.
 */
async function makeWorker({ failing = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-worker-gate-delivery-'));
  const clock = fixedClock('2026-09-19T07:30:00Z');
  const store = openStore({ path: join(dir, 'test.db'), clock });
  const transport = createFixtureTransport(ROUTES);
  const mailCalls = [];
  const smtp = {
    async sendMail(args) {
      if (failing) throw new Error('smtp down');
      mailCalls.push(args);
      return { accepted: [args.to], rejected: [] };
    },
  };
  const brevoFactory = () => brevoProvider(smtp);

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
      OZB_PUBLIC_URL: '',
    },
    providerFactories: { brevo_smtp: brevoFactory },
    log: () => {},
  });

  // Cancel the real schedulers so the test drives the tasks directly.
  await worker.stop();

  return {
    worker,
    store,
    transport,
    mailCalls,
    close: async () => {
      if (store.getDb().isOpen) store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Drive the persisted gate to a given state by writing the full row and one
 * event through the store (copied from worker.test.js).
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

function seedStopped(store) {
  setGateState(store, 'stopped', {
    rule: 'B1',
    reason: 'Cloudflare block',
    min_resume_at: new Date(Date.now() - 3600 * 1000).toISOString(),
  });
}

describe('worker: gate-alert delivery on the task paths (crash-safe sweep)', () => {
  test('deadmanCheck delivers the unsent gate alert, then suppresses the dead-man send while closed', async () => {
    const { worker, store, mailCalls, close } = await makeWorker();
    try {
      store.upsertProvider('brevo_smtp', BREVO_CONFIG, true);
      seedStopped(store);

      await worker.tasks.deadmanCheck();

      assert.equal(mailCalls.length, 1, 'the gate alert is sent through the injected Brevo');
      assert.equal(mailCalls[0].to, 'james@example.com');
      assert.match(mailCalls[0].subject, /access STOPPED/);
      assert.equal(store.getGateEventsAsc()[0].email_status, 'sent', 'the event is marked sent');
    } finally {
      await close();
    }
  });

  test('dealPoll makes zero requests while the gate is closed, but still delivers the gate alert', async () => {
    const { worker, store, transport, mailCalls, close } = await makeWorker();
    try {
      store.upsertProvider('brevo_smtp', BREVO_CONFIG, true);
      seedStopped(store);

      await worker.tasks.dealPoll();

      assert.equal(transport.calls, 0, 'the closed gate blocks every request');
      assert.equal(mailCalls.length, 1, 'the gate alert is delivered before the gate-closed early return');
      assert.equal(store.getGateEventsAsc()[0].email_status, 'sent');
    } finally {
      await close();
    }
  });

  test('a failing Brevo records the gate event as failed and the task does not throw', async () => {
    const { worker, store, close } = await makeWorker({ failing: true });
    try {
      store.upsertProvider('brevo_smtp', BREVO_CONFIG, true);
      seedStopped(store);

      await assert.doesNotReject(worker.tasks.deadmanCheck(), 'the delivery sweep never throws');

      assert.equal(store.getGateEventsAsc()[0].email_status, 'failed');
    } finally {
      await close();
    }
  });
});
