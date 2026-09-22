import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from '../../../lib/store/index.js';
import { fixedClock } from '../../../lib/clock.js';
import { setStoreForTest } from '../../../lib/web/db.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import Layout from '../../../app/layout.js';
import StatusPage from '../../../app/page.js';
import RulesPage from '../../../app/rules/page.js';
import NewRulePage from '../../../app/rules/new/page.js';
import EditRulePage from '../../../app/rules/[id]/page.js';
import AlertsPage from '../../../app/alerts/page.js';
import SuppressionsPage from '../../../app/suppressions/page.js';
import ThresholdsPage from '../../../app/thresholds/page.js';
import DeliveryPage from '../../../app/delivery/page.js';
import ClassifiedsSessionPage from '../../../app/classifieds-session/page.js';

/**
 * One render test per screen (the nine screens of design 7.1, plus the status
 * screen). Each screen is a server component that reads the shared store;
 * `setStoreForTest` points it at a temp DB seeded from `fixtures/records/`
 * (the AC's literal wording) so the render never touches the real database
 * and proves the screen does not throw against the recorded data.
 *
 * M-m8: the deals are loaded from `fixtures/records/deals-page0.json` (not
 * hand-written), the layout's last-checked timestamp is asserted by rendering
 * a page inside `Layout`, and the CSRF hidden input is pinned by setting
 * `OZB_CSRF_SECRET` and asserting the `_csrf` field carries a well-formed
 * token (and is empty when the secret is unset).
 */
const FIXTURES = join('fixtures', 'records');

