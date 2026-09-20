/**
 * Screen 1 — Status (design 7.1). Acquisition health first: last successful
 * poll, last response class, current backoff state. The last-checked
 * timestamp is in the layout (every page).
 *
 * Server component.
 */

import { getStore } from '../lib/web/db.js';

/**
 * The status page.
 * @returns {React.ReactElement}
 */
export default function StatusPage() {
  const store = getStore();
  const pollState = store.getPollState() ?? {};
  const failures = store.getFailures();

  return (
    <section>
      <h2>Status</h2>
      <dl className="status">
        <dt>Last successful poll</dt>
        <dd>{pollState.last_success_at ?? 'never'}</dd>
        <dt>Last response class</dt>
        <dd>{pollState.last_response_class ?? '—'}</dd>
        <dt>Backoff</dt>
        <dd>{(pollState.backoff_seconds ?? 0) > 0 ? `${pollState.backoff_seconds}s` : 'none'}</dd>
        <dt>Consecutive failures</dt>
        <dd>{pollState.consecutive_failures ?? 0}</dd>
        <dt>Deals in store</dt>
        <dd>{store.countDeals()}</dd>
        <dt>Observations</dt>
        <dd>{store.countAllObservations()}</dd>
      </dl>
      {failures.length > 0 && (
        <div className="failures">
          <h3>Recent failures</h3>
          <ul>
            {failures.map((f) => (
              <li key={f.id}>
                {f.url} — {f.response_class}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
