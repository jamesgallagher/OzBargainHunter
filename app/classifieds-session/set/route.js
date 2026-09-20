/**
 * Screen 9 — Classifieds session: set the account cookie (X12). A state-changing
 * route: gated on the access check and the CSRF check. The worker reads
 * `OZB_ACCOUNT_COOKIE` (this route's target); setting it here updates the
 * setting the worker reads on its next poll.
 *
 * X1: lives in its own segment (`/classifieds-session/set`) so it does not
 * collide with the `/classifieds-session` page in the build.
 */
export async function POST(request) {
  const { requireAuthenticated, parseBody } = await import('../../../lib/web/gate.js');
  const { getStore } = await import('../../../lib/web/db.js');

  const body = await parseBody(request);
  const gate = await requireAuthenticated(request, undefined, body);
  if (!gate.ok) return gate.response;

  const store = getStore();
  const cookie = typeof body.cookie === 'string' ? body.cookie.trim() : '';
  if (!cookie) {
    return new Response('cookie required', { status: 400 });
  }

  // Persist the cookie for the worker (OZB_ACCOUNT_COOKIE) and record the
  // instant it was set.
  store.setSetting('ozb_account_cookie', cookie);
  store.setSetting('ozb_account_cookie_set_at', new Date().toISOString());

  return Response.json({ set: true });
}
