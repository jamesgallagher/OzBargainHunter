import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from '../../../lib/store/index.js';
import { fixedClock } from '../../../lib/clock.js';
import { formatMelbourne } from '../../../lib/time.js';
import { brevoProvider } from '../../../lib/notify/brevo.js';
import {
  shouldNotify,
  gateAlertKind,
  durationLabel,
  composeGateNotification,
  sendGateEvents,
} from '../../../lib/notify/gate.js';

// --- the pure policy, the kind, the duration label and the composer ---

test('shouldNotify: a stop is always notified', () => {
  assert.equal(shouldNotify({ to_state: 'stopped', rule: 'B1' }, []), true);
});

test('shouldNotify: a cool-off is notified from tier 2 up, never at tier 1', () => {
  assert.equal(shouldNotify({ to_state: 'cooling', tier: 2 }, []), true);
  assert.equal(shouldNotify({ to_state: 'cooling', tier: 3 }, []), true);
  assert.equal(shouldNotify({ to_state: 'cooling', tier: 1 }, []), false);
  assert.equal(shouldNotify({ to_state: 'cooling', tier: 0 }, []), false);
  assert.equal(shouldNotify({ to_state: 'cooling', tier: null }, []), false);
});

test('shouldNotify: a lazy or manual resume is not notified', () => {
  assert.equal(shouldNotify({ to_state: 'probing' }, []), false);
});

test('shouldNotify: the resumed alert needs an earlier notified, non-skipped event in the episode', () => {
  const open = { id: 2, to_state: 'open' };
  assert.equal(shouldNotify(open, [{ id: 1, to_state: 'stopped', notified: 1, email_status: 'sent' }, open]), true);
  assert.equal(shouldNotify(open, [{ id: 1, to_state: 'stopped', notified: 1, email_status: 'failed' }, open]), true);
  // A policy-skipped event (a tier-1 cool-off that did not email) is not a notification.
  assert.equal(shouldNotify(open, [{ id: 1, to_state: 'cooling', notified: 1, email_status: 'skipped' }, open]), false);
  // An unclaimed event is not a notification either.
  assert.equal(shouldNotify(open, [{ id: 1, to_state: 'stopped', notified: 0, email_status: null }, open]), false);
  assert.equal(shouldNotify(open, [open]), false);
});

test('gateAlertKind maps the state to the alert kind', () => {
  assert.equal(gateAlertKind({ to_state: 'stopped' }), 'stopped');
  assert.equal(gateAlertKind({ to_state: 'cooling' }), 'paused');
  assert.equal(gateAlertKind({ to_state: 'probing' }), 'resumed');
  assert.equal(gateAlertKind({ to_state: 'open' }), 'resumed');
});

test('durationLabel renders minutes under an hour, hours above', () => {
  assert.equal(durationLabel(15 * 60000), '15 min');
  assert.equal(durationLabel(30 * 60000), '30 min');
  assert.equal(durationLabel(59 * 60000), '59 min');
  assert.equal(durationLabel(60 * 60000), '1 h');
  assert.equal(durationLabel(90 * 60000), '1 h 30 min');
  assert.equal(durationLabel(120 * 60000), '2 h');
  assert.equal(durationLabel(24 * 3600000), '24 h');
  // Rounded to the nearest minute.
  assert.equal(durationLabel(903000), '15 min');
});

test('composeGateNotification: a stop (B1) renders fixed text in Melbourne time', () => {
  const event = {
    at: '2026-09-19T07:30:00Z',
    from_state: 'cooling',
    to_state: 'stopped',
    rule: 'B1',
    tier: 0,
    reason: 'cloudflare_block on deals feed',
    until_at: null,
    min_resume_at: '2026-09-20T07:30:00Z',
  };
  const n = composeGateNotification(event, { publicUrl: '' });
  assert.equal(n.title, 'OzBargain Hunter — access STOPPED (B1: Cloudflare block)');
  assert.equal(
    n.body,
    [
      'OzBargain access is STOPPED: B1 (Cloudflare block).',
      `It started at ${formatMelbourne('2026-09-19T07:30:00Z')}.`,
      `The earliest manual resume is ${formatMelbourne('2026-09-20T07:30:00Z')}; resume is manual from the Status screen.`,
      'No requests are being made to OzBargain until then.',
    ].join('\n'),
  );
  assert.equal(n.url, '/');
  assert.equal(n.priority, 'high');
  assert.deepEqual(n.tags, ['gate', 'B1', 'stopped']);
});

