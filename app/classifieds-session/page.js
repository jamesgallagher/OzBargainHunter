/**
 * Screen 9 — Classifieds session status (design 7.1). Validity, when it was
 * last confirmed working, and somewhere to supply a fresh session cookie. This
 * is where the expired-session latch is cleared, by hand.
 *
 * X12: displays "when it was last confirmed working" (the
 * `classifieds_last_confirmed_at` setting, persisted by the classifieds
 * acquisition module on the worker side). The set-cookie form posts to
 * `/classifieds-session/set` (its own segment, so it does not collide with
 * this page in the build) and is CSRF-gated.
 *
 * Server component.
 */

import { getStore } from '../../lib/web/db.js';
import { generateCsrfToken } from '../../lib/csrf.js';
import AsyncForm from '../components/async-form.js';
import SecretField from '../components/secret-field.js';
import LocalTime from '../components/local-time.js';
import { Badge, PageHeader, Subnav } from '../components/ui.js';

export const metadata = { title: 'Classifieds' };
const settingsLinks = [{ label: 'Thresholds', href: '/thresholds' }, { label: 'Delivery', href: '/delivery' }, { label: 'Classifieds', href: '/classifieds-session' }];

const LAST_UID_KEY = 'classifieds_last_uid';
const LAST_CONFIRMED_KEY = 'classifieds_last_confirmed_at';

/**
 * The classifieds session page.
 * @returns {Promise<React.ReactElement>}
 */
export default async function ClassifiedsSessionPage() {
  const store = getStore();
  const uid = store.getSetting(LAST_UID_KEY);
  const sessionStatus = uid === null
    ? { label: 'Not yet confirmed', tone: 'neutral' }
    : uid === '0'
      ? { label: 'Expired', tone: 'danger' }
      : { label: 'Valid', tone: 'success' };
  const lastConfirmed = store.getSetting(LAST_CONFIRMED_KEY);

  // Mint an unbound CSRF token (production relies on the token TTL, m3).
  const secret = process.env.OZB_CSRF_SECRET ?? '';
  const token = secret ? await generateCsrfToken(secret) : '';

  return (
    <section>
      <PageHeader title="Classifieds session" description="Account session health for classifieds acquisition." />
      <Subnav label="Settings" links={settingsLinks} activeHref="/classifieds-session" />
      <dl className="classifieds-session card status-details">
        <dt>Status</dt>
        <dd><Badge tone={sessionStatus.tone}>{sessionStatus.label}</Badge></dd>
        <dt>UID</dt>
        <dd>{uid ?? '—'}</dd>
        <dt>Last confirmed working</dt>
        <dd>{lastConfirmed ? <LocalTime iso={lastConfirmed} /> : '—'}</dd>
      </dl>
      <div className="card form-card settings-card">
      <AsyncForm action="/classifieds-session/set" resetOnSuccess successMessage="Session cookie updated; validity is confirmed on the next classifieds poll.">
        <input type="hidden" name="_csrf" value={token} />
        <div className="field"><label htmlFor="session-cookie">Session cookie</label>
          <SecretField id="session-cookie" name="cookie" placeholder="OzBargain session cookie" />
          <span className="help">The cookie is stored server-side and is never displayed again.</span>
        </div>
        <button className="btn btn-primary" type="submit">Set session</button>
      </AsyncForm>
      </div>
    </section>
  );
}
