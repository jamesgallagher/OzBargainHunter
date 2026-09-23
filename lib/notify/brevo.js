/**
 * The Brevo SMTP provider (delivery mechanisms). Uses nodemailer, with the
 * transport **injected** — the provider never constructs a transport and never
 * calls `globalThis.fetch`. A test supplies a fake transport.
 *
 * The transport is the Brevo relay (`smtp-relay.brevo.com:587`, STARTTLS),
 * authenticated with the Brevo SMTP login and API key (built by the registry).
 * The notification is delivered as an email: from = the configured sender name
 * + address, to = the notification recipient, subject = title, body = body,
 * with a link line to the `/node/<id>` page.
 */

import { makeProvider } from './provider.js';

/**
 * @param {object} transport a nodemailer transport (or a test fake) with
 *   `sendMail({ from, to, subject, text }) => Promise`
 * @returns {Provider}
 */
export function brevoProvider(transport) {
  return makeProvider('brevo_smtp', (n, sender) => {
    const from = sender.mailFromName
      ? `${sender.mailFromName} <${sender.mailFrom}>`
      : sender.mailFrom;
    return transport.sendMail({
      from,
      to: sender.recipient,
      subject: n.title,
      text: `${n.body}\n\n${n.url}`,
    });
  });
}
