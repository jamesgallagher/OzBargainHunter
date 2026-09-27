/**
 * Gate alert delivery (design 3.7, chunk 2).
 *
 * The access gate's state changes are operational alerts: they are sent
 * **through Brevo SMTP always** (even when Brevo is not selected for
 * deal alerts) and through the other selected providers via the normal
 * fan-out. They never change the gate, and they never throw.
 *
 * The policy (`shouldNotify`) is pure: a stop is always notified, a
 * cool-off is notified from tier 2 up (a single 503 must not email),
 * a manual or lazy resume is not notified, and a `probing→open`
 * "resumed" alert is sent only when an earlier event in the same
 * episode was notified (any delivery outcome). An episode is every event
 * since the most recent earlier `to_state = 'open'` event, or since the
 * start of the table.
 *
 * Delivery (`sendGateEvents`) claims each unsent event atomically
 * (`notified = 0 → 1`) before sending, so two concurrent sweeps deliver
 * each event once. A crash after the claim but before the send loses
 * that one alert (accepted: the gate's state is still visible in the UI
 * banner and the event row keeps `notified = 1`); a crash before the
 * claim leaves the event unsent for the next sweep.
 */

import { formatMelbourne } from '../time.js';
import { gateAlertKind, shouldNotify } from '../gate/alert-policy.js';
import { fanout, recordProviderFailureD55 } from './fanout.js';
import { mechanismFor } from './registry.js';

// Re-exported so existing importers (the tests, chunk 6) are unchanged.
export { gateAlertKind, shouldNotify } from '../gate/alert-policy.js';

/**
 * The plain meaning of a gate rule, for human-facing text (design 3.7,
 * chunk 2). Fixed text: never carries a body, URL, cookie or header.
 */
const RULE_MEANING = {
  B1: 'Cloudflare block',
  B2: 'rate limited',
  B3: 'repeated rate limiting',
  B4: 'unexpected access denied',
  B5: 'repeated errors',
};

/**
 * The cool-off duration label: `N min` under 60 minutes, `N h` or
 * `N h M min` above (design 3.7, chunk 2: B2 tier 2 renders `30 min`,
 * B5 tier 2 renders `20 min` on the default poll interval).
 * @param {number} ms the duration, in ms
 * @returns {string}
 */
