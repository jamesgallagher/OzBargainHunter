/**
 * Screen 9 — Classifieds session: set the account cookie (X12). A state-changing
 * route: gated on the access check and the CSRF check. This route writes the
 * `ozb_account_cookie` setting, which the classifieds poll reads on its next
 * poll and sends on its request (M1: the acquisition module is the consumer;
 * the env value `OZB_ACCOUNT_COOKIE` is the fallback). Setting it here
 * therefore actually changes the running system: the next classifieds poll
 * carries the fresh cookie.
 *
 * X1: lives in its own segment (`/classifieds-session/set`) so it does not
 * collide with the `/classifieds-session` page in the build.
 */
export async function POST(request) {
  const { requireAuthenticated, parseBodyOr400 } = await import('../../../lib/web/gate.js');
  const { getStore } = await import('../../../lib/web/db.js');

  const { body, error } = await parseBodyOr400(request);
  if (error) return error;
  const gate = await requireAuthenticated(request, undefined, body);
  if (!gate.ok) return gate.response;

  const store = getStore();
  const cookie = typeof body.cookie === 'string' ? body.cookie.trim() : '';
  if (!cookie) {
    return new Response('cookie required', { status: 400 });
  }

  // Persist the cookie for the classifieds poll (M1: the consumer) and record
  // the instant it was set.
  store.setSetting('ozb_account_cookie', cookie);
  store.setSetting('ozb_account_cookie_set_at', new Date().toISOString());

  return Response.json({ set: true });
}
