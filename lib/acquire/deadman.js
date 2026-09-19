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
 *   lastSuccessAt: string,   // ISO-8601, the last successful poll
 *   now: string,             // ISO-8601, the current instant
 *   lastNotificationAt: string | null, // ISO-8601 or null if none sent
 *   step?: '30min' | '2h' | '6h' | 'daily', // which step the last notification was
 * }} args
 * @returns {{ due: boolean, step: 'none' | '30min' | '2h' | '6h' | 'daily', elapsedMs: number }}
 */
export function deadManState(args) {
  const { lastSuccessAt, now, lastNotificationAt, step = '30min' } = args;
  const successMs = Date.parse(lastSuccessAt);
  const nowMs = Date.parse(now);

  if (lastNotificationAt === null) {
    // No notification sent yet: due once 30 minutes have elapsed since the
    // last success.
    const elapsed = nowMs - successMs;
    if (elapsed >= STEP_30_MIN_MS) {
      return { due: true, step: '30min', elapsedMs: elapsed };
    }
    return { due: false, step: 'none', elapsedMs: elapsed };
  }

  // A notification has been sent: the next is due after the step's interval,
  // measured from the last notification.
  const lastNotifMs = Date.parse(lastNotificationAt);
  const sinceNotif = nowMs - lastNotifMs;
  const interval = NEXT_INTERVAL_MS[step] ?? STEP_2_H_MS;
  if (sinceNotif >= interval) {
    return { due: true, step, elapsedMs: sinceNotif };
  }
  return { due: false, step: 'none', elapsedMs: sinceNotif };
}

export { STEP_30_MIN_MS, STEP_2_H_MS, STEP_6_H_MS, STEP_DAILY_MS };
