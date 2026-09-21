/**
 * Deterministic end-to-end shakeouts over loopback HTTP. Each test owns its
 * fixture server and store, so name filtering and execution order cannot alter
 * the response timeline it observes.
 */

import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLASSIFIEDS_PATH,
  DEALS_PATH,
  FRONT_PATH,
  startFixtureServer,
} from '../../scripts/fixture-server.mjs';
import {
  POLL_1_AT,
  POLL_2_AT,
  createCaptureProvider,
  insertRules,
  openTempStore,
  registerProvider,
  runClassifiedsCycle,
  runPollCycle,
} from '../support/integration.js';

const UBIQUITI_TITLE = '[WA] Ubiquiti Unifi Dream Router 7 (UDR7) $399 + Delivery ($0 WA C&C/ in-Store) @ PLE';

async function withHarness(timeline, run) {
  const fx = await startFixtureServer(timeline ? { timeline } : {});
  const temp = openTempStore('ozb-shakeout-');
  const capture = createCaptureProvider();
  registerProvider(temp.store, capture);
  try {
    await run({ fx, temp, capture });
  } finally {
    temp.close();
    await fx.close();
  }
}

function dealTimeline(response) {
  return {
    [`${DEALS_PATH}?page=0`]: [response],
    [`${DEALS_PATH}?page=1`]: [response],
    [FRONT_PATH]: [response],
  };
}

