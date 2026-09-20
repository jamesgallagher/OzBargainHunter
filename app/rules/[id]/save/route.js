/**
 * Screen 3 — Rule edit (design 7.1). A state-changing route: gated on the
 * access check and the CSRF check (independent, 11.3.6). Threshold rules are
 * fixed to deals-only and not editable.
 *
 * X1: the edit handler lives in its own segment (`/rules/[id]/save`) so it
 * does not collide with the `/rules/[id]` page in the build. The form posts
 * here. X5: the body is parsed (urlencoded or JSON) and the CSRF token is
 * read from it.
 *
 * @param {{ params: { id: string } }} props
 */
export async function POST(request, { params }) {
  const { requireAuthenticated, parseBody } = await import('../../../../lib/web/gate.js');
  const { getStore } = await import('../../../../lib/web/db.js');

  const body = await parseBody(request);
  const gate = await requireAuthenticated(request, undefined, body);
  if (!gate.ok) return gate.response;

  const store = getStore();
  const id = Number((await params).id ?? params.id);
  const rule = store.getRule(id);
  if (!rule) {
    return new Response('rule not found', { status: 404 });
  }

  const now = new Date().toISOString();
  const isThreshold = rule.type === 'threshold';

  const parameters = { ...rule.parameters };
  if (!isThreshold) {
    if (typeof body.term === 'string') parameters.term = body.term;
  }
  if (isThreshold && (typeof body.threshold === 'number' || typeof body.threshold === 'string')) {
    const t = Number(body.threshold);
    if (!Number.isNaN(t)) parameters.threshold = t;
  }
  const surfaces = isThreshold ? 'deals' : body.surfaces ?? rule.surfaces;
  const cooldownSeconds = Number(body.cooldown_seconds ?? rule.cooldown_seconds);

  store.insertRule({
    id,
    type: rule.type,
    parameters: JSON.stringify(parameters),
    state: rule.state,
    surfaces,
    cooldown_seconds: cooldownSeconds,
    pinned_slug: rule.pinned_slug ?? null,
    created_at: rule.created_at,
    modified_at: now,
  });
  return Response.json({ saved: true, id });
}
