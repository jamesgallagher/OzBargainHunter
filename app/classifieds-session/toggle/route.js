/**
 * Screen 9 — Classifieds session: the global enable/disable toggle. A
 * state-changing route: gated on the access check and the CSRF check
 * (independent, 11.3.6).
 *
 * This route writes the `classifieds_enabled` setting the classifieds poll
 * reads on every tick (default disabled when absent). The checkbox is present
 * in the form when on, absent when off (a plain form's checkbox), so the
 * route writes '1' when the field is present and '0' when it is not.
 *
 * Turning it on re-arms classifieds polling: it clears the stale expiry latch
 * (`classifieds_last_uid`) and the cached validators so the next eligible poll
 * runs a fresh check rather than being short-circuited by a stale 304 or a
 * latched-off session. Turning it off does not clear anything — a disabled poll
 * makes zero requests regardless.
 *
 * X1: lives in its own segment (`/classifieds-session/toggle`) so it does not
 * collide with the `/classifieds-session` page in the build.
 */
// The global enable/disable gate key (worker-owned module owns the same
// string; the server tree must not import from lib/acquire/).
const CLASSIFIEDS_ENABLED_KEY = 'classifieds_enabled';

export async function POST(request) {
  const { requireAuthenticated, parseBodyOr400 } = await import('../../../lib/web/gate.js');
  const { getStore } = await import('../../../lib/web/db.js');

  const { body, error } = await parseBodyOr400(request);
  if (error) return error;
  const gate = await requireAuthenticated(request, undefined, body);
  if (!gate.ok) return gate.response;

  const store = getStore();
  // A plain form's checkbox: present (non-empty) when checked, absent when
  // unchecked. Write '1' when present, '0' when absent.
  const on = body.enabled !== undefined && body.enabled !== '' && body.enabled !== '0';
  store.setSetting(CLASSIFIEDS_ENABLED_KEY, on ? '1' : '0');
  if (on) {
    // Re-arm: clear the stale expiry latch and cached validators so a fresh
    // check runs on the next eligible poll.
    store.deleteSetting('classifieds_last_uid');
    const classifiedsUrl = process.env.OZB_CLASSIFIEDS_URL ?? 'https://www.ozbargain.com.au/classified';
    store.setFeedState(classifiedsUrl, null, null);
  }

  return Response.json({ enabled: on });
}
