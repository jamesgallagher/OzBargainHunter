/**
 * Real worker -> real loopback ntfy sink regression. The worker runs unchanged
 * against a two-poll synthetic feed and must persist the send decision.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import { insertRules, openTempStore, spawnWorker, stopChild, waitFor } from '../support/integration.js';
import { startAlertSink } from '../support/alert-sink.js';
import { ALERT_DEAL_TITLE, buildAlertTimeline } from '../support/synthetic-feed.js';

describe('integration: real worker alert reaches the loopback sink', () => {
  let sink;
  let fixture;
  let temp;
  let worker;

  before(async () => {
    sink = await startAlertSink();
    const built = buildAlertTimeline();
    fixture = await startFixtureServer({ timeline: built.timeline });
    temp = openTempStore('ozb-alert-shakeout-');
    insertRules(temp.store, [
      { id: 1, type: 'match', parameters: { term: 'ubiquiti' }, cooldown_seconds: 0 },
    ]);
    temp.store.upsertProvider('ntfy', JSON.stringify({ url: sink.origin, topic: 'alerts' }), 1);

    worker = spawnWorker({
      OZB_DB_PATH: temp.dbPath,
      OZB_SNAPSHOT_PATH: join(temp.dir, 'snapshot.db'),
      OZB_DEALS_FEED_URL: `${fixture.origin}/deals/feed`,
      OZB_FRONT_FEED_URL: `${fixture.origin}/feed`,
      OZB_CLASSIFIEDS_URL: `${fixture.origin}/classified`,
    });
  });

  after(async () => {
    await stopChild(worker?.child);
    temp?.close();
    await fixture?.close();
    await sink?.close();
  });

  it('delivers exactly one deal 900003 alert and records its ledger row', async () => {
    const withLog = (err) => {
      throw new Error(`${err.message}\nworker log:\n${worker.log()}`);
    };
    await waitFor(() => (sink.messages.length === 1 ? sink.messages[0] : null), {
      timeoutMs: 30_000,
      intervalMs: 50,
      what: 'one worker alert',
    }).catch(withLog);
    // Let one more full poll cycle (three URLs) complete, so a duplicate alert
    // would have had its chance to arrive, rather than sleeping a fixed time.
    const seen = fixture.requests.length;
    await waitFor(() => fixture.requests.length >= seen + 3, {
      timeoutMs: 20_000,
      intervalMs: 50,
      what: 'one more full poll cycle after the alert',
    }).catch(withLog);

    assert.equal(worker.child.exitCode, null, `worker exited unexpectedly:\n${worker.log()}`);
    assert.equal(sink.messages.length, 1, `expected one sink message:\n${JSON.stringify(sink.messages, null, 2)}`);
    const [message] = sink.messages;
    assert.equal(message.topic, 'alerts');
    assert.equal(message.title, ALERT_DEAL_TITLE);
    assert.match(message.body, /Rule "ubiquiti" fired at/);
    assert.match(message.body, /Matched term: ubiquiti/);
    assert.match(message.body, /24 votes/);
    assert.match(message.body, /https:\/\/www\.ozbargain\.com\.au\/node\/900003/);

    const ledger = temp.store.getLedgerForRule(1);
    const row = ledger.find((entry) => entry.node_id === 900003);
    assert.ok(row, `ledger row for node 900003/rule 1 missing: ${JSON.stringify(ledger)}`);
    assert.equal(Number.isNaN(Date.parse(row.fired_at)), false, 'ledger fired_at is an ISO instant');
  });
});
