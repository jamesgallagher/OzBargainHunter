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

function makeClient(routes) {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-client-'));
  const dbPath = join(dir, 'test.db');
  const store = openStore({ path: dbPath, clock: fixedClock('2026-09-19T06:20:00Z') });
  const transport = createFixtureTransport(routes);
  const client = createOzbClient({
    transport,
    store,
    clock: fixedClock('2026-09-19T06:20:00Z'),
    random: seededRandom(1),
    config: {},
    log: () => {},
  });
  return { client, transport, store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('after a cloudflare_block, the next two client calls throw BlockedError and transport call count does not increase', async () => {
  const url = 'https://www.ozbargain.com.au/deals/feed';
  const { client, transport, cleanup } = makeClient({
    [url]: {
      status: 403,
      headers: { server: 'cloudflare' },
      body: CLOUDFLARE_BODY,
    },
  });

  try {
    const first = await client.request(url);
    assert.equal(first.class, 'cloudflare_block');
    assert.equal(transport.calls, 1);

    // The next two calls throw BlockedError.
    await assert.rejects(() => client.request(url), (err) => {
      assert.ok(err instanceof BlockedError, `expected BlockedError, got ${err.name}`);
      return true;
    });
    await assert.rejects(() => client.request(url), (err) => {
      assert.ok(err instanceof BlockedError, `expected BlockedError, got ${err.name}`);
      return true;
    });

    // Transport call count did not increase.
    assert.equal(transport.calls, 1);

    // clearBlock allows the client to work again.
    client.clearBlock();
    const after = await client.request(url);
    assert.equal(after.class, 'cloudflare_block'); // still 403
    assert.equal(transport.calls, 2);
  } finally {
    cleanup();
  }
});

test('backoff with seededRandom(1) produces the same delay sequence on two runs, strictly increasing before jitter', async () => {
  const url = 'https://www.ozbargain.com.au/deals/feed';
  const routes = {
    [url]: { status: 500, headers: {}, body: 'error' },
  };

  // Run 1
  const { client: c1, cleanup: cleanup1 } = makeClient(routes);
  for (let i = 0; i < 5; i++) {
    await c1.request(url);
  }
  const delays1 = c1.backoffDelays;
  cleanup1();

  // Run 2
  const { client: c2, cleanup: cleanup2 } = makeClient(routes);
  for (let i = 0; i < 5; i++) {
    await c2.request(url);
  }
  const delays2 = c2.backoffDelays;
  cleanup2();

  // Same sequence on two runs.
  assert.deepEqual(delays1, delays2);

  // Strictly increasing before jitter: the base component doubles each time.
  // The delay = base + jitter, where base = 2 * 2^n.
  // Before jitter, the sequence of base values is 2, 4, 8, 16, 32 — strictly increasing.
  // We verify that the delays are strictly increasing (jitter is [0,1) so
  // the doubling dominates).
  for (let i = 1; i < delays1.length; i++) {
    assert.ok(delays1[i] > delays1[i - 1], `delay[${i}] ${delays1[i]} not > delay[${i - 1}] ${delays1[i - 1]}`);
  }
});
