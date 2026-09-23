/**
 * The delivery-mechanism registry (delivery mechanisms). The single place that
 * knows how to **build** each provider from its store row and the app config,
 * and what **fields** and **test template** each mechanism has.
 *
 * The worker (which fans out real alerts) and the test-send route (which sends
 * a single test notification) both build a provider through `mechanism.build`,
 * so the construction logic lives here once instead of being duplicated in the
 * two processes. A mechanism is a description object; `mechanismView` strips
 * the `build` function so the rest can be handed to a client component.
 *
 * **Adding a mechanism must not require a change to the rules engine.** It is a
 * new entry in `MECHANISMS`; the worker and the test-send route pick it up
 * automatically.
 */

import nodemailer from 'nodemailer';
import { matrixProvider } from './matrix.js';
import { ntfyProvider } from './ntfy.js';
import { brevoProvider } from './brevo.js';

/** The Brevo SMTP relay host and submission port (STARTTLS). */
const BREVO_SMTP_HOST = 'smtp-relay.brevo.com';
const BREVO_SMTP_PORT = 587;

/** The test template shared by every mechanism (one notification shape). */
function defaultTestTemplate() {
  return {
    title: 'OzBargainHunter test send',
    body: 'This is a test notification. If you received it, delivery is working.',
    url: '/',
    priority: 'normal',
    tags: ['test'],
  };
}

/** Build a Matrix client for the matrix provider from its store row. */
function buildMatrixClient(row) {
  const cfg = JSON.parse(row.config ?? '{}');
  return {
    postMessage({ room, text }) {
      return fetch(`${cfg.homeserver ?? ''}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${cfg.accessToken ?? ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'm.text', body: text }),
      });
    },
  };
}

/** Build an ntfy client for the ntfy provider from its store row. */
function buildNtfyClient(row) {
  const cfg = JSON.parse(row.config ?? '{}');
  return {
    publish({ topic, title, message, tags }) {
      return fetch(`${cfg.url ?? ''}/${topic}`, {
        method: 'POST',
        headers: {
          ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
          'X-Title': title ?? '',
          'X-Priority': 'high',
        },
        body: message,
      });
    },
  };
}

/** Build a nodemailer transport for the Brevo SMTP provider from its store row. */
function buildBrevoTransport(row) {
  const cfg = JSON.parse(row.config ?? '{}');
  return nodemailer.createTransport({
    host: BREVO_SMTP_HOST,
    port: BREVO_SMTP_PORT,
    secure: false, // STARTTLS on the submission port
    auth: { user: cfg.login ?? '', pass: cfg.apiKey ?? '' },
  });
}

/**
 * The supported delivery mechanisms. Each `build(row, config)` returns a
 * provider (the worker and the test-send route call it); `fields` drives the
 * add/edit form and the save route's config assembly; `testTemplate` is the
 * notification the "Test delivery" section sends.
 */
export const MECHANISMS = [
  {
    kind: 'matrix',
    label: 'Matrix',
    addLabel: 'Add Matrix delivery',
    fields: [
      { name: 'homeserver', label: 'Homeserver URL', type: 'text', placeholder: 'https://matrix.example.com', required: true },
      { name: 'room', label: 'Room ID', type: 'text', placeholder: '!roomid:example.com', required: true },
      { name: 'accessToken', label: 'Access token', type: 'text', sensitive: true, placeholder: 'syt_…' },
    ],
    testTemplate: defaultTestTemplate(),
    build: (row) => matrixProvider(buildMatrixClient(row)),
  },
  {
    kind: 'ntfy',
    label: 'ntfy',
    addLabel: 'Add ntfy delivery',
    fields: [
      { name: 'url', label: 'Server URL', type: 'text', placeholder: 'https://ntfy.sh', required: true },
      { name: 'topic', label: 'Topic', type: 'text', placeholder: 'ozbargain', required: true },
      { name: 'token', label: 'Access token', type: 'text', sensitive: true, placeholder: '…' },
    ],
    testTemplate: defaultTestTemplate(),
    build: (row) => ntfyProvider(buildNtfyClient(row)),
  },
  {
    kind: 'brevo_smtp',
    label: 'Brevo SMTP',
    addLabel: 'Add Brevo SMTP delivery',
    fields: [
      { name: 'login', label: 'Brevo SMTP login', type: 'email', placeholder: 'alerts@example.com', required: true },
      { name: 'apiKey', label: 'Brevo API key', type: 'text', sensitive: true, placeholder: 'xkeys-…', required: true },
      { name: 'mailFrom', label: 'Mail from', type: 'email', placeholder: 'alerts@example.com', required: true },
      { name: 'mailFromName', label: 'Mail from name', type: 'text', placeholder: 'OzBargainHunter' },
      { name: 'recipient', label: 'Notification recipient', type: 'email', placeholder: 'you@example.com', required: true },
    ],
    testTemplate: defaultTestTemplate(),
    build: (row) => brevoProvider(buildBrevoTransport(row)),
  },
];

/**
 * Look up a mechanism by kind.
 * @param {string} kind
 * @returns {object|undefined}
 */
export function mechanismFor(kind) {
  return MECHANISMS.find((m) => m.kind === kind);
}

/**
 * The client-safe view of a mechanism: everything except the `build` function
 * (which is not serialisable to a client component).
 * @param {object} mechanism
 * @returns {object}
 */
export function mechanismView(mechanism) {
  const view = { ...mechanism };
  delete view.build;
  return view;
}
