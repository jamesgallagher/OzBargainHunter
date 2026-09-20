import { requireAuthenticated, verifyAccess } from '../../../../lib/web/gate.js';
import { generateCsrfToken } from '../../../../lib/csrf.js';
import { getStore } from '../../../../lib/web/db.js';

/**
 * Screen 4 — Mute / unsubscribe (design 6.4). The notification's unsubscribe
 * control links here (an ordinary authenticated URL, `lib/notify/compose.js`).
 *
 * X4: the GET is the one-tap unsubscribe — it mutes the rule and renders the
 * confirmation with an undo (one tap) and the snooze options (24 hours, 7
 * days, or keep it off). The POST is the CSRF-gated state change that the
 * confirmation page (and the UI forms) drive.
 *
 * X11: snooze writes `state='snoozed'` and a `snooze_until_<id>` setting; the
 * engine lapses the snooze (re-enables) when the instant passes. Undo and
 * re-enable set `state='enabled'`.
 *
 * The confirmation is rendered from this GET handler (not a `page.js`): a
 * `page.js` in the same segment would collide with this `route.js` in the
 * build (the X1 class of error).
 */

const snoozeKey = (id) => `snooze_until_${id}`;

/**
 * Mute a rule and clear its pending alerts.
 * @param {object} store
 * @param {number} id
 * @param {string} nowIso
 */
function applyMute(store, id, nowIso) {
  store.setRuleState(id, 'muted', nowIso);
  store.deletePendingAlertsForRule(id);
}

/**
 * Re-enable a rule (undo / lapse). Clears any snooze instant.
 * @param {object} store
 * @param {number} id
 * @param {string} nowIso
 */
function applyEnable(store, id, nowIso) {
  store.setRuleState(id, 'enabled', nowIso);
  store.deleteSetting(snoozeKey(id));
}

/**
 * Snooze a rule until an instant.
 * @param {object} store
 * @param {number} id
 * @param {string} untilIso
 * @param {string} nowIso
 */
function applySnooze(store, id, untilIso, nowIso) {
  store.setRuleState(id, 'snoozed', nowIso);
  store.setSetting(snoozeKey(id), untilIso);
}

/**
 * GET /rules/[id]/mute — the 6.4 one-tap unsubscribe (X4). Authenticates,
 * mutes the rule, and renders the confirmation with undo + snooze.
 * @param {Request} request
 * @param {Promise<{ id: string }>} params
 */
export async function GET(request, { params }) {
  const access = await verifyAccess(request);
  if (!access.ok) return new Response('unauthorized', { status: 401 });

  const store = getStore();
  const id = Number(await params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return new Response('bad id', { status: 400 });
  }
  const rule = store.getRule(id);
  if (!rule) return new Response('not found', { status: 404 });

  // The one-tap unsubscribe mutes (idempotent: re-muting an already-muted rule
  // is a no-op on state, and re-clears pending alerts).
  const nowIso = new Date().toISOString();
  applyMute(store, id, nowIso);

  // Mint an unbound CSRF token (production relies on the token TTL, m3) for
  // the undo / snooze forms on the confirmation.
  const secret = process.env.OZB_CSRF_SECRET ?? '';
  const token = secret ? await generateCsrfToken(secret) : '';

  const label = rule.parameters?.term ?? `${rule.parameters?.threshold ?? ''}+ upvotes`;
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Muted</title></head>
<body>
<h2>Muted</h2>
<p>Alerts for <strong>${escapeHtml(label)}</strong> are off. You will not be notified for this rule.</p>
<form method="POST" action="/rules/${id}/mute">
  <input type="hidden" name="_csrf" value="${escapeHtml(token)}" />
  <input type="hidden" name="action" value="enable" />
  <button type="submit">Undo</button>
</form>
<form method="POST" action="/rules/${id}/mute">
  <input type="hidden" name="_csrf" value="${escapeHtml(token)}" />
  <input type="hidden" name="action" value="snooze24" />
  <button type="submit">Snooze 24 hours</button>
</form>
<form method="POST" action="/rules/${id}/mute">
  <input type="hidden" name="_csrf" value="${escapeHtml(token)}" />
  <input type="hidden" name="action" value="snooze7" />
  <button type="submit">Snooze 7 days</button>
</form>
<p><a href="/rules/${id}">Back to rule</a></p>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

/**
 * POST /rules/[id]/mute — the CSRF-gated state change (X4, X11).
 *
 * `action`:
 *   - `enable`   — undo / re-enable (state='enabled', clears the snooze).
 *   - `snooze24` — snooze 24 hours (state='snoozed', snooze_until = now+24h).
 *   - `snooze7`  — snooze 7 days (state='snoozed', snooze_until = now+7d).
 *   - `mute`     — mute (state='muted', clears pending alerts). Requires the
 *                  6.4 confirmation: the body must carry `confirm` (the
 *                  confirmation page posts it). A `mute` without `confirm`
 *                  is rejected with 400.
 *
 * @param {Request} request
 * @param {Promise<{ id: string }>} params
 */
export async function POST(request, { params }) {
  const { parseBodyOr400 } = await import('../../../../lib/web/gate.js');
  const { body, error } = await parseBodyOr400(request);
  if (error) return error;
  const auth = await requireAuthenticated(request, undefined, body);
  if (!auth.ok) return auth.response;

  const store = getStore();
  const id = Number(await params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return new Response('bad id', { status: 400 });
  }
  const rule = store.getRule(id);
  if (!rule) return new Response('not found', { status: 404 });

  const now = new Date();
  const nowIso = now.toISOString();
  const action = body.action;

  let next = 'muted';
  if (action === 'enable') {
    applyEnable(store, id, nowIso);
    next = 'enabled';
  } else if (action === 'snooze24') {
    applySnooze(store, id, new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(), nowIso);
    next = 'snoozed';
  } else if (action === 'snooze7') {
    applySnooze(store, id, new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(), nowIso);
    next = 'snoozed';
  } else if (action === 'mute' || action === undefined) {
    // X4: a mute from the UI form requires the 6.4 confirmation. The
    // confirmation page posts `confirm=1`; a bare mute without it is refused
    // so the state change is never applied by accident.
    const confirm = body.confirm;
    if (confirm !== '1' && confirm !== 'true' && confirm !== true) {
      return new Response('confirmation required', { status: 400 });
    }
    applyMute(store, id, nowIso);
    next = 'muted';
  } else {
    return new Response('unknown action', { status: 400 });
  }

  return Response.json({ id, state: next });
}

/**
 * Escape a string for safe embedding in HTML.
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