test('composeGateNotification: the public URL builds the Status link', () => {
  const event = {
    at: '2026-09-19T07:30:00Z',
    to_state: 'stopped',
    rule: 'B1',
    tier: 0,
    min_resume_at: '2026-09-20T07:30:00Z',
  };
  assert.equal(composeGateNotification(event, { publicUrl: 'https://ozb.gallagherhome.au' }).url, 'https://ozb.gallagherhome.au/');
});

test('composeGateNotification: a cool-off (B2 tier 2) renders the duration in the title and body', () => {
  const event = {
    at: '2026-09-19T07:30:00Z',
    from_state: 'open',
    to_state: 'cooling',
    rule: 'B2',
    tier: 2,
    reason: 'rate_limited on deals feed',
    until_at: '2026-09-19T08:00:00Z',
    min_resume_at: null,
  };
  const n = composeGateNotification(event, { publicUrl: '' });
  assert.equal(n.title, 'OzBargain Hunter — access paused (B2, tier 2: 30 min)');
  assert.equal(
    n.body,
    [
      'OzBargain access is paused: B2, tier 2 (B2 rate limited).',
      `It started at ${formatMelbourne('2026-09-19T07:30:00Z')}.`,
      `The cool-off ends at ${formatMelbourne('2026-09-19T08:00:00Z')}; the app will make one test request then.`,
      'No requests are being made to OzBargain until then.',
    ].join('\n'),
  );
  assert.deepEqual(n.tags, ['gate', 'B2', 'paused']);
});

test('composeGateNotification: a resume omits the rule and the no-requests line', () => {
  const event = {
    at: '2026-09-19T08:10:00Z',
    from_state: 'probing',
    to_state: 'open',
    rule: null,
    tier: null,
    reason: 'ok on deals feed',
    until_at: null,
    min_resume_at: null,
  };
  const n = composeGateNotification(event, { publicUrl: '' });
  assert.equal(n.title, 'OzBargain Hunter — access resumed');
  assert.equal(
    n.body,
    `Access resumed at ${formatMelbourne('2026-09-19T08:10:00Z')} after back-off. Normal polling continues.`,
  );
  assert.deepEqual(n.tags, ['gate', 'resumed']);

  const withRule = { ...event, rule: 'B5' };
  const n2 = composeGateNotification(withRule, { publicUrl: '' });
  assert.equal(
    n2.body,
    `Access resumed at ${formatMelbourne('2026-09-19T08:10:00Z')} after B5 back-off. Normal polling continues.`,
  );
  assert.deepEqual(n2.tags, ['gate', 'B5', 'resumed']);
});

// --- delivery: claim, policy, Brevo-always, D55, fan-out ---

const CONFIG = { OZB_PUBLIC_URL: '' };
const BREVO_ROW_CONFIG = JSON.stringify({ mailFrom: 'alerts@example.com', recipient: 'james@example.com' });

/**
 * A temp store with a fixed clock, the same shape the gate-store tests use.
 * The caller closes nothing; the helper always cleans up.
 */
function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ozb-gate-notify-'));
  const store = openStore({ path: join(dir, 'test.db'), clock: fixedClock('2026-09-19T07:30:00Z') });
  return Promise.resolve()
    .then(() => fn(store))
    .finally(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
}

const BASE_ROW = {
  state: 'open',
  rule: null,
  tier: 0,
  reason: null,
  since: '2026-09-19T07:30:00Z',
  until_at: null,
  min_resume_at: null,
  consecutive_b2: 0,
  failing_cycles: 0,
  b5_tier: 0,
  probe_used: 0,
  probe_granted_at: null,
};

/** Seed one gate event (and the matching gate row) through the store. */
function seedEvent(store, rowOverrides, event) {
  store.applyGateTransition({ ...BASE_ROW, ...rowOverrides }, [event]);
}