export function durationLabel(ms) {
  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/**
 * Compose the gate notification for one event (design 3.7, chunk 2).
 * Pure: every time is rendered in Melbourne (`formatMelbourne`), the
 * `reason` is fixed text included verbatim, and no response body, cookie,
 * header, query or credential can appear in the output.
 *
 * @param {object} event one gate event row
 * @param {object} opts
 * @param {string} opts.publicUrl the public base URL (no trailing slash),
 *   or empty (the link falls back to a relative `/`)
 * @returns {object} a Notification (`{ title, body, url, priority, tags }`)
 */
export function composeGateNotification(event, { publicUrl = '' }) {
  const kind = gateAlertKind(event);
  const ruleLabel = event.rule ? RULE_MEANING[event.rule] : '';
  const atLine = formatMelbourne(event.at);
  const lines = [];

  if (kind === 'stopped') {
    lines.push(`OzBargain access is STOPPED: ${event.rule} (${ruleLabel}).`);
    lines.push(`It started at ${atLine}.`);
    lines.push(
      `The earliest manual resume is ${formatMelbourne(event.min_resume_at)}; resume is manual from the Status screen.`,
    );
  } else if (kind === 'paused') {
    const duration = durationLabel(Date.parse(event.until_at) - Date.parse(event.at));
    lines.push(`OzBargain access is paused: ${event.rule}, tier ${event.tier} (${event.rule} ${ruleLabel}).`);
    lines.push(`It started at ${atLine}.`);
    lines.push(
      `The cool-off ends at ${formatMelbourne(event.until_at)}; the app will make one test request then.`,
    );
  } else {
    // `probing→open`: the event's rule is null (the probe reset the
    // counters), so the rule is omitted when it is absent.
    lines.push(
      `Access resumed at ${atLine}${event.rule ? ` after ${event.rule} back-off` : ' after back-off'}. Normal polling continues.`,
    );
  }
  if (kind !== 'resumed') {
    lines.push('No requests are being made to OzBargain until then.');
  }

  const title =
    kind === 'stopped'
      ? `OzBargain Hunter — access STOPPED (${event.rule}: ${ruleLabel})`
      : kind === 'paused'
        ? `OzBargain Hunter — access paused (${event.rule}, tier ${event.tier}: ${durationLabel(
            Date.parse(event.until_at) - Date.parse(event.at),
          )})`
        : 'OzBargain Hunter — access resumed';

  return {
    title,
    body: lines.join('\n'),
    url: publicUrl ? `${publicUrl}/` : '/',
    priority: 'high',
    tags: ['gate', ...(event.rule ? [event.rule] : []), kind],
  };
}

/**
 * Deliver the pending gate events (design 3.7, chunk 2).
 *
 * 1. Read the unsent events (`notified = 0`, oldest first).
 * 2. Claim each one atomically first; a failed claim means another sweep
 *    owns it, so it is skipped.
 * 3. Apply the policy; a `false` marks the event `skipped`.
 * 4. Brevo SMTP is always attempted (selected or not): a missing row is
 *    `not_configured`, a disabled row is `disabled`, a send success is
 *    `sent`, a failure is `failed` with the same D55 auto-disable and
 *    notice behaviour as the deal-alert fan-out (shared counter).
 * 5. The other selected+enabled providers (excluding `brevo_smtp`, so
 *    Brevo is never double-sent when it is also selected) go through
 *    the normal fan-out.
 * 6. The email outcome is persisted with `setGateEventEmailStatus`.
 *
 * One log line per event. This function never throws and never changes
 * the gate: a failure of the delivery is logged and the next sweep
 * retries nothing (the claim is the dedup; a lost alert after a crash
 * is the accepted trade-off, see the module comment).
 *
 * @param {object} args
 * @param {object} args.store the store
 * @param {object} args.clock { now(): Date }
 * @param {object} args.config the config (carries `OZB_PUBLIC_URL`)
 * @param {object} [args.providerFactories] provider kind to factory (an
 *   injected factory wins over the real mechanism build, so a test
 *   substitutes a fake Brevo transport — no real SMTP is ever built)
 * @param {(line: string) => void} [args.log] log sink
 * @returns {Promise<void>}
 */
export async function sendGateEvents({ store, clock, config, providerFactories = {}, log = () => {} }) {
  try {
    // Nothing unsent: return before reading the full event table.
    const unsent = store.getUnnotifiedGateEvents();
    if (unsent.length === 0) return;
    const all = store.getGateEventsAsc();

    // The episode boundary for each event: the id of the most recent
    // earlier `to_state = 'open'` event, or 0 (the start of the table).
    const boundaryById = new Map();
    let lastOpenId = 0;
    for (const e of all) {
      boundaryById.set(e.id, lastOpenId);
      if (e.to_state === 'open') lastOpenId = e.id;
    }

    // The notified flag as it stands at this sweep: the persisted value,
    // with the claims made by this sweep applied (an event claimed earlier
    // in this same sweep counts as notified for a later `probing→open`).
    const notifiedById = new Map(all.map((e) => [e.id, e.notified]));
    // The email status as it stands at this sweep: the persisted value,
    // with the outcomes recorded by this sweep applied. The `all` snapshot
    // is stale for events sent earlier in this same sweep, so a `skipped`
    // outcome recorded here must not count as a notification for a later
    // `probing→open` (the policy reads `email_status`, not just `notified`).
    const emailStatusById = new Map(all.map((e) => [e.id, e.email_status]));

    // The other selected+enabled providers, excluding Brevo (Brevo is
    // always sent directly below, whether or not it is selected, so it
    // is excluded here to avoid a double send when it is selected too).
    const otherRows = store.getProviders().filter((row) => row.selected && row.enabled && row.kind !== 'brevo_smtp');
    const otherProviders = otherRows
      .map((row) => {
        const factory = providerFactories[row.kind];
        if (!factory) return null;
        return factory(row, config);
      })
      .filter(Boolean);

    for (const event of unsent) {
      // Claim first: the atomic `notified = 0 → 1` flip is the dedup.
      // A crash after this line but before the send loses this one alert
      // (accepted, see the module comment); a crash before it leaves the
      // event for the next sweep.
      if (!store.claimGateEvent(event.id)) continue;
      notifiedById.set(event.id, 1);

      const boundary = boundaryById.get(event.id) ?? 0;
      const episode = all.filter((e) => e.id > boundary && e.id < event.id);
      const episodeWithFlags = episode.map((e) => ({
        ...e,
        notified: notifiedById.get(e.id) ?? e.notified,
        email_status: emailStatusById.get(e.id) ?? e.email_status,
      }));
      const kind = gateAlertKind(event);

      let emailStatus;
      if (!shouldNotify(event, episodeWithFlags)) {
        emailStatus = 'skipped';
      } else {
        // Brevo is always: selected or not.
        const brevoRow = store.getProvider('brevo_smtp');
        if (!brevoRow) {
          emailStatus = 'not_configured';
        } else if (!brevoRow.enabled) {
          emailStatus = 'disabled';
        } else {
          const factory = providerFactories.brevo_smtp ?? mechanismFor('brevo_smtp').build;
          const provider = factory(brevoRow, config);
          const notification = composeGateNotification(event, { publicUrl: config.OZB_PUBLIC_URL });
          try {
            const sender = { ...JSON.parse(brevoRow.config ?? '{}') };
            await provider.send(notification, sender);
            store.recordProviderSuccess('brevo_smtp');
            emailStatus = 'sent';
          } catch (err) {
            recordProviderFailureD55({
              store,
              kind: 'brevo_smtp',
              err,
              atIso: clock.now().toISOString(),
            });
            emailStatus = 'failed';
          }
        }
      }

      // The other selected providers (excluding Brevo). A policy skip
      // sends nothing at all.
      let otherSent = 0;
      let otherFailed = 0;
      if (emailStatus !== 'skipped') {
        const result = await fanout({ notifications: [composeGateNotification(event, { publicUrl: config.OZB_PUBLIC_URL })], providers: otherProviders, store, clock });
        otherSent = result.sent;
        otherFailed = result.failed;
      }

      store.setGateEventEmailStatus(event.id, emailStatus);
      emailStatusById.set(event.id, emailStatus);
      log(`gate-notify event ${event.id} ${kind} email=${emailStatus} others=${otherSent}/${otherFailed}`);
    }
  } catch (err) {
    // Never throws: a delivery failure is logged, the gate is untouched,
    // and the task that called us continues.
    log(`gate-notify error: ${err?.message ?? err}`);
  }
}
