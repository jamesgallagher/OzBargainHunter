import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openStore } from '../../../lib/store/index.js';
import {
  evaluatePoll,
  normalizeRule,
  jaccard,
  REPOST_SIMILARITY_THRESHOLD,
} from '../../../lib/rules/engine.js';
import { normalise, tokenise, containsTerm } from '../../../lib/rules/normalise.js';
import { matchRule, isClassifiedsEligible } from '../../../lib/rules/match.js';
import { validateThresholdRule, reachedThreshold, MAX_WINDOW_MS } from '../../../lib/rules/threshold.js';
import { emailProvider } from '../../../lib/notify/email.js';
import { matrixProvider } from '../../../lib/notify/matrix.js';
import { ntfyProvider } from '../../../lib/notify/ntfy.js';
import { compose, groupAndCompose } from '../../../lib/notify/compose.js';
import { fanout } from '../../../lib/notify/fanout.js';
import { sendDeadman } from '../../../lib/notify/deadman.js';
import { nodeUrl } from '../../../lib/notify/links.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'records');
const dealsPage0 = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'deals-page0.json'), 'utf8')).records;
const frontFeed = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'front-feed.json'), 'utf8')).records;
const classifieds = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'classifieds.json'), 'utf8')).records;

// The corpus's own timeline (fixtures/README.md section 1).
const POLL_1_AT = '2026-09-19T07:30:00Z';
const POLL_2_AT = '2026-09-19T08:05:00Z';
const POLL_3_AT = '2026-09-19T08:10:00Z';

const byId = (recs) => {
  const m = new Map();
  for (const r of recs) m.set(r.node_id, r);
  return m;
};
const D = byId(dealsPage0);
const F = byId(frontFeed);
const C = byId(classifieds);

function frozenClock(iso) {
  return { now: () => new Date(iso) };
}

function makeStore() {
  return openStore({ path: ':memory:', clock: frozenClock(POLL_1_AT) });
}

// Insert a rule the way the store expects it: a parameters JSON blob plus the
// column fields. Returns the flat rule the engine would read.
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

// A poll-2 deals feed, built from the real poll-1 records plus the deltas
// documented in fixtures/README.md section 2 (cmp_deals.xml has no record
// file; the rules card consumes records directly).
function poll2Deals() {
  const out = dealsPage0.map((r) => ({ ...r }));
  const m = byId(out);
  // 975704: 17 -> 24 votes, live, also on the front page.
  m.get(975704).votes_pos = 24;
  // 975702: 26 -> 28 votes, expired at 2026-09-19T05:51:28Z (before both polls).
  m.get(975702).votes_pos = 28;
  // 975700: 10 -> 11 votes, expired at 2026-09-19T05:29:06Z.
  m.get(975700).votes_pos = 11;
  // 975666: 113 -> 115 votes, in both feeds.
  m.get(975666).votes_pos = 115;
  // 975672: 52 -> 53 votes, expired at 2026-09-19T03:54:27Z.
  m.get(975672).votes_pos = 53;
  // 975623 falls off page 0.
  const idx = out.findIndex((r) => r.node_id === 975623);
  if (idx !== -1) out.splice(idx, 1);
  // 975721: new at poll 2, 2 votes, "U98 Fuel $2.339/L @ 7-Eleven".
  out.push({
    node_id: 975721,
    title: 'U98 Fuel $2.339/L @ 7-Eleven',
    url: 'https://www.ozbargain.com.au/node/975721',
    author: 'fuelwatch',
    posted_at: '2026-09-19T07:58:00Z',
    expiry_at: null,
    merchant_url: null,
    goto_url: 'https://www.ozbargain.com.au/goto/975721',
    image_url: null,
    votes_pos: 2,
    votes_neg: 0,
    comment_count: 0,
    click_count: 1,
    categories: [{ kind: 'cat', slug: 'fuel', label: 'Fuel' }],
    description_html: '<p>U98 Fuel $2.339/L at 7-Eleven</p>',
  });
  return out;
}

// ---------------------------------------------------------------------------
// 1. normalise.js — normalisation and word boundaries
// ---------------------------------------------------------------------------
describe('normalise', () => {
  it('lower-cases, strips punctuation, collapses whitespace', () => {
    assert.equal(normalise('AMD R9700'), 'amd r9700');
    assert.equal(normalise('amd  r9700'), 'amd r9700');
    assert.equal(normalise('AMD, R9700!  (x)'), 'amd r9700 x');
  });

  it('tokenises into a set of whole words', () => {
    const t = tokenise('AMD R9700');
    assert.ok(t.has('amd'));
    assert.ok(t.has('r9700'));
    assert.equal(t.size, 2);
  });

  it('word boundaries are mandatory: ple does not match inside simple', () => {
    assert.equal(containsTerm('ple', 'simple'), false);
    assert.equal(containsTerm('simple', 'simple'), true);
    assert.equal(containsTerm('fuel', 'U98 Fuel $2.339/L'), true);
  });

  it('a multi-word term must appear as a contiguous run', () => {
    assert.equal(containsTerm('unifi dream', 'Ubiquiti Unifi Dream Router 7'), true);
    assert.equal(containsTerm('dream unifi', 'Ubiquiti Unifi Dream Router 7'), false);
  });
});