describe('render: one render test per screen (7.1)', () => {
  let store;
  let dir;
  let firstDeal;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ozb-render-'));
    store = openStore({ path: join(dir, 'test.db'), clock: fixedClock('2026-09-19T07:30:00Z') });
    const now = '2026-09-19T07:30:00Z';

    // Screen 1 (status): a successful poll with a backoff in effect. The
    // layout's last-checked timestamp is the same `last_success_at` value.
    store.setPollState({
      lastSuccessAt: '2026-09-19T07:30:00Z',
      lastResponseClass: 'ok',
      backoffSeconds: 30,
      consecutiveFailures: 0,
    });

    // M-m8: seed the deals from `fixtures/records/deals-page0.json` (the
    // recorded front page) rather than hand-writing two.
    const dealsFixture = JSON.parse(readFileSync(join(FIXTURES, 'deals-page0.json'), 'utf8'));
    firstDeal = dealsFixture.records[0];
    for (const r of dealsFixture.records) {
      store.upsertDeal({
        node_id: r.node_id,
        title: r.title,
        url: r.url,
        author: r.author,
        posted_at: r.posted_at,
        categories: r.categories ?? [],
        merchant_url: r.merchant_url ?? null,
        expiry_at: r.expiry_at ?? null,
        first_seen: now,
        front_page_first_seen: null,
      });
    }

    // Screen 2 (rules list), 3 (edit), 7 (thresholds): a match rule and a
    // threshold rule.
    store.insertRule({
      id: 1,
      type: 'match',
      parameters: JSON.stringify({ term: 'weber' }),
      state: 'enabled',
      surfaces: 'deals',
      cooldown_seconds: 86400,
      pinned_slug: null,
      created_at: now,
      modified_at: now,
    });
    store.insertRule({
      id: 2,
      type: 'threshold',
      parameters: JSON.stringify({ threshold: 5, windowHours: 24 }),
      state: 'muted',
      surfaces: 'deals',
      cooldown_seconds: 86400,
      pinned_slug: null,
      created_at: now,
      modified_at: now,
    });

    // Screen 5 (alert history) + the 7d/30d counts on the rules list: a ledger
    // row for rule 1 pointing at the first fixture deal, within the last 30
    // days. The alerts page joins the deal title from the deals table.
    store.insertLedger({ node_id: firstDeal.node_id, rule_id: 1, fired_at: now, sent: 1 });

    // Screen 6 (suppressions): one suppressed alert (a different fixture deal).
    store.insertSuppression({ poll_at: now, node_id: dealsFixture.records[1].node_id, rule_id: 2, kind: 'cooldown', detail: 'within cooldown' });

    // Screen 8 (delivery): a selected provider.
    store.upsertProvider('email', JSON.stringify({ to: 'a@example.com' }), true);

    // Screen 9 (classifieds session): a valid uid and a last-confirmed instant.
    store.setSetting('classifieds_last_uid', '226301');
    store.setSetting('classifieds_last_confirmed_at', '2026-09-19T06:00:00Z');

    setStoreForTest(store);
  });
  after(() => {
    setStoreForTest(null);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('screen 1 (status) renders the seeded poll state and counts', () => {
    const html = renderToStaticMarkup(StatusPage());
    assert.match(html, /Status/, 'the screen heading');
    assert.match(html, /2026-09-19T07:30:00Z/, 'the last successful poll timestamp');
    assert.match(html, /ok/, 'the last response class');
    assert.match(html, /30s/, 'the backoff in effect');
    assert.match(html, /Deals in store/, 'the deals count label');
    assert.match(html, /Observations/, 'the observations label');
  });

  test('the status screen counts the fixture deals (M-m8)', () => {
    const html = renderToStaticMarkup(StatusPage());
    const dealsFixture = JSON.parse(readFileSync(join(FIXTURES, 'deals-page0.json'), 'utf8'));
    assert.match(html, new RegExp(`<span class="stat-value">${dealsFixture.records.length}</span>`), 'the fixture deal count is shown');
  });

  test('screen 2 (rules list) renders both rules with their state', () => {
    const html = renderToStaticMarkup(RulesPage());
    assert.match(html, /Rules/, 'the screen heading');
    assert.match(html, /weber/, 'the match rule term');
    assert.match(html, /enabled/, 'the match rule state');
    assert.match(html, /muted/, 'the threshold rule state');
    assert.match(html, /5\+ upvotes/, 'the threshold rule label');
  });

  test('screen 3 (rule create) renders the create form without throwing', async () => {
    const html = renderToStaticMarkup(await NewRulePage());
    assert.match(html, /New rule/, 'the screen heading');
    assert.match(html, /\/rules\/new\/create/, 'the form posts to its own segment');
  });

  test('screen 3 (rule edit) renders the edit form for a known rule', async () => {
    const html = renderToStaticMarkup(await EditRulePage({ params: { id: '1' } }));
    assert.match(html, /Edit rule 1/, 'the screen heading');
    assert.match(html, /weber/, 'the rule term is bound');
    assert.match(html, /\/rules\/1\/save/, 'the edit form posts to its own segment');
    assert.match(html, /\/rules\/1\/mute/, 'the mute form is a sibling, not nested');
    assert.match(html, /\/rules\/1\/delete/, 'the delete form is a sibling, not nested');
  });

  test('screen 5 (alert history) renders the seeded fired alert with a link (M-m8)', () => {
    const html = renderToStaticMarkup(AlertsPage());
    assert.match(html, /Alert history/, 'the screen heading');
    assert.ok(html.includes(firstDeal.title), 'the fired alert title (from the fixture)');
    assert.match(html, new RegExp(`https://www\\.ozbargain\\.com\\.au/node/${firstDeal.node_id}`), 'the alert links to the fixture deal');
  });

  test('screen 6 (suppressions) renders the seeded suppressed row', () => {
    const html = renderToStaticMarkup(SuppressionsPage());
    assert.match(html, /Suppressions/, 'the screen heading');
    assert.match(html, /1 suppressed alert/, 'the suppression count');
    assert.match(html, /cooldown/, 'the suppression kind');
  });

  test('screen 7 (thresholds) renders the threshold rule and the freebie checkbox', async () => {
    const html = renderToStaticMarkup(await ThresholdsPage());
    assert.match(html, /Thresholds/, 'the screen heading');
    assert.match(html, /5\+ upvotes/, 'the threshold rule label');
    assert.match(html, /Always notify on freebie/, 'the freebie checkbox');
    assert.match(html, /\/thresholds\/freebie/, 'the freebie form posts to its own segment');
  });

  test('screen 8 (delivery) renders the provider, credential input and test-send', async () => {
    const html = renderToStaticMarkup(await DeliveryPage());
    assert.match(html, /Delivery/, 'the screen heading');
    assert.match(html, /email/, 'the provider kind');
    assert.match(html, /Credentials \(JSON\)/, 'the credential input');
    assert.match(html, /Test send/, 'the test-send button');
    assert.match(html, /\/delivery\/save/, 'the save form posts to its own segment');
    assert.match(html, /\/delivery\/test-send/, 'the test-send form posts to its own segment');
  });

  test('screen 9 (classifieds session) renders validity, last-confirmed and the cookie form', async () => {
    const html = renderToStaticMarkup(await ClassifiedsSessionPage());
    assert.match(html, /Classifieds session/, 'the screen heading');
    assert.match(html, /Valid/, 'the session is valid');
    assert.match(html, /226301/, 'the uid is bound');
    assert.match(html, /Last confirmed working/, 'the last-confirmed label');
    assert.match(html, /2026-09-19T06:00:00Z/, 'the last-confirmed instant');
    assert.match(html, /\/classifieds-session\/set/, 'the cookie form posts to its own segment');
  });
});

