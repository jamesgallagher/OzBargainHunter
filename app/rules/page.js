/**
 * Screen 2 — Rules list (design 7.1). Enabled, muted or snoozed state; match
 * counts over 7 and 30 days; last fired; cooldown; optional pinned slug; and
 * which surfaces the rule applies to (fixed to deals-only for threshold rules,
 * not editable).
 *
 * Server component.
 */

import { getStore } from '../../lib/web/db.js';

/**
 * The rules list page.
 * @returns {React.ReactElement}
 */
export default function RulesPage() {
  const store = getStore();
  const rules = store.getRules();
  const now = new Date().toISOString();
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  return (
    <section>
      <h2>Rules</h2>
      <a href="/rules/new">New rule</a>
      <table className="rules">
        <thead>
          <tr>
            <th>Rule</th>
            <th>State</th>
            <th>7d</th>
            <th>30d</th>
            <th>Last fired</th>
            <th>Cooldown</th>
            <th>Surfaces</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => {
            const label =
              rule.type === 'match'
                ? rule.parameters?.term ?? 'match'
                : `${rule.parameters?.threshold ?? ''}+ upvotes`;
            const rows30 = store.getLedgerWithTitles(rule.id, since30);
            const rows7 = store.getLedgerWithTitles(rule.id, since7);
            const lastFired = store.getRuleLastFire(rule.id);
            return (
              <tr key={rule.id}>
                <td>
                  <a href={`/rules/${rule.id}`}>{label}</a>
                  {rule.pinned_slug ? ` (#${rule.pinned_slug})` : ''}
                </td>
                <td>{rule.state}</td>
                <td>{rows7.length}</td>
                <td>{rows30.length}</td>
                <td>{lastFired ?? '—'}</td>
                <td>{rule.cooldown_seconds}s</td>
                <td>{rule.surfaces}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <span className="sr-only">{now}</span>
    </section>
  );
}
