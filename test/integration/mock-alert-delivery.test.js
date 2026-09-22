/**
 * Real worker -> real loopback ntfy sink regression. The worker runs unchanged
 * against a two-poll synthetic feed and must persist the send decision.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { startFixtureServer } from '../../scripts/fixture-server.mjs';
import { insertRules, openTempStore, stopChild, waitFor } from '../support/integration.js';
import { REPO_ROOT } from '../support/app-server.js';
import { startAlertSink } from '../support/alert-sink.js';
import { ALERT_DEAL_TITLE, buildAlertTimeline } from '../support/synthetic-feed.js';

describe('integration: real worker alert reaches the loopback sink', () => {
  let sink;
  let fixture;
  let temp;
  let worker;
  let workerLog = '';

  before(async () => {
    sink = await startAlertSink();
    const built = buildAlertTimeline();
    fixture = await startFixtureServer({ timeline: built.timeline });
    temp = openTempStore('ozb-alert-shakeout-');
    insertRules(temp.store, [
      { id: 1, type: 'match', parameters: { term: 'ubiquiti' }, cooldown_seconds: 0 },
    ]);
    temp.store.upsertProvider('ntfy', JSON.stringify({ url: sink.origin, topic: 'alerts' }), 1);

    worker = spawn(process.execPath, [join(REPO_ROOT, 'worker/main.js')], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        OZB_DB_PATH: temp.dbPath,
        OZB_SNAPSHOT_PATH: join(temp.dir, 'snapshot.db'),
        OZB_DEALS_FEED_URL: `${fixture.origin}/deals/feed`,
        OZB_FRONT_FEED_URL: `${fixture.origin}/feed`,
        OZB_CLASSIFIEDS_URL: `${fixture.origin}/classified`,
        OZB_POLL_INTERVAL_SECONDS: '300',
        OZB_POLL_INTERVAL_SECONDS_TEST_OVERRIDE: '2',
        OZB_CLASSIFIEDS_INTERVAL_SECONDS: '3600',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import ./test/support/no-network.js'].filter(Boolean).join(' '),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    worker.stdout.on('data', (chunk) => { workerLog += chunk; });
    worker.stderr.on('data', (chunk) => { workerLog += chunk; });
  });

  after(async () => {
    await stopChild(worker);
    temp?.close();
    await fixture?.close();
    await sink?.close();
  });

  it('delivers exactly one deal 900003 alert and records its ledger row', async () => {
    await waitFor(() => sink.messages.length === 1 ? sink.messages[0] : null, {
      timeoutMs: 45_000,
      intervalMs: 250,
      what: `one worker alert; worker log:\n${workerLog}`,
    });
    await new Promise((resolve) => setTimeout(resolve, 2500));

    assert.equal(worker.exitCode, null, `worker exited unexpectedly:\n${workerLog}`);
    assert.equal(sink.messages.length, 1, `expected one sink message:\n${JSON.stringify(sink.messages, null, 2)}\n${workerLog}`);
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

    const evidence = {
      sinkMessageCount: sink.messages.length,
      message,
      ledger: { node_id: 900003, rule_id: 1, fired_at: row.fired_at },
    };
    console.log(`ALERT_SHAKEOUT_EVIDENCE ${JSON.stringify(evidence)}`);
  });
});
