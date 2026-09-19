/**
 * Notification composition (design 6.3, 6.4, 6.5).
 *
 * `compose` turns a group of alerts — every alert that one rule fired in one
 * poll — into a single notification. Grouping is per `(rule, poll)`: one
 * notification per rule per poll, listing every deal that rule matched in
 * that poll, carrying exactly one unsubscribe control. Grouping across rules
 * is prohibited (6.5).
 *
 * Content (6.3): the deal title, current net votes and the rate over the
 * configured window, which rule fired and which term matched, and a link
 * **directly to the `/node/<id>` page — never a `/goto/` redirect.**
 *
 * Controls (6.4): exactly two.
 *   - an unsubscribe control for the rule that fired, labelled with the rule
 *     in the user's own words (never a rule number), an ordinary
 *     authenticated URL `/rules/<id>/mute`;
 *   - a "Manage alerts" link.
 * Nothing in the notification is a credential.
 */

import { nodeUrl } from './links.js';

/**
 * @param {object} alert a single alert from the engine
 * @returns {string} a line for the notification body
 */
function alertLine(alert) {
  const net = alert.netVotes != null ? ` — ${alert.netVotes} votes` : '';
  const rate = alert.rate != null ? `, ${alert.rate.toFixed(1)}/h` : '';
  return `- ${alert.title}${net}${rate}`;
}

/**
 * Compose one notification for one rule in one poll.
 * @param {object} group
 * @param {number} group.ruleId the rule id
 * @param {string} group.ruleLabel the rule's user-facing label (its own words)
 * @param {string} group.pollAt the poll instant
 * @param {object[]} group.alerts the alerts this rule fired in this poll
 * @returns {object} the notification
 */
export function compose(group) {
  const { ruleId, ruleLabel, pollAt, alerts } = group;
  const first = alerts[0];
  // Front-page alerts carry the highest priority; everything else is normal.
  const priority = alerts.some((a) => a.isFrontPage) ? 'high' : 'normal';
  const title = alerts.length === 1 ? first.title : `${alerts.length} matches for "${ruleLabel}"`;
  const lines = alerts.map(alertLine);
  const term = alerts.map((a) => a.matchedTerm).find(Boolean) ?? null;
  const body = [
    `Rule "${ruleLabel}" fired at ${pollAt}:`,
    ...lines,
    term ? `Matched term: ${term}` : null,
    '',
    'Unsubscribe: Stop alerts for this rule',
    'Manage alerts',
  ]
    .filter((l) => l != null)
    .join('\n');

  return {
    title,
    body,
    // Link directly to the node page, never a /goto/ redirect.
    url: nodeUrl(first.node_id),
    priority,
    tags: [ruleId, ...(term ? [term] : [])],
    // Exactly two controls (6.4). The unsubscribe is an ordinary
    // authenticated URL, labelled with the rule in the user's own words.
    unsubscribe: {
      label: `Stop alerts for "${ruleLabel}"`,
      url: `/rules/${ruleId}/mute`,
    },
    manage: {
      label: 'Manage alerts',
      url: '/alerts',
    },
    ruleId,
    ruleLabel,
    pollAt,
    nodeIds: alerts.map((a) => a.node_id),
  };
}

/**
 * Group alerts per (rule, poll) and compose one notification per group.
 * Alerts from different rules are never merged (6.5).
 * @param {object[]} alerts engine alerts
 * @returns {object[]} the composed notifications, one per (rule, poll)
 */
export function groupAndCompose(alerts) {
  const groups = new Map();
  for (const a of alerts) {
    const key = `${a.rule_id}::${a.pollAt}`;
    if (!groups.has(key)) {
      groups.set(key, {
        ruleId: a.rule_id,
        ruleLabel: a.ruleLabel ?? a.rule_id,
        pollAt: a.pollAt,
        alerts: [],
      });
    }
    groups.get(key).alerts.push(a);
  }
  return Array.from(groups.values()).map(compose);
}
