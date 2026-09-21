import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../../lib/store/index.js';
import { fixedClock } from '../../../lib/clock.js';
import { createOzbClient, DeniedPathError } from '../../../lib/http/client.js';
import { createFixtureTransport } from '../../support/fixtureTransport.js';

const DENIED_PATHS = [
  'https://www.ozbargain.com.au/api/something',
  'https://www.ozbargain.com.au/ozbapi/something',
  'https://www.ozbargain.com.au/search?q=test',
  'https://www.ozbargain.com.au/comment/123',
  'https://www.ozbargain.com.au/goto/123',
  'https://www.ozbargain.com.au/privatemsg/123',
  'https://www.ozbargain.com.au/user/login',
];

function makeClient(routes) {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-client-'));
  const dbPath = join(dir, 'test.db');
  const store = openStore({ path: dbPath, clock: fixedClock('2026-09-19T06:20:00Z') });
  const transport = createFixtureTransport(routes);
  const client = createOzbClient({
    transport,
    store,
    clock: fixedClock('2026-09-19T06:20:00Z'),
    random: { next: () => 0.5 },
    config: {},
    log: () => {},
  });
  return { client, transport, store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('each of the seven denied paths throws DeniedPathError with transport call count at zero', async () => {
  for (const url of DENIED_PATHS) {
    const { client, transport, cleanup } = makeClient({
      [url]: { status: 200, headers: {}, body: 'should not be reached' },
    });
    try {
      let caught = null;
      try {
        await client.request(url);
      } catch (err) {
        caught = err;
      }
      assert.ok(caught, `expected an error for denied path ${url}`);
      assert.ok(
        caught instanceof DeniedPathError,
        `expected DeniedPathError for ${url}, got ${caught.name}: ${caught.message}`,
      );
      assert.equal(transport.calls, 0, `transport was called for denied path ${url}`);
    } finally {
      cleanup();
    }
  }
});

test('a 200 with ETag and Last-Modified updates feed_state; next request carries both headers', async () => {
  const url = 'https://www.ozbargain.com.au/deals/feed';
  const { client, transport, store, cleanup } = makeClient({
    [url]: {
      status: 200,
      headers: { etag: '"abc123"', 'last-modified': 'Sat, 19 Sep 2026 06:20:00 GMT' },
      body: '<rss></rss>',
    },
  });

  try {
    const first = await client.request(url);
    assert.equal(first.class, 'ok');

    const state = store.getFeedState(url);
    assert.equal(state.etag, '"abc123"');
    assert.equal(state.last_modified, 'Sat, 19 Sep 2026 06:20:00 GMT');

    const second = await client.request(url);
    assert.equal(second.class, 'ok');

    const secondCall = transport.requestLog[1];
    assert.equal(secondCall.options.headers['if-none-match'], '"abc123"');
    assert.equal(secondCall.options.headers['if-modified-since'], 'Sat, 19 Sep 2026 06:20:00 GMT');
  } finally {
    cleanup();
  }
});

test('a 304 returns not_modified, zero-length body, and leaves feed_state untouched', async () => {
  const url = 'https://www.ozbargain.com.au/deals/feed';
  const { client, store, cleanup } = makeClient({
    [url]: { status: 304, headers: {}, body: '' },
  });

  try {
    store.setFeedState(url, '"seed-etag"', 'Sat, 19 Sep 2026 01:00:00 GMT');

    const result = await client.request(url);
    assert.equal(result.class, 'not_modified');
    assert.equal(result.body.length, 0);

    const state = store.getFeedState(url);
    assert.equal(state.etag, '"seed-etag"');
    assert.equal(state.last_modified, 'Sat, 19 Sep 2026 01:00:00 GMT');
  } finally {
    cleanup();
  }
});

test('forgetValidators clears the cached validators for a URL; the next request goes out without them', async () => {
  const url = 'https://www.ozbargain.com.au/classified';
  const { client, transport, store, cleanup } = makeClient({
    [url]: {
      status: 200,
      headers: { etag: '"abc123"', 'last-modified': 'Sat, 19 Sep 2026 06:20:00 GMT' },
      body: '<html></html>',
    },
  });

  try {
    // A 200 caches the validators.
    await client.request(url);
    let state = store.getFeedState(url);
    assert.equal(state.etag, '"abc123"');

    // forgetValidators drops them (nulls the nullable feed_state row).
    client.forgetValidators(url);
    state = store.getFeedState(url);
    assert.equal(state.etag, null);
    assert.equal(state.last_modified, null);

    // The next request goes out without If-None-Match / If-Modified-Since.
    await client.request(url);
    const secondCall = transport.requestLog[1];
    assert.equal(secondCall.options.headers['if-none-match'], undefined);
    assert.equal(secondCall.options.headers['if-modified-since'], undefined);
  } finally {
    cleanup();
  }
});

test('forgetValidators on a URL with no cached state does not throw and leaves no usable validators', async () => {
  const url = 'https://www.ozbargain.com.au/classified';
  const { client, store, cleanup } = makeClient({
    [url]: { status: 200, headers: {}, body: '<html></html>' },
  });

  try {
    // No throw, and the resulting state carries no usable validators.
    client.forgetValidators(url);
    const state = store.getFeedState(url);
    // setFeedState(url, null, null) upserts a row, so the row exists but its
    // validators are null — i.e. nothing to send on the next request.
    assert.ok(state === null || (state.etag === null && state.last_modified === null));
  } finally {
    cleanup();
  }
});
