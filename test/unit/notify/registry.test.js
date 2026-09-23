import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MECHANISMS, mechanismFor, mechanismView } from '../../../lib/notify/registry.js';

/**
 * The delivery-mechanism registry (delivery mechanisms). The registry is the
 * single place that knows how to **build** each provider from its store row
 * and the app config, and what **fields** and **test template** each mechanism
 * has. These tests pin the shape of the registry: the kinds, the field
 * definitions that drive the add/edit form, the client-safe view (which strips
 * the non-serialisable `build`), and that every `build` returns a provider of
 * the right kind.
 */

describe('registry: mechanism lookup', () => {
  test('mechanismFor returns each known kind and undefined for an unknown kind', () => {
    const kinds = MECHANISMS.map((m) => m.kind);
    assert.deepEqual(kinds, ['email', 'matrix', 'ntfy', 'brevo_smtp']);
    for (const m of MECHANISMS) {
      assert.equal(mechanismFor(m.kind), m, `mechanismFor(${m.kind}) returns the same entry`);
    }
    assert.equal(mechanismFor('nope'), undefined, 'an unknown kind is undefined');
  });

  test('every mechanism has a label, addLabel, fields, a test template, and a build', () => {
    for (const m of MECHANISMS) {
      assert.ok(typeof m.label === 'string' && m.label.length > 0, `${m.kind} label`);
      assert.ok(typeof m.addLabel === 'string' && m.addLabel.length > 0, `${m.kind} addLabel`);
      assert.ok(Array.isArray(m.fields) && m.fields.length > 0, `${m.kind} fields`);
      assert.ok(typeof m.testTemplate.title === 'string', `${m.kind} testTemplate`);
      assert.ok(typeof m.build === 'function', `${m.kind} build`);
    }
  });

  test('the brevo_smtp mechanism exposes the five configured fields, with the API key sensitive', () => {
    const m = mechanismFor('brevo_smtp');
    const names = m.fields.map((f) => f.name);
    assert.deepEqual(names, ['login', 'apiKey', 'mailFrom', 'mailFromName', 'recipient']);
    const apiKey = m.fields.find((f) => f.name === 'apiKey');
    assert.equal(apiKey.sensitive, true, 'the API key field is sensitive');
    // The four credentials plus the notification recipient are required; the
    // sender display name is optional.
    assert.equal(apiKey.required, true);
    assert.equal(m.fields.find((f) => f.name === 'login').required, true);
    assert.equal(m.fields.find((f) => f.name === 'mailFrom').required, true);
    assert.equal(m.fields.find((f) => f.name === 'recipient').required, true);
    assert.ok(!m.fields.find((f) => f.name === 'mailFromName').required, 'the sender display name is optional');
  });
});

describe('registry: mechanismView strips build', () => {
  test('mechanismView returns a client-safe copy without the build function, leaving the original intact', () => {
    const m = mechanismFor('brevo_smtp');
    const view = mechanismView(m);
    assert.equal(view.build, undefined, 'build is stripped from the view');
    assert.equal(view.kind, 'brevo_smtp');
    assert.equal(view.label, 'Brevo SMTP');
    assert.deepEqual(view.fields, m.fields, 'the rest is preserved');
    assert.equal(typeof m.build, 'function', 'the original still has its build');
  });
});

describe('registry: build returns a provider of the right kind', () => {
  test('each mechanism.build(row, config) returns a provider whose kind matches', () => {
    // The email build reads SMTP server auth from config; a blank user means
    // no auth, so no config values are required to construct the transport.
    const config = {};
    const email = mechanismFor('email').build({ config: JSON.stringify({ to: 'a@example.com' }), selected: 1 }, config);
    assert.equal(email.kind, 'email');
    assert.ok(typeof email.send === 'function');

    const matrix = mechanismFor('matrix').build(
      { config: JSON.stringify({ homeserver: 'https://matrix.example.com', room: '!r:example.com' }), selected: 1 },
      config,
    );
    assert.equal(matrix.kind, 'matrix');
    assert.ok(typeof matrix.send === 'function');

    const ntfy = mechanismFor('ntfy').build(
      { config: JSON.stringify({ url: 'http://127.0.0.1:8080', topic: 'alerts' }), selected: 1 },
      config,
    );
    assert.equal(ntfy.kind, 'ntfy');
    assert.ok(typeof ntfy.send === 'function');

    const brevo = mechanismFor('brevo_smtp').build(
      { config: JSON.stringify({ login: 'a@example.com', apiKey: 'xkeys-…', mailFrom: 'a@example.com', recipient: 'b@example.com' }), selected: 1 },
      config,
    );
    assert.equal(brevo.kind, 'brevo_smtp');
    assert.ok(typeof brevo.send === 'function');
  });
});
