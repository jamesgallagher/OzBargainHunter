/**
 * Screen 8 — Delivery: save a provider (delivery mechanisms). A state-changing
 * route: gated on the access check and the CSRF check (independent, 11.3.6).
 *
 * The credentials are assembled from the mechanism's `fields` definition: each
 * field's value is read from the form, a required field that is blank is
 * rejected, and the assembled object is persisted via `store.upsertProvider`.
 * A kind that is not in the registry falls back to the raw `config` JSON
 * (blank = {}), so the route still works for a kind added to the store by
 * another path.
 *
 * X1: lives in its own segment (`/delivery/save`) so it does not collide
 * with the `/delivery` page in the build.
 */
export async function POST(request) {
  const { requireAuthenticated, parseBodyOr400 } = await import('../../../lib/web/gate.js');
  const { getStore } = await import('../../../lib/web/db.js');
  const { mechanismFor } = await import('../../../lib/notify/registry.js');

  const { body, error } = await parseBodyOr400(request);
  if (error) return error;
  const gate = await requireAuthenticated(request, undefined, body);
  if (!gate.ok) return gate.response;

  const store = getStore();
  const kind = typeof body.kind === 'string' ? body.kind : '';
  if (!kind) {
    return new Response('kind required', { status: 400 });
  }

  const mechanism = mechanismFor(kind);
  let config;
  if (mechanism) {
    // Assemble the config from the mechanism's field definitions. A required
    // field that is blank is rejected before anything is written.
    config = {};
    for (const field of mechanism.fields) {
      const value = (typeof body[field.name] === 'string' ? body[field.name] : '').trim();
      if (field.required && !value) {
        return new Response(`${field.label} is required`, { status: 400 });
      }
      config[field.name] = value;
    }
  } else {
    // Unknown kind: fall back to the raw config JSON (blank = {}).
    config = {};
    const rawConfig = typeof body.config === 'string' ? body.config.trim() : '';
    if (rawConfig) {
      try {
        config = JSON.parse(rawConfig);
      } catch {
        return new Response('config must be valid JSON', { status: 400 });
      }
    }
  }
  const selected = body.selected !== undefined && body.selected !== '' && body.selected !== '0';

  store.upsertProvider(kind, JSON.stringify(config), selected);
  return Response.json({ saved: true, kind, selected });
}
