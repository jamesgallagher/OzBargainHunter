/**
 * The gate alert policy (design 3.7, chunk 2).
 *
 * Pure and import-free: the gate layer (the view, the rules) and the
 * notify layer (the delivery sweep) share it without the gate layer
 * pulling in the notify stack.
 */

/**
 * The gate alert policy (design 3.7, chunk 2).
 *
 * @param {object} event one gate event row (the transition itself)
 * @param {object[]} episodeEvents every event in the event's episode
 *   (the events since the most recent earlier `to_state = 'open'` event,
 *   or since the start of the table; may include the event itself)
 * @returns {boolean} whether the event is notified
 */
export function shouldNotify(event, episodeEvents) {
  if (event.to_state === 'stopped') return true;
  // A cool-off is notified from tier 2 up: a single 503 (tier 1) must not
  // email, and an escalation that stays in cooling is a state change too.
  if (event.to_state === 'cooling' && (event.tier ?? 0) >= 2) return true;
  // A lazy or manual resume is not notified.
  if (event.to_state === 'probing') return false;
  // `probing→open`: the "resumed" alert, sent only when an earlier event
  // in the same episode was notified with any delivery outcome (sent,
  // failed, not_configured, disabled). A policy-skipped event (a tier-1
  // cool-off that did not email) is NOT a notification: without this
  // exclusion a single 503 would indirectly trigger the resume email.
  if (event.to_state === 'open') {
    return episodeEvents.some((e) => e.id < event.id && e.notified === 1 && e.email_status !== 'skipped');
  }
  return false;
}

/**
 * The alert kind for an event: `stopped`, `paused` or `resumed`.
 * @param {object} event one gate event row
 * @returns {'stopped'|'paused'|'resumed'}
 */
export function gateAlertKind(event) {
  if (event.to_state === 'stopped') return 'stopped';
  if (event.to_state === 'cooling') return 'paused';
  return 'resumed';
}