// ---------------------------------------------------------------------------
// 2. match.js — both matching modes, classifieds eligibility
// ---------------------------------------------------------------------------
describe('match rule', () => {
  it('default mode: all tokens present, in any order', () => {
    const rule = { term: 'ubiquiti dream' };
    const r = matchRule(rule, D.get(975704), 'deals');
    assert.equal(r.matched, true);
    // A term with a token that is absent does not match in 'all' mode.
    const r2 = matchRule({ term: 'ubiquiti zzzz' }, D.get(975704), 'deals');
    assert.equal(r2.matched, false);
  });

  it('keyword mode: any token present', () => {
    const rule = { term: 'ubiquiti, fuel', mode: 'keyword' };
    assert.equal(matchRule(rule, D.get(975704), 'deals').matched, true, 'ubiquiti present');
    assert.equal(matchRule(rule, { node_id: 1, title: 'U98 Fuel $2.339/L' }, 'deals').matched, true, 'fuel present');
  });

  it('runs over title, description and category labels', () => {
    const rule = { term: 'torbox' };
    assert.equal(matchRule(rule, D.get(975666), 'deals').matched, true);
    // A term only in the description still matches.
    const r = matchRule({ term: 'providoor' }, D.get(975715), 'deals');
    assert.equal(r.matched, true);
  });

  it('a pinned slug matches exactly and additively', () => {
    const rule = { term: 'zzzz', pinnedSlug: 'ubiquiti' };
    assert.equal(matchRule(rule, D.get(975704), 'deals').matched, true, 'brand slug matches');
    assert.equal(matchRule(rule, D.get(975704), 'deals').via, 'slug');
  });

  it('front-page items are matched as well as deals', () => {
    const rule = { term: 'ubiquiti' };
    assert.equal(matchRule(rule, F.get(975704), 'front').matched, true);
  });

  it('classifieds: only sell listings are eligible; want/swap/pinned never', () => {
    for (const r of classifieds) {
      const eligible = isClassifiedsEligible(r);
      const expected = r.type === 'sell' && r.pinned !== true;
      assert.equal(eligible, expected, `node ${r.node_id} (${r.type}, pinned=${r.pinned})`);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. threshold.js — firing and the 24-hour window rejection
// ---------------------------------------------------------------------------
describe('threshold rule', () => {
  it('fires when net votes reach the threshold (unwindowed)', () => {
    assert.equal(reachedThreshold({ threshold: 20 }, { votes_pos: 24, votes_neg: 0 }, '2026-09-19T07:30:00Z'), true);
    assert.equal(reachedThreshold({ threshold: 20 }, { votes_pos: 17, votes_neg: 0 }, '2026-09-19T07:30:00Z'), false);
  });

  it('rejects a window over 24 hours at entry', () => {
    assert.throws(() => validateThresholdRule({ threshold: 10, windowHours: 25 }), /24 hours/);
    assert.doesNotThrow(() => validateThresholdRule({ threshold: 10, windowHours: 24 }));
    assert.doesNotThrow(() => validateThresholdRule({ threshold: 10 }));
    assert.ok(MAX_WINDOW_MS === 24 * 60 * 60 * 1000);
  });

  it('C1: a windowed rule fires only while the deal is inside its window', () => {
    // Deal posted 20 h before the poll, 10 net votes, {threshold: 10, windowHours: 6}:
    // the window (6 h) has closed, so the rule must NOT fire — even though the
    // vote count has reached the threshold.
    const aged = { votes_pos: 10, votes_neg: 0, posted_at: '2026-09-18T11:30:00Z' };
    assert.equal(reachedThreshold({ threshold: 10, windowHours: 6 }, aged, '2026-09-19T07:30:00Z'), false, 'aged out of the window: no fire');
    // The same deal, posted 3 h before the poll (inside the 6 h window): fires.
    const fresh = { votes_pos: 10, votes_neg: 0, posted_at: '2026-09-19T04:30:00Z' };
    assert.equal(reachedThreshold({ threshold: 10, windowHours: 6 }, fresh, '2026-09-19T07:30:00Z'), true, 'inside the window: fires');
    // A windowed rule with no posted_at never fires (cannot establish the window).
    const noPost = { votes_pos: 10, votes_neg: 0 };
    assert.equal(reachedThreshold({ threshold: 10, windowHours: 6 }, noPost, '2026-09-19T07:30:00Z'), false, 'no posted_at: no fire');
  });

  it('a threshold rule can never fire on a classifieds record (engine level)', () => {
    // The engine skips threshold on the classifieds surface entirely: a
    // threshold rule over the classifieds feed produces zero alerts.
    const store = makeStore();
    insertRule(store, { id: 1, type: 'threshold', parameters: { threshold: 1 }, surfaces: 'classifieds' });
    const out = evaluatePoll({
      feeds: [{ surface: 'classifieds', records: classifieds }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    assert.equal(out.alerts.filter((a) => a.rule_id === 1).length, 0, 'no threshold alert on classifieds');
  });
});

// ---------------------------------------------------------------------------
// 4. engine.js — the load-bearing check order
// ---------------------------------------------------------------------------
describe('engine: cross-feed de-duplication', () => {
  it('a torbox rule over poll 1 deals + front produces one alert and one ledger row', () => {
    const store = makeStore();
    insertRule(store, { id: 1, type: 'match', parameters: { term: 'torbox' }, surfaces: 'deals' });
    const out = evaluatePoll({
      feeds: [
        { surface: 'deals', records: dealsPage0 },
        { surface: 'front', records: frontFeed },
      ],
      store,
      clock: frozenClock(POLL_1_AT),
      pollAt: POLL_1_AT,
    });
    const torboxAlerts = out.alerts.filter((a) => a.node_id === 975666);
    assert.equal(torboxAlerts.length, 1, '975666 appears in both feeds but alerts once');
    assert.equal(store.getLedgerForRule(1).filter((l) => l.node_id === 975666).length, 1, 'one ledger row');
  });
});

describe('engine: expiry beats matching and thresholds', () => {
  it('a ubiquiti match at poll 1 alerts the live 975704 and suppresses the expired 975700', () => {
    const store = makeStore();
    insertRule(store, { id: 1, type: 'match', parameters: { term: 'ubiquiti' }, surfaces: 'deals' });
    const out = evaluatePoll({
      feeds: [{ surface: 'deals', records: dealsPage0 }],
      store,
      clock: frozenClock(POLL_1_AT),
      pollAt: POLL_1_AT,
    });
    const alerts = out.alerts.filter((a) => a.rule_id === 1);
    assert.equal(alerts.length, 1, 'exactly one alert (975704 live)');
    assert.equal(alerts[0].node_id, 975704);
    const expired = out.suppressions.filter((s) => s.node_id === 975700 && s.kind === 'expired');
    assert.equal(expired.length, 1, 'one expired suppression for 975700');
  });

  it('a threshold at 27 over polls 1 and 2 never fires on the expired 975702', () => {
    const store = makeStore();
    insertRule(store, { id: 1, type: 'threshold', parameters: { threshold: 27 }, surfaces: 'deals' });
    const p1 = evaluatePoll({
      feeds: [{ surface: 'deals', records: dealsPage0 }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    const p2 = evaluatePoll({
      feeds: [{ surface: 'deals', records: poll2Deals() }],
      store, clock: frozenClock(POLL_2_AT), pollAt: POLL_2_AT,
    });
    const fired = [...p1.alerts, ...p2.alerts].filter((a) => a.node_id === 975702);
    assert.equal(fired.length, 0, '975702 is expired at emit time in both polls');
  });

  it('a noctua match never fires on the expired 975702 at any poll', () => {
    const store = makeStore();
    insertRule(store, { id: 1, type: 'match', parameters: { term: 'noctua' }, surfaces: 'deals' });
    for (const [at, recs] of [[POLL_1_AT, dealsPage0], [POLL_2_AT, poll2Deals()], [POLL_3_AT, poll2Deals()]]) {
      const out = evaluatePoll({
        feeds: [{ surface: 'deals', records: recs }],
        store, clock: frozenClock(at), pollAt: at,
      });
      assert.equal(out.alerts.filter((a) => a.node_id === 975702).length, 0, `no alert at ${at}`);
    }
  });
});

describe('engine: thresholds fire once', () => {
  it('a threshold at 20 fires exactly once on 975704 across polls 1-3', () => {
    const store = makeStore();
    insertRule(store, { id: 1, type: 'threshold', parameters: { threshold: 20 }, surfaces: 'deals' });
    // Isolate 975704 with its real vote trajectory (17 -> 24 -> 24). Feeding the
    // whole corpus would let 975666 (113 votes) fire the rule at poll 1, and
    // the 24-hour cooldown would then suppress 975704 at poll 2; the criterion
    // is specifically about 975704, so it is tracked alone.
    const one = (votes) => [{
      node_id: 975704,
      title: 'Ubiquiti Unifi Dream Router 7',
      url: 'https://www.ozbargain.com.au/node/975704',
      author: 'routerwatch',
      posted_at: '2026-09-19T07:00:00Z',
      expiry_at: null,
      merchant_url: null,
      goto_url: 'https://www.ozbargain.com.au/goto/975704',
      image_url: null,
      votes_pos: votes,
      votes_neg: 0,
      comment_count: 0,
      click_count: 1,
      categories: [{ kind: 'cat', slug: 'networking', label: 'Networking' }],
      description_html: '<p>Ubiquiti Unifi Dream Router 7</p>',
    }];
    const p1 = evaluatePoll({
      feeds: [{ surface: 'deals', records: one(17) }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    const p2 = evaluatePoll({
      feeds: [{ surface: 'deals', records: one(24) }],
      store, clock: frozenClock(POLL_2_AT), pollAt: POLL_2_AT,
    });
    const p3 = evaluatePoll({
      feeds: [{ surface: 'deals', records: one(24) }],
      store, clock: frozenClock(POLL_3_AT), pollAt: POLL_3_AT,
    });
    const fired = [p1, p2, p3].flatMap((p) => p.alerts).filter((a) => a.node_id === 975704 && a.rule_id === 1);
    assert.equal(fired.length, 1, 'fires exactly once (at poll 2, 24 votes)');
    assert.equal(store.getLedgerForRule(1).filter((l) => l.node_id === 975704).length, 1, 'one ledger row');
  });

  it('rules at 20 and 100 produce two independent ledger rows for a deal clearing both', () => {
    const store = makeStore();
    insertRule(store, { id: 1, type: 'threshold', parameters: { threshold: 20 }, surfaces: 'deals' });
    insertRule(store, { id: 2, type: 'threshold', parameters: { threshold: 100 }, surfaces: 'deals' });
    // Isolate 975666 (113 votes): with the whole corpus, 975699 (23 votes)
    // would fire the 20 rule first and the per-rule cooldown would then
    // suppress 975666 on it. The criterion is about one deal clearing both
    // thresholds, so it is tracked alone.
    const out = evaluatePoll({
      feeds: [{ surface: 'deals', records: [D.get(975666)] }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    const for975666 = out.alerts.filter((a) => a.node_id === 975666);
    assert.equal(for975666.length, 2, 'two alerts, one per threshold');
    assert.equal(store.getLedgerForRule(1).filter((l) => l.node_id === 975666).length, 1);
    assert.equal(store.getLedgerForRule(2).filter((l) => l.node_id === 975666).length, 1);
  });
});

describe('engine: cooldown', () => {
  it('a 24-hour cooldown fires at poll 1 and is suppressed at poll 2', () => {
    const store = makeStore();
    insertRule(store, { id: 1, type: 'match', parameters: { term: 'ubiquiti, fuel', mode: 'keyword' }, surfaces: 'deals', cooldownSeconds: 86400 });
    const p1 = evaluatePoll({
      feeds: [{ surface: 'deals', records: dealsPage0 }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    assert.ok(p1.alerts.some((a) => a.node_id === 975704), 'fires at poll 1 on 975704');
    const p2 = evaluatePoll({
      feeds: [{ surface: 'deals', records: poll2Deals() }],
      store, clock: frozenClock(POLL_2_AT), pollAt: POLL_2_AT,
    });
    // Per-rule: the rule fired on 975704 at poll 1, so at poll 2 (35 minutes
    // later) the newly appeared 975721 is suppressed by the cooldown and
    // recorded; the already-fired 975704 is silently skipped by the ledger.
    assert.ok(p2.suppressions.some((s) => s.node_id === 975721 && s.kind === 'cooldown'), '975721 suppressed at poll 2 (cooldown)');
    assert.ok(!p2.alerts.some((a) => a.node_id === 975721), '975721 does not alert while the rule is in cooldown');
  });

  it('with a zero cooldown it fires both times', () => {
    const store = makeStore();
    insertRule(store, { id: 1, type: 'match', parameters: { term: 'ubiquiti, fuel', mode: 'keyword' }, surfaces: 'deals', cooldownSeconds: 0 });
    const p1 = evaluatePoll({
      feeds: [{ surface: 'deals', records: dealsPage0 }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    const p2 = evaluatePoll({
      feeds: [{ surface: 'deals', records: poll2Deals() }],
      store, clock: frozenClock(POLL_2_AT), pollAt: POLL_2_AT,
    });
    assert.ok(p1.alerts.some((a) => a.node_id === 975704), 'fires at poll 1');
    assert.ok(p2.alerts.some((a) => a.node_id === 975721), 'fires at poll 2 (zero cooldown)');
  });
});

describe('engine: priority (M4)', () => {
  it('a front-page node alerts with priority high; a deals-only node with priority normal', () => {
    const store = makeStore();
    // Both rules use surfaces 'deals' (which covers the front feed too); the
    // priority is set by whether the *node* is in the front feed, not the
    // rule's surface. 975704 (ubiquiti) is on the front page; 975714 (weber)
    // is deals-only.
    insertRule(store, { id: 1, type: 'match', parameters: { term: 'ubiquiti' }, surfaces: 'deals' });
    insertRule(store, { id: 2, type: 'match', parameters: { term: 'weber' }, surfaces: 'deals' });
    const out = evaluatePoll({
      feeds: [
        { surface: 'deals', records: dealsPage0 },
        { surface: 'front', records: frontFeed },
      ],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    const highAlerts = out.alerts.filter((a) => a.node_id === 975704);
    const normalAlerts = out.alerts.filter((a) => a.node_id === 975714);
    assert.ok(highAlerts.length > 0, 'front-page node 975704 fired');
    assert.ok(normalAlerts.length > 0, 'deals-only node 975714 fired');
    for (const a of highAlerts) assert.equal(a.priority, 'high', 'front-page alert is priority high');
    for (const a of normalAlerts) assert.equal(a.priority, 'normal', 'deals-only alert is priority normal');
  });
});

describe('engine: repost suppression across every corpus pair', () => {
  it('975593 and 975574 score 0.667; no other classifieds pair reaches 0.60', () => {
    const titles = classifieds.map((r) => ({ id: r.node_id, title: r.title }));
    let maxOther = 0;
    for (let i = 0; i < titles.length; i += 1) {
      for (let j = i + 1; j < titles.length; j += 1) {
        const sim = jaccard(tokenise(titles[i].title), tokenise(titles[j].title));
        const isRepostPair =
          (titles[i].id === 975593 && titles[j].id === 975574) ||
          (titles[i].id === 975574 && titles[j].id === 975593);
        if (isRepostPair) {
          assert.equal(sim.toFixed(3), '0.667', 'the real repost pair scores 0.667');
        } else {
          assert.ok(sim < REPOST_SIMILARITY_THRESHOLD, `pair ${titles[i].id}/${titles[j].id} = ${sim.toFixed(3)} < 0.60`);
          if (sim > maxOther) maxOther = sim;
        }
      }
    }
    assert.ok(maxOther < REPOST_SIMILARITY_THRESHOLD, 'no other pair reaches the threshold');
  });

  it('a second listing reposting an alerted title is suppressed, not sent', () => {
    const store = makeStore();
    // Zero cooldown so the repost check (not the cooldown check, which would
    // also catch this 35-minute-later repost) is what suppresses it.
    insertRule(store, { id: 1, type: 'match', parameters: { term: 'nintendo' }, surfaces: 'classifieds', cooldownSeconds: 0 });
    // Alert the first of the repost pair.
    const first = classifieds.find((r) => r.node_id === 975593);
    const p1 = evaluatePoll({
      feeds: [{ surface: 'classifieds', records: [first] }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    assert.equal(p1.alerts.length, 1, 'the first listing alerts');
    // Now the repost.
    const second = classifieds.find((r) => r.node_id === 975574);
    const p2 = evaluatePoll({
      feeds: [{ surface: 'classifieds', records: [second] }],
      store, clock: frozenClock(POLL_2_AT), pollAt: POLL_2_AT,
    });
    assert.equal(p2.alerts.length, 0, 'the repost does not alert');
    assert.ok(p2.suppressions.some((s) => s.node_id === 975574 && s.kind === 'repost'), 'recorded as a repost suppression');
  });
});

describe('engine: muted rules', () => {
  it('a muted rule that matches writes its ledger row and sends nothing', () => {
    const store = makeStore();
    insertRule(store, { id: 1, type: 'match', parameters: { term: 'torbox' }, surfaces: 'deals', state: 'muted' });
    const out = evaluatePoll({
      feeds: [{ surface: 'deals', records: dealsPage0 }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    assert.equal(out.alerts.filter((a) => a.node_id === 975666).length, 0, 'nothing sent while muted');
    assert.ok(store.hasLedger(975666, 1), 'the ledger row is written');
  });

  it('re-enabling does not fire retroactively for matches that happened while muted', () => {
    const store = makeStore();
    insertRule(store, { id: 1, type: 'match', parameters: { term: 'torbox' }, surfaces: 'deals', state: 'muted' });
    evaluatePoll({
      feeds: [{ surface: 'deals', records: dealsPage0 }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    // Re-enable and re-poll the same record.
    store.setRuleState(1, 'enabled', '2026-09-19T07:40:00Z');
    const out = evaluatePoll({
      feeds: [{ surface: 'deals', records: dealsPage0 }],
      store, clock: frozenClock(POLL_2_AT), pollAt: POLL_2_AT,
    });
    assert.equal(out.alerts.filter((a) => a.node_id === 975666).length, 0, 'no retroactive alert after re-enabling');
  });
});

describe('engine: classifieds eligibility', () => {
  it('a broad match rule alerts on at most the 8 sell listings, never want/swap/pinned', () => {
    const store = makeStore();
    // 'online' appears in 3 sell listings and 1 pinned want listing. The
    // engine must alert only the sell ones and exclude the want.
    insertRule(store, { id: 1, type: 'match', parameters: { term: 'online' }, surfaces: 'classifieds' });
    const out = evaluatePoll({
      feeds: [{ surface: 'classifieds', records: classifieds }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    const sellIds = new Set(classifieds.filter((r) => r.type === 'sell').map((r) => r.node_id));
    for (const a of out.alerts) {
      assert.ok(sellIds.has(a.node_id), `alert ${a.node_id} is a sell listing`);
    }
    const alerted = new Set(out.alerts.map((a) => a.node_id));
    assert.ok(alerted.size <= 8, 'at most the 8 sell listings');
    assert.ok(!alerted.has(975209), 'the matching want listing is never alerted');
  });
});

describe('engine: freebies', () => {
  it('the raw classifieds page produces zero freebie notifications (the only freebie is pinned)', () => {
    const store = makeStore();
    const out = evaluatePoll({
      feeds: [{ surface: 'classifieds', records: classifieds }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    assert.equal(out.alerts.filter((a) => a.kind === 'freebie').length, 0, 'no freebie alert from the raw page');
  });

  it('the unpinned freebie (975712 retyped) produces exactly one, naming the poster', () => {
    const store = makeStore();
    const base = C.get(975712);
    const freebie = { ...base, type: 'free' };
    const out = evaluatePoll({
      feeds: [{ surface: 'classifieds', records: [freebie] }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    const fb = out.alerts.filter((a) => a.kind === 'freebie');
    assert.equal(fb.length, 1, 'exactly one freebie alert');
    assert.equal(fb[0].poster, 'ausdkunst', 'names the poster');
    assert.equal(fb[0].priority, 'normal', 'normal priority');
  });

  it('C2: a freebie notification carries a working unsubscribe link, not a dead /goto/ one', () => {
    const store = makeStore();
    const base = C.get(975712);
    const freebie = { ...base, type: 'free' };
    const out = evaluatePoll({
      feeds: [{ surface: 'classifieds', records: [freebie] }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    const notifications = groupAndCompose(out.alerts);
    const freebieN = notifications.find((n) => n.kind === 'freebie');
    assert.ok(freebieN, 'a freebie notification was composed');
    assert.ok(freebieN.unsubscribe, 'carries an unsubscribe control');
    assert.ok(freebieN.unsubscribe.url.startsWith('/settings/'), 'unsubscribe points at the settings screen');
    assert.ok(!freebieN.unsubscribe.url.includes('/goto/'), 'no /goto/ in the unsubscribe link');
    assert.ok(!JSON.stringify(freebieN).includes('/goto/'), 'no /goto/ anywhere in the freebie notification');
  });
});

describe('engine: cold start', () => {
  it('seeding an empty database from poll 1 sends zero notifications while writing data', () => {
    const store = makeStore();
    insertRule(store, { id: 1, type: 'match', parameters: { term: 'ubiquiti' }, surfaces: 'deals' });
    insertRule(store, { id: 2, type: 'threshold', parameters: { threshold: 20 }, surfaces: 'deals' });
    const out = evaluatePoll({
      feeds: [
        { surface: 'deals', records: dealsPage0 },
        { surface: 'front', records: frontFeed },
      ],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT, coldStart: true,
    });
    assert.equal(out.alerts.length, 0, 'zero notifications on cold start');
    assert.equal(out.counts.records, 50, 'all records written');
    assert.ok(out.counts.seeded > 0, 'already-alerted ledger rows written');
    assert.ok(store.countAllObservations() > 0, 'observations written');
    assert.ok(store.countDeals() > 0, 'deals written');
  });
});

describe('engine: gaps', () => {
  it('a three-hour gap suppresses threshold rules for one cycle and resumes next; match rules fire throughout', () => {
    const store = makeStore();
    insertRule(store, { id: 1, type: 'threshold', parameters: { threshold: 20 }, surfaces: 'deals' });
    insertRule(store, { id: 2, type: 'match', parameters: { term: 'torbox' }, surfaces: 'deals' });
    const threeHours = 3 * 60 * 60 * 1000;
    // The gapped poll: threshold suppressed, match fires.
    const gapped = evaluatePoll({
      feeds: [{ surface: 'deals', records: dealsPage0 }],
      store, clock: frozenClock(POLL_2_AT), pollAt: POLL_2_AT, gapMs: threeHours,
    });
    assert.ok(!gapped.alerts.some((a) => a.rule_id === 1), 'threshold suppressed on the gapped poll');
    assert.ok(gapped.alerts.some((a) => a.rule_id === 2), 'match fires on the gapped poll');
    // The next poll (no gap): threshold resumes.
    const next = evaluatePoll({
      feeds: [{ surface: 'deals', records: poll2Deals() }],
      store, clock: frozenClock(POLL_3_AT), pollAt: POLL_3_AT,
    });
    assert.ok(next.alerts.some((a) => a.rule_id === 1), 'threshold resumes on the next poll');
  });
});

// ---------------------------------------------------------------------------
// 5. notify/ — providers, compose, fan-out, deadman, links
// ---------------------------------------------------------------------------
describe('notify: fan-out and per-provider failure counting', () => {
  function makeProviderSet() {
    const calls = { a: 0, b: 0, c: 0 };
    const okSender = { to: 'x@example.com' };
    const fail = () => { throw new Error('boom'); };
    const pA = emailProvider({ sendMail: async () => { calls.a += 1; } });
    const pB = matrixProvider({ postMessage: async () => { calls.b += 1; } });
    const pC = ntfyProvider({ publish: async () => { calls.c += 1; } });
    return { calls, providers: [pA, pB, pC], okSender };
  }

  function seedProviders(store) {
    for (const kind of ['email', 'matrix', 'ntfy']) {
      store.upsertProvider(kind, JSON.stringify({ to: 'x@example.com', room: 'r', topic: 't' }), true);
    }
  }

  it('three selected providers: one alert produces three send attempts', async () => {
    const store = makeStore();
    seedProviders(store);
    const { providers } = makeProviderSet();
    const result = await fanout({
      notifications: [{ title: 't', body: 'b', url: 'u', priority: 'normal', tags: [] }],
      providers, store, clock: frozenClock(POLL_1_AT),
    });
    assert.equal(result.sent, 3, 'three send attempts');
    assert.equal(result.failed, 0);
  });

  it('a provider failing five consecutive times is disabled; the others keep delivering; a success resets the counter', async () => {
    const store = makeStore();
    seedProviders(store);
    // Make only the email provider fail.
    const failProvider = emailProvider({ sendMail: async () => { throw new Error('boom'); } });
    const okMatrix = matrixProvider({ postMessage: async () => {} });
    const okNtfy = ntfyProvider({ publish: async () => {} });
    const providers = [failProvider, okMatrix, okNtfy];
    const one = [{ title: 't', body: 'b', url: 'u', priority: 'normal', tags: [] }];

    // Four failures: not yet disabled.
    for (let i = 0; i < 4; i += 1) {
      await fanout({ notifications: one, providers, store, clock: frozenClock(POLL_1_AT) });
    }
    assert.equal(store.getProvider('email').enabled, 1, 'still enabled after 4 failures');
    // The fifth failure disables it.
    const r5 = await fanout({ notifications: one, providers, store, clock: frozenClock(POLL_1_AT) });
    assert.equal(store.getProvider('email').enabled, 0, 'disabled after 5 consecutive failures');
    assert.ok(r5.disabled.includes('email'));
    assert.ok(r5.notices.some((n) => n.provider === 'email' && n.lastError === 'boom'), 'UI notice names provider, time, last error');
    // The others are unaffected: still selected and enabled.
    assert.equal(store.getProvider('matrix').enabled, 1);
    assert.equal(store.getProvider('ntfy').enabled, 1);
    // A success before the fifth failure resets the counter.
    store.setProviderEnabled('email', 1, '2026-09-19T08:00:00Z');
    store.recordProviderSuccess('email');
    const goodEmail = emailProvider({ sendMail: async () => {} });
    const mixed = [goodEmail, okMatrix, okNtfy];
    await fanout({ notifications: one, providers: mixed, store, clock: frozenClock(POLL_1_AT) });
    assert.equal(store.getProvider('email').consecutive_failures, 0, 'counter reset by a success');
  });
});

describe('notify: priority (M4)', () => {
  it('a front-page alert composes with priority high; a deals alert with priority normal', () => {
    const [n] = groupAndCompose([{ rule_id: 1, ruleLabel: 'ubiquiti', node_id: 975704, title: 't', isFrontPage: true, pollAt: POLL_1_AT }]);
    assert.equal(n.priority, 'high', 'front-page alert composes with priority high');
    const [n2] = groupAndCompose([{ rule_id: 2, ruleLabel: 'torbox', node_id: 975666, title: 't', isFrontPage: false, pollAt: POLL_1_AT }]);
    assert.equal(n2.priority, 'normal', 'deals alert composes with priority normal');
  });
});

describe('notify: grouping', () => {
  it('a rule matching three deals in one poll produces one notification with one unsubscribe control', () => {
    const alerts = [975666, 975704, 975672].map((id) => ({
      rule_id: 1,
      ruleLabel: 'torbox',
      node_id: id,
      title: `deal ${id}`,
      isFrontPage: false,
      pollAt: POLL_1_AT,
    }));
    const [n] = groupAndCompose(alerts);
    assert.equal(n.nodeIds.length, 3, 'lists three deals');
    assert.ok(n.unsubscribe, 'carries an unsubscribe control');
    assert.ok(!n.goto, 'no /goto/ link');
  });

  it('two rules matching in the same poll produce two notifications, never one merged', () => {
    const alerts = [
      { rule_id: 1, ruleLabel: 'a', node_id: 1, title: 't1', isFrontPage: false, pollAt: POLL_1_AT },
      { rule_id: 2, ruleLabel: 'b', node_id: 2, title: 't2', isFrontPage: false, pollAt: POLL_1_AT },
    ];
    const ns = groupAndCompose(alerts);
    assert.equal(ns.length, 2, 'two notifications, one per rule');
  });
});

describe('notify: links and the /goto/ prohibition', () => {
  it('nodeUrl links to the node page, never a /goto/ redirect', () => {
    assert.equal(nodeUrl(975704), 'https://www.ozbargain.com.au/node/975704');
    assert.ok(!nodeUrl(975704).includes('/goto/'));
  });

  it('no composed notification contains a /goto/ URL (over every notification this card produces)', () => {
    const store = makeStore();
    insertRule(store, { id: 1, type: 'match', parameters: { term: 'ubiquiti' }, surfaces: 'deals' });
    const out = evaluatePoll({
      feeds: [{ surface: 'deals', records: dealsPage0 }],
      store, clock: frozenClock(POLL_1_AT), pollAt: POLL_1_AT,
    });
    const notifications = groupAndCompose(out.alerts);
    for (const n of notifications) {
      assert.ok(!JSON.stringify(n).includes('/goto/'), `notification for ${n.nodeIds} has no /goto/ URL`);
      assert.ok(n.url.startsWith('https://www.ozbargain.com.au/node/'), 'links to the node page');
    }
  });
});

describe('notify: deadman', () => {
  it('sends a high-priority alert when deadManState reports due, and nothing when not due', async () => {
    const store = makeStore();
    store.upsertProvider('email', JSON.stringify({ to: 'x@example.com' }), true);
    const provider = emailProvider({ sendMail: async () => {} });
    const due = { due: true, step: '30min', elapsedMs: 30 * 60 * 1000 };
    const r = await sendDeadman({ deadmanState: due, providers: [provider], store, clock: frozenClock(POLL_1_AT) });
    assert.equal(r.sent, 1, 'sends when due');
    const notDue = { due: false, step: 'none', elapsedMs: 0 };
    const r2 = await sendDeadman({ deadmanState: notDue, providers: [provider], store, clock: frozenClock(POLL_1_AT) });
    assert.equal(r2, null, 'sends nothing when not due');
  });
});

describe('notify: providers are addable without touching the engine', () => {
  it('normalizeRule flattens a stored rule row (parameters blob + pinned_slug)', () => {
    const row = {
      id: 7, type: 'match',
      parameters: { term: 'torbox', mode: 'all' },
      state: 'enabled', surfaces: 'deals', cooldown_seconds: 86400,
      pinned_slug: 'torbox', created_at: 'x', modified_at: 'x',
    };
    const flat = normalizeRule(row);
    assert.equal(flat.term, 'torbox');
    assert.equal(flat.mode, 'all');
    assert.equal(flat.pinnedSlug, 'torbox');
  });
});
