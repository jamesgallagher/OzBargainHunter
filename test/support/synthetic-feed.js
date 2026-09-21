/**
 * Clock-aligned RSS timeline for the real-worker alert test. Poll one contains
 * only non-matching deals; poll two adds live deal 900003 with 24 votes.
 */

import { CLASSIFIEDS_PATH, DEALS_PATH, FRONT_PATH } from '../../scripts/fixture-server.mjs';

export const ALERT_DEAL_TITLE = 'Ubiquiti Unifi Dream Router 7 (UDR7) $399 Delivered @ PLE';

function xml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function item({ id, title, votes, now, expiry }) {
  const published = now.toUTCString().replace('GMT', '+0000');
  return `<item>
<title>${xml(title)}</title>
<link>https://www.ozbargain.com.au/node/${id}</link>
<description><![CDATA[<p>Clock-aligned integration deal ${id}</p>]]></description>
<category domain="https://www.ozbargain.com.au/cat/computing">Computing</category>
<ozb:meta comment-count="0" click-count="1" votes-pos="${votes}" votes-neg="0" expiry="${expiry}" url="https://example.invalid/${id}" />
<pubDate>${published}</pubDate>
<dc:creator>integration</dc:creator>
<guid isPermaLink="false">${id} at https://www.ozbargain.com.au</guid>
</item>`;
}

function feed(items) {
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:ozb="https://www.ozbargain.com.au">
<channel><title>Integration feed</title>${items.join('')}</channel>
</rss>`;
}

/** Build the fixture-server timeline and the expected deal title. */
export function buildAlertTimeline({ now = new Date() } = {}) {
  const expiry = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const cold = [
    item({ id: 900001, title: 'Coffee beans $20 delivered', votes: 3, now, expiry }),
    item({ id: 900002, title: 'Garden hose clearance', votes: 5, now, expiry }),
  ];
  const alert = item({ id: 900003, title: ALERT_DEAL_TITLE, votes: 24, now, expiry });
  const pollOne = feed(cold);
  const pollTwo = feed([...cold, alert]);
  return {
    timeline: {
      [`${DEALS_PATH}?page=0`]: [
        { body: pollOne, contentType: 'application/rss+xml; charset=utf-8' },
        { body: pollTwo, contentType: 'application/rss+xml; charset=utf-8' },
      ],
      [`${DEALS_PATH}?page=1`]: [{ body: pollOne, contentType: 'application/rss+xml; charset=utf-8' }],
      [FRONT_PATH]: [{ body: pollOne, contentType: 'application/rss+xml; charset=utf-8' }],
      [CLASSIFIEDS_PATH]: [{ fixture: 'http/classifieds-page.html' }],
    },
    title: ALERT_DEAL_TITLE,
  };
}
