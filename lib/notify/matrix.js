/**
 * The Matrix provider (design 6.1). One POST to the client-server API, with
 * the POST function **injected** — the provider never calls
 * `globalThis.fetch` directly. A test supplies a fake POST.
 *
 * The notification is delivered as a Matrix message: the body is the
 * notification body, with a link line to the `/node/<id>` page.
 */

import { makeProvider } from './provider.js';

/**
 * @param {object} client an object with `postMessage({ room, text })` that
 *   POSTs to the Matrix client-server API (or a test fake)
 * @returns {Provider}
 */
export function matrixProvider(client) {
  return makeProvider('matrix', (n, sender) => {
    const room = sender.room ?? sender.roomId;
    return client.postMessage({
      room,
      text: `${n.body}\n\n${n.url}`,
    });
  });
}
