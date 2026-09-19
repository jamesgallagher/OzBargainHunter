import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDealPoll } from '../../../lib/acquire/poll.js';
import { createFixtureTransport } from '../../support/fixtureTransport.js';
import { openStore } from '../../../lib/store/index.js';
import { createOzbClient } from '../../../lib/http/client.js';
import { fixedClock } from '../../../lib/clock.js';
import { seededRandom } from '../../../lib/random.js';

const POLL_1_AT = '2026-09-19T07:30:00Z';
const POLL_2_AT = '2026-09-19T08:05:00Z';

const P1 = {
  'https://www.ozbargain.com.au/deals/feed?page=0': { status: 200, fixture: 'http/r0.xml' },
  'https://www.ozbargain.com.au/deals/feed?page=1': { status: 200, fixture: 'http/r1.xml' },
  'https://www.ozbargain.com.au/feed': { status: 200, fixture: 'http/feed_feed.xml' },
};
const P2 = {
  'https://www.ozbargain.com.au/deals/feed?page=0': { status: 200, fixture: 'http/cmp_deals.xml' },
  'https://www.ozbargain.com.au/deals/feed?page=1': { status: 304, fixture: 'http/r1.xml' },
  'https://www.ozbargain.com.au/feed': { status: 200, fixture: 'http/cmp_front.xml' },
};

function makeClient(transport, clock, store) {
  return createOzbClient({ transport, store, clock, random: seededRandom(1), log: () => {} });
}

