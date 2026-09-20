/**
 * The three-poll corpus scenario, end to end (card 5, design 2.3, 11.3, 11.4).
 *
 * This is the integration suite's centrepiece: the real poll cycle
 * (`runDealPoll`) talking over a real socket to the fixture server, with the
 * real transport, the real HTTP client (so the conditional requests are real),
 * the real store on a temporary database, the real rules engine, the real
 * compositor and the real fan-out with a capturing provider.
 *
 * Rules configured, as the card names them: a match rule on `ubiquiti`, a match
 * rule on `torbox`, a threshold rule at 20 upvotes, and the freebie setting on.
 *
 * **Two readings of the same three feeds, and why both are here.**
 *
 * The card's acceptance criteria mix two situations that cannot both hold in one
 * run:
 *
 * 1. *Cold start.* "Poll 1 sends zero notifications" and "the 20-vote threshold
 *    rule sends nothing at poll 1 and one notification at poll 2" are the
 *    cold-start reading: poll 1 from an empty database seeds the ledger
 *    silently (design 5.4/D26), so no rule sends anything at poll 1, and the
 *    first real alert is the one poll 2 fires.
 * 2. *An established database.* "The `ubiquiti` rule sends one notification, for
 *    975704" and "the `torbox` rule sends one notification, although 975666 is
 *    in both feeds" are the rules card's own assertions, made against a
 *    database that is not a cold start — and they must be, because a cold start
 *    seeds the very ledger rows that would otherwise fire them. So both
 *    situations are exercised: the cold-start run first, then the same poll-1
 *    feeds evaluated against a database that is not seeding.
 *
 * Two further corpus facts the assertions encode, measured from the captures:
 * 975700 (`ubiquiti`, expired at 05:29:06Z) and 975569 (`ubiquiti`, on page 1 at
 * poll 1, live) match the same rule, so "one notification" is one *grouped*
 * notification per rule per poll (6.5) — and page 1's 975569 is the first
 * cooldown-suppressed sibling of 975704, not a second alert. The observation
 * cardinality is one row per deal per poll (design 4.1, D46), which is 60 after
 * poll 1 — not the 80 in the card's first acceptance bullet, which counts feed
 * occurrences (a cross-card note from the review of the acquisition card records
 * the correction and the measurement).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEALS_PATH, FRONT_PATH, startFixtureServer } from '../../scripts/fixture-server.mjs';
import {
  configureCardRules,
  createCaptureProvider,
  openTempStore,
  registerProvider,
  runPollCycle,
  POLL_1_AT,
  POLL_2_AT,
  POLL_3_AT,
} from '../support/integration.js';

/** Every notification produced by a run, flattened. */
function allNotifications(cycles) {
  return cycles.flatMap((cycle) => cycle.notifications);
}

/** A corpus instant in the canonical ISO form the store writes (`…:00.000Z`). */
function iso(instant) {
  return new Date(instant).toISOString();
}

/** The `(node_id, rule_id)` pairs recorded in the ledger, with their counts. */
function ledgerPairs(store) {
  return store
    .getDb()
    .prepare('SELECT node_id, rule_id, COUNT(*) AS n FROM ledger GROUP BY node_id, rule_id ORDER BY node_id, rule_id')
    .all()
    // node:sqlite returns null-prototype rows; copy them so deepEqual compares
    // like for like.
    .map((row) => ({ node_id: row.node_id, rule_id: row.rule_id, n: row.n }));
}

