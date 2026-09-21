/**
 * The dead-man's switch (design 3.7).
 *
 * Pure: reports whether a "no successful poll" notification is due on the
 * decaying schedule — 30 minutes, then 2 hours, then 6 hours, then daily.
 * Sending the notification is card 3's job; this only decides *when* it is
 * due.
 *
 * The schedule is relative to the last notification, not the last success:
 *   - no notification has been sent yet: due once 30 minutes have passed
 *     since the last success;
 *   - the 30-minute one has been sent: the next is due 2 hours after it;
 *   - then 6 hours after that;
 *   - then every 24 hours after that.
 */

const STEP_30_MIN_MS = 30 * 60 * 1000;
const STEP_2_H_MS = 2 * 60 * 60 * 1000;
const STEP_6_H_MS = 6 * 60 * 60 * 1000;
const STEP_DAILY_MS = 24 * 60 * 60 * 1000;

// The interval that applies to the *next* notification for each step.
const NEXT_INTERVAL_MS = {
  '30min': STEP_2_H_MS,
  '2h': STEP_6_H_MS,
  '6h': STEP_DAILY_MS,
  daily: STEP_DAILY_MS,
};

/**
 * @param {{
 *   lastSuccessAt: string | null,   // ISO-8601, the last successful poll (null if none yet)
 *   now: string,             // ISO-8601, the current instant
 *   lastNotificationAt: string | null, // ISO-8601 or null if none sent
 *   step?: '30min' | '2h' | '6h' | 'daily', // which step the last notification was
 * }} args
 * @returns {{ due: boolean, step: 'none' | '30min' | '2h' | '6h' | 'daily', elapsedMs: number }}
 *
 * A notification is due only while the poller is *still failing*. If a
 * successful poll has landed since the last notification (a recovery), the
 * dead-man resets: the next notification is not due, regardless of how long
 * it has been since the last one. `step` is *not* persisted anywhere today,
 * so a caller that forgets to advance it after the 6-hour step will keep
 * re-reading at the 2-hour interval — pass the current step explicitly.
 */
export function deadManState(args) {
  const { lastSuccessAt, now, lastNotificationAt, step = 'none' } = args;
  const successMs = lastSuccessAt === null ? NaN : Date.parse(lastSuccessAt);
  const nowMs = Date.parse(now);

  if (lastNotificationAt === null) {
    // No notification sent yet. Due once 30 minutes have elapsed since the
    // last success. If there has never been a success (successMs is NaN), the
    // poller is already failing, so the first notification is due immediately.
    if (Number.isNaN(successMs)) {
      return { due: true, step: '30min', elapsedMs: STEP_30_MIN_MS };
    }
    const elapsed = nowMs - successMs;
    if (elapsed >= STEP_30_MIN_MS) {
      return { due: true, step: '30min', elapsedMs: elapsed };
    }
    return { due: false, step: 'none', elapsedMs: elapsed };
  }

  // A notification has been sent. First check for a recovery: if a successful
  // poll landed after the last notification, the dead-man resets and nothing
  // is due until the next failure window opens.
  const lastNotifMs = Date.parse(lastNotificationAt);
  if (!Number.isNaN(successMs) && successMs > lastNotifMs) {
    // Recovered: not due. Report the time since the recovery so callers can
    // see the poller is healthy.
    return { due: false, step: 'none', elapsedMs: nowMs - successMs };
  }

  // Still failing: the next notification is due after the step's interval,
  // measured from the last notification.
  const sinceNotif = nowMs - lastNotifMs;
  const interval = NEXT_INTERVAL_MS[step] ?? STEP_2_H_MS;
  if (sinceNotif >= interval) {
    return { due: true, step, elapsedMs: sinceNotif };
  }
  return { due: false, step: 'none', elapsedMs: sinceNotif };
}

export { STEP_30_MIN_MS, STEP_2_H_MS, STEP_6_H_MS, STEP_DAILY_MS };
