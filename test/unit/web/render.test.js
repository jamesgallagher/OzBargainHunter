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
import Layout, { metadata } from '../../../app/layout.js';
import StatusPage from '../../../app/page.js';
import RulesPage from '../../../app/rules/page.js';
import NewRulePage from '../../../app/rules/new/page.js';
import EditRulePage from '../../../app/rules/[id]/page.js';
import AlertsPage from '../../../app/alerts/page.js';
import SuppressionsPage from '../../../app/suppressions/page.js';
import ThresholdsPage from '../../../app/thresholds/page.js';
import DeliveryPage from '../../../app/delivery/page.js';
import ClassifiedsSessionPage from '../../../app/classifieds-session/page.js';
import LocalTime from '../../../app/components/local-time.js';
import { formatMelbourne } from '../../../lib/time.js';
import { defaultGate } from '../../../lib/gate/rules.js';

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
    store.upsertProvider('matrix', JSON.stringify({ homeserver: 'https://matrix.example.com', room: '!r:example.com' }), true);

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

  test('screen 1 (status) renders the seeded poll state and counts', async () => {
    const html = renderToStaticMarkup(await StatusPage());
    assert.match(html, /Status/, 'the screen heading');
    assert.match(html, /2026-09-19T07:30:00Z/, 'the last successful poll timestamp');
    assert.match(html, /ok/, 'the last response class');
    assert.match(html, /30s/, 'the backoff in effect');
    assert.match(html, /Deals in store/, 'the deals count label');
    assert.match(html, /Observations/, 'the observations label');
  });

  test('the status screen counts the fixture deals (M-m8)', async () => {
    const html = renderToStaticMarkup(await StatusPage());
    const dealsFixture = JSON.parse(readFileSync(join(FIXTURES, 'deals-page0.json'), 'utf8'));
    assert.match(html, new RegExp(`<span class="stat-value">${dealsFixture.records.length}</span>`), 'the fixture deal count is shown');
  });

  test('the status screen lists failures newest-first, capped at ten, with show-more and clear controls', async () => {
    // Seed 15 failures in order; the last inserted (fail-15) is the newest and
    // gets the highest id, so getFailures() (ORDER BY id DESC) puts it first.
    for (let i = 1; i <= 15; i += 1) {
      const n = String(i).padStart(2, '0');
      store.insertFailure({
        failed_at: `2026-09-19T08:${n}:00Z`,
        response_class: `fail-${n}`,
        body: `failure body ${n}`,
      });
    }
    const html = renderToStaticMarkup(await StatusPage());
    assert.match(html, /fail-15/, 'the newest failure is shown');
    assert.match(html, /fail-06/, 'the tenth-newest failure is the last of the default ten');
    assert.doesNotMatch(html, /fail-05/, 'the eleventh-newest failure is hidden by default');
    assert.match(html, /Show more/, 'the show-more control is offered while rows remain');
    assert.match(html, /Clear failures/, 'the clear-failures control is offered');
    assert.match(html, /\/failures\/clear/, 'the clear control posts to its own segment');
  });

  test('the status screen shows the empty state when there are no failures', async () => {
    store.clearFailures();
    const html = renderToStaticMarkup(await StatusPage());
    assert.match(html, /No recent failures\./, 'the empty state is shown');
    assert.doesNotMatch(html, /Show more/, 'no show-more control when there is nothing to reveal');
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

  test('screen 7 (thresholds) renders the Freebie alerts card with two independent switches and the threshold rule', async () => {
    const html = renderToStaticMarkup(await ThresholdsPage());
    assert.match(html, /Thresholds/, 'the screen heading');
    assert.match(html, /Freebie alerts/, 'the Freebie alerts card heading');
    assert.match(html, /Alert on anything OzBargain lists as a freebie/, 'the card description');
    assert.match(html, /Deals/, 'the Deals switch label');
    assert.match(html, /Classifieds/, 'the Classifieds switch label');
    assert.match(html, /\/thresholds\/freebie-deals/, 'the deals form posts to its own segment');
    assert.match(html, /\/thresholds\/freebie/, 'the classifieds form posts to its own segment');
    assert.match(html, /5\+ upvotes/, 'the threshold rule label');
  });

  test('screen 7: both freebie switches default checked (absent means on)', async () => {
    // A fresh store with no freebie settings: both switches are checked
    // (absent = on).
    const freshDir = mkdtempSync(join(tmpdir(), 'ozb-freebie-fresh-'));
    const freshStore = openStore({ path: join(freshDir, 'test.db'), clock: fixedClock('2026-09-19T07:30:00Z') });
    setStoreForTest(freshStore);
    try {
      const html = renderToStaticMarkup(await ThresholdsPage());
      assert.match(html, /<input id="deal-freebie-setting" type="checkbox" name="freebie_deals" checked/, 'the Deals switch is checked (absent = on)');
      assert.match(html, /<input id="classifieds-freebie-setting" type="checkbox" name="freebie" checked/, 'the Classifieds switch is checked (absent = on)');
    } finally {
      setStoreForTest(store);
      freshStore.close();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });

  test('screen 7: a setting of "0" unchecks its switch; "1" keeps it checked', async () => {
    store.setSetting('always_notify_deal_freebie', '0');
    store.setSetting('always_notify_freebie', '1');
    try {
      const html = renderToStaticMarkup(await ThresholdsPage());
      assert.match(html, /<input id="deal-freebie-setting" type="checkbox" name="freebie_deals"\/>/, 'the Deals switch is unchecked (setting "0")');
      assert.doesNotMatch(html, /<input id="deal-freebie-setting" type="checkbox" name="freebie_deals" checked/, 'the Deals switch is not checked');
      assert.match(html, /<input id="classifieds-freebie-setting" type="checkbox" name="freebie" checked/, 'the Classifieds switch is checked (setting "1")');
    } finally {
      store.deleteSetting('always_notify_deal_freebie');
      store.deleteSetting('always_notify_freebie');
    }
  });

  test('screen 7: the classifieds hint is shown when classifieds polling is off or no session is stored', async () => {
    // The store has no classifieds_enabled and no ozb_account_cookie, so the
    // hint is shown.
    const html = renderToStaticMarkup(await ThresholdsPage());
    assert.match(html, /Classifieds polling is off, so no classified freebies will be seen/, 'the classifieds hint is shown');
    assert.match(html, /\/classifieds-session/, 'the hint links to the classifieds session');
  });

  test('screen 7: the classifieds hint is hidden when classifieds polling is on and a session is stored', async () => {
    store.setSetting('classifieds_enabled', '1');
    store.setSetting('ozb_account_cookie', 'some-cookie');
    try {
      const html = renderToStaticMarkup(await ThresholdsPage());
      assert.doesNotMatch(html, /Classifieds polling is off, so no classified freebies will be seen/, 'the classifieds hint is hidden');
    } finally {
      store.deleteSetting('classifieds_enabled');
      store.deleteSetting('ozb_account_cookie');
    }
  });

  test('the rules page shows the freebie alerts line reflecting the two settings', async () => {
    const html = renderToStaticMarkup(RulesPage());
    assert.match(html, /Freebie alerts: Deals on · Classifieds on/, 'the freebie alerts line (absent = on)');
    assert.match(html, /\/thresholds/, 'the line links to the thresholds settings');
  });

  test('the rules page freebie line reflects a setting of "0"', async () => {
    store.setSetting('always_notify_deal_freebie', '0');
    try {
      const html = renderToStaticMarkup(RulesPage());
      assert.match(html, /Freebie alerts: Deals off · Classifieds on/, 'the freebie alerts line reflects the off setting');
    } finally {
      store.deleteSetting('always_notify_deal_freebie');
    }
  });

  test('screen 5 (alert history) lists a freebie ledger row with its Freebie · Deal or Freebie · Classified badge', async () => {
    // Seed a freebie ledger row (rule 0) for a deal that was first seen in the
    // freebies feed (freebie_first_seen set) and one for a classifieds freebie
    // (freebie_first_seen null).
    const now = '2026-09-19T07:30:00Z';
    // A deal freebie: the node is in the deals table with freebie_first_seen set.
    store.upsertDeal({
      node_id: 977067,
      title: '[iOS, Android] Free Pair of adidas Shoes Avatar Clothing @ Pokémon GO',
      url: 'https://www.ozbargain.com.au/node/977067',
      author: 'RichardL',
      posted_at: now,
      categories: [],
      merchant_url: null,
      expiry_at: null,
      first_seen: now,
      freebie_first_seen: now,
    });
    store.insertLedger({ node_id: 977067, rule_id: 0, fired_at: now, sent: 1 });
    // A classifieds freebie: the node is in the deals table with freebie_first_seen null.
    store.upsertDeal({
      node_id: 975712,
      title: 'Classifieds Freebie Listing',
      url: 'https://www.ozbargain.com.au/node/975712',
      author: 'ausdkunst',
      posted_at: now,
      categories: [],
      merchant_url: null,
      expiry_at: null,
      first_seen: now,
    });
    store.insertLedger({ node_id: 975712, rule_id: 0, fired_at: now, sent: 1 });

    const html = renderToStaticMarkup(AlertsPage());
    // The deal freebie row shows a Freebie badge and the Deal surface.
    assert.ok(html.includes('[iOS, Android] Free Pair of adidas Shoes Avatar Clothing @ Pokémon GO'), 'the deal freebie title is listed');
    assert.ok(html.includes('Freebie'), 'the Freebie badge is shown');
    assert.ok(html.includes('Deal'), 'the Deal surface is shown for the deal freebie');
    // The classifieds freebie row shows a Freebie badge and the Classified surface.
    assert.ok(html.includes('Classifieds Freebie Listing'), 'the classifieds freebie title is listed');
    assert.ok(html.includes('Classified'), 'the Classified surface is shown for the classifieds freebie');
  });

  test('screen 8 (delivery) renders the mechanism cards and test-send', async () => {
    const html = renderToStaticMarkup(await DeliveryPage());
    assert.match(html, /Delivery/, 'the screen heading');
    assert.match(html, /Matrix/, 'the Matrix mechanism card');
    assert.match(html, /Add Brevo SMTP delivery/, 'the Brevo mechanism add button');
    assert.match(html, /Test send/, 'the test-send button');
    // Add/edit forms are rendered only after their client-side action; route
    // behavior is covered by the delivery-route tests.
    assert.match(html, /\/delivery\/test-send/, 'the test-send form posts to its own segment');
  });

  test('screen 8 marks unsupported saved providers and does not offer them for test-send', async () => {
    store.upsertProvider('email', JSON.stringify({ to: 'legacy@example.com' }), true);
    try {
      const html = renderToStaticMarkup(await DeliveryPage());
      assert.match(html, /Unsupported saved delivery: email/);
      assert.match(html, /Delete saved email configuration/);
      assert.doesNotMatch(html, /<option[^>]*value="email"/);
    } finally {
      store.deleteProvider('email');
    }
  });

  test('screen 9 (classifieds session) renders validity, last-confirmed and the toggle form', async () => {
    const html = renderToStaticMarkup(await ClassifiedsSessionPage());
    assert.match(html, /Classifieds session/, 'the screen heading');
    assert.match(html, /Valid/, 'the session is valid');
    assert.match(html, /226301/, 'the uid is bound');
    assert.match(html, /Last confirmed working/, 'the last-confirmed label');
    assert.match(html, /2026-09-19T06:00:00Z/, 'the last-confirmed instant');
    assert.match(html, /Enable classifieds polling/, 'the enabled checkbox label');
    assert.match(html, /\/classifieds-session\/toggle/, 'the toggle form posts to its own segment');
  });

  test('screen 9 distinguishes valid, expired and not-yet-confirmed session states', async () => {
    store.setSetting('classifieds_last_uid', '0');
    const expired = renderToStaticMarkup(await ClassifiedsSessionPage());
    assert.match(expired, /class="badge" data-tone="danger">Expired</, 'uid 0 is explicitly expired');
    assert.doesNotMatch(expired, />Not yet confirmed</, 'uid 0 is not an unknown session');

    store.deleteSetting('classifieds_last_uid');
    const unknown = renderToStaticMarkup(await ClassifiedsSessionPage());
    assert.match(unknown, /class="badge" data-tone="neutral">Not yet confirmed</, 'an absent uid has no confirmed state');
    assert.doesNotMatch(unknown, />Expired</, 'an absent uid is not known to be expired');

    store.setSetting('classifieds_last_uid', '226301');
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

  test('a page rendered inside the layout shows the last-checked instant', async () => {
    const html = renderToStaticMarkup(createElement(Layout, null, renderToStaticMarkup(await StatusPage())));
    assert.match(html, /Last checked:/, 'the last-checked label');
    assert.match(html, /2026-09-19T07:30:00Z/, 'the last-checked instant (poll_state.last_success_at)');
    assert.match(html, /ok/, 'the last response class');
    assert.match(html, /backoff 30s/, 'the backoff in the header');
  });

  test('the layout shows "never" when no poll has succeeded', async () => {
    // A fresh store with no poll_state row: the layout's `?? 'never'` fallback
    // applies. (setPollState preserves a stored last_success_at when passed
    // null, so a fresh store is the honest "no poll yet" state.)
    const freshDir = mkdtempSync(join(tmpdir(), 'ozb-layout-never-'));
    const freshStore = openStore({ path: join(freshDir, 'test.db'), clock: fixedClock('2026-09-19T07:30:00Z') });
    setStoreForTest(freshStore);
    try {
      const html = renderToStaticMarkup(createElement(Layout, null, renderToStaticMarkup(await StatusPage())));
      assert.match(html, /Last checked: <time dateTime="never">never<\/time>/, 'no last success renders "never"');
    } finally {
      setStoreForTest(store);
      freshStore.close();
      rmSync(freshDir, { recursive: true, force: true });
    }
  });
});

// The layout metadata's icon is cache-busted with the package version
// (?v=<VERSION>): a new version changes the URL so browsers re-fetch the
// icon. The icon route stays authenticated (not public) — the query string
// does not change that.
describe('render: the layout metadata icon is cache-busted by the package version', () => {
  test('the layout metadata icon URL starts with /favicon.ico?v=', () => {
    assert.ok(
      typeof metadata.icons.icon === 'string',
      'the layout metadata exposes a string icon',
    );
    assert.ok(
      metadata.icons.icon.startsWith('/favicon.ico?v='),
      `the icon URL starts with /favicon.ico?v= (got ${metadata.icons.icon})`,
    );
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
    store.upsertProvider('matrix', JSON.stringify({ homeserver: 'https://matrix.example.com', room: '!r:example.com' }), true);
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

// M-m8: LocalTime hydration parity. `LocalTime` is a 'use client' component
// whose `useState` initializer runs on the first client render and calls
// `formatMelbourne(iso)`. Because `formatMelbourne` is pure and its locale is
// pinned to `en-AU`, the server render (the same initializer, computed during
// `renderToStaticMarkup`) produces byte-identical text to the first client
// render — so there is no post-hydration flash. Rendering it server-side and
// asserting the `<time>` text equals `formatMelbourne(iso)` proves the two
// renders use the same formatter, and the `dateTime`/`title` attributes keep
// the absolute ISO instant (AC-7).
describe('render: LocalTime server render matches the first client render', () => {
  test('the <time> text equals formatMelbourne(iso) and preserves the ISO instant', () => {
    const iso = '2026-09-19T06:20:00Z';
    const html = renderToStaticMarkup(createElement(LocalTime, { iso }));
    // The <time> element is present and preserves the absolute ISO instant in
    // both dateTime and title (AC-7).
    assert.match(html, /<time class="local-time-value" dateTime="2026-09-19T06:20:00Z" title="2026-09-19T06:20:00Z">/);
    // The server-rendered text content equals formatMelbourne(iso) — the exact
    // value the useState initializer computes on the first client render.
    const m = html.match(/<time[^>]*>(.*?)<\/time>/);
    assert.ok(m, 'the <time> element has text content');
    assert.equal(m[1], formatMelbourne(iso), 'server render text === formatMelbourne(iso)');
    // And it is the en-AU Melbourne wall clock, not the raw ISO instant.
    assert.equal(m[1], '19 Sept 2026, 4:20:00 pm');
  });
});

// A7/A9: the gate banner on every screen (design 3.7, chunk 2). Each test
// seeds the `access_gate` row directly (and, where the wording depends on
// it, one `gate_events` row) and renders all nine screens inside `Layout`.
// The layout and the status screen read the gate with the SYSTEM clock, so
// any instant that must be in the future (a cooling `until_at`, a
// `min_resume_at` before the resume is allowed) is computed relative to the
// real now; fixed 2024-01-01 instants are safely in the past.
describe('render: the gate banner on every screen (A7, A9)', () => {
  async function renderEveryScreenWithGate(seedRow, seedEvents, markEmailStatus) {
    const dir = mkdtempSync(join(tmpdir(), 'ozb-gate-render-'));
    const store = openStore({ path: join(dir, 'test.db'), clock: fixedClock('2026-09-19T07:30:00Z') });
    setStoreForTest(store);
    try {
      const now = '2026-09-19T07:30:00Z';
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
      store.upsertProvider('matrix', JSON.stringify({ homeserver: 'https://matrix.example.com', room: '!r:example.com' }), true);
      store.applyGateTransition(seedRow, seedEvents);
      if (markEmailStatus) {
        const ev = store.getGateEvents()[0];
        store.setGateEventEmailStatus(ev.id, markEmailStatus);
      }
      const screens = {
        status: await StatusPage(),
        rules: RulesPage(),
        'rule-create': await NewRulePage(),
        'rule-edit': await EditRulePage({ params: { id: '1' } }),
        alerts: AlertsPage(),
        suppressions: SuppressionsPage(),
        thresholds: await ThresholdsPage(),
        delivery: await DeliveryPage(),
        'classifieds-session': await ClassifiedsSessionPage(),
      };
      const out = {};
      for (const [name, pageEl] of Object.entries(screens)) {
        // The awaited page element goes straight into the layout — rendering
        // it to a string first would make React escape the page markup.
        out[name] = renderToStaticMarkup(createElement(Layout, null, pageEl));
      }
      return out;
    } finally {
      setStoreForTest(null);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // The exact string `class="gate-banner"` (with the closing quote) matches
  // only the banner div — the inner elements are `gate-banner-*`.
  function assertExactlyOneBanner(html, screen) {
    assert.equal(html.split('class="gate-banner"').length - 1, 1, `${screen}: exactly one .gate-banner`);
  }

  test('A7: a cooling gate shows the banner on every screen with the 4.6 wording', async () => {
    // The cool-off must still be in the future on the SYSTEM clock, or the
    // effective state reads as `probing`.
    const sinceIso = new Date().toISOString();
    const untilIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const out = await renderEveryScreenWithGate(
      { ...defaultGate(), state: 'cooling', rule: 'B2', tier: 2, reason: 'rate limited', since: sinceIso, until_at: untilIso },
      [],
    );
    for (const [name, html] of Object.entries(out)) {
      assertExactlyOneBanner(html, name);
      assert.match(html, /class="gate-banner" role="alert" data-gate-state="cooling"/, `${name}: the banner element`);
      assert.ok(html.includes('OzBargain is being backed off'), `${name}: the banner title`);
      assert.ok(html.includes(`No requests until ${formatMelbourne(untilIso)} (B2: rate limited, tier 2).`), `${name}: the banner detail`);
      assert.match(html, /class="health-summary" data-health="attention"/, `${name}: the header health tone`);
    }
    assert.ok(out.status.includes(`Backing off — no requests until ${formatMelbourne(untilIso)}.`), 'the status screen line');
  });

  test('A7: a probing gate shows the resuming banner on every screen', async () => {
    const out = await renderEveryScreenWithGate(
      { ...defaultGate(), state: 'probing', rule: 'B5', tier: 0, reason: 'manual resume', since: '2026-09-19T07:30:00Z' },
      [],
    );
    for (const [name, html] of Object.entries(out)) {
      assertExactlyOneBanner(html, name);
      assert.match(html, /class="gate-banner" role="alert" data-gate-state="probing"/, `${name}: the banner element`);
      assert.ok(html.includes('OzBargain is being backed off'), `${name}: the banner title`);
      assert.ok(html.includes('Resuming — one test request will be made at the next poll.'), `${name}: the banner detail`);
      assert.match(html, /class="health-summary" data-health="attention"/, `${name}: the header health tone`);
    }
    assert.ok(out.status.includes('Resuming — one test request will be made at the next poll.'), 'the status screen line');
  });

  test('A7: a stopped gate before min_resume_at shows the banner, the panel and a disabled resume', async () => {
    // The earliest resume must still be in the future on the SYSTEM clock,
    // or the resume button would be enabled.
    const sinceIso = new Date().toISOString();
    const minResumeIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const out = await renderEveryScreenWithGate(
      { ...defaultGate(), state: 'stopped', rule: 'B1', tier: 0, reason: 'Cloudflare block', since: sinceIso, min_resume_at: minResumeIso },
      [{ at: sinceIso, from_state: 'cooling', to_state: 'stopped', rule: 'B1', tier: 0, reason: 'cloudflare block on deals feed', until_at: null, min_resume_at: minResumeIso }],
    );
    for (const [name, html] of Object.entries(out)) {
      assertExactlyOneBanner(html, name);
      assert.match(html, /class="gate-banner" role="alert" data-gate-state="stopped"/, `${name}: the banner element`);
      assert.ok(html.includes('OzBargain access is stopped'), `${name}: the banner title`);
      assert.ok(html.includes(`Cloudflare block at ${formatMelbourne(sinceIso)}. Manual resume available from ${formatMelbourne(minResumeIso)}.`), `${name}: the banner detail`);
      assert.match(html, /class="health-summary" data-health="attention"/, `${name}: the header health tone`);
    }
    const status = out.status;
    assert.ok(status.includes('<dt>State</dt><dd>stopped</dd>'), 'the panel state');
    assert.ok(status.includes('<dt>Rule</dt><dd>B1</dd>'), 'the panel rule');
    assert.ok(status.includes('<dt>Reason</dt><dd>Cloudflare block</dd>'), 'the panel reason');
    assert.ok(status.includes(`<dt>Since</dt><dd>${formatMelbourne(sinceIso)}</dd>`), 'the panel since');
    assert.ok(status.includes(`<dt>Earliest resume</dt><dd>${formatMelbourne(minResumeIso)}</dd>`), 'the panel earliest resume');
    assert.ok(status.includes('<dt>Tier</dt><dd>0</dd>'), 'the panel tier');
    assert.match(status, /class="data-table gate-events"/, 'the event table is present');
    assert.ok(status.includes('cooling → stopped'), 'the event change cell');
    assert.ok(status.includes(`<button type="submit" class="btn btn-primary" disabled="">Available from ${formatMelbourne(minResumeIso)}</button>`), 'the resume button is disabled with the min-resume instant');
  });

  test('A7: a stopped gate after min_resume_at enables the resume button', async () => {
    const out = await renderEveryScreenWithGate(
      { ...defaultGate(), state: 'stopped', rule: 'B1', tier: 0, reason: 'Cloudflare block', since: '2026-09-19T07:30:00Z', min_resume_at: '2024-01-01T00:00:00Z' },
      [{ at: '2026-09-19T07:30:00Z', from_state: 'cooling', to_state: 'stopped', rule: 'B1', tier: 0, reason: 'cloudflare block on deals feed', until_at: null, min_resume_at: '2024-01-01T00:00:00Z' }],
    );
    for (const [name, html] of Object.entries(out)) {
      assertExactlyOneBanner(html, name);
      assert.ok(html.includes('OzBargain access is stopped'), `${name}: the banner title`);
      assert.ok(html.includes('Cloudflare block at 19 Sept 2026, 5:30:00 pm. Manual resume is available now.'), `${name}: the banner detail`);
    }
    assert.match(out.status, /<button type="submit" class="btn btn-primary">Resume OzBargain access<\/button>/, 'the resume button is enabled');
  });

  test('A7: a notify-worthy event that could not be sent shows the email problem in the banner', async () => {
    const out = await renderEveryScreenWithGate(
      { ...defaultGate(), state: 'stopped', rule: 'B1', tier: 0, reason: 'Cloudflare block', since: '2026-09-19T07:30:00Z', min_resume_at: '2026-09-20T07:30:00Z' },
      [{ at: '2026-09-19T07:30:00Z', from_state: 'cooling', to_state: 'stopped', rule: 'B1', tier: 0, reason: 'cloudflare block on deals feed', until_at: null, min_resume_at: '2026-09-20T07:30:00Z' }],
      'not_configured',
    );
    for (const [name, html] of Object.entries(out)) {
      assert.ok(html.includes('Email alert not sent — Brevo is not configured'), `${name}: the email problem line`);
    }
  });

  test('A7: an open gate shows no banner on any screen', async () => {
    const out = await renderEveryScreenWithGate(defaultGate(), []);
    for (const [name, html] of Object.entries(out)) {
      assert.doesNotMatch(html, /class="gate-banner"/, `${name}: no banner`);
    }
    assert.ok(out.status.includes('Access is open.'), 'the status screen line');
  });

  test('A9: rendering a stale cooling row (past until_at) does not touch the gate row or the event table', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ozb-gate-render-a9-'));
    const store = openStore({ path: join(dir, 'test.db'), clock: fixedClock('2026-09-19T07:30:00Z') });
    setStoreForTest(store);
    try {
      const now = '2026-09-19T07:30:00Z';
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
      store.upsertProvider('matrix', JSON.stringify({ homeserver: 'https://matrix.example.com', room: '!r:example.com' }), true);
      store.applyGateTransition(
        { ...defaultGate(), state: 'cooling', rule: 'B2', tier: 2, reason: 'rate limited', since: now, until_at: '2024-01-01T00:00:00Z' },
        [
          { at: now, from_state: 'open', to_state: 'cooling', rule: 'B2', tier: 2, reason: 'rate limited on deals feed', until_at: '2026-09-19T08:30:00Z', min_resume_at: null },
          { at: '2026-09-19T08:30:00Z', from_state: 'cooling', to_state: 'probing', rule: 'B2', tier: 2, reason: 'rate limited on deals feed', until_at: null, min_resume_at: null },
          { at: '2026-09-19T08:31:00Z', from_state: 'probing', to_state: 'cooling', rule: 'B2', tier: 3, reason: 'transport error on deals feed', until_at: '2026-09-19T08:46:00Z', min_resume_at: null },
        ],
      );
      const eventCountBefore = store.getGateEvents().length;
      const rowBefore = JSON.stringify(store.getGate());
      const screens = {
        status: await StatusPage(),
        rules: RulesPage(),
        'rule-create': await NewRulePage(),
        'rule-edit': await EditRulePage({ params: { id: '1' } }),
        alerts: AlertsPage(),
        suppressions: SuppressionsPage(),
        thresholds: await ThresholdsPage(),
        delivery: await DeliveryPage(),
        'classifieds-session': await ClassifiedsSessionPage(),
      };
      const statusHtml = renderToStaticMarkup(createElement(Layout, null, screens.status));
      for (const [name, pageEl] of Object.entries(screens)) {
        renderToStaticMarkup(createElement(Layout, null, pageEl));
      }
      // The stale cooling row reads as probing (viewGate is read-only) — the
      // banner says so, and nothing was written.
      assert.ok(statusHtml.includes('Resuming — one test request will be made at the next poll.'), 'the stale cooling row renders as probing');
      assert.equal(store.getGateEvents().length, eventCountBefore, 'the gate_events row count is unchanged by a render');
      assert.equal(JSON.stringify(store.getGate()), rowBefore, 'the access_gate row is byte-for-byte unchanged by a render');
    } finally {
      setStoreForTest(null);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Chunk 6 (prompt 4.5/4.6): the sign-in wizard on screen 9. The wizard is
// enabled when the gate is open and disabled with the exact 4.5 wording for
// each disabled reason; the `Cookie expires` row is part of the screen.
// Rendering is read-only (prompt 7): every render asserts the gate row, the
// event table and the settings are untouched.
describe('render: screen 9 the sign-in wizard (chunk 6)', () => {
  async function renderScreen9({ gateRow, gateEvents = [], settings = {}, env = {} } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'ozb-wizard-render-'));
    const store = openStore({ path: join(dir, 'test.db'), clock: fixedClock('2026-09-19T07:30:00Z') });
    setStoreForTest(store);
    const savedEnv = {};
    for (const [key, value] of Object.entries(env)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      if (gateRow) store.applyGateTransition(gateRow, gateEvents);
      for (const [key, value] of Object.entries(settings)) store.setSetting(key, value);
      const rowBefore = JSON.stringify(store.getGate());
      const eventsBefore = store.getGateEvents().length;
      const settingsBefore = JSON.stringify(store.getSettings());
      const html = renderToStaticMarkup(await ClassifiedsSessionPage());
      // The page reads getGate(), getGateEvents() and getSetting() — it
      // never applies lazy gate transitions or writes anything (prompt 7).
      assert.equal(JSON.stringify(store.getGate()), rowBefore, 'the access_gate row is byte-for-byte unchanged by a render');
      assert.equal(store.getGateEvents().length, eventsBefore, 'the gate_events row count is unchanged by a render');
      assert.equal(JSON.stringify(store.getSettings()), settingsBefore, 'no setting is written by a render');
      return html;
    } finally {
      setStoreForTest(null);
      store.close();
      rmSync(dir, { recursive: true, force: true });
      for (const [key, saved] of Object.entries(savedEnv)) {
        if (saved === undefined) delete process.env[key];
        else process.env[key] = saved;
      }
    }
  }

  function assertWizardDisabled(html) {
    assert.match(html, /class="wizard-disabled"/, 'the disabled reason is shown');
    assert.match(html, /id="login-username"[^>]*disabled/, 'the username field is disabled');
    assert.match(html, /id="login-password"[^>]*disabled/, 'the password field is disabled');
    assert.match(html, /<button class="btn btn-primary" type="submit" disabled="">Sign in<\/button>/, 'the sign-in button is disabled');
  }

  test('the wizard is enabled when the gate is open, with the title and the help line', async () => {
    const html = await renderScreen9();
    assert.match(html, /<h2 class="card-title">Sign in to OzBargain<\/h2>/, 'the wizard title');
    assert.ok(html.includes('Your username and password are used once to sign in and are never stored. Only the session cookie is kept.'), 'the wizard help line');
    assert.doesNotMatch(html, /class="wizard-disabled"/, 'no disabled reason');
    assert.doesNotMatch(html, /id="login-username"[^>]*disabled/, 'the username field is enabled');
    assert.doesNotMatch(html, /id="login-password"[^>]*disabled/, 'the password field is enabled');
    assert.match(html, /<button class="btn btn-primary" type="submit">Sign in<\/button>/, 'the sign-in button is enabled');
  });

  test('a cooling gate disables the wizard with the 4.5 wording (the cool-off end)', async () => {
    const sinceIso = new Date().toISOString();
    const untilIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const html = await renderScreen9({
      gateRow: { ...defaultGate(), state: 'cooling', rule: 'B2', tier: 2, reason: 'rate limited', since: sinceIso, until_at: untilIso },
    });
    assertWizardDisabled(html);
    assert.ok(html.includes(`OzBargain access is paused or stopped, so sign-in is unavailable until ${formatMelbourne(untilIso)}.`), 'the exact 4.5 wording with the cool-off end');
  });

  test('a stopped gate disables the wizard with the 4.5 wording (the earliest resume)', async () => {
    const sinceIso = new Date().toISOString();
    const minResumeIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const html = await renderScreen9({
      gateRow: { ...defaultGate(), state: 'stopped', rule: 'B1', tier: 0, reason: 'Cloudflare block', since: sinceIso, min_resume_at: minResumeIso },
    });
    assertWizardDisabled(html);
    assert.ok(html.includes(`OzBargain access is paused or stopped, so sign-in is unavailable until ${formatMelbourne(minResumeIso)}.`), 'the exact 4.5 wording with the earliest resume');
  });

  test('a stopped gate with no resume instant says "until access is resumed"', async () => {
    const html = await renderScreen9({
      gateRow: { ...defaultGate(), state: 'stopped', rule: 'B1', tier: 0, reason: 'Cloudflare block', since: new Date().toISOString() },
    });
    assertWizardDisabled(html);
    assert.ok(html.includes('OzBargain access is paused or stopped, so sign-in is unavailable until access is resumed.'), 'the 4.5 wording without a time');
  });

  test('a B6-locked account disables the wizard with the 4.5 wording', async () => {
    const recentAt = new Date(Date.now() - 60 * 1000).toISOString();
    const olderAt = new Date(Date.now() - 120 * 1000).toISOString();
    const lockedUntil = new Date(Date.parse(recentAt) + 24 * 60 * 60 * 1000).toISOString();
    const html = await renderScreen9({
      settings: {
        ozb_login_attempts: JSON.stringify([
          { at: olderAt, outcome: 'validation_error' },
          { at: recentAt, outcome: 'validation_error' },
        ]),
      },
    });
    assertWizardDisabled(html);
    assert.ok(
      html.includes(`Sign-in is locked until ${formatMelbourne(lockedUntil)} after repeated failed attempts (rule B6). Polling is unaffected.`),
      'the exact 4.5 B6 wording',
    );
  });

  test('an unallowed classifieds URL disables the wizard with the 4.5 wording', async () => {
    const html = await renderScreen9({ env: { OZB_CLASSIFIEDS_URL: 'https://evil.example.com/classified' } });
    assertWizardDisabled(html);
    assert.ok(html.includes('Sign-in is unavailable: the classifieds URL is not an allowed OzBargain address.'), 'the exact 4.5 origin wording');
  });

  test('the live origin in dev mode disables the wizard with the 4.5 wording', async () => {
    const html = await renderScreen9({
      env: {
        OZB_CLASSIFIEDS_URL: 'https://www.ozbargain.com.au/classified',
        OZB_DEV_MOCK_TRANSPORT: '1',
        NODE_ENV: 'development',
      },
    });
    assertWizardDisabled(html);
    assert.ok(
      html.includes('Sign-in is unavailable in dev mode while the classifieds URL points at the live site. Run the fixture server with --login.'),
      'the exact 4.5 dev-mode wording',
    );
  });

  test('the Cookie expires row shows the stored expiry, or an em dash when absent', async () => {
    const withExpiry = await renderScreen9({ settings: { ozb_account_cookie_expires_at: '2026-10-19T00:00:00.000Z' } });
    assert.match(withExpiry, /<dt>Cookie expires<\/dt>/, 'the row label');
    assert.match(withExpiry, /<time class="local-time-value" dateTime="2026-10-19T00:00:00.000Z"/, 'the expiry renders as a LocalTime with the ISO instant');

    const without = await renderScreen9();
    const m = without.match(/<dt>Cookie expires<\/dt><dd>(.*?)<\/dd>/);
    assert.ok(m, 'the row is present without the setting');
    assert.equal(m[1], '—', 'an absent expiry renders an em dash');
  });

  test('the legacy paste form is gone (chunk 7)', async () => {
    const html = await renderScreen9();
    assert.doesNotMatch(html, /Paste a session cookie/, 'the paste card is gone');
    assert.doesNotMatch(html, /\/classifieds-session\/set/, 'no form posts to the removed segment');
  });

  test('S4: rendering screen 9 with a gate row and attempts leaves ozb_login_attempts, access_gate and gate_events unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ozb-wizard-s4-'));
    const store = openStore({ path: join(dir, 'test.db'), clock: fixedClock('2026-09-19T07:30:00Z') });
    setStoreForTest(store);
    try {
      const sinceIso = new Date().toISOString();
      const untilIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      // Seed a cooling gate row and a B6-locked attempts record so the render
      // reads all three (the gate, the events, and the attempts).
      store.applyGateTransition(
        { ...defaultGate(), state: 'cooling', rule: 'B2', tier: 2, reason: 'rate limited', since: sinceIso, until_at: untilIso },
        [],
      );
      store.setSetting('ozb_login_attempts', JSON.stringify([
        { at: new Date(Date.now() - 120 * 1000).toISOString(), outcome: 'validation_error' },
        { at: new Date(Date.now() - 60 * 1000).toISOString(), outcome: 'validation_error' },
      ]));
      // Capture the three values before the render.
      const attemptsBefore = store.getSetting('ozb_login_attempts');
      const rowBefore = JSON.stringify(store.getGate());
      const eventsBefore = store.getGateEvents().length;
      // Render screen 9 (it reads getGate(), getGateEvents() and getSetting(ozb_login_attempts)).
      renderToStaticMarkup(await ClassifiedsSessionPage());
      // A render is read-only: all three are byte-for-byte / count unchanged.
      assert.equal(store.getSetting('ozb_login_attempts'), attemptsBefore, 'ozb_login_attempts is byte-for-byte unchanged by a render');
      assert.equal(JSON.stringify(store.getGate()), rowBefore, 'access_gate is byte-for-byte unchanged by a render');
      assert.equal(store.getGateEvents().length, eventsBefore, 'gate_events count is unchanged by a render');
    } finally {
      setStoreForTest(null);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
