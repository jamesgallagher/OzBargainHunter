/**
 * Screen 5 — Alert history (design 7.1). What fired, when, under which rule,
 * for which deal or listing, with a link.
 *
 * Server component.
 */

import { getStore } from '../../lib/web/db.js';
import LocalTime from '../components/local-time.js';
import { DataTable, EmptyState, PageHeader, Subnav } from '../components/ui.js';

export const metadata = { title: 'Alerts' };
const activityLinks = [{ label: 'Alerts', href: '/alerts' }, { label: 'Suppressions', href: '/suppressions' }];

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
      <PageHeader title="Alert history" description="Notifications sent for matched deals and listings." />
      <Subnav label="Activity" links={activityLinks} activeHref="/alerts" />
      {rows.length ? (
        <DataTable className="alerts" columns={['When', 'Rule', 'Deal / listing']} rows={rows.map((r) => [
          <LocalTime key="time" iso={r.firedAt} />,
          <span key="rule">Rule #{r.ruleId}</span>,
          <a key="deal" href={r.url} target="_blank" rel="noreferrer">{r.title} <span aria-hidden="true">↗</span></a>,
        ])} />
      ) : <EmptyState title="No alerts yet." body="Alerts will appear here after a rule fires." />}
    </section>
  );
}
