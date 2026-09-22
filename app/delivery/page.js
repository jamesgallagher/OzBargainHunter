/**
 * Screen 8 — Delivery configuration (design 7.1, 9.2). Provider selection,
 * credentials, and a **test-send button**. A test send happens in the Next.js
 * process: that is a request, not a schedule, and it is the one place the
 * server may send a notification.
 *
 * X7: the page now renders a credential input and a selection checkbox per
 * provider, and writes them via `/delivery/save` (which calls
 * `store.upsertProvider` — the writer that was never called from `app/`).
 * The test-send button posts to `/delivery/test-send` (its own segment, so
 * it does not collide with this page in the build). Both forms are
 * CSRF-gated.
 *
 * Server component.
 */

import { getStore } from '../../lib/web/db.js';
import { generateCsrfToken } from '../../lib/csrf.js';
import AsyncForm from '../components/async-form.js';
import { Badge, EmptyState, PageHeader, Subnav } from '../components/ui.js';

export const metadata = { title: 'Delivery' };
const settingsLinks = [{ label: 'Thresholds', href: '/thresholds' }, { label: 'Delivery', href: '/delivery' }, { label: 'Classifieds', href: '/classifieds-session' }];

/**
 * The delivery page.
 * @returns {Promise<React.ReactElement>}
 */
export default async function DeliveryPage() {
  const store = getStore();
  const providers = store.getProviders();

  // Mint an unbound CSRF token (production relies on the token TTL, m3).
  const secret = process.env.OZB_CSRF_SECRET ?? '';
  const token = secret ? await generateCsrfToken(secret) : '';

  return (
    <section>
      <PageHeader title="Delivery" description="Configure notification providers and test delivery." />
      <Subnav label="Settings" links={settingsLinks} activeHref="/delivery" />
      {providers.length ? <div className="provider-cards">{providers.map((p) => (
        <article key={p.kind} className="card provider-card">
          <div className="provider-head"><h2>{p.kind}</h2>
            <Badge tone={p.selected ? 'success' : 'neutral'}>{p.selected ? 'Selected' : 'Not selected'}</Badge>
            <Badge tone={p.enabled ? 'success' : 'warning'}>{p.enabled ? 'Enabled' : 'Disabled'}</Badge>
            <Badge tone={p.consecutive_failures ? 'danger' : 'neutral'}>{p.consecutive_failures} failures</Badge>
          </div>
          <details><summary>Configure {p.kind}</summary>
            <AsyncForm action="/delivery/save" formClassName="provider-config provider-form" successMessage={`${p.kind} saved.`}>
              <input type="hidden" name="_csrf" value={token} /><input type="hidden" name="kind" value={p.kind} />
              <label className="switch"><input type="checkbox" name="selected" defaultChecked={p.selected} /> Select {p.kind}</label>
              <div className="field"><label htmlFor={`config-${p.kind}`}>Credentials (JSON)</label>
                <textarea className="mono" id={`config-${p.kind}`} name="config" placeholder='{"to":"…"}' spellCheck="false" />
                <span className="help">Stored credentials are never displayed. Blank replaces the stored configuration with an empty object.</span>
              </div>
              <button className="btn btn-primary" type="submit">Save {p.kind}</button>
            </AsyncForm>
          </details>
        </article>
      ))}</div> : <EmptyState title="No providers configured." body="Provider rows are created by the application configuration." />}
      <div className="card form-card settings-card">
      <h2>Test delivery</h2>
      <AsyncForm action="/delivery/test-send" formClassName="test-send" pendingLabel="Sending test…" successMessage="Test notification sent via {kind}.">
        <input type="hidden" name="_csrf" value={token} />
        <div className="field"><label htmlFor="test-provider">
          Provider
          </label><select id="test-provider" name="kind">
            {providers.map((p) => (
              <option key={p.kind} value={p.kind}>
                {p.kind}
              </option>
            ))}
          </select></div>
        <button className="btn btn-primary" type="submit">Test send</button>
      </AsyncForm>
      </div>
    </section>
  );
}
