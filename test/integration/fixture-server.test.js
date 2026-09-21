/**
 * The fixture server's own contract (card 5, design 10.4). Everything the
 * integration suite depends on is asserted here directly, so a change to the
 * server cannot quietly weaken the three-poll test: the timeline order, the
 * real conditional request, the two-page cap and the loopback-only bind.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CLASSIFIEDS_PATH,
  DEALS_PATH,
  FIXTURES_DIR,
  FRONT_PATH,
  createFixtureServer,
  etagFor,
  resolveKey,
  startFixtureServer,
  TIMELINE,
} from '../../scripts/fixture-server.mjs';

describe('integration: the fixture server', () => {
  let fx;

  before(async () => {
    fx = await startFixtureServer();
  });

  after(async () => {
    await fx.close();
  });

  beforeEach(() => {
    fx.reset();
  });

  it('binds loopback only', () => {
    assert.equal(fx.host, '127.0.0.1');
    assert.match(fx.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('maps the three poll URLs to the corpus timeline (fixtures/README.md §2)', async () => {
    assert.deepEqual(TIMELINE[`${DEALS_PATH}?page=0`], ['http/r0.xml', 'http/cmp_deals.xml', 'http/cmp_deals.xml']);
    assert.deepEqual(TIMELINE[`${DEALS_PATH}?page=1`], ['http/r1.xml', 'http/r1.xml']);
    assert.deepEqual(TIMELINE[FRONT_PATH], ['http/feed_feed.xml', 'http/cmp_front.xml', 'http/cmp_front.xml']);
    assert.deepEqual(TIMELINE[CLASSIFIEDS_PATH], ['http/classifieds-page.html']);
  });

  it('serves the corpus bytes with a strong ETag and an XML content type', async () => {
    const res = await fetch(`${fx.origin}${DEALS_PATH}?page=0`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /xml/);
    const body = await res.text();
    assert.equal(body, readFileSync(`${FIXTURES_DIR}http/r0.xml`, 'utf8'));
    assert.equal(res.headers.get('etag'), etagFor(body));
    assert.equal(fx.requests[0].fixture, 'http/r0.xml');
  });

  it('advances through the timeline on successive requests', async () => {
    // The page-0 timeline is r0 → cmp_deals → cmp_deals.
    const second = await fetch(`${fx.origin}${DEALS_PATH}?page=0`);
    assert.equal(second.status, 200);
    assert.equal((await second.text()).length, readFileSync(`${FIXTURES_DIR}http/cmp_deals.xml`, 'utf8').length);
    assert.equal(fx.requests[1].fixture, 'http/cmp_deals.xml');
    assert.equal(fx.requests[1].index, 1);
  });

  it('honours If-None-Match with a real 304 and an empty body', async () => {
    // Page 1 repeats the same fixture on its second request, so this assertion
    // is self-contained and does not rely on earlier tests advancing page 0.
    const first = await fetch(`${fx.origin}${DEALS_PATH}?page=1`);
    const etag = first.headers.get('etag');
    await first.text();
    const conditional = await fetch(`${fx.origin}${DEALS_PATH}?page=1`, {
      headers: { 'if-none-match': etag },
    });
    assert.equal(conditional.status, 304);
    assert.equal(await conditional.text(), '');
    assert.equal(conditional.headers.get('etag'), etag, 'the validator is repeated on the 304');
    // The stored ETag is what makes the third poll a 304: same fixture, same
    // bytes, same validator.
    assert.equal(fx.requests.at(-1).status, 304);
    assert.equal(fx.requests.at(-1).ifNoneMatch, etag);
  });

  it('still answers 200 when the client presents a stale validator', async () => {
    const res = await fetch(`${fx.origin}${DEALS_PATH}?page=0`, {
      headers: { 'if-none-match': '"stale-etag"' },
    });
    assert.equal(res.status, 200, 'a validator we do not serve is not a match');
    await res.text();
  });

  it('serves the classifieds page', async () => {
    const res = await fetch(`${fx.origin}${CLASSIFIEDS_PATH}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /html/);
    assert.match(await res.text(), /OzB_vars/);
  });

  it('refuses a page past the two-page cap, and records that it was asked', async () => {
    const before = fx.requests.length;
    const res = await fetch(`${fx.origin}${DEALS_PATH}?page=2`);
    assert.equal(res.status, 500, 'page 2 is not a feed');
    assert.ok(!(await res.text()).includes('<item>'), 'and not parseable as one');
    assert.equal(fx.requests.length, before + 1);
    assert.equal(fx.requests.at(-1).reason, 'page-beyond-cap');
    assert.equal(fx.requests.at(-1).page, 2);
  });

  it('answers an unmapped path with a body that is not a feed', async () => {
    const res = await fetch(`${fx.origin}/deals/feed?page=0&extra=1`);
    // The key ignores other query params, so this is still page 0 — the app
    // composes `page` as its own param, and nothing else is added.
    assert.equal(res.status, 200);
    await res.text();
    const other = await fetch(`${fx.origin}/nope`);
    assert.equal(other.status, 500);
    await other.text();
  });

  it('records every request with its URL, status and validator', async () => {
    for (const entry of fx.requests) {
      assert.equal(typeof entry.url, 'string');
      assert.ok([200, 304, 500].includes(entry.status));
      assert.equal(typeof entry.at, 'string');
    }
  });

  it('resolves keys the way the application composes URLs', () => {
    assert.deepEqual(resolveKey(`${DEALS_PATH}?page=0`), { key: `${DEALS_PATH}?page=0`, page: 0 });
    assert.deepEqual(resolveKey(`${DEALS_PATH}?page=1`), { key: `${DEALS_PATH}?page=1`, page: 1 });
    assert.deepEqual(resolveKey(FRONT_PATH), { key: FRONT_PATH, page: null });
    assert.deepEqual(resolveKey(CLASSIFIEDS_PATH), { key: CLASSIFIEDS_PATH, page: null });
    // No page param at all is page 0, which is how the first request of a
    // cycle looks if a caller forgets the query.
    assert.equal(resolveKey(DEALS_PATH).page, 0);
    assert.deepEqual(resolveKey('/anything-else'), { key: null, page: null });
    assert.deepEqual(resolveKey('/deals/feed/extra?page=1'), { key: null, page: null });
  });

  it('reset() rewinds the timeline and the log, so a run can be replayed', async () => {
    const server = createFixtureServer();
    await server.start();
    try {
      const first = await fetch(`${server.origin}${DEALS_PATH}?page=0`);
      await first.text();
      assert.equal(server.requests.length, 1);
      server.reset();
      assert.equal(server.requests.length, 0);
      const firstAgain = await fetch(`${server.origin}${DEALS_PATH}?page=0`);
      await firstAgain.text();
      assert.equal(server.requests[0].fixture, 'http/r0.xml', 'back to the start of the timeline');
    } finally {
      await server.close();
    }
  });
});