describe('integration: the three-poll corpus scenario', () => {
  let fx;
  /** The cold-start run: polls 1-3 from an empty database. */
  let cold;
  /** The same poll-1 feeds against a database that is not seeding. */
  let established;
  const teardown = [];

  /** A per-cycle snapshot, so a poll-scoped assertion is not read after the
   *  later polls have already moved the numbers on. The observation rows are
   *  copied eagerly: a closure over the live store would read the final state. */
  function snapshot(store, nodeIds = [975704, 975666]) {
    const obs = {};
    for (const id of nodeIds) obs[id] = store.getObservations(id).map((o) => ({ ...o }));
    return {
      deals: store.countDeals(),
      observations: store.countAllObservations(),
      obs,
      frontPageFirstSeen: store.getDeal(975704)?.front_page_first_seen ?? null,
      suppressions: store.getSuppressions().map((s) => ({ ...s })),
    };
  }

  function freshRunStore() {
    const temp = openTempStore();
    teardown.push(temp);
    const capture = createCaptureProvider();
    registerProvider(temp.store, capture);
    configureCardRules(temp.store);
    return { ...temp, capture };
  }

  before(async () => {
    fx = await startFixtureServer();

    const coldRun = freshRunStore();
    const cycles = [];
    const snapshots = [];
    for (const pollAt of [POLL_1_AT, POLL_2_AT, POLL_3_AT]) {
      const cycle = await runPollCycle({
        store: coldRun.store,
        config: fx.appConfig(),
        pollAt,
        capture: coldRun.capture,
      });
      cycles.push(cycle);
      snapshots.push(snapshot(coldRun.store));
    }
    // The fixture server's request log for the cold run, captured before the
    // established run rewinds it.
    const coldRequests = fx.requests.map((r) => ({ ...r }));
    cold = { ...coldRun, cycles, snapshots, requests: coldRequests };

    // Rewind the timeline so the established run sees poll 1 again (the app's
    // URLs are the same, so the server is not restarted).
    fx.reset();
    const establishedRun = freshRunStore();
    const establishedCycle = await runPollCycle({
      store: establishedRun.store,
      config: fx.appConfig(),
      pollAt: POLL_1_AT,
      capture: establishedRun.capture,
      // The rules card's reading: the database is established, so poll 1 is
      // not a cold start and the rules that match at poll 1 do fire.
      coldStart: false,
    });
    established = {
      ...establishedRun,
      cycle: establishedCycle,
      snapshot: snapshot(establishedRun.store),
      requests: fx.requests.map((r) => ({ ...r })),
    };
  });

  after(async () => {
    for (const temp of teardown) temp.close();
    await fx.close();
  });

  describe('poll 1 — a cold start on an empty database seeds silently', () => {
    it('sends zero notifications (11.4.5)', () => {
      assert.equal(cold.cycles[0].notifications.length, 0);
      assert.equal(cold.cycles[0].evaluation.counts.alerts, 0);
      assert.equal(cold.cycles[0].evaluation.coldStart, true);
    });

    it('writes 60 deals and one observation per deal (60)', () => {
      assert.equal(cold.snapshots[0].deals, 60);
      assert.equal(cold.snapshots[0].observations, 60);
      // One row per deal, not one per feed occurrence: 975704 is observed once
      // at its poll-1 vote count of 17, and 975666 once at page 0's 113 (the
      // first feed in order wins; the front feed carries 99 for it).
      assert.equal(cold.snapshots[0].obs[975704].length, 1);
      assert.equal(cold.snapshots[0].obs[975704][0].votes_pos, 17);
      assert.equal(cold.snapshots[0].obs[975666].length, 1);
      assert.equal(cold.snapshots[0].obs[975666][0].votes_pos, 113);
    });

    it('records the expired ubiquiti match (975700) as a suppression, not an alert', () => {
      const expired = cold.snapshots[0].suppressions.filter(
        (s) => s.kind === 'expired' && s.node_id === 975700,
      );
      assert.equal(expired.length, 1, 'one expired suppression row for 975700 at poll 1');
      assert.equal(expired[0].rule_id, 1, 'recorded against the ubiquiti rule');
      assert.equal(expired[0].poll_at, iso(POLL_1_AT));
    });

    it('asks the fixture server for exactly three URLs, in order, and never page 2', () => {
      const cycle = cold.requests.slice(0, 3);
      assert.equal(cold.requests.length, 9, 'three polls, three requests each');
      assert.deepEqual(
        cycle.map((r) => r.key),
        [`${DEALS_PATH}?page=0`, `${DEALS_PATH}?page=1`, FRONT_PATH],
        'deals page 0, deals page 1, front page — in that order',
      );
      assert.deepEqual(cycle.map((r) => r.status), [200, 200, 200]);
      assert.ok(
        !cold.requests.some((r) => r.url.includes('page=2')),
        'the two-page cap holds: the fixture server was never asked for page 2',
      );
      assert.equal(cold.requests.length % 3, 0, 'every cycle is exactly three requests');
    });
  });

  describe('poll 2 — the alerts that should fire, fire', () => {
    it('sends exactly one notification: the 20-vote threshold rule on 975704', () => {
      const notifications = cold.cycles[1].notifications;
      assert.equal(notifications.length, 1, 'one rule fired, so one grouped notification');
      const [n] = notifications;
      assert.equal(n.ruleId, 3, 'the threshold rule');
      assert.deepEqual(n.nodeIds, [975704]);
      assert.match(n.body, /20\+ upvotes/, 'labelled in the user\'s own words, not a rule number');
    });

    it('carries the highest priority, because 975704 is on the front page at poll 2', () => {
      const [n] = cold.cycles[1].notifications;
      assert.equal(n.priority, 'high');
      assert.equal(n.url, 'https://www.ozbargain.com.au/node/975704');
    });

    it('gives 975704 its front_page_first_seen at poll 2, and only at poll 2', () => {
      const deal = cold.store.getDeal(975704);
      assert.ok(deal.front_page_first_seen, 'front_page_first_seen is set');
      assert.ok(
        Date.parse(deal.front_page_first_seen) > Date.parse(POLL_1_AT) &&
          Date.parse(deal.front_page_first_seen) < Date.parse(POLL_3_AT),
        'set during the poll-2 cycle',
      );
      // It was not on the front page in either poll-1 capture: the timestamp is
      // a first, not a copy of first_seen.
      assert.notEqual(deal.front_page_first_seen, deal.first_seen);
    });

    it('observes the new deal 975721 and the risen vote count on 975704', () => {
      assert.ok(cold.store.getDeal(975721), '975721 (U98 Fuel, new at poll 2) is stored');
      assert.equal(cold.snapshots[1].deals, 61);
      assert.deepEqual(
        cold.snapshots[1].obs[975704].map((o) => o.votes_pos),
        [17, 24],
        'one observation per poll, not per feed',
      );
    });

    it('takes 975666 once, although it is in both poll-2 feeds', () => {
      assert.equal(cold.snapshots[1].obs[975666].length, 2, 'one row per poll');
      assert.equal(cold.snapshots[1].observations, 90, '60 at poll 1 + 30 at poll 2');
    });

    it('is answered 200 / 304 / 200 — the mid-cycle conditional request is real', () => {
      assert.deepEqual(
        cold.requests.slice(3, 6).map((r) => r.status),
        [200, 304, 200],
        'page 0 changed, page 1 did not (a real 304), the front page changed',
      );
      assert.equal(cold.cycles[1].poll.feeds.length, 2, 'a 304 contributes no feed');
    });
  });

  describe('poll 3 — three 304s, nothing sent', () => {
    it('gets three 304 responses', () => {
      const cycle = cold.requests.slice(6, 9);
      assert.deepEqual(cycle.map((r) => r.status), [304, 304, 304]);
      assert.deepEqual(
        cycle.map((r) => r.key),
        [`${DEALS_PATH}?page=0`, `${DEALS_PATH}?page=1`, FRONT_PATH],
        'still exactly the three poll URLs',
      );
      assert.ok(
        cycle.every((r) => r.ifNoneMatch),
        'each request carried the ETag the client stored, which is what makes the 304 real',
      );
    });

    it('sends nothing and writes nothing new', () => {
      assert.equal(cold.cycles[2].notifications.length, 0);
      assert.equal(cold.cycles[2].poll.feeds.length, 0, 'no 200, so no feed reaches the engine');
      assert.equal(cold.snapshots[2].deals, cold.snapshots[1].deals);
      assert.equal(cold.snapshots[2].observations, cold.snapshots[1].observations);
    });
  });

  describe('the ledger across all three polls', () => {
    it('holds exactly one row per node-and-rule pair (11.3.1)', () => {
      const pairs = ledgerPairs(cold.store);
      assert.ok(pairs.length > 0, 'the run recorded ledger rows');
      assert.ok(
        pairs.every((p) => p.n === 1),
        `every node-and-rule pair appears once, got ${JSON.stringify(pairs.filter((p) => p.n !== 1))}`,
      );
      const total = cold.store.getDb().prepare('SELECT COUNT(*) AS n FROM ledger').get().n;
      assert.equal(total, pairs.length, 'no duplicate pair anywhere in the ledger');
    });

    it('marks the cold-start matches as already-alerted, and the poll-2 alert as sent', () => {
      // Seeded at poll 1: 975704 under the ubiquiti rule (17 votes matches the
      // term) and 975666 under the torbox rule.
      assert.equal(cold.snapshots[2].obs[975666].length, 2, 'observed once per poll');
      assert.ok(cold.store.hasLedger(975704, 1), '975704 seeded under the ubiquiti rule');
      assert.ok(cold.store.hasLedger(975666, 2), '975666 seeded under the torbox rule');
      assert.equal(cold.store.getLedgerLastFire(975704, 3), iso(POLL_2_AT), 'the threshold rule fired at poll 2');
    });
  });

  describe('notifications in general', () => {
    it('never contain a /goto/ URL', () => {
      for (const n of allNotifications(cold.cycles)) {
        assert.ok(!JSON.stringify(n).includes('/goto/'), `no /goto/ in ${n.title}`);
      }
      for (const n of established.cycle.notifications) {
        assert.ok(!JSON.stringify(n).includes('/goto/'), `no /goto/ in ${n.title}`);
      }
    });

    it('link to the node page and carry exactly two controls (6.4)', () => {
      const every = [...allNotifications(cold.cycles), ...established.cycle.notifications];
      assert.ok(every.length > 0, 'the runs produced notifications to check');
      for (const n of every) {
        assert.match(n.url, /^https:\/\/www\.ozbargain\.com\.au\/node\/\d+$/);
        assert.ok(n.unsubscribe?.url, 'an unsubscribe control');
        assert.equal(n.manage?.url, '/alerts', 'a Manage alerts control');
      }
    });
  });

  describe('the same feeds against an established database', () => {
    it('sends one ubiquiti notification, for the live 975704', () => {
      const ubiquiti = established.cycle.notifications.filter((n) => n.ruleId === 1);
      assert.equal(ubiquiti.length, 1, 'one grouped notification for the rule');
      assert.deepEqual(ubiquiti[0].nodeIds, [975704]);
      assert.match(ubiquiti[0].body, /Ubiquiti/);
    });

    it('suppresses the expired 975700 under the same rule', () => {
      const expired = established.store
        .getSuppressions()
        .filter((s) => s.kind === 'expired' && s.rule_id === 1);
      assert.deepEqual(expired.map((s) => s.node_id), [975700]);
    });

    it('sends one torbox notification, for 975666, although it is in both feeds', () => {
      const torbox = established.cycle.notifications.filter((n) => n.ruleId === 2);
      assert.equal(torbox.length, 1);
      assert.deepEqual(torbox[0].nodeIds, [975666]);
      const rows = ledgerPairs(established.store).filter((p) => p.rule_id === 2);
      assert.deepEqual(rows, [{ node_id: 975666, rule_id: 2, n: 1 }], 'one ledger row under the rule');
    });

    it('does not fire the 20-vote threshold rule on 975704 at poll 1 (17 votes)', () => {
      const threshold = established.cycle.notifications.filter((n) => n.ruleId === 3);
      for (const n of threshold) {
        assert.ok(!n.nodeIds.includes(975704), '975704 is below the threshold at poll 1');
      }
      assert.equal(established.store.getLedgerLastFire(975704, 3), null, 'no ledger row either');
    });

    it('notifies on freebies only when a free listing exists — the corpus deals feed has none', () => {
      assert.equal(established.store.getSetting('always_notify_freebie'), '1', 'the setting is on');
      const freebie = established.cycle.notifications.filter((n) => n.kind === 'freebie');
      assert.equal(freebie.length, 0, 'no free classifieds listing is fetched by a deal poll');
    });
  });

  describe('the first cooldown suppression under a rule', () => {
    it('suppresses page 1\'s second ubiquiti match (975569) after 975704 sent', () => {
      // Feed order decides: 975704 comes from page 0, 975569 from page 1, so the
      // first match fires and the second is held back by the rule's cooldown —
      // which is why the ubiquiti rule produces one notification, not two.
      const cooldown = established.store
        .getSuppressions()
        .filter((s) => s.kind === 'cooldown' && s.rule_id === 1);
      assert.deepEqual(cooldown.map((s) => s.node_id), [975569]);
      assert.equal(
        established.cycle.notifications.find((n) => n.ruleId === 1).nodeIds.length,
        1,
        'the notification lists only the deal that fired',
      );
    });
  });
});
