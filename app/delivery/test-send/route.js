/**
 * Screen 8 — Delivery: test-send (design 7.1, 9.2). A state-changing route:
 * gated on the access check and the CSRF check (independent, 11.3.6).
 *
 * X7: this endpoint did not exist; the delivery page's test-send button
 * posted here to nothing. A test send happens in the Next.js process — that
 * is a request, not a schedule, and it is the one place the server may send
 * a notification. It builds the provider through the mechanism registry
 * (`mechanism.build` — the same construction point the worker uses) and
 * sends the mechanism's test template through it, reporting success or the
 * provider's error.
 *
 * X1: lives in its own segment (`/delivery/test-send`) so it does not
 * collide with the `/delivery` page in the build.
 */
export async function POST(request) {
  const { requireAuthenticated, parseBodyOr400 } = await import('../../../lib/web/gate.js');
  const { getStore } = await import('../../../lib/web/db.js');
  const { loadConfig } = await import('../../../lib/config.js');
  const { mechanismFor } = await import('../../../lib/notify/registry.js');

  const { body, error } = await parseBodyOr400(request);
  if (error) return error;
  const gate = await requireAuthenticated(request, undefined, body);
  if (!gate.ok) return gate.response;

  const store = getStore();
  const config = loadConfig();
  const kind = typeof body.kind === 'string' ? body.kind : '';
  const row = store.getProvider(kind);
  if (!row) {
    return new Response('unknown provider', { status: 404 });
  }
  const mechanism = mechanismFor(kind);
  if (!mechanism) {
    return new Response('unknown provider kind', { status: 404 });
  }

  const provider = mechanism.build(row, config);
  try {
    await provider.send(mechanism.testTemplate, JSON.parse(row.config ?? '{}'));
    return Response.json({ sent: true, kind });
  } catch (err) {
    return Response.json({ sent: false, kind, error: err?.message ?? String(err) }, { status: 502 });
  }
}
