/**
 * /healthz — acquisition health, not process liveness (design 3.7). Reports
 * **unhealthy when the last successful poll is older than three poll
 * intervals**. The middleware authenticates it with the container-local
 * `OZB_HEALTHCHECK_SECRET` header; a LAN request without the secret is
 * rejected exactly like any other path.
 *
 * A state-reading route (no CSRF). The access check is the middleware's job;
 * when called directly (as in the acceptance test) the healthcheck-secret
 * check is what gates it.
 */

import { getStore } from '../../lib/web/db.js';

/** How many poll intervals before a poll is "stale". 3 (design 3.7). */
const STALE_INTERVALS = 3;

/**
 * The healthz handler.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function GET(request) {
  // The container health check authenticates with the shared secret. When the
  // middleware has already let the request through, the header is present;
  // when called directly, require it. m1: fail **closed** when the secret is
  // unset — the opposite of the previous `if (secret && ...)`, which let an
  // unset secret through (a LAN request with no secret reached the handler).
  // The middleware rejects a missing secret with 401; the handler does the
  // same.
  const secret = process.env.OZB_HEALTHCHECK_SECRET ?? '';
  const presented = request.headers.get('x-healthcheck-secret') ?? '';
  if (!secret || presented !== secret) {
    return new Response('unauthorized', { status: 401 });
  }

  const store = getStore();
  const pollState = store.getPollState() ?? {};
  const lastSuccess = pollState.last_success_at;
  const intervalSeconds = Number(process.env.OZB_POLL_INTERVAL_SECONDS ?? 300);

  if (!lastSuccess) {
    return Response.json({ status: 'unhealthy', reason: 'no successful poll yet' }, { status: 503 });
  }
  const ageMs = Date.now() - Date.parse(lastSuccess);
  const staleMs = STALE_INTERVALS * intervalSeconds * 1000;
  const healthy = ageMs <= staleMs;
  return Response.json(
    {
      status: healthy ? 'healthy' : 'unhealthy',
      last_success_at: lastSuccess,
      age_seconds: Math.round(ageMs / 1000),
      threshold_seconds: STALE_INTERVALS * intervalSeconds,
    },
    { status: healthy ? 200 : 503 },
  );
}
