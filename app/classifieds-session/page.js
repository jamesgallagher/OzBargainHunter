/**
 * Screen 9 — Classifieds session status (design 7.1, prompt 4.5). Validity,
 * when it was last confirmed working, when the stored cookie expires, and
 * the sign-in wizard (the only way the app logs in — it never logs in on
 * its own). The session is supplied only through the sign-in wizard; the
 * legacy paste form is removed (chunk 7).
 *
 * X12: displays "when it was last confirmed working" (the
 * `classifieds_last_confirmed_at` setting, persisted by the classifieds
 * acquisition module on the worker side). The toggle posts to
 * `/classifieds-session/toggle` (its own segment, so it does not collide
 * with this page in the build); it is CSRF-gated.
 *
 * Rendering is read-only (prompt 7): the gate is read with `getGate()` and
 * projected with the pure `viewGate` — never `createGate().read()`/`isOpen()`,
 * which apply lazy transitions and write.
 *
 * Server component.
 */

import { getStore } from '../../lib/web/db.js';
import { generateCsrfToken } from '../../lib/csrf.js';
import { systemClock } from '../../lib/clock.js';
import { viewGate } from '../../lib/gate/view.js';
import { resolveLoginOrigin } from '../../lib/ozb-login/origin.js';
import { readAttempts, loginLockView } from '../../lib/web/login-throttle.js';
import { unavailableReasonText } from '../../lib/web/login-unavailable.js';
import { formatMelbourne } from '../../lib/time.js';
import AsyncForm from '../components/async-form.js';
import LoginWizard from '../components/login-wizard.js';
import LocalTime from '../components/local-time.js';
import { Badge, PageHeader, Subnav } from '../components/ui.js';

export const metadata = { title: 'Classifieds' };
const settingsLinks = [{ label: 'Thresholds', href: '/thresholds' }, { label: 'Delivery', href: '/delivery' }, { label: 'Classifieds', href: '/classifieds-session' }];

const LAST_UID_KEY = 'classifieds_last_uid';
const LAST_CONFIRMED_KEY = 'classifieds_last_confirmed_at';
const COOKIE_EXPIRES_KEY = 'ozb_account_cookie_expires_at';
// The global enable/disable gate key (worker-owned module owns the same
// string; the server tree must not import from lib/acquire/).
const CLASSIFIEDS_ENABLED_KEY = 'classifieds_enabled';
const ATTEMPTS_KEY = 'ozb_login_attempts';

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
  const cookieExpires = store.getSetting(COOKIE_EXPIRES_KEY);
  // The global enable/disable gate: absent (null) means disabled.
  const enabledRaw = store.getSetting(CLASSIFIEDS_ENABLED_KEY);
  const enabledOn = enabledRaw === null ? false : enabledRaw === '1';

  // Read-only gate/lock/origin projections (prompt 4.5): `getGate()` + the
  // pure `viewGate`, never the writing `createGate().read()`/`isOpen()`.
  const now = systemClock().now();
  const gateView = viewGate(store.getGate(), store.getGateEvents({ limit: 50 }), now);
  const lock = loginLockView(readAttempts(store.getSetting(ATTEMPTS_KEY)), now);
  const origin = resolveLoginOrigin({
    classifiedsUrl: process.env.OZB_CLASSIFIEDS_URL ?? 'https://www.ozbargain.com.au/classified',
    env: process.env,
  });

  // The wizard's disabled reason: the first that applies (prompt 4.5).
  let disabledReason = '';
  if (gateView.closed) {
    const time = gateView.untilAt ?? gateView.minResumeAt;
    disabledReason = `OzBargain access is paused or stopped, so sign-in is unavailable until ${
      time ? formatMelbourne(time) : 'access is resumed'
    }.`;
  } else if (lock.locked) {
    disabledReason = `Sign-in is locked until ${formatMelbourne(lock.lockedUntil)} after repeated failed attempts (rule B6). Polling is unaffected.`;
  } else if (!origin.ok) {
    disabledReason = unavailableReasonText(origin.reason);
  }

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
        <dt>Cookie expires</dt>
        <dd>{cookieExpires ? <LocalTime iso={cookieExpires} /> : '—'}</dd>
      </dl>
      <LoginWizard disabledReason={disabledReason} pollingEnabled={enabledOn} csrfToken={token} />
      <div className="card form-card settings-card">
      <AsyncForm action="/classifieds-session/toggle" successMessage="Classifieds polling preference saved.">
        <input type="hidden" name="_csrf" value={token} />
        <label className="switch" htmlFor="classifieds-enabled" aria-label="Enable classifieds polling">
          <input id="classifieds-enabled" type="checkbox" name="enabled" defaultChecked={enabledOn} />
          <span><strong>Enable classifieds polling</strong><small>Poll the classifieds page with the stored session cookie. Disabled by default.</small></span>
        </label>
        <button className="btn btn-primary" type="submit">Save</button>
      </AsyncForm>
      </div>
    </section>
  );
}
