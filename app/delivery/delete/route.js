/**
 * Screen 8 — Delivery: delete a provider (delivery mechanisms). A state-changing
 * route: gated on the access check and the CSRF check (independent, 11.3.6).
 *
 * X1: lives in its own segment (`/delivery/delete`) so it does not collide with
 * the `/delivery` page in the build. Mirrors the rule delete route
 * (`app/rules/[id]/delete`): a `confirm: 'delete'` body field is required.
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
  const kind = typeof body.kind === 'string' ? body.kind : '';
  if (!kind) {
    return new Response('kind required', { status: 400 });
  }

  const store = getStore();
  if (!store.getProvider(kind)) {
    return new Response('provider not found', { status: 404 });
  }

  // Full CRUD: remove the provider row. A deleted provider is gone from the
  // list and the worker no longer builds or fans out through it.
  store.deleteProvider(kind);
  return Response.json({ deleted: true, kind });
}
