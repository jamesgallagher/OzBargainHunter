/**
 * Screen 4 — Rule state control (design 7.1, 6.4). The route `/rules/<id>/mute`
 * is the unsubscribe target from 6.4, gated exactly like every other path.
 * **Muting suppresses that rule's already-queued rows in `pending_alerts`** and
 * marks the rule `muted` rather than deleting it. **Mute, never delete.**
 *
 * The confirmation offers undo in one tap, and snooze for 24 hours, 7 days, or
 * keep it off.
 *
 * A state-changing route: gated on the access check and the CSRF check
 * (independent, 11.3.6).
 *
 * @param {{ params: { id: string } }} props
 */
export async function POST(request, { params }) {
  const { requireAuthenticated } = await import('../../../../lib/web/gate.js');
  const { getStore } = await import('../../../../lib/web/db.js');

  const gate = await requireAuthenticated(request);
  if (!gate.ok) return gate.response;

  const store = getStore();
  const id = Number((await params).id ?? params.id);
  const rule = store.getRule(id);
  if (!rule) {
    return new Response('rule not found', { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const action = body.action ?? 'mute';
  const now = new Date().toISOString();

  if (action === 'mute') {
    // Mark muted (never delete) and suppress this rule's queued rows.
    store.setRuleState(id, 'muted', now);
    const removed = store.deletePendingAlertsForRule(id);
    return Response.json({ muted: true, pendingRemoved: removed, state: 'muted' });
  }
  if (action === 'undo') {
    store.setRuleState(id, 'enabled', now);
    return Response.json({ state: 'enabled' });
  }
  if (action === 'snooze') {
    const hours = Number(body.hours ?? 24);
    store.setRuleState(id, 'muted', now);
    store.deletePendingAlertsForRule(id);
    store.setSetting(`snooze_until_${id}`, new Date(Date.now() + hours * 3600 * 1000).toISOString());
    return Response.json({ state: 'muted', snoozeHours: hours });
  }
  if (action === 'enable') {
    store.setRuleState(id, 'enabled', now);
    return Response.json({ state: 'enabled' });
  }
  return new Response('unknown action', { status: 400 });
}
