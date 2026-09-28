'use client';

/**
 * The sign-in wizard (prompt 4.6). The user's username and password are used
 * once, over the wire to `/classifieds-session/login`, and are never stored:
 * no React state holds them (uncontrolled inputs, cleared the moment the
 * `FormData` is built, on every submit, never restored), and nothing is kept
 * in localStorage, sessionStorage, or cookies. Only the session cookie the
 * login produces is kept — server-side, by the route.
 *
 * The CSRF token is the hidden `_csrf` field minted by the server; the
 * request is same-origin with credentials, exactly as `AsyncForm` sends its
 * forms, so the Access session and the double-submit CSRF check apply.
 *
 * While the request runs, an `aria-live="polite"` region shows three timed
 * step estimates — timed estimates only, not live progress: the browser's
 * actual steps are not observed, so the steps advance on one-shot timers at
 * 0s/4s/10s and are cleared when the response arrives or the component
 * unmounts.
 *
 * @param {{
 *   disabledReason: string,
 *   pollingEnabled: boolean,
 *   csrfToken: string
 * }} props
 */
import { useRouter } from 'next/navigation.js';
import { useEffect, useRef, useState } from 'react';
import { formatMelbourne } from '../../lib/time.js';
import { unavailableReasonText } from '../../lib/web/login-unavailable.js';

/** The three timed step estimates (prompt 4.6). Not live progress. */
const PROGRESS_STEPS = ['Opening the browser', 'Signing in', 'Checking classifieds access'];

/**
 * The fixed result messages (prompt 4.6). The message never includes the
 * submitted credentials; `uid`/`expiresAt`/`retryAt` come from the response.
 * @param {string} outcome
 * @param {object} data the response body
 * @param {string} disabledReason the page's disabled reason (for `unavailable`)
 * @returns {{ message: string, tone: 'success'|'danger'|'neutral' }}
 */
function messageFor(outcome, data, disabledReason) {
  let message;
  switch (outcome) {
    case 'ok':
      message = `Signed in. Classifieds session saved for uid ${data.uid}. Cookie expires ${
        data.expiresAt ? formatMelbourne(data.expiresAt) : 'at the end of the session'
      }.`;
      break;
    case 'bad_credentials':
      message =
        'OzBargain did not recognise that username or password. Nothing was saved. ' +
        'Five failures in 24 hours lock sign-in for 24 hours.';
      break;
    case 'validation_error':
      message =
        'OzBargain rejected the sign-in form. Nothing was saved. A second rejection ' +
        'within 24 hours locks sign-in for 24 hours.';
      break;
    case 'login_failed':
      message = 'Sign-in did not produce a session. Nothing was saved.';
      break;
    case 'not_entitled':
      message = 'Signed in, but this account cannot see OzBargain classifieds. Nothing was saved.';
      break;
    case 'cloudflare_block':
      message =
        'OzBargain presented a Cloudflare challenge. All OzBargain access is now stopped; ' +
        'see the Status screen.';
      break;
    case 'rate_limited':
      message =
        'OzBargain is rate limiting requests. All OzBargain access is paused; see the Status screen.';
      break;
    case 'form_changed':
      message =
        "OzBargain's sign-in page has changed, so the wizard cannot use it. Nothing was submitted.";
      break;
    case 'timeout':
      message = 'Sign-in took too long and was abandoned. Nothing was saved.';
      break;
    case 'transient':
      message = 'OzBargain returned an error. Nothing was saved. Try again later.';
      break;
    case 'browser_error':
      message = 'The sign-in browser could not run. Nothing was saved.';
      break;
    case 'gate_closed':
      message = `OzBargain access is paused or stopped, so sign-in is unavailable until ${
        data.retryAt ? formatMelbourne(data.retryAt) : 'access is resumed'
      }.`;
      break;
    case 'locked':
      message = `Sign-in is locked until ${formatMelbourne(data.retryAt)} after repeated failed attempts (rule B6).`;
      break;
    case 'throttled':
      message = `Please wait until ${formatMelbourne(data.retryAt)} before trying again.`;
      break;
    case 'busy':
      message = 'A sign-in is already running.';
      break;
    case 'unavailable': {
      // Map the response's `data.reason` to the 4.5 text (the origin reasons
      // are known only at submit time, so the `disabledReason` prop may be
      // stale); fall back to the page's disabled reason for the gate/lock.
      message = unavailableReasonText(data.reason) || disabledReason || '';
      break;
    }
    default:
      message = 'Sign-in failed unexpectedly. Nothing was saved.';
  }
  const tone =
    outcome === 'ok' ? 'success' : outcome === 'throttled' || outcome === 'busy' ? 'neutral' : 'danger';
  return { message, tone };
}

