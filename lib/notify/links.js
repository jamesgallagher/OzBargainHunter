/**
 * Link helpers (design 6.3).
 *
 * Notifications link **directly to the OzBargain node page** —
 * `https://www.ozbargain.com.au/node/<id>` — and never to the `/goto/`
 * redirect. The `/goto/` URL is stored for display only and is never
 * fetched or linked.
 */

const NODE_BASE = 'https://www.ozbargain.com.au';

/**
 * @param {number} nodeId
 * @returns {string} the node page URL, never a /goto/ redirect
 */
export function nodeUrl(nodeId) {
  return `${NODE_BASE}/node/${nodeId}`;
}
