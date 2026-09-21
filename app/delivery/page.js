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
      <h2>Delivery</h2>
      <table className="providers">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Selected</th>
            <th>Enabled</th>
            <th>Failures</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => (
            <tr key={p.kind}>
              <td>{p.kind}</td>
              <td>{p.selected ? 'yes' : 'no'}</td>
              <td>{p.enabled ? 'yes' : 'no'}</td>
              <td>{p.consecutive_failures}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {providers.map((p) => (
        <form key={p.kind} method="POST" action="/delivery/save" className="provider-config">
          <input type="hidden" name="_csrf" value={token} />
          <input type="hidden" name="kind" value={p.kind} />
          <label>
            <input type="checkbox" name="selected" defaultChecked={p.selected} />
            Select {p.kind}
          </label>
          <label>
            Credentials (JSON)
            <input type="text" name="config" placeholder='{"to":"…"}' />
          </label>
          <button type="submit">Save {p.kind}</button>
        </form>
      ))}
      <form method="POST" action="/delivery/test-send" className="test-send">
        <input type="hidden" name="_csrf" value={token} />
        <label>
          Provider
          <select name="kind">
            {providers.map((p) => (
              <option key={p.kind} value={p.kind}>
                {p.kind}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Test send</button>
      </form>
    </section>
  );
}
