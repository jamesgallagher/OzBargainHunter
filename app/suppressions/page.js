/**
 * Screen 6 — Near-miss and suppression log (design 7.1). Reads the
 * `suppressions` table.
 *
 * Server component.
 */

import { getStore } from '../../lib/web/db.js';

/**
 * The suppressions page.
 * @returns {React.ReactElement}
 */
export default function SuppressionsPage() {
  const store = getStore();
  const rows = store.getSuppressions();

  return (
    <section>
      <h2>Suppressions</h2>
      <p>
        {rows.length} suppressed {rows.length === 1 ? 'alert' : 'alerts'}
      </p>
      <table className="suppressions">
        <thead>
          <tr>
            <th>Poll at</th>
            <th>Node</th>
            <th>Rule</th>
            <th>Kind</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.poll_at}</td>
              <td>{r.node_id}</td>
              <td>#{r.rule_id}</td>
              <td>{r.kind}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
