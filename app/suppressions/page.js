/**
 * Screen 6 — Near-miss and suppression log (design 7.1). Reads the
 * `suppressions` table.
 *
 * Server component.
 */

import { getStore } from '../../lib/web/db.js';
import LocalTime from '../components/local-time.js';
import { Badge, DataTable, EmptyState, PageHeader, Subnav } from '../components/ui.js';

export const metadata = { title: 'Suppressions' };
const activityLinks = [{ label: 'Alerts', href: '/alerts' }, { label: 'Suppressions', href: '/suppressions' }];

/**
 * The suppressions page.
 * @returns {React.ReactElement}
 */
export default function SuppressionsPage() {
  const store = getStore();
  const rows = store.getSuppressions();

  return (
    <section>
      <PageHeader title="Suppressions" description="Matches withheld by cooldown and deduplication rules." />
      <Subnav label="Activity" links={activityLinks} activeHref="/suppressions" />
      <p className="summary-count">
        {rows.length} suppressed {rows.length === 1 ? 'alert' : 'alerts'}
      </p>
      {rows.length ? <DataTable className="suppressions" columns={['Poll at', 'Node', 'Rule', 'Reason']} rows={rows.map((r) => [
        <LocalTime key="time" iso={r.poll_at} />,
        <span key="node">Node {r.node_id}</span>,
        <span key="rule">Rule #{r.rule_id}</span>,
        <Badge key="kind" tone="neutral">{r.kind}</Badge>,
      ])} /> : <EmptyState title="No suppressions." body="No alerts have been withheld." />}
    </section>
  );
}