export default function LoginWizard({ disabledReason, pollingEnabled, csrfToken }) {
  const router = useRouter();
  const formRef = useRef(null);
  const timersRef = useRef([]);
  const [pending, setPending] = useState(false);
  const [step, setStep] = useState(0);
  const [result, setResult] = useState(null); // { message, tone }
  const [toggleError, setToggleError] = useState('');

  const disabled = disabledReason !== undefined && disabledReason !== '';

  function clearTimers() {
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = [];
  }

  // Clear the step timers on unmount (prompt 4.6).
  useEffect(() => clearTimers, []);

  async function handleSubmit(event) {
    event.preventDefault();
    if (pending || disabled) return; // duplicate submission guard
    const form = formRef.current;
    const formData = new FormData(form);
    // Clear both fields immediately after building the FormData, on every
    // submit, and never restore them (prompt 4.6).
    form.reset();

    setPending(true);
    setResult(null);
    setStep(0);
    clearTimers();
    // Timed estimates, not live progress: the browser's actual steps are not
    // observed, so the steps advance on one-shot timers at 0s/4s/10s.
    timersRef.current.push(setTimeout(() => setStep(0), 0));
    timersRef.current.push(setTimeout(() => setStep(1), 4000));
    timersRef.current.push(setTimeout(() => setStep(2), 10000));

    try {
      const response = await fetch('/classifieds-session/login', {
        method: 'POST',
        body: formData,
        // Same-origin, credentials: 'same-origin' preserves the Access
        // session cookie, exactly as AsyncForm sends its forms.
        credentials: 'same-origin',
      });
      if (response.ok) {
        const data = await response.json();
        const { message, tone } = messageFor(data.outcome, data, disabledReason);
        setResult({ message, tone });
        if (data.outcome === 'ok') router.refresh();
      } else {
        // A 400 carries the fixed validation message as plain text.
        const text = (await response.text().catch(() => '')) || `Request failed (${response.status})`;
        const { message, tone } =
          response.status === 400
            ? { message: text, tone: 'danger' }
            : messageFor('', {}, disabledReason);
        setResult({ message, tone });
      }
    } catch {
      setResult({ message: 'Sign-in failed unexpectedly. Nothing was saved.', tone: 'danger' });
    } finally {
      clearTimers();
      setPending(false);
    }
  }

  async function handleTurnOnPolling() {
    setToggleError('');
    try {
      const response = await fetch('/classifieds-session/toggle', {
        method: 'POST',
        body: new URLSearchParams({ _csrf: csrfToken, enabled: 'on' }),
        credentials: 'same-origin',
      });
      if (response.ok) {
        router.refresh();
      } else {
        setToggleError('Could not turn on classifieds polling.');
      }
    } catch {
      setToggleError('Could not turn on classifieds polling.');
    }
  }

  return (
    <div className="card form-card settings-card login-wizard">
      <h2 className="card-title">Sign in to OzBargain</h2>
      <p className="help">
        Your username and password are used once to sign in and are never stored. Only the session
        cookie is kept.
      </p>
      {disabled ? <p className="wizard-disabled" role="status">{disabledReason}</p> : null}
      <form ref={formRef} onSubmit={handleSubmit}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <div className="field">
          <label htmlFor="login-username">Username</label>
          <input
            id="login-username"
            type="text"
            name="username"
            autoComplete="off"
            maxLength={60}
            spellCheck={false}
            disabled={disabled || pending}
          />
          <span className="help">Your OzBargain username, not your email address.</span>
        </div>
        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            name="password"
            autoComplete="off"
            disabled={disabled || pending}
          />
        </div>
        <button className="btn btn-primary" type="submit" disabled={disabled || pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <div className="async-form-status" aria-live="polite">
        {pending ? (
          <ol className="async-form-pending">
            {PROGRESS_STEPS.map((label, i) => (
              <li key={label} aria-current={i === step ? 'step' : undefined}>
                {label}
              </li>
            ))}
          </ol>
        ) : null}
        {!pending && result ? (
          <span
            className={result.tone === 'success' ? 'async-form-success' : 'async-form-error'}
            role={result.tone === 'danger' ? 'alert' : 'status'}
          >
            {result.message}
          </span>
        ) : null}
      </div>
      {!pending && result?.tone === 'success' && !pollingEnabled ? (
        <p className="wizard-polling-off">
          Classifieds polling is off.{' '}
          <button className="btn" type="button" onClick={handleTurnOnPolling}>
            Turn on classifieds polling
          </button>
        </p>
      ) : null}
      {toggleError ? <p className="async-form-error" role="alert">{toggleError}</p> : null}
    </div>
  );
}
