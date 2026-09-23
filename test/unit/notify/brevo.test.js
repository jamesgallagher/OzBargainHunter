import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brevoProvider } from '../../../lib/notify/brevo.js';

/**
 * The Brevo SMTP provider (delivery mechanisms). The transport is **injected**
 * (a fake here), so the test never constructs a nodemailer transport and never
 * touches the network. The provider turns one notification into one email:
 * from = the configured sender name + address (name only when present),
 * to = the notification recipient, subject = title, body = body + a link line.
 */

/** A fake nodemailer transport that records every `sendMail` call. */
function fakeTransport() {
  const calls = [];
  return {
    calls,
    async sendMail(args) {
      calls.push(args);
      return { accepted: [args.to], rejected: [] };
    },
  };
}

const notification = {
  title: 'Weber grill 40% off',
  body: 'A deal matched your rule.',
  url: 'https://www.ozbargain.com.au/node/12345',
  priority: 'normal',
  tags: ['match', 'weber'],
};

test('the provider kind is brevo_smtp', () => {
  const provider = brevoProvider(fakeTransport());
  assert.equal(provider.kind, 'brevo_smtp');
});

test('with mailFromName set, from is "Name <mailFrom>" and the email carries to/subject/text', async () => {
  const transport = fakeTransport();
  const provider = brevoProvider(transport);
  await provider.send(notification, {
    login: 'alerts@example.com',
    apiKey: 'xkeys-secret',
    mailFrom: 'alerts@example.com',
    mailFromName: 'OzBargainHunter',
    recipient: 'you@example.com',
  });
  assert.equal(transport.calls.length, 1, 'exactly one sendMail call');
  assert.deepEqual(transport.calls[0], {
    from: 'OzBargainHunter <alerts@example.com>',
    to: 'you@example.com',
    subject: 'Weber grill 40% off',
    text: 'A deal matched your rule.\n\nhttps://www.ozbargain.com.au/node/12345',
  });
});

test('with mailFromName absent, from is the bare mailFrom address', async () => {
  const transport = fakeTransport();
  const provider = brevoProvider(transport);
  await provider.send(notification, {
    login: 'alerts@example.com',
    apiKey: 'xkeys-secret',
    mailFrom: 'alerts@example.com',
    recipient: 'you@example.com',
  });
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].from, 'alerts@example.com');
  assert.equal(transport.calls[0].to, 'you@example.com');
  assert.equal(transport.calls[0].subject, 'Weber grill 40% off');
  assert.equal(
    transport.calls[0].text,
    'A deal matched your rule.\n\nhttps://www.ozbargain.com.au/node/12345',
  );
});
