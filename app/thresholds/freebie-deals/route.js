/**
 * Screen 7 — Thresholds: the "deal freebie" toggle (design 6.6, D49).
 * A state-changing route: gated on the access check and the CSRF check
 * (independent, 11.3.6).
 *
 * It writes the `always_notify_deal_freebie` setting the deal-freebie
 * evaluator reads (`lib/notify/freebie.js`). The checkbox is present in the
 * form when on, absent when off (a plain form's checkbox), so the route
 * writes '1' when the field is present and '0' when it is not.
 *
 * Lives in its own segment (`/thresholds/freebie-deals`) so it does not
 * collide with the `/thresholds` page or the classifieds freebie route
 * (`/thresholds/freebie`) in the build.
 */
export async function POST(request) {
  const { requireAuthenticated, parseBodyOr400 } = await import('../../../lib/web/gate.js');
  const { getStore } = await import('../../../lib/web/db.js');
  const { DEAL_FREEBIE_SETTING_KEY } = await import('../../../lib/notify/freebie.js');

  const { body, error } = await parseBodyOr400(request);
  if (error) return error;
  const gate = await requireAuthenticated(request, undefined, body);
  if (!gate.ok) return gate.response;

  const store = getStore();
  // A plain form's checkbox: present (non-empty) when checked, absent when
  // unchecked. Write '1' when present, '0' when absent.
  const on = body.freebie_deals !== undefined && body.freebie_deals !== '' && body.freebie_deals !== '0';
  store.setSetting(DEAL_FREEBIE_SETTING_KEY, on ? '1' : '0');

  return Response.json({ freebie_deals: on });
}
