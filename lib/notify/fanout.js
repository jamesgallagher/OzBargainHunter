/**
 * Notification fan-out (design 6.1, 6.7).
 *
 * **Every alert is delivered through every selected provider.** There is no
 * priority order and no fallback chain: if email and Matrix are both
 * selected, one alert produces both.
 *
 * Failure is counted **per provider, on consecutive attempts**. After five
 * consecutive failures that provider is disabled automatically and a UI
 * notice is written naming the provider, when it was disabled, and the
 * last error. Disabling is per provider and never affects the others —
 * with several selected, one failing leaves the rest delivering. A success
 * before the fifth failure resets the counter.
 *
 * `fanout` takes the composed notifications, the selected providers, a store
 * and a clock, and delivers each notification through every selected
 * provider. It is pure in the sense that every send goes through an
 * injected provider; nothing here opens a socket.
 */

const DISABLE_AFTER_CONSECUTIVE_FAILURES = 5;

/**
 * Record one provider failure with the D55 auto-disable behaviour:
 * increment the consecutive-failure counter, and when the threshold is
 * reached, the provider is disabled and a UI notice is produced naming
 * the provider, when it was disabled, and the last error.
 *
 * Shared by `fanout`'s catch path and the gate email delivery (chunk 2)
 * so both paths count failures and disable identically — a gate-alert
 * failure and a deal-alert failure advance the same counter.
 * @param {object} args
 * @param {object} args.store the store
 * @param {string} args.kind the provider kind
 * @param {unknown} args.err the thrown error
 * @param {string} args.atIso the failure instant (ISO)
 * @returns {{ disabled: boolean, notice: object|null }}
 */
export function recordProviderFailureD55({ store, kind, err, atIso }) {
  const message = err && err.message ? err.message : String(err);
  const result = store.recordProviderFailure(kind, message, atIso);
  if (result.consecutiveFailures >= DISABLE_AFTER_CONSECUTIVE_FAILURES && result.disabled) {
    return {
      disabled: true,
      notice: { provider: kind, disabledAt: atIso, lastError: message },
    };
  }
  return { disabled: false, notice: null };
}

/**
 * @param {object} args
 * @param {object[]} args.notifications composed notifications
 * @param {object[]} args.providers selected providers (each a Provider)
 * @param {object} args.store the store
 * @param {object} args.clock { now(): Date }
 * @returns {Promise<{ sent: number, failed: number, disabled: object[], notices: object[] }>}
 */
export async function fanout({ notifications, providers, store, clock }) {
  let sent = 0;
  let failed = 0;
  const disabled = [];
  const notices = [];

  for (const notification of notifications) {
    for (const provider of providers) {
      const kind = provider.kind;
      const providerRow = store.getProvider(kind);
      // A provider that is not selected or is disabled is not attempted.
      if (!providerRow || !providerRow.selected || !providerRow.enabled) continue;

      try {
        // The sender carries the provider's configured target.
        const sender = { ...JSON.parse(providerRow.config ?? '{}') };
        await provider.send(notification, sender);
        store.recordProviderSuccess(kind);
        sent += 1;
      } catch (err) {
        failed += 1;
        const { disabled: nowDisabled, notice } = recordProviderFailureD55({
          store,
          kind,
          err,
          atIso: clock.now().toISOString(),
        });
        if (nowDisabled) {
          disabled.push(kind);
          notices.push(notice);
        }
      }
    }
  }

  return { sent, failed, disabled, notices };
}

export { DISABLE_AFTER_CONSECUTIVE_FAILURES };
