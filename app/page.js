/**
 * Screen 1 — Status (spec §6.1). Acquisition health first: a prominent health
 * banner derived from existing poll state (presentation only — no new
 * persisted state), six stat cards, and recent failures.
 *
 * Server component: it reads the live store state. Times are rendered with
 * LocalTime (server fallback is the ISO value; the locale is a client
 * enhancement after hydration) with the exact ISO instant preserved in
 * `dateTime`/`title`. It is async to mint an unbound CSRF token (production
 * relies on the token TTL, m3) for the "Clear failures" control.
 */

import { getStore } from '../lib/web/db.js';
import {
  PageHeader,
  StatCard,
  healthFromPollState,
} from './components/ui.js';
import LocalTime from './components/local-time.js';
import FailureList from './components/failure-list.js';

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
  const health = healthFromPollState(pollState);

  // Mint an unbound CSRF token (production relies on the token TTL, m3) for
  // the "Clear failures" control.
  const secret = process.env.OZB_CSRF_SECRET ?? '';
  const token = secret ? await generateCsrfToken(secret) : '';

  return (
    <section>
      <PageHeader title="Status" description="Live acquisition and storage health." />

      <div className="health-banner" data-health={health.tone} role="status">
        <span className="label">{health.label}</span>
        <span className="detail">{health.detail}</span>
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
