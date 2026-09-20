import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from '../../../lib/store/index.js';
import { fixedClock } from '../../../lib/clock.js';
import { setStoreForTest } from '../../../lib/web/db.js';
import { renderToStaticMarkup } from 'react-dom/server';
import StatusPage from '../../../app/page.js';

/**
 * Render the status screen (screen 1) with a fixture-seeded store and assert
 * the data is bound into the markup. The page is a server component that reads
 * the shared store; `setStoreForTest` points it at a temp DB so the render
 * never touches the real database.
 */
describe('render: the status screen binds the seeded store data', () => {
  let store;
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ozb-render-'));
    store = openStore({ path: join(dir, 'test.db'), clock: fixedClock('2026-09-19T07:30:00Z') });
    // A successful poll with a backoff in effect.
    store.setPollState({
      lastSuccessAt: '2026-09-19T07:30:00Z',
      lastResponseClass: 'ok',
      backoffSeconds: 30,
      consecutiveFailures: 0,
    });
    // Two deals in the store.
    const now = '2026-09-19T07:30:00Z';
    store.upsertDeal({
      node_id: 101,
      title: 'Deal one',
      url: 'https://example.com/deal-1',
      author: 'a',
      posted_at: now,
      categories: 'deals',
      merchant_url: null,
      expiry_at: null,
      first_seen: now,
      front_page_first_seen: null,
    });
    store.upsertDeal({
      node_id: 102,
      title: 'Deal two',
      url: 'https://example.com/deal-2',
      author: 'b',
      posted_at: now,
      categories: 'deals',
      merchant_url: null,
      expiry_at: null,
      first_seen: now,
      front_page_first_seen: null,
    });
    setStoreForTest(store);
  });
  after(() => {
    setStoreForTest(null);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('the status screen renders the seeded poll state and counts', () => {
    const html = renderToStaticMarkup(StatusPage());
    assert.match(html, /Status/, 'the screen heading');
    assert.match(html, /2026-09-19T07:30:00Z/, 'the last successful poll timestamp');
    assert.match(html, /ok/, 'the last response class');
    assert.match(html, /30s/, 'the backoff in effect');
    assert.match(html, /Deals in store/, 'the deals count label');
    assert.match(html, /Observations/, 'the observations label');
  });

  test('the deals count reflects the two seeded deals', () => {
    const html = renderToStaticMarkup(StatusPage());
    // The two seeded deals: the count "2" appears in the deals row.
    assert.match(html, /<dd>2<\/dd>/, 'two deals are counted');
  });
});
