/**
 * Screen 8 — Delivery configuration (design 7.1, 9.2). Delivery mechanisms:
 * the home for managing providers. Each supported mechanism (one provider per
 * type) is a card that can be added, viewed (sensitive fields masked), edited
 * and deleted. A **test-send** section sends the mechanism's test template
 * through a chosen provider — a test send happens in the Next.js process:
 * that is a request, not a schedule, and it is the one place the server may
 * send a notification.
 *
 * The provider cards are driven by the delivery-mechanism registry
 * (`MECHANISMS`); adding a mechanism is a new registry entry, not a page
 * change. Add/edit POST to `/delivery/save`, delete to `/delivery/delete`,
 * test to `/delivery/test-send`. All are CSRF-gated.
 *
 * Server component.
 */

import { getStore } from '../../lib/web/db.js';
import { generateCsrfToken } from '../../lib/csrf.js';
import { MECHANISMS, mechanismView } from '../../lib/notify/registry.js';
import AsyncForm from '../components/async-form.js';
import ProviderCard from '../components/provider-card.js';
import { EmptyState, PageHeader, Subnav } from '../components/ui.js';

export const metadata = { title: 'Delivery' };
const settingsLinks = [{ label: 'Thresholds', href: '/thresholds' }, { label: 'Delivery', href: '/delivery' }, { label: 'Classifieds', href: '/classifieds-session' }];

/** Parse a stored config JSON string into an object ({} on failure). */
function safeParse(raw) {
  try {
    return JSON.parse(raw ?? '{}');
  } catch {
    return {};
  }
}

/**
 * The delivery page.
 * @returns {Promise<React.ReactElement>}
 */
export default async function DeliveryPage() {
  const store = getStore();
  const providers = store.getProviders();
  const byKind = new Map(providers.map((p) => [p.kind, p]));

  // Mint an unbound CSRF token (production relies on the token TTL, m3).
  const secret = process.env.OZB_CSRF_SECRET ?? '';
  const token = secret ? await generateCsrfToken(secret) : '';

  return (
    <section>
      <PageHeader title="Delivery" description="Configure delivery mechanisms and test delivery." />
      <Subnav label="Settings" links={settingsLinks} activeHref="/delivery" />
      <div className="provider-cards">
        {MECHANISMS.map((m) => {
          const row = byKind.get(m.kind);
          return (
            <ProviderCard
              key={m.kind}
              mechanism={mechanismView(m)}
              existing={
                row
                  ? {
                    config: safeParse(row.config),
                    selected: !!row.selected,
                    enabled: !!row.enabled,
                    consecutive_failures: row.consecutive_failures ?? 0,
                  }
                  : null
              }
              token={token}
            />
          );
        })}
      </div>
      <div className="card form-card settings-card">
        <h2>Test delivery</h2>
        {providers.length ? (
          <AsyncForm action="/delivery/test-send" formClassName="test-send" pendingLabel="Sending test…" successMessage="Test notification sent via {kind}.">
            <input type="hidden" name="_csrf" value={token} />
            <div className="field">
              <label htmlFor="test-provider">Provider</label>
              <select id="test-provider" name="kind">
                {providers.map((p) => {
                  const m = MECHANISMS.find((x) => x.kind === p.kind);
                  return (
                    <option key={p.kind} value={p.kind}>
                      {m ? m.label : p.kind}
                    </option>
                  );
                })}
              </select>
            </div>
            <button className="btn btn-primary" type="submit">Test send</button>
          </AsyncForm>
        ) : (
          <EmptyState title="No providers added." body="Add a delivery mechanism above, then test it here." />
        )}
      </div>
    </section>
  );
}
