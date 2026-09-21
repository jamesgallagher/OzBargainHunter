/**
 * The ntfy provider (design 6.1). One POST to the ntfy topic endpoint, with
 * the POST function **injected** — the provider never calls
 * `globalThis.fetch` directly. A test supplies a fake POST.
 *
 * The notification is delivered as an ntfy message: topic = the topic
 * configured on the sender, title = the notification title, body = the
 * notification body plus a link line to the `/node/<id>` page, and the
 * tags carried through.
 */

import { makeProvider } from './provider.js';

/**
 * @param {object} client an object with `publish({ topic, title, message, tags })`
 *   that POSTs to the ntfy API (or a test fake)
 * @returns {Provider}
 */
export function ntfyProvider(client) {
  return makeProvider('ntfy', (n, sender) => {
    const topic = sender.topic ?? 'alerts';
    return client.publish({
      topic,
      title: n.title,
      message: `${n.body}\n\n${n.url}`,
      tags: n.tags ?? [],
    });
  });
}
