/**
 * Screen 8 — Delivery: save provider selection + credentials (design 7.1, 9.2).
 * A state-changing route: gated on the access check and the CSRF check
 * (independent, 11.3.6).
 *
 * X7: the delivery page rendered a read-only table with no credential input
 * and no writer — `upsertProvider` was never called from `app/`. This route
 * is the writer: it persists the provider's selection and credentials
 * (`config` JSON) via `store.upsertProvider`.
 *
 * X1: lives in its own segment (`/delivery/save`) so it does not collide
 * with the `/delivery` page in the build.
 */
export async function POST(request) {
  const { requireAuthenticated, parseBody } = await import('../../../lib/web/gate.js');
  const { getStore } = await import('../../../lib/web/db.js');

  const body = await parseBody(request);
  const gate = await requireAuthenticated(request, undefined, body);
  if (!gate.ok) return gate.response;

  const store = getStore();
  const kind = typeof body.kind === 'string' ? body.kind : '';
  if (!kind) {
    return new Response('kind required', { status: 400 });
  }

  // The credentials are a JSON object (the provider's config). Parse it; a
  // blank field means "no credentials" ({}).
  let config = {};
  const rawConfig = typeof body.config === 'string' ? body.config.trim() : '';
  if (rawConfig) {
    try {
      config = JSON.parse(rawConfig);
    } catch {
      return new Response('config must be valid JSON', { status: 400 });
    }
  }
  const selected = body.selected !== undefined && body.selected !== '' && body.selected !== '0';

  store.upsertProvider(kind, JSON.stringify(config), selected);
  return Response.json({ saved: true, kind, selected });
}
