/**
 * Screen 3 — Rule create (design 7.1). Full CRUD. A state-changing route:
 * gated on the access check and the CSRF check (independent, 11.3.6).
 *
 * X1: the create handler lives in its own segment (`/rules/new/create`) so it
 * does not collide with the `/rules/new` page in the build. The form posts
 * here.
 *
 * X6: the new rule's id is `MAX(id)+1` (`store.nextRuleId()`), never
 * `COUNT(*)+1` — the latter collides with an existing id after a delete and
 * `insertRule`'s `ON CONFLICT(id) DO UPDATE` would overwrite that rule.
 */
export async function POST(request) {
  const { requireAuthenticated, parseBodyOr400 } = await import('../../../../lib/web/gate.js');
  const { getStore } = await import('../../../../lib/web/db.js');

  const { body, error } = await parseBodyOr400(request);
  if (error) return error;
  const gate = await requireAuthenticated(request, undefined, body);
  if (!gate.ok) return gate.response;

  const store = getStore();
  const now = new Date().toISOString();

  const type = body.type === 'threshold' ? 'threshold' : 'match';
  const id = store.nextRuleId();

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
