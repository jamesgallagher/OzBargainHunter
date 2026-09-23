/**
 * Screen 1 — Status: clear the recent-failures list. A state-changing route:
 * gated on the access check and the CSRF check (independent, 11.3.6).
 *
 * X1: lives in its own segment (`/failures/clear`) so it does not collide with
 * the `/` page in the build. Mirrors the provider delete route
 * (`app/delivery/delete`): a `confirm: 'delete'` body field is required.
 */
export async function POST(request) {
  const { parseBodyOr400, requireAuthenticated } = await import('../../../lib/web/gate.js');
  const { getStore } = await import('../../../lib/web/db.js');

  const { body, error } = await parseBodyOr400(request);
  if (error) return error;
  const gate = await requireAuthenticated(request, undefined, body);
  if (!gate.ok) return gate.response;

  if (body.confirm !== 'delete') {
    return new Response('delete confirmation required', { status: 400 });
  }

  const store = getStore();
  const deleted = store.clearFailures();
  return Response.json({ cleared: true, deleted });
}
