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

const LAST_UID_KEY = 'classifieds_last_uid';
const LAST_CONFIRMED_KEY = 'classifieds_last_confirmed_at';

/**
 * The classifieds session page.
 * @returns {Promise<React.ReactElement>}
 */
export default async function ClassifiedsSessionPage() {
  const store = getStore();
  const uid = store.getSetting(LAST_UID_KEY);
  const valid = uid !== null && uid !== '0';
  const lastConfirmed = store.getSetting(LAST_CONFIRMED_KEY);

  // Mint an unbound CSRF token (production relies on the token TTL, m3).
  const secret = process.env.OZB_CSRF_SECRET ?? '';
  const token = secret ? await generateCsrfToken(secret) : '';

  return (
    <section>
      <h2>Classifieds session</h2>
      <dl className="classifieds-session">
        <dt>Valid</dt>
        <dd>{valid ? 'yes' : 'no'}</dd>
        <dt>UID</dt>
        <dd>{uid ?? '—'}</dd>
        <dt>Last confirmed working</dt>
        <dd>{lastConfirmed ?? '—'}</dd>
      </dl>
      <form method="POST" action="/classifieds-session/set">
        <input type="hidden" name="_csrf" value={token} />
        <label>
          Session cookie
          <input type="text" name="cookie" placeholder="ozbargain session cookie" />
        </label>
        <button type="submit">Set session</button>
      </form>
    </section>
  );
}
