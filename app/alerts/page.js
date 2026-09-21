/**
 * Screen 5 — Alert history (design 7.1). What fired, when, under which rule,
 * for which deal or listing, with a link.
 *
 * Server component.
 */

import { getStore } from '../../lib/web/db.js';

/**
 * The alert history page.
 * @returns {React.ReactElement}
 */
export default function AlertsPage() {
  const store = getStore();
  const rules = store.getRules();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const rows = [];
  for (const rule of rules) {
    const ledger = store.getLedgerWithTitles(rule.id, since);
    for (const entry of ledger) {
      rows.push({
        id: `${rule.id}-${entry.node_id}-${entry.fired_at}`,
        firedAt: entry.fired_at,
        ruleId: rule.id,
        title: entry.title ?? `node ${entry.node_id}`,
        url: `https://www.ozbargain.com.au/node/${entry.node_id}`,
      });
    }
  }
  rows.sort((a, b) => (a.firedAt < b.firedAt ? 1 : -1));

  return (
    <section>
      <h2>Alert history</h2>
      <table className="alerts">
        <thead>
          <tr>
            <th>When</th>
            <th>Rule</th>
            <th>Deal / listing</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.firedAt}</td>
              <td>#{r.ruleId}</td>
              <td>
                <a href={r.url}>{r.title}</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
