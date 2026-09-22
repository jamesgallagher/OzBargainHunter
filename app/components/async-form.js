'use client';

/**
 * AsyncForm (spec §7.3). Progressively enhances an existing POST endpoint:
 *
 * 1. Intercepts submit only after hydration.
 * 2. Sends the original FormData to the original same-origin action with POST
 *    and the browser's current credentials/Access session.
 * 3. CSRF remains the hidden `_csrf` field minted by the server. No new token
 *    source, no bypass of `requireAuthenticated`.
 * 4. Disables duplicate submission, exposes pending state, and announces it
 *    through an `aria-live="polite"` region.
 * 5. Treats non-2xx as failure, displays bounded response text, and never
 *    clears user input on failure.
 * 6. On success it either `router.push(destination)` or `router.refresh()`.
 * 7. Without JavaScript the original form and endpoint still submit.
 *
 * The endpoint response contract remains JSON; progressive enhancement does
 * not weaken authentication or CSRF.
 *
 * @param {{
 *   action: string,
 *   method?: string,
 *   children: React.ReactNode,
 *   destination?: string,
 *   onSuccess?: 'refresh'|'push',
 *   pendingLabel?: string,
 *   successMessage?: string,
 *   errorPrefix?: string,
 *   className?: string,
 *   formClassName?: string,
 *   resetOnSuccess?: boolean,
 *   [key: string]: any
 * }} props
 */
import { useRouter } from 'next/navigation.js';
import { useRef, useState, useId } from 'react';

export default function AsyncForm({
  action,
  method = 'POST',
  children,
  destination,
  onSuccess = 'refresh',
  pendingLabel = 'Saving…',
  successMessage,
  errorPrefix = 'Error:',
  className = '',
  formClassName = '',
  resetOnSuccess = false,
  ...rest
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const lastStatus = useRef('');

  async function handleSubmit(event) {
    // Only intercept after hydration (the handler is attached by React, which
    // runs client-side). Without JS the native form submit proceeds to the
    // same action.
    event.preventDefault();
    if (pending) return; // duplicate submission guard (spec §7.3.4)

    const form = event.currentTarget;
    const submitter = event.nativeEvent.submitter;
    const formData = new FormData(form);
    const config = formData.get('config');
    if (typeof config === 'string' && config.trim()) {
      try {
        JSON.parse(config);
      } catch {
        setError('Error: Credentials must be valid JSON.');
        setStatus('');
        return;
      }
    }

    setPending(true);
    // Disable only the control that submitted this form. The rest of the
    // fields stay available and retain their values while the request runs.
    if (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) {
      submitter.disabled = true;
    }
    setError('');
    setStatus(pendingLabel);

    try {
      const response = await fetch(action, {
        method,
        body: new URLSearchParams(formData),
        // Same-origin, credentials: 'same-origin' preserves the Access
        // session cookie (spec §7.3.2).
        credentials: 'same-origin',
      });

      if (response.ok) {
        if (resetOnSuccess) form.reset();
        const resolvedMessage = (successMessage ?? 'Done.').replace(
          '{kind}',
          String(formData.get('kind') ?? ''),
        );
        setStatus(resolvedMessage);
        if (onSuccess === 'push' && destination) {
          router.push(destination);
        } else {
          router.refresh();
        }
      } else {
        // Non-2xx is a failure: display bounded response text, never clear
        // user input (spec §7.3.5).
        const text = await response.text().catch(() => '');
        const bounded = (text || `Request failed (${response.status})`).slice(0, 400);
        setError(`${errorPrefix} ${bounded}`);
        setStatus('');
      }
    } catch (err) {
      setError(`${errorPrefix} ${err?.message ?? String(err)}`.slice(0, 400));
      setStatus('');
    } finally {
      if (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) {
        submitter.disabled = false;
      }
      setPending(false);
    }
  }

  const liveRegionId = useId();

  return (
    <form
      className={formClassName}
      method={method}
      action={action}
      onSubmit={handleSubmit}
      {...rest}
    >
      {children}
      <div className="async-form-status" aria-live="polite" id={liveRegionId}>
        {pending ? <span className="async-form-pending">{pendingLabel}</span> : null}
        {!pending && status ? (
          <span className="async-form-success" role="status">
            {status}
          </span>
        ) : null}
        {error ? (
          <span className="async-form-error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </form>
  );
}
