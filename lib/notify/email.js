/**
 * The email provider (design 6.1). Uses nodemailer, with the transport
 * **injected** — the provider never constructs a transport and never calls
 * `globalThis.fetch`. A test supplies a fake transport.
 *
 * The notification is delivered as an email: subject = title, body = body,
 * with a link line to the `/node/<id>` page.
 */

import { makeProvider } from './provider.js';

/**
 * @param {object} transport a nodemailer transport (or a test fake) with
 *   `sendMail({ to, subject, text }) => Promise`
 * @returns {Provider}
 */
export function emailProvider(transport) {
  return makeProvider('email', (n, sender) => {
    const to = sender.to ?? sender.address;
    return transport.sendMail({
      to,
      subject: n.title,
      text: `${n.body}\n\n${n.url}`,
    });
  });
}
