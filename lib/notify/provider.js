/**
 * The notification provider interface (design 6.1).
 *
 * One interface, one shape: a provider is a function that takes a
 * notification and a sender and sends it. A notification is the composed
 * payload (see `compose.js`): `{ title, body, url, priority, tags }`.
 *
 * **Adding a provider must not require a change to the rules engine.** The
 * engine produces alerts; `fanout` turns them into notifications and hands
 * each to every selected provider. A provider never inspects the rules, the
 * store, or the engine — it only knows how to deliver one notification
 * through one sender.
 *
 * Every provider takes an **injected sender** and never calls
 * `globalThis.fetch` directly, so a test supplies a fake sender and no
 * network stub is needed at all.
 */

/**
 * The notification shape a provider receives.
 * @typedef {object} Notification
 * @property {string} title the notification title
 * @property {string} body the notification body
 * @property {string} url the link to the `/node/<id>` page (never a `/goto/` redirect)
 * @property {'normal' | 'high'} priority front-page alerts are `high`, everything else `normal`
 * @property {string[]} tags the tags that fired (rule type, matched term, …)
 */

/**
 * @typedef {object} Provider
 * @property {string} kind the provider's kind name (e.g. `email`, `matrix`, `ntfy`)
 * @property {(n: Notification, sender: object) => Promise<void> | void} send
 *   deliver one notification through the injected sender
 */

/**
 * Build a provider. The factory keeps the three concrete providers uniform:
 * each supplies a `kind` and a `send` implementation that uses only the
 * injected `sender`.
 * @param {string} kind
 * @param {(n: Notification, sender: object) => Promise<void> | void} send
 * @returns {Provider}
 */
export function makeProvider(kind, send) {
  return { kind, send };
}
