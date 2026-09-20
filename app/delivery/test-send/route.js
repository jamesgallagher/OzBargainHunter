/**
 * Screen 8 — Delivery: test-send (design 7.1, 9.2). A state-changing route:
 * gated on the access check and the CSRF check (independent, 11.3.6).
 *
 * X7: this endpoint did not exist; the delivery page's test-send button
 * posted here to nothing. A test send happens in the Next.js process — that
 * is a request, not a schedule, and it is the one place the server may send
 * a notification. It builds the provider from the store row + config and
 * sends a single test notification through it, reporting success or the
 * provider's error.
 *
 * X1: lives in its own segment (`/delivery/test-send`) so it does not
 * collide with the `/delivery` page in the build.
 */
import nodemailer from 'nodemailer';
import { emailProvider } from '../../../lib/notify/email.js';
import { matrixProvider } from '../../../lib/notify/matrix.js';
import { ntfyProvider } from '../../../lib/notify/ntfy.js';

/**
 * Build the real providers from the store's selected provider rows. Mirrors
 * the worker process's factories (the one place the server may send).
 * @param {string} kind
 * @param {object} row
 * @param {object} config
 * @returns {{ send: Function }}
 */
function buildProvider(kind, row, config) {
  const cfg = JSON.parse(row.config ?? '{}');
  if (kind === 'email') {
    const transport = nodemailer.createTransport({
      host: cfg.host ?? config.EMAIL_SMTP_HOST,
      port: cfg.port ?? config.EMAIL_SMTP_PORT,
      auth: config.EMAIL_SMTP_USER ? { user: config.EMAIL_SMTP_USER, pass: config.EMAIL_SMTP_PASS } : false,
    });
    return emailProvider(transport);
  }
  if (kind === 'matrix') {
    return matrixProvider({
      postMessage({ room, text }) {
        return fetch(
          `${cfg.homeserver ?? ''}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message`,
          {
            method: 'PUT',
            headers: { Authorization: `Bearer ${cfg.accessToken ?? ''}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ msgtype: 'm.text', body: text }),
          },
        );
      },
    });
  }
  if (kind === 'ntfy') {
    return ntfyProvider({
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
    });
  }
  throw new Error(`unknown provider kind: ${kind}`);
}

/**
 * POST /delivery/test-send — send a single test notification through the
 * named provider.
 * @param {Request} request
 */
export async function POST(request) {
  const { requireAuthenticated, parseBody } = await import('../../../lib/web/gate.js');
  const { getStore } = await import('../../../lib/web/db.js');
  const { loadConfig } = await import('../../../lib/config.js');

  const body = await parseBody(request);
  const gate = await requireAuthenticated(request, undefined, body);
  if (!gate.ok) return gate.response;

  const store = getStore();
  const config = loadConfig();
  const kind = typeof body.kind === 'string' ? body.kind : '';
  const row = store.getProvider(kind);
  if (!row) {
    return new Response('unknown provider', { status: 404 });
  }

  const provider = buildProvider(kind, row, config);
  const notification = {
    title: 'OzBargainHunter test send',
    body: 'This is a test notification. If you received it, delivery is working.',
    url: '/',
    priority: 'normal',
    tags: ['test'],
  };
  try {
    await provider.send(notification, JSON.parse(row.config ?? '{}'));
    return Response.json({ sent: true, kind });
  } catch (err) {
    return Response.json({ sent: false, kind, error: err?.message ?? String(err) }, { status: 502 });
  }
}