function stoppedEvent(overrides = {}) {
  return {
    at: '2026-09-19T07:30:00Z',
    from_state: 'cooling',
    to_state: 'stopped',
    rule: 'B1',
    tier: 0,
    reason: 'cloudflare_block on deals feed',
    until_at: null,
    min_resume_at: '2026-09-20T07:30:00Z',
    ...overrides,
  };
}

function openEvent(overrides = {}) {
  return {
    at: '2026-09-19T08:10:00Z',
    from_state: 'probing',
    to_state: 'open',
    rule: null,
    tier: null,
    reason: 'ok on deals feed',
    until_at: null,
    min_resume_at: null,
    ...overrides,
  };
}

/**
 * A fake Brevo factory: the injected `providerFactories.brevo_smtp` builds the
 * real `brevoProvider` over a recording transport, so no real SMTP is ever
 * built and every mail is observable.
 */
function fakeBrevo({ failing = false } = {}) {
  const calls = [];
  const factory = () => {
    const transport = {
      async sendMail(args) {
        calls.push(args);
        if (failing) throw new Error('smtp down');
        return { accepted: [args.to], rejected: [] };
      },
    };
    return brevoProvider(transport);
  };
  return { factory, calls };
}

/** Run one sweep, collecting the log lines. */
async function sweep(store, providerFactories, logs, config = CONFIG) {
  await sendGateEvents({ store, clock: fixedClock('2026-09-19T07:30:00Z'), config, providerFactories, log: (line) => logs.push(line) });
}

function statuses(store) {
  return store.getGateEventsAsc().map((e) => ({ id: e.id, to_state: e.to_state, notified: e.notified, email_status: e.email_status }));
}

test('sendGateEvents: a stop is sent through Brevo and logged (sent)', () =>
  withStore(async (store) => {
    store.upsertProvider('brevo_smtp', BREVO_ROW_CONFIG, true);
    seedEvent(store, { state: 'stopped', rule: 'B1', min_resume_at: '2026-09-20T07:30:00Z' }, stoppedEvent());
    const { factory, calls } = fakeBrevo();
    const logs = [];
    await sweep(store, { brevo_smtp: factory }, logs);

    assert.deepEqual(statuses(store), [{ id: 1, to_state: 'stopped', notified: 1, email_status: 'sent' }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].from, 'alerts@example.com');
    assert.equal(calls[0].to, 'james@example.com');
    assert.match(calls[0].subject, /access STOPPED \(B1: Cloudflare block\)/);
    assert.ok(calls[0].text.endsWith('\n\n/'), 'no public URL: the link is the relative /');
    assert.deepEqual(logs, ['gate-notify event 1 stopped email=sent others=0/0']);
  }));

test('sendGateEvents: the public URL builds the Status link in the email', () =>
  withStore(async (store) => {
    store.upsertProvider('brevo_smtp', BREVO_ROW_CONFIG, true);
    seedEvent(store, { state: 'stopped', rule: 'B1' }, stoppedEvent());
    const { factory, calls } = fakeBrevo();
    await sweep(store, { brevo_smtp: factory }, [], { OZB_PUBLIC_URL: 'https://ozb.gallagherhome.au' });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].text.endsWith('\n\nhttps://ozb.gallagherhome.au/'), 'the link is the public Status URL');
  }));

test('sendGateEvents: a missing Brevo row is not_configured (no send, no throw)', () =>
  withStore(async (store) => {
    seedEvent(store, { state: 'stopped', rule: 'B1' }, stoppedEvent());
    const logs = [];
    await sweep(store, {}, logs);
    assert.deepEqual(statuses(store), [{ id: 1, to_state: 'stopped', notified: 1, email_status: 'not_configured' }]);
    assert.deepEqual(logs, ['gate-notify event 1 stopped email=not_configured others=0/0']);
  }));