describe('integration: full mock shakeout', () => {
  it('classifieds Selling-only filtering excludes pinned/free/wanted/swap and emits the expected freebie', async () => {
    await withHarness({
      [CLASSIFIEDS_PATH]: [
        'http/classifieds-page.html',
        'http/derived/classifieds-page-unpinned-freebie.html',
      ],
    }, async ({ fx, temp, capture }) => {
      insertRules(temp.store, [{
        id: 10,
        type: 'match',
        parameters: { term: 'qantas' },
        surfaces: 'classifieds',
      }]);
      temp.store.setSetting('always_notify_freebie', '1');

      const selling = await runClassifiedsCycle({
        store: temp.store,
        config: fx.appConfig(),
        pollAt: POLL_1_AT,
        capture,
        coldStart: false,
      });

      assert.equal(selling.poll.state, 'valid');
      assert.equal(selling.poll.listings.length, 25);
      assert.equal(selling.notifications.length, 1, 'only the Selling Qantas listing is eligible');
      assert.equal(selling.notifications[0].ruleId, 10);
      assert.deepEqual(selling.notifications[0].nodeIds, [975710]);
      assert.equal(selling.notifications[0].title, '120,000 Qantas Points @ 1.4c Per Point');
      assert.equal(selling.notifications[0].url, 'https://www.ozbargain.com.au/node/975710');
      assert.equal(temp.store.hasLedger(751807, 0), false, 'the pinned 2023 freebie is not seeded or sent');

      const freebie = await runClassifiedsCycle({
        store: temp.store,
        config: fx.appConfig(),
        pollAt: POLL_2_AT,
        capture,
        coldStart: false,
      });

      assert.equal(freebie.notifications.length, 1);
      assert.equal(freebie.notifications[0].kind, 'freebie');
      assert.deepEqual(freebie.notifications[0].nodeIds, [975712]);
      assert.equal(freebie.notifications[0].title, 'ausdkunst has just listed a new freebie');
      assert.equal(freebie.notifications[0].url, 'https://www.ozbargain.com.au/node/975712');
      assert.deepEqual(fx.requests.map((request) => request.fixture), [
        'http/classifieds-page.html',
        'http/derived/classifieds-page-unpinned-freebie.html',
      ]);
      assert.equal(capture.notifications.length, 2, 'both decisions reached the selected mock sink');
    });
  });

  it('classifieds deal polling uses pages 0 and 1 only, deduplicates feeds, and stores comments', async () => {
    await withHarness(null, async ({ fx, temp, capture }) => {
      insertRules(temp.store, [{ id: 11, type: 'match', parameters: { term: 'ubiquiti' } }]);

      const cycle = await runPollCycle({
        store: temp.store,
        config: fx.appConfig(),
        pollAt: POLL_1_AT,
        capture,
        coldStart: false,
      });

      assert.deepEqual(fx.requests.map((request) => request.key), [
        `${DEALS_PATH}?page=0`,
        `${DEALS_PATH}?page=1`,
        FRONT_PATH,
      ]);
      assert.ok(!fx.requests.some((request) => request.url.includes('page=2')));
      assert.ok(!fx.requests.some((request) => request.url.includes('/comment/')));
      assert.deepEqual(fx.requests.map((request) => request.fixture), [
        'http/r0.xml',
        'http/r1.xml',
        'http/feed_feed.xml',
      ]);

      assert.equal(cycle.notifications.length, 1);
      assert.equal(cycle.notifications[0].title, UBIQUITI_TITLE);
      assert.deepEqual(cycle.notifications[0].nodeIds, [975704]);
      assert.equal(cycle.notifications[0].url, 'https://www.ozbargain.com.au/node/975704');
      assert.equal(capture.notifications.length, 1);

      const ubiquitiObservation = temp.store.getObservations(975704);
      assert.equal(ubiquitiObservation.length, 1, 'the page-0/front duplicate is observed once');
      assert.equal(ubiquitiObservation[0].comment_count, 3, 'comment metadata is stored without fetching comments');
      assert.equal(temp.store.getObservations(975666).length, 1, 'the deals/front duplicate identity is stored once');
    });
  });

  for (const scenario of [
    {
      name: 'malformed',
      response: { fixture: 'http/derived/deals-page0-truncated.xml' },
      expectedClass: 'unparseable',
    },
    {
      name: 'empty',
      response: { body: '', contentType: 'application/rss+xml; charset=utf-8' },
      expectedClass: 'unparseable',
    },
    {
      name: 'failure',
      response: { status: 500, body: 'fixture failure' },
      expectedClass: 'transient',
    },
  ]) {
    it(`${scenario.name} loopback responses record failures and send no alert`, async () => {
      await withHarness(dealTimeline(scenario.response), async ({ fx, temp, capture }) => {
        insertRules(temp.store, [{ id: 12, type: 'match', parameters: { term: 'ubiquiti' } }]);

        const cycle = await runPollCycle({
          store: temp.store,
          config: fx.appConfig(),
          pollAt: POLL_1_AT,
          capture,
          coldStart: false,
        });

        assert.equal(cycle.notifications.length, 0);
        assert.equal(capture.notifications.length, 0);
        assert.equal(cycle.poll.failures, 3);
        assert.deepEqual(fx.requests.map((request) => request.status), [
          scenario.response.status ?? 200,
          scenario.response.status ?? 200,
          scenario.response.status ?? 200,
        ]);
        assert.deepEqual(
          temp.store.getFailures().map((failure) => failure.response_class),
          [scenario.expectedClass, scenario.expectedClass, scenario.expectedClass],
        );
      });
    });
  }

  // --- Classifieds negative responses ---------------------------------------
  //
  // The same malformed/empty/failure shakeout for the classifieds surface. The
  // classifieds poll fetches a single URL, so each case carries a descriptor for
  // CLASSIFIEDS_PATH alone and owns its fixture server and store — the same rule
  // as the cases above, which is what makes it selectable by
  // --test-name-pattern and independent of execution order.

  // The malformed body is read from the corpus and cut inside its first
  // listing, before that listing's title heading: the analogue of the corpus's
  // `derived/deals-page0-truncated.xml`, which is cut inside the third <item>.
  // Deriving it here keeps the captured corpus free of synthetic files.
  const classifiedsCorpus = readFileSync(
    new URL('../../fixtures/http/classifieds-page.html', import.meta.url),
    'utf8',
  );
  const classifiedsRule = {
    id: 12,
    type: 'match',
    parameters: { term: 'qantas' },
    surfaces: 'classifieds',
  };

  it('classifieds malformed 200: the parse failure reaches the caller, delivers nothing, and writes no session state', async () => {
    const listingStart = classifiedsCorpus.indexOf('<div class="node node-classified');
    const truncated = classifiedsCorpus.slice(
      0,
      classifiedsCorpus.indexOf('<h2 class="title"', listingStart),
    );
    assert.ok(truncated.includes('<div class="node node-classified'), 'the cut lands inside a listing');

    await withHarness(
      { [CLASSIFIEDS_PATH]: [{ body: truncated, contentType: 'text/html; charset=utf-8' }] },
      async ({ fx, temp, capture }) => {
        insertRules(temp.store, [classifiedsRule]);

        await assert.rejects(
          runClassifiedsCycle({
            store: temp.store,
            config: fx.appConfig(),
            pollAt: POLL_1_AT,
            capture,
            coldStart: false,
          }),
          /classifieds: listing without a numeric node id/,
        );

        assert.equal(capture.notifications.length, 0, 'nothing reached the mock sink');
        assert.equal(temp.store.countDeals(), 0);
        assert.equal(temp.store.countAllObservations(), 0);
        assert.deepEqual(
          temp.store.getFailures(),
          [],
          'a body that is not a classifieds page writes no session trace and no failure row',
        );
        assert.equal(temp.store.getSetting('classifieds_last_uid'), null, 'no uid is persisted');
        assert.deepEqual(
          fx.requests.map((request) => [request.key, request.status ?? 200]),
          [[CLASSIFIEDS_PATH, 200]],
          'the classifieds page is fetched once, over real HTTP',
        );
      },
    );
  });

  it('classifieds empty 200 body: the documented uid-0 rule holds, nothing is evaluated, nothing is delivered', async () => {
    await withHarness(
      { [CLASSIFIEDS_PATH]: [{ body: '', contentType: 'text/html; charset=utf-8' }] },
      async ({ fx, temp, capture }) => {
        insertRules(temp.store, [classifiedsRule]);

        const cycle = await runClassifiedsCycle({
          store: temp.store,
          config: fx.appConfig(),
          pollAt: POLL_1_AT,
          capture,
          coldStart: false,
        });

        // The authoritative session check is the page's own uid (design 3.6), so a
        // body carrying no `OzB_vars` yields uid 0, and uid 0 is `expired`. That is
        // the documented fail-closed rule and it delivers nothing: with no listings
        // there is no feed to evaluate, so no notification can reach a provider.
        assert.equal(cycle.poll.state, 'expired');
        assert.equal(cycle.poll.listings.length, 0);
        assert.equal(cycle.evaluation, null, 'no feed is evaluated from a page with no listings');
        assert.equal(cycle.notifications.length, 0);
        assert.equal(capture.notifications.length, 0, 'nothing reached the mock sink');
        assert.equal(temp.store.countDeals(), 0);
        assert.equal(temp.store.countAllObservations(), 0);
        assert.deepEqual(fx.requests.map((request) => request.key), [CLASSIFIEDS_PATH]);

        // The hazard this case exposes is pinned here rather than left implicit:
        // the empty body reaches the parser, the parser reports uid 0, and the
        // uid-0 rule writes a durable `session_expired` trace and latches the
        // session off. No delivery results from it, but the trace is a false
        // session expiry for a body that is not a page at all. Changing that is a
        // `lib/acquire/classifieds.js` change, which this card's approved file set
        // excludes; it is recorded on the card as a finding for routing.
        assert.equal(cycle.poll.alert, true);
        assert.equal(cycle.poll.latched, true);
        assert.deepEqual(
          temp.store.getFailures().map((failure) => failure.response_class),
          ['session_expired'],
        );
        assert.equal(temp.store.getSetting('classifieds_last_uid'), '0');

        // Positive control: the same rule and the same sink DO deliver when the page
        // is the real capture, so the zero above is a property of the response and
        // not of the instrument.
        await withHarness(
          { [CLASSIFIEDS_PATH]: ['http/classifieds-page.html'] },
          async (control) => {
            insertRules(control.temp.store, [classifiedsRule]);
            const real = await runClassifiedsCycle({
              store: control.temp.store,
              config: control.fx.appConfig(),
              pollAt: POLL_1_AT,
              capture: control.capture,
              coldStart: false,
            });
            assert.equal(real.notifications.length, 1);
            assert.deepEqual(real.notifications[0].nodeIds, [975710]);
            assert.equal(control.capture.notifications.length, 1, 'the mock sink is live');
          },
        );
      },
    );
  });

  for (const status of [500, 404]) {
    it(`classifieds ${status} failure: the session is unknown, never latches, and delivers nothing`, async () => {
      await withHarness(
        { [CLASSIFIEDS_PATH]: [{ status, body: 'fixture failure' }] },
        async ({ fx, temp, capture }) => {
          insertRules(temp.store, [classifiedsRule]);

          const cycle = await runClassifiedsCycle({
            store: temp.store,
            config: fx.appConfig(),
            pollAt: POLL_1_AT,
            capture,
            coldStart: false,
          });

          // A non-200 is not a session signal (design 3.5/3.6): the session is
          // unknown for this response, so the poll neither latches nor alerts.
          assert.equal(cycle.poll.state, 'unknown');
          assert.equal(cycle.poll.alert, false);
          assert.equal(cycle.poll.latched, false);
          assert.equal(cycle.poll.listings.length, 0);
          assert.equal(cycle.evaluation, null);
          assert.equal(cycle.notifications.length, 0);
          assert.equal(capture.notifications.length, 0, 'nothing reached the mock sink');
          assert.equal(temp.store.getSetting('classifieds_last_uid'), null, 'no uid is persisted');
          assert.deepEqual(
            fx.requests.map((request) => [request.key, request.status ?? 200]),
            [[CLASSIFIEDS_PATH, status]],
          );
        },
      );
    });
  }
});
