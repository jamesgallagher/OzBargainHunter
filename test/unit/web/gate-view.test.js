import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { viewGate } from '../../../lib/gate/view.js';
import { defaultGate } from '../../../lib/gate/rules.js';
import { healthWithGate, healthFromPollState } from '../../../app/components/ui.js';

// A fixed instant: 08:00Z. Everything in the rows is relative to it.
const NOW = new Date('2026-09-19T08:00:00Z');
const BASE_ROW = { ...defaultGate(), since: '2026-09-19T07:30:00Z' };

describe('viewGate (pure, read-only)', () => {
  test('an open gate reports open, not closed, and resume is not allowed', () => {
    const view = viewGate(BASE_ROW, [], NOW);
    assert.equal(view.closed, false);
    assert.equal(view.state, 'open');
    assert.equal(view.resumeAllowed, false);
    assert.equal(view.emailProblem, null);
  });

  test('a cooling gate whose until_at is in the future stays cooling (closed)', () => {
    const row = { ...BASE_ROW, state: 'cooling', rule: 'B2', tier: 2, reason: 'rate limited', until_at: '2026-09-19T08:30:00Z' };
    const view = viewGate(row, [], NOW);
    assert.equal(view.closed, true);
    assert.equal(view.state, 'cooling');
    assert.equal(view.untilAt, '2026-09-19T08:30:00Z');
  });

  test('a cooling gate whose until_at has passed reads as probing (closed), without writing', () => {
    const row = { ...BASE_ROW, state: 'cooling', rule: 'B2', tier: 2, reason: 'rate limited', until_at: '2026-09-19T07:45:00Z' };
    const view = viewGate(row, [], NOW);
    assert.equal(view.closed, true);
    assert.equal(view.state, 'probing');
  });

  test('a probing gate whose probe window expired reads back as cooling (closed)', () => {
    const row = { ...BASE_ROW, state: 'probing', probe_used: 1, probe_granted_at: '2026-09-19T07:45:00Z' };
    const view = viewGate(row, [], NOW);
    assert.equal(view.closed, true);
    assert.equal(view.state, 'cooling');
  });

  test('a stopped gate allows resume once min_resume_at has passed', () => {
    const row = { ...BASE_ROW, state: 'stopped', rule: 'B1', reason: 'Cloudflare block', min_resume_at: '2026-09-19T07:45:00Z' };
    const view = viewGate(row, [], NOW);
    assert.equal(view.closed, true);
    assert.equal(view.state, 'stopped');
    assert.equal(view.resumeAllowed, true);
  });

  test('a stopped gate does not allow resume before min_resume_at', () => {
    const row = { ...BASE_ROW, state: 'stopped', rule: 'B1', reason: 'Cloudflare block', min_resume_at: '2026-09-19T08:15:00Z' };
    const view = viewGate(row, [], NOW);
    assert.equal(view.resumeAllowed, false);
  });

  test('a stopped gate with no min_resume_at does not allow resume', () => {
    const row = { ...BASE_ROW, state: 'stopped', rule: 'B1', reason: 'Cloudflare block', min_resume_at: null };
    const view = viewGate(row, [], NOW);
    assert.equal(view.resumeAllowed, false);
  });

  test('emailProblem surfaces the failed email of the latest notify-able event in the episode', () => {
    // No `open` event: the episode starts at the table bottom (boundary 0).
    const events = [
      { id: 2, to_state: 'stopped', rule: 'B1', tier: 0, notified: 1, email_status: 'failed' },
      { id: 1, to_state: 'cooling', rule: 'B2', tier: 2, notified: 1, email_status: 'sent' },
    ];
    const view = viewGate({ ...BASE_ROW, state: 'stopped', rule: 'B1' }, events, NOW);
    assert.equal(view.emailProblem, 'failed');
  });

  test('emailProblem is null when the email was sent', () => {
    const events = [{ id: 1, to_state: 'stopped', rule: 'B1', tier: 0, notified: 1, email_status: 'sent' }];
    const view = viewGate({ ...BASE_ROW, state: 'stopped', rule: 'B1' }, events, NOW);
    assert.equal(view.emailProblem, null);
  });

  test('emailProblem is null when the event was skipped by policy', () => {
    const events = [{ id: 1, to_state: 'cooling', rule: 'B2', tier: 2, notified: 1, email_status: 'skipped' }];
    const view = viewGate({ ...BASE_ROW, state: 'cooling', rule: 'B2', tier: 2 }, events, NOW);
    assert.equal(view.emailProblem, null);
  });

  test('events before the most recent open event are not part of the episode', () => {
    // Newest first: the open event (id 2) closes the episode that contained
    // the failed stop (id 1); the tier-1 cooling (id 3) does not notify.
    const events = [
      { id: 3, to_state: 'cooling', rule: 'B2', tier: 1, notified: 1, email_status: 'skipped' },
      { id: 2, to_state: 'open' },
      { id: 1, to_state: 'stopped', rule: 'B1', tier: 0, notified: 1, email_status: 'failed' },
    ];
    const view = viewGate({ ...BASE_ROW, state: 'cooling', rule: 'B2', tier: 1 }, events, NOW);
    assert.equal(view.emailProblem, null);
  });
});

describe('healthWithGate (the banner health line)', () => {
  test('a closed stopped gate wins: attention / Stopped', () => {
    const health = healthWithGate(null, { closed: true, state: 'stopped' });
    assert.deepEqual(health, { tone: 'attention', label: 'Stopped', detail: 'OzBargain access is stopped' });
  });

  test('a closed cooling gate wins: attention / Backing off', () => {
    const health = healthWithGate(null, { closed: true, state: 'cooling' });
    assert.deepEqual(health, { tone: 'attention', label: 'Backing off', detail: 'OzBargain is being backed off' });
  });

  test('an open gate with no successful poll falls back to the poll health', () => {
    const health = healthWithGate(null, { closed: false, state: 'open' });
    assert.deepEqual(health, { tone: 'waiting', label: 'Waiting', detail: 'No successful poll yet' });
  });

  test('an open gate with a backoff poll reports the poll backoff', () => {
    const health = healthWithGate({ backoff_seconds: 30 }, { closed: false, state: 'open' });
    assert.deepEqual(health, { tone: 'backing-off', label: 'Backing off', detail: 'Retry in 30s' });
  });

  test('a null gate view falls back to the poll health', () => {
    const health = healthWithGate({ backoff_seconds: 30 }, null);
    assert.deepEqual(health, healthFromPollState({ backoff_seconds: 30 }));
  });

  test('the gate line wins even when the poll looks healthy', () => {
    const poll = { backoff_seconds: 0, consecutive_failures: 0, last_success_at: '2026-09-19T07:55:00Z', last_response_class: 'ok' };
    const health = healthWithGate(poll, { closed: true, state: 'stopped' });
    assert.deepEqual(health, { tone: 'attention', label: 'Stopped', detail: 'OzBargain access is stopped' });
  });
});
