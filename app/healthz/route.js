/**
 * /healthz — acquisition health, not process liveness (design 3.7). Reports
 * **unhealthy when the last successful poll is older than three poll
 * intervals**, and **backing_off (503) while the access gate is not open**
 * (cooling / stopped / probing), carrying the gate's state — the back-off
 * itself is the reason, ahead of the last-success age check. The middleware
 * authenticates it with the container-local `OZB_HEALTHCHECK_SECRET` header;
 * a LAN request without the secret is rejected exactly like any other path.
 *
 * A state-reading route (no CSRF). The access check is the middleware's job;
 * when called directly (as in the acceptance test) the healthcheck-secret
 * check is what gates it.
 */

import { getStore } from '../../lib/web/db.js';
import { createGate } from '../../lib/gate/index.js';
import { systemClock } from '../../lib/clock.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { normalizeAppSecret } from '../../lib/env-secret.js';

/** How many poll intervals before a poll is "stale". 3 (design 3.7). */
const STALE_INTERVALS = 3;

/**
 * Constant-time secret comparison (M-m2). `timingSafeEqual` throws when the
 * buffers differ in length, so both values are first hashed to a fixed length
 * (sha256) and the digests compared. This keeps the comparison in constant
 * time with respect to the secret, instead of the old `!==` which leaks how
 * many leading bytes match.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function secretsEqual(a, b) {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

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
  const secret = normalizeAppSecret(process.env.OZB_HEALTHCHECK_SECRET);
  const presented = request.headers.get('x-healthcheck-secret') ?? '';
  if (!secret || !secretsEqual(presented, secret)) {
    return new Response('unauthorized', { status: 401 });
  }

  const store = getStore();

  // The access gate (design 3.7): while it is not open (cooling / stopped
  // / probing) the app is backing off, and that is the health status —
  // ahead of the last-success age check. The gate is built over the shared
  // store with the system clock (web code; the injected-clock rule applies
  // to lib/ and worker/), and its lazy cooling→probing transition in
  // read() uses the same clock.
  const gate = createGate({
    store,
    clock: systemClock(),
    config: { OZB_DEALS_FEED_URL: process.env.OZB_DEALS_FEED_URL },
    log: () => {},
  });
  const gateRow = gate.read();
  if (gateRow.state !== 'open') {
    return Response.json(
      {
        status: 'backing_off',
        gate: {
          state: gateRow.state,
          rule: gateRow.rule,
          tier: gateRow.tier,
          since: gateRow.since,
          until_at: gateRow.until_at,
          min_resume_at: gateRow.min_resume_at,
        },
      },
      { status: 503 },
    );
  }

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
