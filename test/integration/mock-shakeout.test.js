/**
 * Deterministic end-to-end shakeouts over loopback HTTP. Each test owns its
 * fixture server and store, so name filtering and execution order cannot alter
 * the response timeline it observes.
 */

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
});
