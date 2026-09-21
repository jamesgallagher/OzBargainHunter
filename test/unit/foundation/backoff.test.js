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

test('a transport rejection (timeout/connection error) backs off with jitter, is logged, and rethrows', async () => {
  // A failure below the HTTP layer is not a classifyResponse input, so the
  // post-response wait block never runs for it; the client must back off
  // here (design 3.3: "all other failures back off exponentially with
  // jitter"). A rejecting transport is the production shape of a timeout or
  // connection error.
  const url = 'https://www.ozbargain.com.au/deals/feed';
  const dir = mkdtempSync(join(tmpdir(), 'ozb-client-'));
  const dbPath = join(dir, 'test.db');
  const store = openStore({ path: dbPath, clock: fixedClock(START) });
  const clock = fixedClock(START);
  let randomCalls = 0;
  const randomSource = seededRandom(1);
  const random = {
    next() {
      randomCalls += 1;
      return randomSource.next();
    },
  };
  const logs = [];
  let transportCalls = 0;
  const transport = {
    get calls() {
      return transportCalls;
    },
    async fetch() {
      transportCalls += 1;
      throw new Error('socket hang up (timeout)');
    },
  };
  const client = createOzbClient({ transport, store, clock, random, config: {}, log: (l) => logs.push(l) });

  try {
    const startMs = clock.now().getTime();
    await assert.rejects(
      () => client.request(url),
      (err) => {
        assert.ok(/socket hang up/.test(err.message), `expected the transport error, got ${err.message}`);
        return true;
      },
    );
    // Non-empty backoff sequence (the old [] is gone).
    assert.ok(client.backoffDelays.length >= 1, 'expected a non-empty backoff sequence');
    // One random.next() per failure.
    assert.equal(randomCalls, 1, 'random.next() must be called once per transport failure');
    // The clock advanced by the backoff delay (non-zero), not 0 ms.
    const advancedMs = clock.now().getTime() - startMs;
    const expected = Math.round(client.backoffDelays[0] * 1000);
    assert.equal(advancedMs, expected, `clock must advance by the backoff delay: got ${advancedMs}, expected ${expected}`);
    assert.ok(advancedMs > 0, 'clock must advance by a non-zero amount');
    // The failure was logged (card: "every request's URL, response class and
    // timestamp is logged").
    assert.ok(logs.some((l) => l.includes('transport_error')), 'the transport failure must be logged');
    assert.equal(transport.calls, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a negative Retry-After does not rewind the clock (clamped to >= 0)', async () => {
  const url = 'https://www.ozbargain.com.au/deals/feed';
  const { client, clock, cleanup } = makeClient({
    [url]: { status: 429, headers: { 'retry-after': '-5' }, body: '' },
  });

  try {
    const startMs = clock.now().getTime();
    const result = await client.request(url);
    assert.equal(result.class, 'rate_limited');
    // The clock must not move backwards, and a negative Retry-After clamps
    // the wait to 0 (no advance).
    const movedMs = clock.now().getTime() - startMs;
    assert.ok(movedMs >= 0, `clock must not rewind: moved ${movedMs} ms`);
    assert.equal(movedMs, 0, 'a negative Retry-After clamps the wait to 0');
  } finally {
    cleanup();
  }
});

test('the backoff delay includes the injected jitter (delay - base === random.next())', async () => {
  // Kills the `base + 0 * jitter` mutant: if jitter never reaches the delay,
  // delay - base is 0, but the actual jitter from seededRandom(1) is non-zero.
  const url = 'https://www.ozbargain.com.au/deals/feed';
  const { client, cleanup } = makeClient({
    [url]: { status: 500, headers: {}, body: 'error' },
  });

  try {
    const base = 2; // BASE_BACKOFF_SECONDS for the first failure
    const expectedJitter = seededRandom(1).next();
    await client.request(url);
    const [delay] = client.backoffDelays;
    assert.ok(
      Math.abs(delay - (base + expectedJitter)) < 1e-9,
      `delay ${delay} should be base(${base}) + jitter(${expectedJitter})`,
    );
    assert.notEqual(delay, base, 'jitter must reach the delay (delay !== base)');
  } finally {
    cleanup();
  }
});