test('sendGateEvents: a disabled Brevo row is disabled (no send, no throw)', () =>
  withStore(async (store) => {
    store.upsertProvider('brevo_smtp', BREVO_ROW_CONFIG, true);
    store.setProviderEnabled('brevo_smtp', false, '2026-09-19T07:29:00Z');
    seedEvent(store, { state: 'stopped', rule: 'B1' }, stoppedEvent());
    const { factory, calls } = fakeBrevo();
    const logs = [];
    await sweep(store, { brevo_smtp: factory }, logs);
    assert.deepEqual(statuses(store), [{ id: 1, to_state: 'stopped', notified: 1, email_status: 'disabled' }]);
    assert.equal(calls.length, 0);
    assert.deepEqual(logs, ['gate-notify event 1 stopped email=disabled others=0/0']);
  }));

test('sendGateEvents: a send failure is failed and advances the shared D55 counter; the fifth failure disables the provider', () =>
  withStore(async (store) => {
    store.upsertProvider('brevo_smtp', BREVO_ROW_CONFIG, true);
    for (let i = 0; i < 6; i++) {
      seedEvent(store, { state: 'stopped', rule: 'B1' }, stoppedEvent({ at: `2026-09-19T07:3${i}:00Z` }));
    }
    const { factory, calls } = fakeBrevo({ failing: true });
    const logs = [];
    await sweep(store, { brevo_smtp: factory }, logs);

    // One sweep, six events: the first five fail, the sixth sees the
    // auto-disabled row and is marked disabled.
    assert.deepEqual(
      statuses(store).map((e) => e.email_status),
      ['failed', 'failed', 'failed', 'failed', 'failed', 'disabled'],
    );
    assert.equal(calls.length, 5, 'every failure attempted a send');
    const row = store.getProvider('brevo_smtp');
    assert.equal(row.consecutive_failures, 5);
    assert.equal(row.enabled, 0, 'the D55 auto-disable landed on the shared row');
    assert.ok(row.disabled_at !== null);
    assert.ok(logs.includes('gate-notify event 5 stopped email=failed others=0/0'));
    assert.ok(logs.includes('gate-notify event 6 stopped email=disabled others=0/0'));
  }));

test('sendGateEvents: the D55 counter is shared with the deal-alert fan-out (four earlier failures + one gate failure disables)', () =>
  withStore(async (store) => {
    store.upsertProvider('brevo_smtp', BREVO_ROW_CONFIG, true);
    // Four earlier failures, as recorded by the deal-alert fan-out.
    for (let i = 0; i < 4; i++) store.recordProviderFailure('brevo_smtp', 'earlier failure', '2026-09-19T07:00:00Z');
    seedEvent(store, { state: 'stopped', rule: 'B1' }, stoppedEvent());
    const { factory } = fakeBrevo({ failing: true });
    await sweep(store, { brevo_smtp: factory }, []);
    assert.deepEqual(statuses(store), [{ id: 1, to_state: 'stopped', notified: 1, email_status: 'failed' }]);
    const row = store.getProvider('brevo_smtp');
    assert.equal(row.consecutive_failures, 5);
    assert.equal(row.enabled, 0, 'the gate failure was the fifth on the shared counter');
  }));

test('sendGateEvents: a successful send resets the shared D55 counter', () =>
  withStore(async (store) => {
    store.upsertProvider('brevo_smtp', BREVO_ROW_CONFIG, true);
    store.recordProviderFailure('brevo_smtp', 'earlier failure', '2026-09-19T07:00:00Z');
    seedEvent(store, { state: 'stopped', rule: 'B1' }, stoppedEvent());
    const { factory } = fakeBrevo();
    await sweep(store, { brevo_smtp: factory }, []);
    assert.deepEqual(statuses(store), [{ id: 1, to_state: 'stopped', notified: 1, email_status: 'sent' }]);
    assert.equal(store.getProvider('brevo_smtp').consecutive_failures, 0);
  }));

test('sendGateEvents: the claim dedups — an event claimed by another sweep is not delivered twice', () =>
  withStore(async (store) => {
    store.upsertProvider('brevo_smtp', BREVO_ROW_CONFIG, true);
    seedEvent(store, { state: 'stopped', rule: 'B1' }, stoppedEvent());
    assert.equal(store.claimGateEvent(1), true, 'the other sweep claims it first');
    const { factory, calls } = fakeBrevo();
    const logs = [];
    await sweep(store, { brevo_smtp: factory }, logs);
    assert.equal(calls.length, 0, 'no second send');
    assert.deepEqual(statuses(store), [{ id: 1, to_state: 'stopped', notified: 1, email_status: null }]);
    assert.deepEqual(logs, [], 'no per-event line for a claim that was not ours');
  }));

