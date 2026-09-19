import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../../lib/store/index.js';
import { fixedClock } from '../../../lib/clock.js';
import { seededRandom } from '../../../lib/random.js';
import { createOzbClient, BlockedError } from '../../../lib/http/client.js';
import { createFixtureTransport } from '../../support/fixtureTransport.js';

const CLOUDFLARE_BODY = readFileSync(
  new URL('../../../fixtures/http/derived/cloudflare-1010.txt', import.meta.url),
  'utf8',
);

const START = '2026-09-19T06:20:00Z';

function makeClient(routes, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-client-'));
  const dbPath = join(dir, 'test.db');
  const store = openStore({ path: dbPath, clock: fixedClock(START) });
  const transport = createFixtureTransport(routes);
  const clock = fixedClock(START);
  let randomCalls = 0;
  const randomSource = opts.random ?? seededRandom(1);
  const random = {
    next() {
      randomCalls += 1;
      return randomSource.next();
    },
  };
  const client = createOzbClient({
    transport,
    store,
    clock,
    random,
    config: {},
    log: () => {},
  });
  return { client, transport, store, clock, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); }, randomCalls: () => randomCalls };
}

test('after a cloudflare_block, the next client calls throw BlockedError and the transport call count does not increase', async () => {
  const url = 'https://www.ozbargain.com.au/deals/feed';
  const { client, transport, cleanup } = makeClient({
    [url]: { status: 403, headers: { server: 'cloudflare' }, body: CLOUDFLARE_BODY },
  });

  try {
    const first = await client.request(url);
    assert.equal(first.class, 'cloudflare_block');
    assert.equal(transport.calls, 1);

    // The next THREE calls (persistence beyond two) throw BlockedError.
    for (let i = 0; i < 3; i++) {
      await assert.rejects(
        () => client.request(url),
        (err) => {
          assert.ok(err instanceof BlockedError, `expected BlockedError, got ${err.name}`);
          return true;
        },
      );
    }

    // Transport call count did not increase across the blocked calls.
    assert.equal(transport.calls, 1);
    assert.equal(client.blocked, true);

    // clearBlock allows the client to work again.
    client.clearBlock();
    assert.equal(client.blocked, false);
    const after = await client.request(url);
    assert.equal(after.class, 'cloudflare_block'); // still 403
    assert.equal(transport.calls, 2);
  } finally {
    cleanup();
  }
});

test('a permission_denied 403 does not latch the client (design 3.6 expired-session path)', async () => {
  const url = 'https://www.ozbargain.com.au/classified';
  const cls403 = readFileSync(new URL('../../../fixtures/http/cls403.html', import.meta.url), 'utf8');
  const { client, transport, cleanup } = makeClient({
    [url]: { status: 403, headers: { server: 'cloudflare' }, body: cls403 },
  });

  try {
    const first = await client.request(url);
    assert.equal(first.class, 'permission_denied');
    assert.equal(client.blocked, false);

    // The client is NOT latched: the next call goes out again.
    const second = await client.request(url);
    assert.equal(second.class, 'permission_denied');
    assert.equal(transport.calls, 2);
    assert.equal(client.blocked, false);
  } finally {
    cleanup();
  }
});

test('backoff with seededRandom(1) produces the same delay sequence on two runs, strictly increasing, and random.next() is consulted', async () => {
  const url = 'https://www.ozbargain.com.au/deals/feed';
  const routes = { [url]: { status: 500, headers: {}, body: 'error' } };

  async function run() {
    const { client, clock, cleanup, randomCalls } = makeClient(routes);
    const startMs = clock.now().getTime();
    for (let i = 0; i < 5; i++) {
      await client.request(url);
    }
    const delays = client.backoffDelays;
    const advancedMs = clock.now().getTime() - startMs;
    cleanup();
    return { delays, advancedMs, randomCalls: randomCalls() };
  }

  const r1 = await run();
  const r2 = await run();

  // Non-empty sequence (the old vacuous deepEqual([], []) is gone).
  assert.equal(r1.delays.length, 5, 'expected a non-empty backoff sequence');

  // Same sequence on two runs (deterministic under seededRandom(1)).
  assert.deepEqual(r1.delays, r2.delays);

  // Strictly increasing: the base component doubles each failure
  // (2, 4, 8, 16, 32) and the jitter is in [0, 1), so the doubling dominates.
  for (let i = 1; i < r1.delays.length; i++) {
    assert.ok(r1.delays[i] > r1.delays[i - 1], `delay[${i}] ${r1.delays[i]} not > delay[${i - 1}] ${r1.delays[i - 1]}`);
  }

  // The injected random was actually consulted (jitter drawn from it).
  assert.equal(r1.randomCalls, 5, 'random.next() must be called once per backoff');

  // The backoff actually consumed the clock: the clock advanced by the
  // sum of the delays (plus the 3s inter-request pauses). Date.getTime()
  // truncates the fractional milliseconds, so allow a sub-millisecond
  // tolerance rather than exact equality.
  const expectedPause = 4 * 3 * 1000; // 4 pauses between 5 requests
  const sumDelays = r1.delays.reduce((a, b) => a + b, 0) * 1000;
  const expectedMs = expectedPause + sumDelays;
  assert.ok(
    r1.advancedMs >= expectedMs - 1 && r1.advancedMs <= expectedMs,
    `clock must advance by pauses + backoff: got ${r1.advancedMs}, expected ~${expectedMs}`,
  );
});

test('Retry-After is honoured on 429: the clock advances by the header value', async () => {
  const url = 'https://www.ozbargain.com.au/deals/feed';
  const { client, clock, cleanup } = makeClient({
    [url]: { status: 429, headers: { 'retry-after': '120' }, body: '' },
  });

  try {
    const startMs = clock.now().getTime();
    const result = await client.request(url);
    assert.equal(result.class, 'rate_limited');
    assert.equal(result.retryAfterSeconds, 120);
    // 120s Retry-After + the 3s inter-request pause (first request has no
    // pause, so only the 120s is expected here).
    assert.equal(clock.now().getTime() - startMs, 120 * 1000);
  } finally {
    cleanup();
  }
});

test('a 429 without Retry-After falls back to exponential backoff with jitter', async () => {
  const url = 'https://www.ozbargain.com.au/deals/feed';
  const { client, clock, cleanup, randomCalls } = makeClient({
    [url]: { status: 429, headers: {}, body: '' },
  });

  try {
    const startMs = clock.now().getTime();
    const result = await client.request(url);
    assert.equal(result.class, 'rate_limited');
    assert.equal(result.retryAfterSeconds, undefined);
    // Backoff was used: random consulted, clock advanced by base + jitter.
    assert.equal(randomCalls(), 1);
    const [delay] = client.backoffDelays;
    assert.ok(delay >= 2 && delay < 3, `first backoff delay ${delay} should be in [2, 3)`);
    assert.equal(clock.now().getTime() - startMs, Math.round(delay * 1000));
  } finally {
    cleanup();
  }
});

test('the inter-request pause is taken from the clock (3s between requests)', async () => {
  const url = 'https://www.ozbargain.com.au/deals/feed';
  const { client, clock, cleanup } = makeClient({
    [url]: { status: 200, headers: {}, body: '<rss></rss>' },
  });

  try {
    const startMs = clock.now().getTime();
    for (let i = 0; i < 4; i++) {
      await client.request(url);
    }
    // 4 requests => 3 pauses of 3s each = 9s, all taken from the clock.
    assert.equal(clock.now().getTime() - startMs, 3 * 3 * 1000);
  } finally {
    cleanup();
  }
});
