/**
 * Screen 8 — Delivery configuration (design 7.1, 9.2). Provider selection,
 * credentials, and a **test-send button**. A test send happens in the Next.js
 * process: that is a request, not a schedule, and it is the one place the
 * server may send a notification.
 *
 * Server component.
 */

import { getStore } from '../../lib/web/db.js';

/**
 * The delivery page.
 * @returns {React.ReactElement}
 */
export default function DeliveryPage() {
  const store = getStore();
  const providers = store.getProviders();

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
      <form method="POST" action="/delivery/test-send">
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