test('sendGateEvents: a tier-1 cool-off is policy-skipped — no email and no fan-out', () =>
  withStore(async (store) => {
    store.upsertProvider('brevo_smtp', BREVO_ROW_CONFIG, true);
    const matrixCalls = [];
    const matrixFactory = () => ({ kind: 'matrix', send: (n) => { matrixCalls.push(n); } });
    store.upsertProvider('matrix', '{}', true);
    seedEvent(
      store,
      { state: 'cooling', rule: 'B2', tier: 1, until_at: '2026-09-19T07:45:00Z' },
      {
        at: '2026-09-19T07:30:00Z',
        from_state: 'open',
        to_state: 'cooling',
        rule: 'B2',
        tier: 1,
        reason: 'rate_limited on deals feed',
        until_at: '2026-09-19T07:45:00Z',
        min_resume_at: null,
      },
    );
    const { factory, calls } = fakeBrevo();
    const logs = [];
    await sweep(store, { brevo_smtp: factory, matrix: matrixFactory }, logs);
    assert.deepEqual(statuses(store), [{ id: 1, to_state: 'cooling', notified: 1, email_status: 'skipped' }]);
    assert.equal(calls.length, 0, 'no email');
    assert.equal(matrixCalls.length, 0, 'no fan-out either');
    assert.deepEqual(logs, ['gate-notify event 1 paused email=skipped others=0/0']);
  }));

test('sendGateEvents: the other selected providers receive the alert and Brevo is never double-sent', () =>
  withStore(async (store) => {
    // Brevo is selected for deal alerts too — it must still be sent exactly once.
    store.upsertProvider('brevo_smtp', BREVO_ROW_CONFIG, true);
    const matrixCalls = [];
    const matrixFactory = () => ({ kind: 'matrix', send: (n) => { matrixCalls.push(n); } });
    store.upsertProvider('matrix', '{}', true);
    seedEvent(store, { state: 'stopped', rule: 'B1' }, stoppedEvent());
    const { factory, calls } = fakeBrevo();
    const logs = [];
    await sweep(store, { brevo_smtp: factory, matrix: matrixFactory }, logs);
    assert.equal(calls.length, 1, 'Brevo sent once, directly');
    assert.equal(matrixCalls.length, 1, 'the other selected provider fanned out');
    assert.deepEqual(statuses(store), [{ id: 1, to_state: 'stopped', notified: 1, email_status: 'sent' }]);
    assert.deepEqual(logs, ['gate-notify event 1 stopped email=sent others=1/0']);
  }));

test('sendGateEvents: a resumed alert is sent when an earlier event in the same sweep was notified', () =>
  withStore(async (store) => {
    store.upsertProvider('brevo_smtp', BREVO_ROW_CONFIG, true);
    seedEvent(store, { state: 'stopped', rule: 'B1' }, stoppedEvent());
    seedEvent(store, { state: 'open' }, openEvent());
    const { factory, calls } = fakeBrevo();
    await sweep(store, { brevo_smtp: factory }, []);
    assert.deepEqual(
      statuses(store).map((e) => e.email_status),
      ['sent', 'sent'],
      'the stop and the resume are both sent in one sweep',
    );
    assert.equal(calls.length, 2);
  }));

test('sendGateEvents: a policy-skipped earlier event does not trigger the resumed alert', () =>
  withStore(async (store) => {
    store.upsertProvider('brevo_smtp', BREVO_ROW_CONFIG, true);
    seedEvent(
      store,
      { state: 'cooling', rule: 'B2', tier: 1, until_at: '2026-09-19T07:45:00Z' },
      {
        at: '2026-09-19T07:30:00Z',
        from_state: 'open',
        to_state: 'cooling',
        rule: 'B2',
        tier: 1,
        reason: 'rate_limited on deals feed',
        until_at: '2026-09-19T07:45:00Z',
        min_resume_at: null,
      },
    );
    seedEvent(store, { state: 'open' }, openEvent());
    const { factory, calls } = fakeBrevo();
    await sweep(store, { brevo_smtp: factory }, []);
    assert.deepEqual(
      statuses(store).map((e) => e.email_status),
      ['skipped', 'skipped'],
      'a single 503 must not indirectly trigger the resume email',
    );
    assert.equal(calls.length, 0);
  }));

