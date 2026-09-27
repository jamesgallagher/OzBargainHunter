/**
 * The gate's presentation view (design 3.7, chunk 2).
 *
 * `viewGate` is pure and **never writes**: the lazy `cooling→probing`
 * transition stays in the worker (chunk 1's `read()` performs it in a
 * transaction), so a page render with a cooling gate whose `until_at` is
 * in the past reads the effective `probing` state without touching the
 * `access_gate` row or the `gate_events` table.
 */

import { shouldNotify } from './alert-policy.js';
import { effectiveGate } from './rules.js';

/**
 * The email-problem statuses that surface in the UI (design 3.7, chunk 2):
 * a `sent` or `skipped` email is not a problem.
 */
const EMAIL_PROBLEMS = new Set(['not_configured', 'disabled', 'failed']);

/**
 * Derive the gate view for one render (design 3.7, chunk 2).
 *
 * @param {object} gateRow the `access_gate` row (all columns)
 * @param {object[]} events the recent gate events, newest first
 *   (`store.getGateEvents({ limit: 50 })` shape: `id, at, from_state,
 *   to_state, rule, tier, reason, until_at, min_resume_at, notified,
 *   email_status`)
 * @param {Date} now the current instant (the web passes
 *   `systemClock().now()`)
 * @returns {{
 *   closed: boolean,
 *   state: string,
 *   rule: string|null,
 *   tier: number|null,
 *   reason: string|null,
 *   since: string|null,
 *   untilAt: string|null,
 *   minResumeAt: string|null,
 *   resumeAllowed: boolean,
 *   emailProblem: 'not_configured'|'disabled'|'failed'|null,
 * }}
 */
export function viewGate(gateRow, events, now) {
  const nowMs = now.getTime();
  // Reuse the pure, read-only effective-state logic (chunk 1) so the banner
  // and the Status panel always agree with `/healthz`: an expired cool-off
  // reads as `probing`, and an expired unanswered probe reads back as
  // `cooling` (the hand-rolled transition below would have missed the
  // second case).
  const state = effectiveGate(gateRow, nowMs).state;

  const resumeAllowed =
    state === 'stopped' && gateRow.min_resume_at !== null && nowMs >= Date.parse(gateRow.min_resume_at);

  // The episode boundary: the id of the most recent `to_state = 'open'`
  // event, or 0 (the start of the table). `events` is newest-first, so the
  // FIRST `open` encountered is the most recent — stop there. The email
  // problem is the `email_status` of the latest event in this episode whose
  // policy said notify — a problem only when the send did not reach the
  // recipient.
  let boundary = 0;
  for (const e of events) {
    if (e.to_state === 'open') {
      boundary = e.id;
      break;
    }
  }
  let emailProblem = null;
  let latest = null;
  for (const e of events) {
    if (e.id <= boundary) continue;
    if (latest === null || e.id > latest.id) latest = e;
  }
  if (latest !== null) {
    const episode = events.filter((e) => e.id > boundary && e.id < latest.id);
    if (shouldNotify(latest, [...episode, latest]) && EMAIL_PROBLEMS.has(latest.email_status)) {
      emailProblem = latest.email_status;
    }
  }

  return {
    closed: state !== 'open',
    state,
    rule: gateRow.rule,
    tier: gateRow.tier,
    reason: gateRow.reason,
    since: gateRow.since,
    untilAt: gateRow.until_at,
    minResumeAt: gateRow.min_resume_at,
    resumeAllowed,
    emailProblem,
  };
}
