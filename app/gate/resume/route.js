/**
 * Screen 1 — Status: manually resume the access gate (design 3.7, chunk 2).
 * A state-changing route: gated on the access check and the CSRF check
 * (independent, 11.3.6). Mirrors the failures-clear route
 * (`app/failures/clear`): a `confirm: 'resume'` body field is required.
 *
 * The resume is manual-only and time-gated: `gate.resume()` refuses before
 * the rule's earliest-resume instant (`too_early`) and when the gate is not
 * stopped (`not_stopped`). A successful resume moves the gate to `probing` —
 * one test request at the next poll.
 */
export async function POST(request) {
  const { parseBodyOr400, requireAuthenticated } = await import('../../../lib/web/gate.js');
  const { getStore } = await import('../../../lib/web/db.js');

  const { body, error } = await parseBodyOr400(request);
  if (error) return error;
  const auth = await requireAuthenticated(request, undefined, body);
  if (!auth.ok) return auth.response;

  if (body.confirm !== 'resume') {
    return new Response('resume confirmation required', { status: 400 });
  }

  const { createGate } = await import('../../../lib/gate/index.js');
  const { systemClock } = await import('../../../lib/clock.js');
  const { loadConfig } = await import('../../../lib/config.js');
  const { formatMelbourne } = await import('../../../lib/time.js');

  const store = getStore();
  const accessGate = createGate({ store, clock: systemClock(), config: loadConfig(), log: console.log });
  const result = accessGate.resume();
  if (result.ok) {
    return Response.json({ resumed: true, state: 'probing' });
  }
  if (result.reason === 'too_early') {
    return new Response(
      `Manual resume is not allowed before ${formatMelbourne(result.minResumeAt)}.`,
      { status: 409 },
    );
  }
  return new Response('Access is not stopped.', { status: 409 });
}
