/**
 * Threshold rule (design 5.1): "has reached X upvotes."
 *
 * Each threshold is its own rule with its own ID. A 10-vote rule and a
 * 50-vote rule are two rules, and a deal clearing both produces two alerts.
 *
 * The window is optional. Unset, the rule fires when a deal is seen to
 * reach X votes at any point while it is visible. If set, it means
 * "reached X votes within Y of posting", and Y may not exceed 24 hours —
 * anything longer is rejected at entry rather than accepted, because it
 * could never be satisfied and would present as a rule that silently
 * never fires (D44).
 *
 * Threshold rules apply to deals only. Classified listings carry no vote,
 * comment or click counts, so a threshold rule can never fire on them.
 */

const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Validate a threshold rule's parameters at rule entry.
 * @param {{ threshold: number, windowHours?: number | null }} rule
 * @throws {Error} if the window exceeds 24 hours
 */
export function validateThresholdRule(rule) {
  if (typeof rule.threshold !== 'number' || !Number.isFinite(rule.threshold) || rule.threshold < 1) {
    throw new Error(`threshold must be a positive integer, got ${rule.threshold}`);
  }
  if (rule.windowHours != null) {
    const windowMs = rule.windowHours * 60 * 60 * 1000;
    if (windowMs > MAX_WINDOW_MS) {
      throw new Error(
        `window may not exceed 24 hours, got ${rule.windowHours} hours ` +
          `(it could never be satisfied and would silently never fire)`,
      );
    }
  }
}

/**
 * Whether a deal's current net votes have reached the threshold.
 * @param {{ threshold: number }} rule
 * @param {{ votesPos: number, votesNeg: number }} deal
 * @returns {boolean}
 */
export function reachedThreshold(rule, deal) {
  const net = deal.votes_pos - deal.votes_neg;
  return net >= rule.threshold;
}

export { MAX_WINDOW_MS };
