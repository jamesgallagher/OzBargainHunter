/**
 * Screen 7 — Thresholds: the "always notify on freebie" toggle (design 6.6).
 * A state-changing route: gated on the access check and the CSRF check
 * (independent, 11.3.6).
 *
 * X7: this endpoint did not exist; the thresholds page's freebie form posted
 * here to nothing. It writes the `always_notify_freebie` setting the freebie
 * evaluator reads (`lib/notify/freebie.js`). The checkbox is present in the
 * form when on, absent when off (a plain form's checkbox), so the route
 * writes '1' when the field is present and '0' when it is not.
 *
 * X1: lives in its own segment (`/thresholds/freebie`) so it does not
 * collide with the `/thresholds` page in the build.
 */
export async function POST(request) {
  const { requireAuthenticated, parseBodyOr400 } = await import('../../../lib/web/gate.js');
  const { getStore } = await import('../../../lib/web/db.js');
  const { FREEBIE_SETTING_KEY } = await import('../../../lib/notify/freebie.js');

  const { body, error } = await parseBodyOr400(request);
  if (error) return error;
  const gate = await requireAuthenticated(request, undefined, body);
  if (!gate.ok) return gate.response;

  const store = getStore();
  // A plain form's checkbox: present (non-empty) when checked, absent when
  // unchecked. Write '1' when present, '0' when absent.
  const on = body.freebie !== undefined && body.freebie !== '' && body.freebie !== '0';
  store.setSetting(FREEBIE_SETTING_KEY, on ? '1' : '0');

  return Response.json({ freebie: on });
}