// M-m8: the layout's last-checked timestamp. The layout is a server component
// that reads `poll_state.last_success_at`; rendering a page inside `Layout`
// proves the timestamp appears on every page.
describe('render: the layout last-checked timestamp (M-m8)', () => {
  let store;
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ozb-layout-'));
    store = openStore({ path: join(dir, 'test.db'), clock: fixedClock('2026-09-19T07:30:00Z') });
    store.setPollState({
      lastSuccessAt: '2026-09-19T07:30:00Z',
      lastResponseClass: 'ok',
      backoffSeconds: 30,
      consecutiveFailures: 0,
    });
    setStoreForTest(store);
  });
  after(() => {
    setStoreForTest(null);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a page rendered inside the layout shows the last-checked instant', () => {
    const html = renderToStaticMarkup(createElement(Layout, null, renderToStaticMarkup(StatusPage())));
    assert.match(html, /Last checked:/, 'the last-checked label');
    assert.match(html, /2026-09-19T07:30:00Z/, 'the last-checked instant (poll_state.last_success_at)');
    assert.match(html, /ok/, 'the last response class');
    assert.match(html, /backoff 30s/, 'the backoff in the header');
  });

  test('the layout shows "never" when no poll has succeeded', () => {
    // A fresh store with no poll_state row: the layout's `?? 'never'` fallback
    // applies. (setPollState preserves a stored last_success_at when passed
    // null, so a fresh store is the honest "no poll yet" state.)
    const freshDir = mkdtempSync(join(tmpdir(), 'ozb-layout-never-'));
    const freshStore = openStore({ path: join(freshDir, 'test.db'), clock: fixedClock('2026-09-19T07:30:00Z') });
    setStoreForTest(freshStore);
    try {
      const html = renderToStaticMarkup(createElement(Layout, null, renderToStaticMarkup(StatusPage())));
      assert.match(html, /Last checked: <time dateTime="never">never<\/time>/, 'no last success renders "never"');
    } finally {
      setStoreForTest(store);
      freshStore.close();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

// M-m8: the CSRF hidden input. The form pages mint an unbound token from
// `OZB_CSRF_SECRET`; with the secret set the `_csrf` field carries a
// well-formed `value.exp.signature` token, and with it unset the field is
// empty (the pages fail closed at the gate, X10).
describe('render: the CSRF hidden input (M-m8)', () => {
  let store;
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ozb-csrf-'));
    store = openStore({ path: join(dir, 'test.db'), clock: fixedClock('2026-09-19T07:30:00Z') });
    store.upsertProvider('email', JSON.stringify({ to: 'a@example.com' }), true);
    setStoreForTest(store);
  });
  after(() => {
    setStoreForTest(null);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('with OZB_CSRF_SECRET set, the delivery form carries a well-formed _csrf token', async () => {
    process.env.OZB_CSRF_SECRET = 'test-csrf-secret';
    try {
      const html = renderToStaticMarkup(await DeliveryPage());
      const m = html.match(/<input type="hidden" name="_csrf" value="([^"]*)"/);
      assert.ok(m, 'the _csrf hidden input is present');
      const token = m[1];
      assert.match(token, /^[0-9a-f]{48}\.\d+\.[0-9a-f]{64}$/, 'the token is value.exp.signature (48 hex, ms, 64 hex)');
    } finally {
      delete process.env.OZB_CSRF_SECRET;
    }
  });

  test('with OZB_CSRF_SECRET unset, the _csrf field is empty (fails closed, X10)', async () => {
    delete process.env.OZB_CSRF_SECRET;
    const html = renderToStaticMarkup(await DeliveryPage());
    assert.match(html, /<input type="hidden" name="_csrf" value=""/, 'the _csrf field is empty when the secret is unset');
  });
});
