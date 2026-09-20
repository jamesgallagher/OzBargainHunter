/**
 * Screen 3 — Rule create (design 7.1). Full CRUD. A state-changing route:
 * gated on the access check and the CSRF check (independent, 11.3.6).
 */
export async function POST(request) {
  const { requireAuthenticated } = await import('../../../lib/web/gate.js');
  const { getStore } = await import('../../../lib/web/db.js');

  const gate = await requireAuthenticated(request);
  if (!gate.ok) return gate.response;

  const store = getStore();
  const body = await request.json().catch(() => ({}));
  const now = new Date().toISOString();

  const type = body.type === 'threshold' ? 'threshold' : 'match';
  const id = store.countRules() + 1;

  // Threshold rules are fixed to deals-only (not editable).
  const surfaces = type === 'threshold' ? 'deals' : body.surfaces ?? 'deals';
  const parameters =
    type === 'threshold'
      ? { threshold: Number(body.threshold ?? 1) }
      : { term: String(body.term ?? '') };

  store.insertRule({
    id,
    type,
    parameters: JSON.stringify(parameters),
    state: 'enabled',
    surfaces,
    cooldown_seconds: Number(body.cooldown_seconds ?? 0),
    pinned_slug: null,
    created_at: now,
    modified_at: now,
  });
  return Response.json({ created: true, id });
}
