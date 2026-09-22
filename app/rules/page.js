/**
 * Screen 2 — Rules list (spec §6.2). Each rule shows a human label, explicit
 * type, state badge, surfaces, 7-day and 30-day counts, last fired and
 * cooldown. Desktop/tablet render a semantic table; on phone each row
 * transforms into a labelled card (D5). Headers are static — no
 * sortable-looking styling because no sorting is implemented.
 *
 * Server component: it reads the live store state.
 */

import { getStore } from '../../lib/web/db.js';
import {
  PageHeader,
  DataTable,
  Badge,
  EmptyState,
  stateTone,
  ruleLabel,
} from '../components/ui.js';
import LocalTime from '../components/local-time.js';

export const metadata = { title: 'Rules' };

/**
 * The rules list page.
 * @returns {React.ReactElement}
 */
export default function RulesPage() {
  const store = getStore();
  const rules = store.getRules();
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const columns = ['Rule', 'Type', 'State', 'Surfaces', '7d', '30d', 'Last fired', 'Cooldown'];

  const rows = rules.map((rule) => {
    const label = ruleLabel(rule);
    const rows30 = store.getLedgerWithTitles(rule.id, since30);
    const rows7 = store.getLedgerWithTitles(rule.id, since7);
    const lastFired = store.getRuleLastFire(rule.id);
    return [
      <a key="rule" href={`/rules/${rule.id}`}>
        {label}
        {rule.pinned_slug ? ` (#${rule.pinned_slug})` : ''}
      </a>,
      <span key="type">{rule.type}</span>,
      <Badge key="state" tone={stateTone(rule.state)}>
        {rule.state}
      </Badge>,
      <span key="surfaces">{rule.surfaces}</span>,
      <span key="c7" className="tabular">{rows7.length}</span>,
      <span key="c30" className="tabular">{rows30.length}</span>,
      lastFired ? (
        <LocalTime key="lf" iso={lastFired} />
      ) : (
        <span key="lf">—</span>
      ),
      <span key="cd" className="tabular">{rule.cooldown_seconds}s</span>,
    ];
  });

  return (
    <section>
      <PageHeader
        title="Rules"
        description="Match and threshold rules that trigger alerts."
        action={<a className="btn btn-primary" href="/rules/new">New rule</a>}
      />

      {rules.length > 0 ? (
        <div className="card">
          <DataTable columns={columns} rows={rows} />
        </div>
      ) : (
        <EmptyState
          title="No rules yet."
          body="A rule watches for a term or an upvote threshold and alerts you when it matches. Create your first rule to start watching."
          action={<a className="btn btn-primary" href="/rules/new">Create first rule</a>}
        />
      )}
    </section>
  );
}
