import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openStore } from '../../../lib/store/index.js';
import { evaluatePoll } from '../../../lib/rules/engine.js';
import {
  evaluateDealFreebies,
  isDealFreebieEligible,
  FREEBIE_RULE_ID,
  DEAL_FREEBIE_SETTING_KEY,
  DEAL_FREEBIE_SEEDED_AT_KEY,
} from '../../../lib/notify/freebie.js';
import { groupAndCompose } from '../../../lib/notify/compose.js';
import { parseDealsFeed } from '../../../lib/parse/deals.js';

const HTTP_FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'http');
// The freebies feed (design 6.6, D49) is parsed by the same deals parser; the
// records are the corpus the deal-freebie evaluator reads.
const freebiesFeed = parseDealsFeed(fs.readFileSync(path.join(HTTP_FIXTURES, 'freebies_feed.xml'), 'utf8'));

// The classifieds corpus (design 6.6): a real classifieds freebie (type
// 'free') is the other half of the Activity freebie ledger, and its
// `freebie_first_seen` is null (badge "Freebie · Classified").
const RECORDS_FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'records');
const classifiedsById = (() => {
  const m = new Map();
  for (const r of JSON.parse(fs.readFileSync(path.join(RECORDS_FIXTURES, 'classifieds.json'), 'utf8')).records) m.set(r.node_id, r);
  return m;
})();

// The corpus's own timeline (fixtures/README.md section 1).
const POLL_1_AT = '2026-09-19T07:30:00Z';
const POLL_2_AT = '2026-09-19T08:05:00Z';
const POLL_3_AT = '2026-09-19T08:10:00Z';

function frozenClock(iso) {
  return { now: () => new Date(iso) };
}

function makeStore() {
  return openStore({ path: ':memory:', clock: frozenClock(POLL_1_AT) });
}

// Insert a rule the way the store expects it: a parameters JSON blob plus the
// column fields.
function insertRule(store, { id, type, parameters, state = 'enabled', surfaces = 'deals', cooldownSeconds = 86400, pinnedSlug = null }) {
  const now = '2026-09-19T06:20:00Z';
  store.insertRule({
    id,
    type,
    parameters: JSON.stringify(parameters),
    state,
    surfaces,
    cooldown_seconds: cooldownSeconds,
    pinned_slug: pinnedSlug,
    created_at: now,
    modified_at: now,
  });
}

// A synthetic deal record (the freebies feed is parsed from XML, so a new
// freebie that appears later is modelled as a plain record of the same shape).
function synthFreebie(nodeId, { title = `Free Thing ${nodeId}`, types = [], expiry = null, merchant = null } = {}) {
  return {
    node_id: nodeId,
    title,
    url: `https://www.ozbargain.com.au/node/${nodeId}`,
    author: 'someone',
    posted_at: '2026-09-19T08:00:00Z',
    expiry_at: expiry,
    merchant_url: merchant,
    goto_url: null,
    image_url: null,
    votes_pos: 5,
    votes_neg: 0,
    comment_count: 0,
    click_count: 1,
    categories: [],
    title_msg_types: types,
    description_html: `<p>${title}</p>`,
  };
}

// The eligible subset of the fixture at a given instant (the same check the
// evaluator uses).
function eligibleAt(recs, nowIso) {
  return recs.filter((r) => isDealFreebieEligible(r, nowIso));
}

