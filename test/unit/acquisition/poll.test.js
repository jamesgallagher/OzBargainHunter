import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDealPoll } from '../../../lib/acquire/poll.js';
import { deadManState } from '../../../lib/acquire/deadman.js';
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

test('node 975666 appears in the deals feed and the front-page feed at poll 1 and produces one observation row', async () => {
  const { store, close } = await runSingle(POLL_1_AT, P1);
  try {
    // 975666 is in r0.xml (deals page 0) and feed_feed.xml (front). The
    // cross-feed de-duplication means it occupies exactly one deals row AND
    // exactly one observation row. The deals-row count is guaranteed by the
    // schema (node_id is the primary key), so it cannot catch a de-dup
    // failure — the observation count is the assertion that would actually
    // fail: a node seen in two feeds must yield one observation, not two.
    const deal = store.getDeal(975666);
    assert.ok(deal, '975666 should be in deals');
    const obs = store.getObservations(975666);
    assert.equal(obs.length, 1);
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
    // Page 1 (the 304) is observable in the transport's request log: the
    // third request (page 1) was served a 304, while page 0 and the front
    // feed were served 200s. `poll_state` holds only the last class, so
    // this per-URL status is the only place the mid-cycle 304 can be
    // asserted.
    const byUrl = Object.fromEntries(transport.requestLog.map((e) => [e.url, e.status]));
    assert.equal(byUrl['https://www.ozbargain.com.au/deals/feed?page=0'], 200);
    assert.equal(byUrl['https://www.ozbargain.com.au/deals/feed?page=1'], 304);
    assert.equal(byUrl['https://www.ozbargain.com.au/feed'], 200);
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

// --- Review round-1 required tests ---

test('POLL_3 all-304 cycle: last_success_at is preserved (not wiped to NULL), the front feed stays available, and it is not an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-poll3-'));
  const clock = fixedClock(POLL_1_AT);
  const store = openStore({ path: join(dir, 'test.db'), clock });
  // A successful first poll establishes the baseline last_success_at.
  const t1 = createFixtureTransport(P1);
  await runDealPoll({ client: makeClient(t1, clock, store), store, clock, log: () => {} });
  const baseline = store.getPollState().last_success_at;
  assert.ok(baseline, 'baseline last_success_at should be set after a successful poll');
  // POLL_3: all three URLs return 304 (the expected common case, design 3.2).
  await clock.advance(5 * 60 * 1000);
  const all304 = {
    'https://www.ozbargain.com.au/deals/feed?page=0': { status: 304, fixture: 'http/r0.xml' },
    'https://www.ozbargain.com.au/deals/feed?page=1': { status: 304, fixture: 'http/r1.xml' },
    'https://www.ozbargain.com.au/feed': { status: 304, fixture: 'http/feed_feed.xml' },
  };
  const t3 = createFixtureTransport(all304);
  const result = await runDealPoll({ client: makeClient(t3, clock, store), store, clock, log: () => {} });
  try {
    const state = store.getPollState();
    // A 304 proves the URL was reached, so it is a successful poll: the
    // last-success timestamp is NOT wiped to NULL (the dead-man's switch
    // and /healthz depend on it being present).
    assert.ok(state.last_success_at, 'last_success_at must not be NULL after an all-304 cycle');
    assert.notEqual(state.last_success_at, null);
    assert.equal(state.last_response_class, 'not_modified');
    assert.equal(state.consecutive_failures, 0);
    // The front feed returned 304 (its normal state when nothing changed), so
    // front-page detection must still be reported as available.
    assert.equal(result.frontPageAvailable, true);
    assert.equal(result.failures, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('front feed 304 with 200 deals: the cycle commits the deals and keeps the front feed available', async () => {
  const routes = {
    'https://www.ozbargain.com.au/deals/feed?page=0': { status: 200, fixture: 'http/cmp_deals.xml' },
    'https://www.ozbargain.com.au/deals/feed?page=1': { status: 200, fixture: 'http/r1.xml' },
    'https://www.ozbargain.com.au/feed': { status: 304, fixture: 'http/cmp_front.xml' },
  };
  const { store, result, close } = await runSingle(POLL_2_AT, routes);
  try {
    // The front feed merely returned 304 (nothing changed): not an error, and
    // front-page detection stays available. The two deals pages (200) are
    // committed.
    assert.equal(result.frontPageAvailable, true);
    assert.equal(result.failures, 0);
    assert.equal(result.lastResponseClass, 'not_modified');
    assert.equal(store.countDeals(), 60);
  } finally {
    close();
  }
});

test('front_page_first_seen is stable across polls: 975666 keeps its poll-1 value and 975704 acquires it at poll 2', async () => {
  const { t1, t2, store, close } = await runTwoPolls();
  try {
    assertNoPage2(t1);
    assertNoPage2(t2);
    // 975666 is seen in the front feed at both poll 1 and poll 2. Its
    // front_page_first_seen must be the poll-1 timestamp, preserved (not
    // overwritten to the poll-2 time) — first-seen, not last-seen (4.1).
    const deal = store.getDeal(975666);
    assert.ok(deal.front_page_first_seen, '975666 front_page_first_seen should be set');
    // The poll-1 instant is 07:30:00Z (the deals feed 200 lands at +6s).
    assert.equal(deal.front_page_first_seen, '2026-09-19T07:30:06.000Z');
    // 975704 is on the front feed only at poll 2 (cmp_front), so it acquires
    // front_page_first_seen at poll 2 — the COALESCE must not block a first
    // acquisition, only an overwrite.
    const deal704 = store.getDeal(975704);
    assert.ok(deal704.front_page_first_seen, '975704 front_page_first_seen should be set at poll 2');
    assert.equal(deal704.front_page_first_seen, '2026-09-19T08:05:12.000Z');
  } finally {
    close();
  }
});

test('a transport error mid-cycle is recorded as a failure and the cycle continues to the next URL (degrade rather than die)', async () => {
  // Page 1 has no route, so the fixture transport throws — the client
  // rethrows it as a transport error. The cycle must not abort: page 0 is
  // committed, the error is recorded, and the front feed is still requested.
  const routes = {
    'https://www.ozbargain.com.au/deals/feed?page=0': { status: 200, fixture: 'http/r0.xml' },
    'https://www.ozbargain.com.au/feed': { status: 200, fixture: 'http/feed_feed.xml' },
  };
  const { transport, store, result, close } = await runSingle(POLL_1_AT, routes);
  try {
    // All three URLs were requested (page 0, the failing page 1, and front).
    assert.equal(transport.requestLog.length, 3);
    assertNoPage2(transport);
    assert.ok(transport.requestLog.some((e) => e.url === 'https://www.ozbargain.com.au/feed'), 'the front feed should still be requested after the page-1 transport error');
    // One failure row, classed transport_error; the deals already fetched are
    // committed (page 0: 30) with their observations.
    assert.equal(result.failures, 1);
    assert.equal(store.getFailures()[0].response_class, 'transport_error');
    assert.equal(store.countDeals(), 30);
    assert.equal(store.countAllObservations(), 30);
  } finally {
    close();
  }
});

test('a fully-failed cycle after a success leaves last_success_at intact and accumulates the counter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-fail-'));
  const clock = fixedClock(POLL_1_AT);
  const store = openStore({ path: join(dir, 'test.db'), clock });
  const t1 = createFixtureTransport(P1);
  await runDealPoll({ client: makeClient(t1, clock, store), store, clock, log: () => {} });
  const baseline = store.getPollState().last_success_at;
  assert.ok(baseline, 'baseline last_success_at should be set');
  // A fully-failed cycle (all three 500 / transient).
  await clock.advance(5 * 60 * 1000);
  const all500 = {
    'https://www.ozbargain.com.au/deals/feed?page=0': { status: 500, body: 'boom' },
    'https://www.ozbargain.com.au/deals/feed?page=1': { status: 500, body: 'boom' },
    'https://www.ozbargain.com.au/feed': { status: 500, body: 'boom' },
  };
  const t2 = createFixtureTransport(all500);
  const result = await runDealPoll({ client: makeClient(t2, clock, store), store, clock, log: () => {} });
  try {
    const state = store.getPollState();
    // The failed cycle must NOT wipe the stored last_success_at (the dead-man
    // and /healthz depend on it). It is preserved from the baseline.
    assert.ok(state.last_success_at, 'last_success_at must not be NULL after a failed cycle');
    assert.equal(state.last_success_at, baseline);
    assert.equal(result.failures, 3);
    assert.equal(state.last_response_class, 'transient');
    assert.equal(state.consecutive_failures, 3);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two consecutive failed cycles accumulate consecutive_failures and grow the backoff (2^n, not a per-cycle count)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-2fail-'));
  const clock = fixedClock(POLL_1_AT);
  const store = openStore({ path: join(dir, 'test.db'), clock });
  const all500 = {
    'https://www.ozbargain.com.au/deals/feed?page=0': { status: 500, body: 'boom' },
    'https://www.ozbargain.com.au/deals/feed?page=1': { status: 500, body: 'boom' },
    'https://www.ozbargain.com.au/feed': { status: 500, body: 'boom' },
  };
  const t1 = createFixtureTransport(all500);
  await runDealPoll({ client: makeClient(t1, clock, store), store, clock, log: () => {} });
  const s1 = store.getPollState();
  await clock.advance(5 * 60 * 1000);
  const t2 = createFixtureTransport(all500);
  await runDealPoll({ client: makeClient(t2, clock, store), store, clock, log: () => {} });
  const s2 = store.getPollState();
  try {
    // Each all-failed cycle fails 3 URLs. The counter is accumulated across
    // cycles from the stored value (design 3.5 "three consecutive failures"),
    // not reset every cycle: 3 after the first, 6 after the second. The
    // backoff is a real delay (2^n), not the per-cycle URL count.
    assert.equal(s1.consecutive_failures, 3);
    assert.equal(s1.backoff_seconds, 8); // 2^3
    assert.equal(s2.consecutive_failures, 6);
    assert.equal(s2.backoff_seconds, 64); // 2^6
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a loopback config base changes the requested URL list (the config seam is live)', async () => {
  // Point the feed bases at a loopback fixture server (design 9.1 / 10.4).
  // The requested URLs must follow the config, not the production defaults.
  const config = {
    OZB_DEALS_FEED_URL: 'http://127.0.0.1:8787/deals/feed',
    OZB_FRONT_FEED_URL: 'http://127.0.0.1:8787/feed',
  };
  const dir = mkdtempSync(join(tmpdir(), 'ozb-lb-'));
  const clock = fixedClock(POLL_1_AT);
  const store = openStore({ path: join(dir, 'test.db'), clock });
  const routes = {
    'http://127.0.0.1:8787/deals/feed?page=0': { status: 200, fixture: 'http/r0.xml' },
    'http://127.0.0.1:8787/deals/feed?page=1': { status: 200, fixture: 'http/r1.xml' },
    'http://127.0.0.1:8787/feed': { status: 200, fixture: 'http/feed_feed.xml' },
  };
  const transport = createFixtureTransport(routes);
  const client = makeClient(transport, clock, store);
  await runDealPoll({ client, store, clock, config, log: () => {} });
  try {
    const urls = transport.requestLog.map((e) => e.url);
    assert.deepEqual(urls, [
      'http://127.0.0.1:8787/deals/feed?page=0',
      'http://127.0.0.1:8787/deals/feed?page=1',
      'http://127.0.0.1:8787/feed',
    ]);
    // The production base must NOT appear in the requested URLs.
    assert.ok(!urls.some((u) => u.includes('ozbargain.com.au')), 'a loopback-configured poll must not call the production site');
    assertNoPage2(transport);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Review round-2 required tests ---

test('C1: a broken deals feed (500/500) with a front-feed 304 does not launder the cycle — the counter accumulates, last_success_at is not advanced, and the dead-man fires', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-c1-'));
  const clock = fixedClock(POLL_1_AT);
  const store = openStore({ path: join(dir, 'test.db'), clock });
  // A successful baseline poll establishes last_success_at.
  await runDealPoll({ client: makeClient(createFixtureTransport(P1), clock, store), store, clock, log: () => {} });
  const baseline = store.getPollState().last_success_at;
  assert.ok(baseline, 'baseline last_success_at should be set');
  // Three failing cycles: the deals feed is down (500/500) and the front feed
  // 304s (nothing changed). A front-feed 304 must NOT certify the poll
  // healthy: the counter accumulates and last_success_at is preserved.
  const failCycle = {
    'https://www.ozbargain.com.au/deals/feed?page=0': { status: 500, body: 'boom' },
    'https://www.ozbargain.com.au/deals/feed?page=1': { status: 500, body: 'boom' },
    'https://www.ozbargain.com.au/feed': { status: 304, fixture: 'http/feed_feed.xml' },
  };
  let lastResult;
  for (let i = 0; i < 3; i += 1) {
    await clock.advance(5 * 60 * 1000);
    lastResult = await runDealPoll({ client: makeClient(createFixtureTransport(failCycle), clock, store), store, clock, log: () => {} });
  }
  try {
    const state = store.getPollState();
    // The counter accumulates across cycles from the stored value: 3 cycles x
    // 2 failures = 6, not reset by the front-feed 304.
    assert.equal(state.consecutive_failures, 6);
    // The backoff grows as a real delay (2^6).
    assert.equal(state.backoff_seconds, 64);
    // last_success_at is NOT advanced by the front-feed 304 (no deals feed
    // was reached): it is preserved from the baseline. This is what lets the
    // dead-man's switch and /healthz fire.
    assert.equal(state.last_success_at, baseline);
    // The front feed 304 still reports the front page as available (round-1
    // behaviour, kept).
    assert.equal(lastResult.frontPageAvailable, true);
    assert.equal(lastResult.failures, 2);
    // The dead-man's switch is due 30 minutes after the (preserved) last
    // success, and not yet due at 29.
    const dueNow = new Date(Date.parse(baseline) + 31 * 60 * 1000).toISOString();
    assert.equal(deadManState({ lastSuccessAt: state.last_success_at, now: dueNow, lastNotificationAt: null }).due, true);
    const notDueNow = new Date(Date.parse(baseline) + 29 * 60 * 1000).toISOString();
    assert.equal(deadManState({ lastSuccessAt: state.last_success_at, now: notDueNow, lastNotificationAt: null }).due, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C1: the counter is derived from the cycle totals, not the last URL (order-independent)', async () => {
  // Ordering A: 500, 500, 304. Ordering B: 304, 500, 500. Both have exactly
  // two failures, so both must store the same counter and backoff (the
  // round-2 bug stored 0/0 for A and 2/4 for B, depending on the last URL).
  const runOne = async (routes) => {
    const dir = mkdtempSync(join(tmpdir(), 'ozb-c1o-'));
    const clock = fixedClock(POLL_1_AT);
    const store = openStore({ path: join(dir, 'test.db'), clock });
    const client = makeClient(createFixtureTransport(routes), clock, store);
    await runDealPoll({ client, store, clock, log: () => {} });
    const s = store.getPollState();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    return s;
  };
  const sa = await runOne({
    'https://www.ozbargain.com.au/deals/feed?page=0': { status: 500, body: 'boom' },
    'https://www.ozbargain.com.au/deals/feed?page=1': { status: 500, body: 'boom' },
    'https://www.ozbargain.com.au/feed': { status: 304, fixture: 'http/feed_feed.xml' },
  });
  const sb = await runOne({
    'https://www.ozbargain.com.au/deals/feed?page=0': { status: 304, fixture: 'http/feed_feed.xml' },
    'https://www.ozbargain.com.au/deals/feed?page=1': { status: 500, body: 'boom' },
    'https://www.ozbargain.com.au/feed': { status: 500, body: 'boom' },
  });
  // Both orderings store the same counter (2) and backoff (2^2 = 4), even
  // though their last response class differs (not_modified vs transient).
  assert.equal(sa.consecutive_failures, 2);
  assert.equal(sa.backoff_seconds, 4);
  assert.equal(sb.consecutive_failures, 2);
  assert.equal(sb.backoff_seconds, 4);
});

test('C2: 20 consecutive all-failed cycles do not wedge the store (backoff bounded, getPollState readable)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-c2-'));
  const clock = fixedClock(POLL_1_AT);
  const store = openStore({ path: join(dir, 'test.db'), clock });
  // A stub client that fails every request with a transport error (all three
  // URLs, so each cycle records 3 failures). It does not advance the clock
  // (the real client's own backoff would overflow a fixed clock over 60
  // failures), so this isolates the poll.js/store clamp.
  const stubClient = { blocked: false, async request() { throw new Error('transport down'); } };
  for (let i = 0; i < 20; i += 1) {
    await clock.advance(5 * 60 * 1000);
    await runDealPoll({ client: stubClient, store, clock, log: () => {} });
    // getPollState must remain readable on every cycle: the round-2 bug
    // stored 2^54 at the 18th cycle, after which getPollState threw a
    // RangeError and wedged every later cycle at its first statement.
    store.getPollState();
  }
  try {
    const s = store.getPollState();
    assert.equal(s.consecutive_failures, 60); // 20 cycles x 3 URLs
    // The exponent is clamped, so the stored backoff stays a safe integer
    // (2 * 2^11 = 4096) and never leaves the safe-integer range.
    assert.ok(Number.isSafeInteger(s.backoff_seconds), `backoff_seconds ${s.backoff_seconds} is not a safe integer`);
    assert.ok(s.backoff_seconds <= 4096, `backoff_seconds ${s.backoff_seconds} exceeds the clamp`);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Minor 3: a latched client (BlockedError) is recorded as cloudflare_block, not transport_error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-m3-'));
  const clock = fixedClock(POLL_1_AT);
  const store = openStore({ path: join(dir, 'test.db'), clock });
  // A client already latched by a Cloudflare block: the first request throws
  // BlockedError and the cycle breaks. The row must be classed
  // cloudflare_block, not transport_error (round-2 Minor 3).
  const latchedClient = {
    blocked: true,
    async request() {
      const err = new Error('Cloudflare block: client latched off');
      err.name = 'BlockedError';
      throw err;
    },
  };
  await runDealPoll({ client: latchedClient, store, clock, log: () => {} });
  try {
    const failures = store.getFailures();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].response_class, 'cloudflare_block');
    assert.equal(store.getPollState().last_response_class, 'cloudflare_block');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Minor 3: a DeniedPathError fails loudly (rethrows) rather than being recorded as a transient failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-m3b-'));
  const clock = fixedClock(POLL_1_AT);
  const store = openStore({ path: join(dir, 'test.db'), clock });
  // A configured URL that points at a deny-listed path: the client throws
  // DeniedPathError. It is a configuration error that fails on every cycle,
  // so it must fail loudly (rethrow), not be recorded as a transient failure
  // and retried forever (round-2 Minor 3).
  const denyClient = {
    blocked: false,
    async request() {
      const err = new Error('Denied path: https://www.ozbargain.com.au/api/x');
      err.name = 'DeniedPathError';
      throw err;
    },
  };
  try {
    await assert.rejects(runDealPoll({ client: denyClient, store, clock, log: () => {} }), /Denied path/);
    // No transient failure row was recorded for the deny-listed path.
    assert.equal(store.getFailures().length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
