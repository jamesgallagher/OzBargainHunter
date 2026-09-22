/**
 * Screen 7 — Threshold configuration (design 7.1, 9.2). Editable. Each
 * threshold is its own rule with its own ID (6.5); the "always notify on
 * freebie" checkbox (6.6) is on by default.
 *
 * Server component.
 */

import { getStore } from '../../lib/web/db.js';
import { FREEBIE_SETTING_KEY } from '../../lib/notify/freebie.js';
import { generateCsrfToken } from '../../lib/csrf.js';
import AsyncForm from '../components/async-form.js';
import { Badge, DataTable, EmptyState, PageHeader, Subnav, stateTone } from '../components/ui.js';

export const metadata = { title: 'Thresholds' };
const settingsLinks = [{ label: 'Thresholds', href: '/thresholds' }, { label: 'Delivery', href: '/delivery' }, { label: 'Classifieds', href: '/classifieds-session' }];

/**
 * The thresholds page.
 * @returns {React.ReactElement}
 */
export default async function ThresholdsPage() {
  const store = getStore();
  const rules = store.getRules().filter((r) => r.type === 'threshold');
  const freebieRaw = store.getSetting(FREEBIE_SETTING_KEY);
  const freebieOn = freebieRaw === null ? true : freebieRaw === '1';
  const secret = process.env.OZB_CSRF_SECRET ?? '';
  const token = secret ? await generateCsrfToken(secret) : '';

  return (
    <section>
      <PageHeader title="Thresholds" description="Upvote and freebie notification settings." />
      <Subnav label="Settings" links={settingsLinks} activeHref="/thresholds" />
      {rules.length ? <DataTable className="thresholds" columns={['Threshold', 'State', 'Window']} rows={rules.map((rule) => [
        <a key="threshold" href={`/rules/${rule.id}`}>{rule.parameters?.threshold}+ upvotes</a>,
        <Badge key="state" tone={stateTone(rule.state)}>{rule.state}</Badge>,
        <span key="window">{rule.parameters?.windowHours != null ? `${rule.parameters.windowHours} h` : '—'}</span>,
      ])} /> : <EmptyState title="No threshold rules." body="Create a threshold rule from the Rules page." />}
      <div className="card form-card settings-card">
      <AsyncForm action="/thresholds/freebie" successMessage="Threshold preference saved.">
        <input type="hidden" name="_csrf" value={token} />
        <label className="switch">
          <input type="checkbox" name="freebie" defaultChecked={freebieOn} />
          <span><strong>Always notify on freebie</strong><small>Notify for free deals regardless of their current vote count.</small></span>
        </label>
        <button className="btn btn-primary" type="submit">Save</button>
      </AsyncForm>
      </div>
    </section>
  );
}
