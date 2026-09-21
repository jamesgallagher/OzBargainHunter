/**
 * The shared app layout (design 7.2). A visible **last-checked timestamp**
 * appears on every page of the application: it is the last successful poll
 * instant the worker wrote to `poll_state`. The UI is operable on a phone, so
 * the layout is a single narrow column.
 *
 * Server component — it reads the store directly (no client JS required for
 * the timestamp).
 */

import { getStore } from '../lib/web/db.js';

// FIX-A (measured-necessary and measured-sufficient, spec §5): force every screen
// to be server-rendered **per request** instead of prerendered at build time.
// The screens mint a CSRF token from `OZB_CSRF_SECRET` and read live store
// state; when they were prerendered at build time the runtime secret was unset
// (so `_csrf` rendered empty and every write 403'd "csrf") and the store showed
// build-time state. Forcing dynamic rendering makes `_csrf` mint per request and
// the screens reflect the store at request time.
export const dynamic = 'force-dynamic';

/**
 * The layout.
 * @param {{ children: React.ReactNode }} props
 * @returns {React.ReactElement}
 */
export default function Layout({ children }) {
  const store = getStore();
  const pollState = store.getPollState() ?? {};
  const lastChecked = pollState.last_success_at ?? 'never';
  const lastResponseClass = pollState.last_response_class ?? '—';
  const backoffSeconds = pollState.backoff_seconds ?? 0;

  return (
    <html lang="en">
      <body>
        <header>
          <h1>OzBargainHunter</h1>
          <p className="last-checked">
            Last checked: <time dateTime={lastChecked}>{lastChecked}</time>
            {' · '}
            {lastResponseClass}
            {backoffSeconds > 0 ? ` · backoff ${backoffSeconds}s` : ''}
          </p>
        </header>
        <nav>
          <a href="/">Status</a>
          <a href="/rules">Rules</a>
          <a href="/alerts">Alerts</a>
          <a href="/suppressions">Suppressions</a>
          <a href="/thresholds">Thresholds</a>
          <a href="/delivery">Delivery</a>
          <a href="/classifieds-session">Classifieds session</a>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