async function runSingle(clockIso, routes) {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-poll-'));
  const clock = fixedClock(clockIso);
  const store = openStore({ path: join(dir, 'test.db'), clock });
  const transport = createFixtureTransport(routes);
  const client = makeClient(transport, clock, store);
  const result = await runDealPoll({ client, store, clock, log: () => {} });
  return { transport, store, result, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function runTwoPolls() {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-poll2-'));
  const clock = fixedClock(POLL_1_AT);
  const store = openStore({ path: join(dir, 'test.db'), clock });
  const t1 = createFixtureTransport(P1);
  const c1 = makeClient(t1, clock, store);
  await runDealPoll({ client: c1, store, clock, log: () => {} });
  await clock.advance(35 * 60 * 1000);
  const t2 = createFixtureTransport(P2);
  const c2 = makeClient(t2, clock, store);
  await runDealPoll({ client: c2, store, clock, log: () => {} });
  return { t1, t2, store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function assertNoPage2(transport) {
  for (const entry of transport.requestLog) {
    assert.ok(!entry.url.includes('page=2'), `transport was asked for ${entry.url}`);
  }
}

test('poll 1: 60 deals, 60 observations, front_page_first_seen on 20', async () => {
  const { transport, store, result, close } = await runSingle(POLL_1_AT, P1);
  try {
    assertNoPage2(transport);
    assert.equal(transport.requestLog.length, 3);
    assert.equal(store.countDeals(), 60);
    assert.equal(store.countAllObservations(), 60);
    assert.equal(store.countFrontPageFirstSeen(), 20);
    assert.equal(result.frontPageAvailable, true);
    assert.equal(result.lastResponseClass, 'ok');
  } finally {
    close();
  }
});

test('poll 2 (single fresh run): 30 deals (cmp_deals; cmp_front is a subset), 30 observations', async () => {
  const { transport, store, result, close } = await runSingle(POLL_2_AT, P2);
  try {
    assertNoPage2(transport);
    // A fresh store at poll 2 sees only cmp_deals (30) — cmp_front is a
    // strict subset of cmp_deals here, so no new nodes. The 61-deal figure
    // is the cumulative count across both polls (60 from poll 1 + 975721).
    assert.equal(store.countDeals(), 30);
    assert.equal(store.countAllObservations(), 30);
    assert.equal(result.lastResponseClass, 'ok');
  } finally {
    close();
  }
});

test('cumulative two-poll run: 61 deals (975721 the new fuel deal), 90 observation rows (60 + 30, one per node per poll)', async () => {
  const { t1, t2, store, close } = await runTwoPolls();
  try {
    assertNoPage2(t1);
    assertNoPage2(t2);
    assert.equal(store.countDeals(), 61);
    // Per-node-per-poll: poll 1 saw 60 nodes, poll 2 saw 30 — 90 rows total.
    // A node seen in both polls (e.g. 975704) has two rows; that is the model.
    assert.equal(store.countAllObservations(), 90);
    assert.ok(store.getDeal(975721), '975721 should be present after poll 2');
  } finally {
    close();
  }
});

test('975704: two observation rows across two polls, votes 17 then 24', async () => {
  const { t1, t2, store, close } = await runTwoPolls();
  try {
    assertNoPage2(t1);
    assertNoPage2(t2);
    const obs = store.getObservations(975704);
    assert.equal(obs.length, 2);
    const votes = obs.map((o) => o.votes_pos).sort((a, b) => a - b);
    assert.deepEqual(votes, [17, 24]);
  } finally {
    close();
  }
});

test('a Cloudflare block on the front feed commits the deals already fetched', async () => {
  const routes = {
    'https://www.ozbargain.com.au/deals/feed?page=0': { status: 200, fixture: 'http/r0.xml' },
    'https://www.ozbargain.com.au/deals/feed?page=1': { status: 200, fixture: 'http/r1.xml' },
    'https://www.ozbargain.com.au/feed': { status: 403, fixture: 'http/derived/cloudflare-1010.txt' },
  };
  const { transport, store, result, close } = await runSingle(POLL_1_AT, routes);
  try {
    assertNoPage2(transport);
    assert.equal(store.countDeals(), 60);
    assert.equal(result.frontPageAvailable, false);
    assert.equal(store.countFrontPageFirstSeen(), 0);
  } finally {
    close();
  }
});

test('an unparseable 200 body is recorded as a failure and nothing is upserted from it', async () => {
  const routes = {
    'https://www.ozbargain.com.au/deals/feed?page=0': { status: 200, fixture: 'http/derived/deals-page0-truncated.xml' },
    'https://www.ozbargain.com.au/deals/feed?page=1': { status: 200, fixture: 'http/r1.xml' },
    'https://www.ozbargain.com.au/feed': { status: 200, fixture: 'http/feed_feed.xml' },
  };
  const { store, result, close } = await runSingle(POLL_1_AT, routes);
  try {
    assert.equal(result.failures, 1);
    assert.equal(store.countDeals(), 50);
  } finally {
    close();
  }
});

test('node 975666 appears in the deals feed and the front-page feed at poll 1 and produces one row in deals', async () => {
  const { store, close } = await runSingle(POLL_1_AT, P1);
  try {
    // 975666 is in r0.xml (deals page 0) and feed_feed.xml (front). The
    // cross-feed de-duplication means it occupies exactly one row in deals.
    const deal = store.getDeal(975666);
    assert.ok(deal, '975666 should be in deals');
    // One row: count the deals rows for this node via the store.
    const rows = store.getDb().prepare('SELECT COUNT(*) AS n FROM deals WHERE node_id = ?').get(975666);
    assert.equal(rows.n, 1);
  } finally {
    close();
  }
});

test('mid-cycle 304 at poll 2: all three requests are made, page 1 is not_modified, the other two are processed', async () => {
  const { transport, store, result, close } = await runSingle(POLL_2_AT, P2);
  try {
    // All three URLs were requested, in order.
    assert.equal(transport.requestLog.length, 3);
    assertNoPage2(transport);
    // Page 1 (the 304) contributed nothing; page 0 (cmp_deals, 30) and the
    // front feed (a subset) did. 304 is not an error, so no failures row.
    assert.equal(result.failures, 0);
    assert.equal(result.lastResponseClass, 'ok');
    // poll_state records the last response class and a clean success.
    const state = store.getPollState();
    assert.equal(state.last_response_class, 'ok');
    assert.ok(state.last_success_at, 'last_success_at should be set');
    assert.equal(state.consecutive_failures, 0);
  } finally {
    close();
  }
});

test('promoted front feed at poll 1: 975122 is in deals with front_page_first_seen set, though it is on neither deals page', async () => {
  const routes = {
    'https://www.ozbargain.com.au/deals/feed?page=0': { status: 200, fixture: 'http/r0.xml' },
    'https://www.ozbargain.com.au/deals/feed?page=1': { status: 200, fixture: 'http/r1.xml' },
    'https://www.ozbargain.com.au/feed': { status: 200, fixture: 'http/derived/front-feed-promoted.xml' },
  };
  const { store, close } = await runSingle(POLL_1_AT, routes);
  try {
    // 975122 appears only in the promoted front feed, so it is a new deal.
    const deal = store.getDeal(975122);
    assert.ok(deal, '975122 should be in deals');
    assert.ok(deal.front_page_first_seen, '975122 front_page_first_seen should be set');
  } finally {
    close();
  }
});
