/**
 * Screen 9 — Classifieds session status (design 7.1). Validity, when it was
 * last confirmed working, and somewhere to supply a fresh session cookie. This
 * is where the expired-session latch is cleared, by hand.
 *
 * Server component.
 */

import { getStore } from '../../lib/web/db.js';

const LAST_UID_KEY = 'classifieds_last_uid';

/**
 * The classifieds session page.
 * @returns {React.ReactElement}
 */
export default function ClassifiedsSessionPage() {
  const store = getStore();
  const uid = store.getSetting(LAST_UID_KEY);
  const valid = uid !== null && uid !== '0';

  return (
    <section>
      <h2>Classifieds session</h2>
      <dl className="classifieds-session">
        <dt>Valid</dt>
        <dd>{valid ? 'yes' : 'no'}</dd>
        <dt>UID</dt>
        <dd>{uid ?? '—'}</dd>
      </dl>
      <form method="POST" action="/classifieds-session">
        <label>
          Session cookie
          <input type="text" name="cookie" placeholder="ozbargain session cookie" />
        </label>
        <button type="submit">Set session</button>
      </form>
    </section>
  );
}