// ---------------------------------------------------------------------------
// Seeding (design 6.6, D49): the first time the freebies feed is evaluated on
// a store that has never seen it, every eligible item is marked in the ledger
// and nothing is sent, and the deal_freebies_seeded_at key is set. This is
// independent of the worker's coldStart (which only covers an empty database).
// ---------------------------------------------------------------------------
describe('deal freebie: seeding', () => {
  it('a non-empty store with no deal_freebies_seeded_at sends 0 alerts on the first freebies evaluation, writes ledger rows, and sets the key', () => {
    const store = makeStore();
    // Make the store non-empty: a deal from the deals corpus is already
    // present, so the worker's coldStart would not be the trigger.
    store.upsertDeal({
      node_id: 975704,
      title: 'Ubiquiti Unifi Dream Router 7',
      url: 'https://www.ozbargain.com.au/node/975704',
      author: 'routerwatch',
      posted_at: '2026-09-19T07:00:00Z',
      categories: [],
      merchant_url: null,
      expiry_at: null,
      first_seen: '2026-09-19T07:00:00Z',
    });
    assert.ok(store.countDeals() > 0, 'the store is non-empty');
    assert.equal(store.getSetting(DEAL_FREEBIE_SEEDED_AT_KEY), null, 'no seeding key yet');

    const out = evaluatePoll({
      feeds: [{ surface: 'freebies', records: freebiesFeed }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    assert.equal(out.alerts.filter((a) => a.kind === 'deal_freebie').length, 0, 'the first evaluation sends nothing');
    assert.ok(store.getSetting(DEAL_FREEBIE_SEEDED_AT_KEY), 'the seeding key is set');
    // Every eligible item is marked in the ledger (rule 0); the expired ones are not.
    for (const r of eligibleAt(freebiesFeed, POLL_1_AT)) {
      assert.ok(store.hasLedger(r.node_id, FREEBIE_RULE_ID), `eligible node ${r.node_id} is marked in the ledger`);
    }
    for (const r of freebiesFeed.filter((x) => !isDealFreebieEligible(x, POLL_1_AT))) {
      assert.ok(!store.hasLedger(r.node_id, FREEBIE_RULE_ID), `expired node ${r.node_id} is not marked`);
    }
  });

  it('a later poll with one new item sends exactly one deal_freebie', () => {
    const store = makeStore();
    // Seed first (no new items).
    evaluatePoll({
      feeds: [{ surface: 'freebies', records: freebiesFeed }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    // A new freebie appears at poll 2.
    const newFreebie = synthFreebie(999999);
    const out = evaluatePoll({
      feeds: [{ surface: 'freebies', records: [newFreebie] }],
      store, clock: frozenClock(POLL_2_AT), pollAt: POLL_2_AT,
    });
    const dealFreebieAlerts = out.alerts.filter((a) => a.kind === 'deal_freebie');
    assert.equal(dealFreebieAlerts.length, 1, 'exactly one deal_freebie (the new item)');
    assert.equal(dealFreebieAlerts[0].node_id, 999999);
  });

  it('with the setting off, seeding still happens (ledger rows written, key set) and nothing is sent', () => {
    const store = makeStore();
    store.setSetting(DEAL_FREEBIE_SETTING_KEY, '0');
    const out = evaluatePoll({
      feeds: [{ surface: 'freebies', records: freebiesFeed }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    assert.equal(out.alerts.filter((a) => a.kind === 'deal_freebie').length, 0, 'nothing sent while the setting is off');
    assert.ok(store.getSetting(DEAL_FREEBIE_SEEDED_AT_KEY), 'the seeding key is set even with the setting off');
    for (const r of eligibleAt(freebiesFeed, POLL_1_AT)) {
      assert.ok(store.hasLedger(r.node_id, FREEBIE_RULE_ID), `eligible node ${r.node_id} is marked in the ledger`);
    }
  });

  it('turning the setting on later sends only items new since the seeding', () => {
    const store = makeStore();
    // Seed with the setting off.
    store.setSetting(DEAL_FREEBIE_SETTING_KEY, '0');
    evaluatePoll({
      feeds: [{ surface: 'freebies', records: freebiesFeed }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    // Turn the setting on.
    store.setSetting(DEAL_FREEBIE_SETTING_KEY, '1');
    // A new freebie appears.
    const newFreebie = synthFreebie(999999);
    const out = evaluatePoll({
      feeds: [{ surface: 'freebies', records: [newFreebie] }],
      store, clock: frozenClock(POLL_2_AT), pollAt: POLL_2_AT,
    });
    const dealFreebieAlerts = out.alerts.filter((a) => a.kind === 'deal_freebie');
    assert.equal(dealFreebieAlerts.length, 1, 'only the new item alerts');
    assert.equal(dealFreebieAlerts[0].node_id, 999999);
    // Re-evaluating the original feed sends nothing (all already in the ledger).
    const out2 = evaluatePoll({
      feeds: [{ surface: 'freebies', records: freebiesFeed }],
      store, clock: frozenClock(POLL_3_AT), pollAt: POLL_3_AT,
    });
    assert.equal(out2.alerts.filter((a) => a.kind === 'deal_freebie').length, 0, 'the original feed sends nothing after seeding');
  });
});

// ---------------------------------------------------------------------------
// Eligibility (design 6.6): a deal freebie is eligible when it is not expired
// by either the `ozb:title-msg type="expired"` marker or its `expiry_at`
// timestamp. `upcoming`, `targeted` and `longrunning` items are eligible.
// ---------------------------------------------------------------------------
describe('deal freebie: eligibility', () => {
  it('expired freebies (by title-msg or expiry_at) are never eligible', () => {
    // Every fixture record with an `expired` title-msg is not eligible.
    const expiredByTitle = freebiesFeed.filter((r) => r.title_msg_types?.includes('expired'));
    assert.ok(expiredByTitle.length > 0, 'the fixture has expired freebies');
    for (const r of expiredByTitle) {
      assert.equal(isDealFreebieEligible(r, POLL_1_AT), false, `node ${r.node_id} (expired title-msg) is not eligible`);
    }
    // A record with a past `expiry_at` but no title-msg is not eligible.
    const expiredByDate = { node_id: 888888, title: 'Free Expired By Date', expiry_at: '2026-09-18T00:00:00Z', title_msg_types: [] };
    assert.equal(isDealFreebieEligible(expiredByDate, POLL_1_AT), false, 'a past expiry_at is not eligible');
  });

  it('upcoming, targeted and longrunning freebies are eligible', () => {
    const upcoming = freebiesFeed.filter((r) => r.title_msg_types?.includes('upcoming'));
    assert.ok(upcoming.length > 0, 'the fixture has upcoming freebies');
    for (const r of upcoming) {
      assert.equal(isDealFreebieEligible(r, POLL_1_AT), true, `node ${r.node_id} (upcoming) is eligible`);
    }
    const longrunning = freebiesFeed.filter((r) => r.title_msg_types?.includes('longrunning'));
    assert.ok(longrunning.length > 0, 'the fixture has longrunning freebies');
    for (const r of longrunning) {
      assert.equal(isDealFreebieEligible(r, POLL_1_AT), true, `node ${r.node_id} (longrunning) is eligible`);
    }
    // The fixture's only targeted item (976088) is also expired, so it is not
    // eligible; a targeted-but-not-expired item is.
    const targeted = { node_id: 777777, title: 'Free Targeted', title_msg_types: ['targeted'], expiry_at: null };
    assert.equal(isDealFreebieEligible(targeted, POLL_1_AT), true, 'a targeted (not expired) freebie is eligible');
  });

  it('a non-seeded evaluation alerts a new eligible freebie and never a new expired one', () => {
    const store = makeStore();
    // Pre-set the seeding key so this is a pure eligibility + alerting test
    // (not a seeding).
    store.setSetting(DEAL_FREEBIE_SEEDED_AT_KEY, POLL_1_AT);
    const newEligible = synthFreebie(666666, { types: ['upcoming'] });
    const newExpired = synthFreebie(555555, { types: ['expired'] });
    const out = evaluateDealFreebies({
      records: [newEligible, newExpired],
      store, clock: frozenClock(POLL_2_AT), pollAt: POLL_2_AT,
    });
    const alerted = new Set(out.alerts.map((a) => a.node_id));
    assert.ok(alerted.has(666666), 'the new eligible freebie alerts');
    assert.ok(!alerted.has(555555), 'the new expired freebie does not alert');
    assert.equal(out.alerts.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Isolation (design 6.6): the rules engine never evaluates the freebies
// surface, and a node that both a rule and the freebie evaluator alert on in
// the same poll produces one notification (the rule's) plus a rule-0 ledger
// row.
// ---------------------------------------------------------------------------
describe('deal freebie: isolation', () => {
  it('a keyword rule matching only a freebies-feed-unique item does not fire', () => {
    const store = makeStore();
    // 'adidas' matches 977067, which is unique to the freebies feed (not in
    // the deals corpus).
    insertRule(store, { id: 1, type: 'match', parameters: { term: 'adidas' }, surfaces: 'deals' });
    const out = evaluatePoll({
      feeds: [{ surface: 'freebies', records: freebiesFeed }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    assert.equal(out.alerts.filter((a) => a.rule_id === 1).length, 0, 'the rule did not fire on the freebies feed');
  });

  it('a node in both the deals and freebies feeds matching a rule produces one rule notification and a rule-0 ledger row', () => {
    const store = makeStore();
    // Pre-set the seeding key so the freebie evaluation is not a seeding.
    store.setSetting(DEAL_FREEBIE_SEEDED_AT_KEY, POLL_1_AT);
    const sharedNode = synthFreebie(500000, { title: 'Free Shared Thing' });
    insertRule(store, { id: 1, type: 'match', parameters: { term: 'shared' }, surfaces: 'deals' });
    const out = evaluatePoll({
      feeds: [
        { surface: 'deals', records: [sharedNode] },
        { surface: 'freebies', records: [sharedNode] },
      ],
      store, clock: frozenClock(POLL_2_AT), pollAt: POLL_2_AT,
    });
    const ruleAlerts = out.alerts.filter((a) => a.rule_id === 1 && a.node_id === 500000);
    assert.equal(ruleAlerts.length, 1, 'the rule fired once on the shared node');
    const dealFreebieAlerts = out.alerts.filter((a) => a.kind === 'deal_freebie' && a.node_id === 500000);
    assert.equal(dealFreebieAlerts.length, 0, 'the freebie alert was dropped (one notification per node)');
    assert.ok(store.hasLedger(500000, FREEBIE_RULE_ID), 'the rule-0 ledger row was written');
  });
});

// ---------------------------------------------------------------------------
// Surface safety (design 6.6): a node first seen on the front page keeps its
// front_page_first_seen when it later appears in the freebies feed, and gains
// a freebie_first_seen. The COALESCE semantics protect the earlier stamp.
// ---------------------------------------------------------------------------
describe('deal freebie: surface safety', () => {
  it('a node seen first on front then in the freebies feed keeps front_page_first_seen and gains freebie_first_seen', () => {
    const store = makeStore();
    const node = synthFreebie(400000, { title: 'Front Then Freebie' });
    // Poll 1: the node is on the front page.
    evaluatePoll({
      feeds: [{ surface: 'front', records: [node] }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    let deal = store.getDeal(400000);
    assert.ok(deal.front_page_first_seen, 'front_page_first_seen is set after the front poll');
    assert.equal(deal.freebie_first_seen, null, 'freebie_first_seen is not set yet');
    // Poll 2: the node is in the freebies feed.
    evaluatePoll({
      feeds: [{ surface: 'freebies', records: [node] }],
      store, clock: frozenClock(POLL_2_AT), pollAt: POLL_2_AT,
    });
    deal = store.getDeal(400000);
    assert.ok(deal.front_page_first_seen, 'front_page_first_seen is preserved after the freebies poll');
    assert.ok(deal.freebie_first_seen, 'freebie_first_seen is set after the freebies poll');
  });
});

// ---------------------------------------------------------------------------
// Activity (review round 1 F3): `getFreebieLedger` returns only freebies the
// user actually saw. Silent seeding rows, rows written while the setting was
// off, and a node dropped because a rule alerted (all `sent = 0`) do not
// appear. A real deal freebie (`sent = 1`) and a real classifieds freebie
// (`sent = 1`, `freebie_first_seen` null) do.
// ---------------------------------------------------------------------------
describe('deal freebie: Activity (sent filter)', () => {
  it('after seeding, getFreebieLedger returns 0 rows (seeding rows are sent = 0)', () => {
    const store = makeStore();
    evaluatePoll({
      feeds: [{ surface: 'freebies', records: freebiesFeed }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    assert.ok(store.getSetting(DEAL_FREEBIE_SEEDED_AT_KEY), 'seeding happened');
    const rows = store.getFreebieLedger('2000-01-01T00:00:00Z');
    assert.equal(rows.length, 0, 'no sent freebies after seeding');
  });

  it('one real deal freebie gives exactly one row', () => {
    const store = makeStore();
    // Seed first (no alerts).
    evaluatePoll({
      feeds: [{ surface: 'freebies', records: freebiesFeed }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    // A new freebie appears at poll 2.
    const newFreebie = synthFreebie(999999);
    const out = evaluatePoll({
      feeds: [{ surface: 'freebies', records: [newFreebie] }],
      store, clock: frozenClock(POLL_2_AT), pollAt: POLL_2_AT,
    });
    const dealFreebieAlerts = out.alerts.filter((a) => a.kind === 'deal_freebie');
    assert.equal(dealFreebieAlerts.length, 1, 'one deal_freebie alert');
    const rows = store.getFreebieLedger('2000-01-01T00:00:00Z');
    assert.equal(rows.length, 1, 'one sent freebie row');
    assert.equal(rows[0].node_id, 999999);
    assert.ok(rows[0].freebie_first_seen, 'a deal freebie has freebie_first_seen set');
  });

  it('a node dropped for a rule alert gives no freebie row (sent = 0)', () => {
    const store = makeStore();
    // Pre-set the seeding key so this is a pure drop test, not a seeding.
    store.setSetting(DEAL_FREEBIE_SEEDED_AT_KEY, POLL_1_AT);
    const sharedNode = synthFreebie(500000, { title: 'Free Shared Thing' });
    insertRule(store, { id: 1, type: 'match', parameters: { term: 'shared' }, surfaces: 'deals' });
    evaluatePoll({
      feeds: [
        { surface: 'deals', records: [sharedNode] },
        { surface: 'freebies', records: [sharedNode] },
      ],
      store, clock: frozenClock(POLL_2_AT), pollAt: POLL_2_AT,
    });
    assert.ok(store.hasLedger(500000, FREEBIE_RULE_ID), 'the rule-0 ledger row was written');
    const rows = store.getFreebieLedger('2000-01-01T00:00:00Z');
    assert.equal(rows.length, 0, 'the dropped node does not appear in Activity');
  });

  it('a real classifieds freebie still appears with freebie_first_seen null (badge Freebie · Classified)', () => {
    const store = makeStore();
    // The unpinned freebie (975712) retyped to free — a real classifieds freebie.
    const freebie = { ...classifiedsById.get(975712), type: 'free' };
    const out = evaluatePoll({
      feeds: [{ surface: 'classifieds', records: [freebie] }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    const freebieAlerts = out.alerts.filter((a) => a.kind === 'freebie');
    assert.equal(freebieAlerts.length, 1, 'one classifieds freebie alert');
    const rows = store.getFreebieLedger('2000-01-01T00:00:00Z');
    assert.equal(rows.length, 1, 'the classifieds freebie appears in Activity');
    assert.equal(rows[0].node_id, 975712);
    assert.equal(rows[0].freebie_first_seen, null, 'freebie_first_seen is null (badge Freebie · Classified)');
  });
});

// ---------------------------------------------------------------------------
// Compose (design 6.6, D49): the deal_freebie notification. The title is the
// RSS title; the body carries the title plus the merchant host from
// `ozb:meta url` when present; the link is the node page; the unsubscribe
// targets the `always_notify_deal_freebie` setting.
// ---------------------------------------------------------------------------
describe('deal freebie: compose', () => {
  it('a deal_freebie composes with the right title, link, tags, and unsubscribe target', () => {
    const alert = {
      kind: 'deal_freebie',
      rule_id: FREEBIE_RULE_ID,
      ruleLabel: 'freebie',
      node_id: 977067,
      title: '[iOS, Android] Free Pair of adidas Shoes Avatar Clothing @ Pokémon GO',
      url: 'https://www.ozbargain.com.au/node/977067',
      merchant_url: 'https://store.pokemongo.com/offer-redemption?passcode=ADIDASxPOKEMON',
      priority: 'normal',
      tags: ['freebie', 'deal'],
      isFrontPage: false,
      pollAt: POLL_1_AT,
    };
    const [n] = groupAndCompose([alert]);
    assert.equal(n.kind, 'deal_freebie');
    assert.equal(n.title, 'Freebie: [iOS, Android] Free Pair of adidas Shoes Avatar Clothing @ Pokémon GO');
    assert.ok(n.body.includes('[iOS, Android] Free Pair of adidas Shoes Avatar Clothing @ Pokémon GO'), 'the body carries the title');
    assert.ok(n.body.includes('store.pokemongo.com'), 'the body carries the merchant host');
    assert.equal(n.url, 'https://www.ozbargain.com.au/node/977067', 'the link is the node page');
    assert.deepEqual(n.tags, ['freebie', 'deal']);
    assert.equal(n.priority, 'normal');
    assert.ok(n.unsubscribe, 'carries an unsubscribe control');
    assert.equal(n.unsubscribe.label, 'Stop deal freebie alerts');
    assert.equal(n.unsubscribe.target, 'always_notify_deal_freebie', 'the unsubscribe targets the deal freebie setting');
    assert.equal(n.unsubscribe.url, '/thresholds');
    assert.ok(!JSON.stringify(n).includes('/goto/'), 'no /goto/ link');
  });

  it('a deal_freebie without a merchant_url omits the merchant line', () => {
    const alert = {
      kind: 'deal_freebie',
      rule_id: FREEBIE_RULE_ID,
      ruleLabel: 'freebie',
      node_id: 976991,
      title: '[VIC] Free Anti-Theft Number Plate Screws Delivered @ Neighbourhood Watch Victoria & RACV',
      url: 'https://www.ozbargain.com.au/node/976991',
      merchant_url: null,
      priority: 'normal',
      tags: ['freebie', 'deal'],
      isFrontPage: false,
      pollAt: POLL_1_AT,
    };
    const [n] = groupAndCompose([alert]);
    assert.ok(n.body.includes('[VIC] Free Anti-Theft Number Plate Screws Delivered'), 'the body carries the title');
    assert.ok(!n.body.includes('Merchant:'), 'no merchant line when there is no merchant_url');
  });
});
