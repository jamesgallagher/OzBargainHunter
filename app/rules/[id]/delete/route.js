/**
 * Screen 3 — Rule delete (design 7.1). Full CRUD. A state-changing route:
 * gated on the access check and the CSRF check (independent, 11.3.6).
 *
 * Note: the *mute* route (6.4) mutes, never deletes — it is the
 * unsubscribe target. This delete route is the explicit CRUD delete.
 *
 * @param {{ params: { id: string } }} props
 */
export async function POST(request, { params }) {
  const { parseBodyOr400, requireAuthenticated } = await import('../../../../lib/web/gate.js');
  const { getStore } = await import('../../../../lib/web/db.js');

  const { body, error } = await parseBodyOr400(request);
  if (error) return error;
  const gate = await requireAuthenticated(request, process.env, body);
  if (!gate.ok) return gate.response;

  if (body.confirm !== 'delete') {
    return new Response('delete confirmation required', { status: 400 });
  }

  const store = getStore();
  const id = Number((await params).id ?? params.id);
  const rule = store.getRule(id);
  if (!rule) {
    return new Response('rule not found', { status: 404 });
  }

  // Full CRUD: remove the rule from the store. A deleted rule is gone from
  // the list and the engine no longer matches it. (The *mute* route, 6.4,
  // mutes rather than deletes — it is the unsubscribe target.)
  store.deleteRule(id);
  store.deletePendingAlertsForRule(id);
  return Response.json({ deleted: true, id });
}
