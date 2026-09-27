/**
 * Screen 1 — Status (spec §6.1). Acquisition health first: a prominent health
 * banner derived from existing poll state (presentation only — no new
 * persisted state), six stat cards, the OzBargain access panel (design 3.7,
 * chunk 2), and recent failures.
 *
 * Server component: it reads the live store state. Times are rendered with
 * LocalTime (server fallback is the ISO value; the locale is a client
 * enhancement after hydration) with the exact ISO instant preserved in
 * `dateTime`/`title`. It is async to mint an unbound CSRF token (production
 * relies on the token TTL, m3) for the "Clear failures" control and the
 * gate "Resume" control.
 */

import { getStore } from '../lib/web/db.js';
import { systemClock } from '../lib/clock.js';
import { viewGate } from '../lib/gate/view.js';
import { formatMelbourne } from '../lib/time.js';
import {
  PageHeader,
  StatCard,
  Button,
  DataTable,
  healthWithGate,
} from './components/ui.js';
import LocalTime from './components/local-time.js';
import FailureList from './components/failure-list.js';
import AsyncForm from './components/async-form.js';

export const metadata = { title: 'Status' };

/**
 * The status page.
 * @returns {Promise<React.ReactElement>}
 */
export default async function StatusPage() {
  const { generateCsrfToken } = await import('../lib/csrf.js');
  const store = getStore();
  const pollState = store.getPollState() ?? {};
  const failures = store.getFailures();
  // The access gate (design 3.7, chunk 2): read-only, like the layout.
  const gate = viewGate(store.getGate(), store.getGateEvents({ limit: 50 }), systemClock().now());
  const gateEvents = store.getGateEvents({ limit: 10 });
  const health = healthWithGate(pollState, gate);

  // Mint an unbound CSRF token (production relies on the token TTL, m3) for
  // the "Clear failures" control and the gate "Resume" control.
  const secret = process.env.OZB_CSRF_SECRET ?? '';
  const token = secret ? await generateCsrfToken(secret) : '';

  return (
    <section>
      <PageHeader title="Status" description="Live acquisition and storage health." />

      <div className="health-banner" data-health={health.tone} role="status">
        <span className="label">{health.label}</span>
        <span className="detail">{health.detail}</span>
      </div>

      <div className="card">
        <h2 className="card-title">OzBargain access</h2>
        <dl className="status-details">
          <dt>State</dt>
          <dd>{gate.state}</dd>
          <dt>Rule</dt>
          <dd>{gate.rule ?? '—'}</dd>
          <dt>Reason</dt>
          <dd>{gate.reason ?? '—'}</dd>
          <dt>Since</dt>
          <dd>{gate.since ? formatMelbourne(gate.since) : '—'}</dd>
          <dt>{gate.state === 'stopped' ? 'Earliest resume' : 'Until'}</dt>
          <dd>
            {gate.state === 'stopped'
              ? (gate.minResumeAt ? formatMelbourne(gate.minResumeAt) : '—')
              : (gate.untilAt ? formatMelbourne(gate.untilAt) : '—')}
          </dd>
          <dt>Tier</dt>
          <dd>{gate.tier ?? '—'}</dd>
        </dl>
        {gateEvents.length > 0 ? (
          <DataTable
            className="gate-events"
            columns={['Time', 'Change', 'Rule', 'Tier', 'Email']}
            rows={gateEvents.map((event) => [
              formatMelbourne(event.at),
              `${event.from_state} → ${event.to_state}`,
              event.rule ?? '—',
              event.tier ?? '—',
              event.email_status ?? '—',
            ])}
          />
        ) : null}
        {gate.state === 'stopped' ? (
          <AsyncForm
            action="/gate/resume"
            onSuccess="refresh"
            successMessage="Resumed — one test request will be made at the next poll."
          >
            <input type="hidden" name="_csrf" value={token} />
            <input type="hidden" name="confirm" value="resume" />
            <Button type="submit" variant="primary" disabled={!gate.resumeAllowed}>
              {gate.resumeAllowed
                ? 'Resume OzBargain access'
                : `Available from ${formatMelbourne(gate.minResumeAt)}`}
            </Button>
          </AsyncForm>
        ) : (
          <p className="gate-open-line">Access is open.</p>
        )}
      </div>

      <div className="stat-grid">
        <StatCard
          label="Last successful poll"
          value={
            pollState.last_success_at ? (
              <LocalTime iso={pollState.last_success_at} />
            ) : (
              'never'
            )
          }
        />
        <StatCard
          label="Response class"
          value={pollState.last_response_class ?? '—'}
        />
        <StatCard
          label="Backoff"
          value={(pollState.backoff_seconds ?? 0) > 0 ? `${pollState.backoff_seconds}s` : 'none'}
        />
        <StatCard label="Consecutive failures" value={pollState.consecutive_failures ?? 0} />
        <StatCard label="Deals in store" value={store.countDeals()} />
        <StatCard label="Observations" value={store.countAllObservations()} />
      </div>

      <div className="card">
        <h2 className="card-title">Recent failures</h2>
        <FailureList failures={failures} csrf={token} />
      </div>
    </section>
  );
}
