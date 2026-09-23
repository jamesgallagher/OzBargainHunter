import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDevMockTransport, createDevMockTransport } from '../../../lib/http/mock-transport.js';
import { buildDealPollUrls } from '../../../lib/acquire/poll.js';

// The config the dev .env uses: the live OzBargain URLs. The mock must serve
// fixtures for exactly these URLs so the worker never reaches the network.
const CONFIG = {
  OZB_DEALS_FEED_URL: 'https://www.ozbargain.com.au/deals/feed',
  OZB_FRONT_FEED_URL: 'https://www.ozbargain.com.au/feed',
  OZB_CLASSIFIEDS_URL: 'https://www.ozbargain.com.au/classified',
};

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/http');

test('isDevMockTransport: true only when the flag is truthy and not production', () => {
  assert.equal(isDevMockTransport({ OZB_DEV_MOCK_TRANSPORT: 'true', NODE_ENV: 'development' }), true);
  assert.equal(isDevMockTransport({ OZB_DEV_MOCK_TRANSPORT: '1', NODE_ENV: 'test' }), true);
  assert.equal(isDevMockTransport({ OZB_DEV_MOCK_TRANSPORT: 'yes' }), true); // no NODE_ENV set
  assert.equal(isDevMockTransport({ OZB_DEV_MOCK_TRANSPORT: 'on', NODE_ENV: '' }), true);
  // Flag unset or falsy.
  assert.equal(isDevMockTransport({ NODE_ENV: 'development' }), false);
  assert.equal(isDevMockTransport({ OZB_DEV_MOCK_TRANSPORT: 'false', NODE_ENV: 'development' }), false);
  assert.equal(isDevMockTransport({ OZB_DEV_MOCK_TRANSPORT: 'off', NODE_ENV: 'development' }), false);
  assert.equal(isDevMockTransport({ OZB_DEV_MOCK_TRANSPORT: '', NODE_ENV: 'development' }), false);
  // Inert in production, even with the flag set.
  assert.equal(isDevMockTransport({ OZB_DEV_MOCK_TRANSPORT: 'true', NODE_ENV: 'production' }), false);
  assert.equal(isDevMockTransport({ OZB_DEV_MOCK_TRANSPORT: '1', NODE_ENV: 'production' }), false);
});

test('createDevMockTransport serves the four poll URLs from fixtures and never calls fetch', async () => {
  const transport = createDevMockTransport(CONFIG);
  const urls = [...buildDealPollUrls(CONFIG), CONFIG.OZB_CLASSIFIEDS_URL];
  assert.equal(urls.length, 4);

  // Sabotage globalThis.fetch: if the mock reaches for the network it throws.
  const realFetch = globalThis.fetch;
  let fetchCalled = 0;
  globalThis.fetch = () => {
    fetchCalled += 1;
    throw new Error('DevMockTransport must not call globalThis.fetch');
  };
  try {
    for (const url of urls) {
      const res = await transport.fetch(url);
      assert.equal(res.status, 200);
      assert.ok(res.body.length > 0, `empty body for ${url}`);
      assert.ok(res.bytes > 0, `zero bytes for ${url}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetchCalled, 0, 'the mock transport called globalThis.fetch');
});

test('createDevMockTransport serves the same fixture the real fixtures carry', async () => {
  const transport = createDevMockTransport(CONFIG);
  const [page0, page1, front] = buildDealPollUrls(CONFIG);

  const p0 = await transport.fetch(page0);
  const p1 = await transport.fetch(page1);
  const fr = await transport.fetch(front);
  const cl = await transport.fetch(CONFIG.OZB_CLASSIFIEDS_URL);

  assert.equal(p0.body, readFileSync(resolve(FIXTURES_DIR, 'r0.xml'), 'utf8'));
  assert.equal(p1.body, readFileSync(resolve(FIXTURES_DIR, 'r1.xml'), 'utf8'));
  assert.equal(fr.body, readFileSync(resolve(FIXTURES_DIR, 'feed_feed.xml'), 'utf8'));
  assert.equal(cl.body, readFileSync(resolve(FIXTURES_DIR, 'classifieds-page.html'), 'utf8'));
});

test('createDevMockTransport throws for a URL outside the four poll URLs', async () => {
  const transport = createDevMockTransport(CONFIG);
  // A page beyond 1 (the two-page cap) is not one of the four poll URLs.
  await assert.rejects(
    () => transport.fetch('https://www.ozbargain.com.au/deals/feed?page=2'),
    /no route for URL/,
  );
});

test('createDevMockTransport works with a config that omits the feed URLs (defaults)', async () => {
  const transport = createDevMockTransport({});
  // buildDealPollUrls with no config uses the production defaults, which the
  // mock must still serve — the worker always requests exactly these URLs.
  const urls = [...buildDealPollUrls({}), 'https://www.ozbargain.com.au/classified'];
  for (const url of urls) {
    const res = await transport.fetch(url);
    assert.equal(res.status, 200);
    assert.ok(res.body.length > 0);
  }
});
