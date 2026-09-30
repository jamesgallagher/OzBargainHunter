/**
 * Screen 7 — Threshold configuration (design 7.1, 9.2). Editable. Each
 * threshold is its own rule with its own ID (6.5).
 *
 * The Freebie alerts card (6.6, D49) sits at the top of the page, separate
 * from the keyword/upvote rules: two independent switches, one for deals
 * OzBargain lists under Freebies (`always_notify_deal_freebie`) and one for
 * classified listings of type Freebie (`always_notify_freebie`). Freebies are
 * not a rule, so they are not part of the threshold table.
 *
 * Server component.
 */

import { getStore } from '../../lib/web/db.js';
import { FREEBIE_SETTING_KEY, DEAL_FREEBIE_SETTING_KEY } from '../../lib/notify/freebie.js';
import { generateCsrfToken } from '../../lib/csrf.js';
import AsyncForm from '../components/async-form.js';
import Link from 'next/link.js';
import { Badge, DataTable, EmptyState, PageHeader, Subnav, stateTone } from '../components/ui.js';

export const metadata = { title: 'Thresholds' };
const settingsLinks = [{ label: 'Thresholds', href: '/thresholds' }, { label: 'Delivery', href: '/delivery' }, { label: 'Classifieds', href: '/classifieds-session' }];

// The server tree must not import from lib/acquire/ (the worker-owned module
// owns the same strings). The classifieds hint reads these settings directly.
const CLASSIFIEDS_ENABLED_KEY = 'classifieds_enabled';
const ACCOUNT_COOKIE_KEY = 'ozb_account_cookie';

/**
 * The thresholds page.
 * @returns {Promise<React.ReactElement>}
 */
export default async function ThresholdsPage() {
  const store = getStore();
  const rules = store.getRules().filter((r) => r.type === 'threshold');

  // Freebie settings (6.6): absent means on.
  const dealFreebieRaw = store.getSetting(DEAL_FREEBIE_SETTING_KEY);
  const dealFreebieOn = dealFreebieRaw === null ? true : dealFreebieRaw === '1';
  const classifiedsFreebieRaw = store.getSetting(FREEBIE_SETTING_KEY);
  const classifiedsFreebieOn = classifiedsFreebieRaw === null ? true : classifiedsFreebieRaw === '1';

  // The classifieds hint: shown when classifieds polling is off or no
  // session cookie is stored — then no classified freebies will be seen.
  const classifiedsEnabledRaw = store.getSetting(CLASSIFIEDS_ENABLED_KEY);
  const classifiedsEnabled = classifiedsEnabledRaw === null ? false : classifiedsEnabledRaw === '1';
  const accountCookie = store.getSetting(ACCOUNT_COOKIE_KEY);
  const classifiedsHint = !classifiedsEnabled || !accountCookie;

  const secret = process.env.OZB_CSRF_SECRET ?? '';
  const token = secret ? await generateCsrfToken(secret) : '';

  return (
    <section>
      <PageHeader title="Thresholds" description="Freebie alerts and upvote thresholds." />
      <Subnav label="Settings" links={settingsLinks} activeHref="/thresholds" />
      <div className="card form-card settings-card freebie-card">
        <h2>Freebie alerts</h2>
        <p className="card-description">Alert on anything OzBargain lists as a freebie. This is separate from your keyword rules.</p>
        <AsyncForm action="/thresholds/freebie-deals" successMessage="Deals freebie preference saved.">
          <input type="hidden" name="_csrf" value={token} />
          <label className="switch" htmlFor="deal-freebie-setting" aria-label="Deal freebie alerts">
            <input id="deal-freebie-setting" type="checkbox" name="freebie_deals" defaultChecked={dealFreebieOn} />
            <span><strong>Deals</strong><small>Deals OzBargain lists under Freebies.</small></span>
          </label>
          <button className="btn btn-primary" type="submit">Save</button>
        </AsyncForm>
        <AsyncForm action="/thresholds/freebie" successMessage="Classifieds freebie preference saved.">
          <input type="hidden" name="_csrf" value={token} />
          <label className="switch" htmlFor="classifieds-freebie-setting" aria-label="Classifieds freebie alerts">
            <input id="classifieds-freebie-setting" type="checkbox" name="freebie" defaultChecked={classifiedsFreebieOn} />
            <span><strong>Classifieds</strong><small>Classified listings of type Freebie (pinned listings excluded).</small></span>
          </label>
          {classifiedsHint ? (
            <p className="hint">
              Classifieds polling is off, so no classified freebies will be seen.{' '}
              <Link href="/classifieds-session">Set up classifieds</Link>
            </p>
          ) : null}
          <button className="btn btn-primary" type="submit">Save</button>
        </AsyncForm>
      </div>
      {rules.length ? <DataTable className="thresholds" columns={['Threshold', 'State', 'Window']} rows={rules.map((rule) => [
        <a key="threshold" href={`/rules/${rule.id}`}>{rule.parameters?.threshold}+ upvotes</a>,
        <Badge key="state" tone={stateTone(rule.state)}>{rule.state}</Badge>,
        <span key="window">{rule.parameters?.windowHours != null ? `${rule.parameters.windowHours} h` : '—'}</span>,
      ])} /> : <EmptyState title="No threshold rules." body="Create a threshold rule from the Rules page." />}
    </section>
  );
}
