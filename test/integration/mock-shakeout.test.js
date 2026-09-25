/**
 * The classifieds Selling-only and freebie flow end to end over loopback HTTP:
 * the real fixture server, classifieds poll, rules engine and fan-out. Failure
 * handling is covered by unit tests and classifieds-safe-failure.test.js.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLASSIFIEDS_PATH,
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
} from '../support/integration.js';

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

/**
 * Enable classifieds polling on a temp store and set a fake session cookie.
 * The production default is disabled + unconfigured (the gate makes zero
 * classifieds requests); the scenario below exists to
 * exercise a *real* fetch, so the intended state is set explicitly here
 * rather than in the shared `openTempStore` helper (which would also flip
 * the default-exercising deals tests). The default-disabled and
 * enabled-without-credentials contracts are covered separately by the unit
 * tests, which assert zero requests.
 */
function enableClassifieds(temp) {
  temp.store.setSetting('classifieds_enabled', '1');
  temp.store.setSetting('ozb_account_cookie', 'test-session=authenticated');
  return temp;
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
      enableClassifieds(temp);

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
});
