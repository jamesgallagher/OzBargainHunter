/**
 * Screen 9 — Classifieds session: the sign-in wizard route (prompt 4.1).
 *
 * A state-changing route: gated on the access check and the CSRF check
 * (independent, 11.3.6), exactly like the toggle and set routes. The body is
 * the wizard's `username`/`password` (plus the hidden `_csrf`), posted as
 * urlencoded `FormData`.
 *
 * The route is a thin wrapper over `handleLoginRequest` (prompt 4.2): the
 * input validation fails with a plain-text 400 (fixed messages, never echoing
 * submitted values); every later outcome (unavailable, busy, gate_closed,
 * locked, throttled, and every `performLogin` outcome) is a 200 JSON body of
 * `{ outcome }` plus `uid`/`expiresAt` for `ok` — nothing else.
 *
 * The login module is reached only through `lib/web/classifieds-login.js`
 * (W11), and only dynamically, so the module (and Playwright) loads only
 * when a login actually runs.
 *
 * X1: lives in its own segment (`/classifieds-session/login`) so it does not
 * collide with the `/classifieds-session` page in the build.
 */

export async function POST(request) {
  const { requireAuthenticated, parseBodyOr400 } = await import('../../../lib/web/gate.js');
  const { getStore } = await import('../../../lib/web/db.js');
  const { handleLoginRequest } = await import('../../../lib/web/classifieds-login.js');
  const { systemClock } = await import('../../../lib/clock.js');

  const { body, error } = await parseBodyOr400(request);
  if (error) return error;
  const gate = await requireAuthenticated(request, undefined, body);
  if (!gate.ok) return gate.response;

  const store = getStore();
  const config = {
    OZB_CLASSIFIEDS_URL:
      process.env.OZB_CLASSIFIEDS_URL ?? 'https://www.ozbargain.com.au/classified',
    // `sendGateEvents` builds the notification URL from this (chunk 2).
    OZB_PUBLIC_URL: process.env.OZB_PUBLIC_URL ?? '',
  };
  const now = systemClock().now();
  const result = await handleLoginRequest({ body, store, config, env: process.env, now });
  if (result.inputError) {
    return new Response(result.inputError, { status: 400 });
  }
  return Response.json(result);
}