test('sendGateEvents: a resumed alert honours the persisted outcome of an earlier sweep (sent)', () =>
  withStore(async (store) => {
    store.upsertProvider('brevo_smtp', BREVO_ROW_CONFIG, true);
    seedEvent(store, { state: 'stopped', rule: 'B1' }, stoppedEvent());
    // An earlier sweep claimed and sent the stop.
    assert.equal(store.claimGateEvent(1), true);
    store.setGateEventEmailStatus(1, 'sent');
    seedEvent(store, { state: 'open' }, openEvent());
    const { factory, calls } = fakeBrevo();
    await sweep(store, { brevo_smtp: factory }, []);
    assert.deepEqual(
      statuses(store).map((e) => e.email_status),
      ['sent', 'sent'],
    );
    assert.equal(calls.length, 1, 'only the resume is sent by this sweep');
  }));

test('sendGateEvents: a persisted skipped outcome does not trigger the resumed alert', () =>
  withStore(async (store) => {
    store.upsertProvider('brevo_smtp', BREVO_ROW_CONFIG, true);
    seedEvent(store, { state: 'stopped', rule: 'B1' }, stoppedEvent());
    assert.equal(store.claimGateEvent(1), true);
    store.setGateEventEmailStatus(1, 'skipped');
    seedEvent(store, { state: 'open' }, openEvent());
    const { factory, calls } = fakeBrevo();
    await sweep(store, { brevo_smtp: factory }, []);
    assert.deepEqual(
      statuses(store).map((e) => e.email_status),
      ['skipped', 'skipped'],
    );
    assert.equal(calls.length, 0);
  }));

test('sendGateEvents: never throws — a factory failure marks the event failed and the sweep ends', () =>
  withStore(async (store) => {
    store.upsertProvider('brevo_smtp', BREVO_ROW_CONFIG, true);
    seedEvent(store, { state: 'stopped', rule: 'B1' }, stoppedEvent());
    const logs = [];
    await assert.doesNotReject(
      sweep(store, { brevo_smtp: () => { throw new Error('factory boom'); } }, logs),
    );
    assert.deepEqual(statuses(store), [{ id: 1, to_state: 'stopped', notified: 1, email_status: 'failed' }]);
    assert.deepEqual(logs, ['gate-notify event 1 error (Error)']);
  }));

test('sendGateEvents: an unexpected failure on one event does not stop the next event in the same sweep', () =>
  withStore(async (store) => {
    store.upsertProvider('brevo_smtp', BREVO_ROW_CONFIG, true);
    seedEvent(store, { state: 'stopped', rule: 'B1' }, stoppedEvent());
    seedEvent(store, { state: 'stopped', rule: 'B1' }, stoppedEvent({ at: '2026-09-19T07:31:00Z' }));
    const { factory, calls } = fakeBrevo();
    let builds = 0;
    const flakyFactory = () => {
      builds += 1;
      if (builds === 1) throw new Error('factory boom');
      return factory();
    };
    const logs = [];
    await assert.doesNotReject(sweep(store, { brevo_smtp: flakyFactory }, logs));
    assert.equal(builds, 2, 'the factory is consulted once per event');
    assert.deepEqual(
      statuses(store).map((e) => e.email_status),
      ['failed', 'sent'],
      'the first event is failed, the next is still delivered',
    );
    assert.equal(calls.length, 1, 'one send for the second event');
    assert.ok(logs.includes('gate-notify event 1 error (Error)'));
    assert.ok(logs.includes('gate-notify event 2 stopped email=sent others=0/0'));
  }));

test('sendGateEvents: no unsent events — no log, no throw', () =>
  withStore(async (store) => {
    const logs = [];
    await assert.doesNotReject(sweep(store, {}, logs));
    assert.deepEqual(logs, []);
  }));
