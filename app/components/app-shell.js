/**
 * AppShell (spec §4.4) — the server-side wrapper that composes the application
 * chrome around every page: the brand row, the health summary, the theme
 * control, the primary tab strip, the main landmark and the footer.
 *
 * Server component: it receives render-safe values (the health summary derived
 * from poll state, the last-checked instant, the page content). The reactive
 * parts — the theme control and the tab strip — are the small client islands
 * imported below. No store read or secret access happens here; the layout
 * reads the store and passes only presentation values in.
 */

/* The authenticated static asset must be requested directly rather than
 * through Next's image optimizer, which would create a second asset boundary. */
/* eslint-disable @next/next/no-img-element */

import Link from 'next/link.js';
import AppNav from './app-nav.js';
import ThemeControl from './theme-control.js';
import { formatMelbourne } from '../../lib/time.js';

/**
 * The gate banner (design 3.7, chunk 2). Fixed text with Melbourne times;
 * the plain meaning of a rule never carries a body, URL, cookie or header.
 */
const GATE_RULE_MEANING = {
  B1: 'Cloudflare block',
  B2: 'rate limited',
  B3: 'repeated rate limiting',
  B4: 'unexpected access denied',
  B5: 'repeated errors',
};

const GATE_EMAIL_PROBLEM_TEXT = {
  not_configured: 'Brevo is not configured',
  disabled: 'Brevo is disabled',
  failed: 'sending failed',
};

/**
 * The application shell.
 * @param {{
 *   children: React.ReactNode,
 *   health: { label: string, detail: string, tone: string },
 *   lastChecked: string,
 *   lastResponseClass: string,
 *   backoffSeconds: number,
 *   gate: { closed: boolean, state: string, rule: string|null, tier: number|null,
 *     since: string|null, untilAt: string|null, minResumeAt: string|null,
 *     resumeAllowed: boolean, emailProblem: string|null },
 * }} props
 */
export default function AppShell({
  children,
  health,
  lastChecked,
  lastResponseClass,
  backoffSeconds,
  gate,
}) {
  let gateBanner = null;
  if (gate && gate.closed) {
    const meaning = gate.rule ? GATE_RULE_MEANING[gate.rule] : '';
    const title = gate.state === 'stopped' ? 'OzBargain access is stopped' : 'OzBargain is being backed off';
    let detail;
    if (gate.state === 'probing') {
      detail = 'Resuming — one test request will be made at the next poll.';
    } else if (gate.state === 'stopped') {
      detail = `${meaning} at ${formatMelbourne(gate.since)}. ` + (
        gate.resumeAllowed
          ? 'Manual resume is available now.'
          : `Manual resume available from ${formatMelbourne(gate.minResumeAt)}.`
      );
    } else {
      detail = `No requests until ${formatMelbourne(gate.untilAt)} (${gate.rule}: ${meaning}, tier ${gate.tier}).`;
    }
    gateBanner = (
      <div className="gate-banner" role="alert" data-gate-state={gate.state}>
        <strong className="gate-banner-title">{title}</strong>
        <span className="gate-banner-detail">{detail}</span>
        {gate.emailProblem ? (
          <span className="gate-banner-email">
            Email alert not sent — {GATE_EMAIL_PROBLEM_TEXT[gate.emailProblem]}
          </span>
        ) : null}
        <Link className="gate-banner-link" href="/">View status</Link>
      </div>
    );
  }
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="app-header">
        <div className="brand-row">
          <div className="brand">
            <img src="/banner-raw.png" alt="" width="25" height="32" aria-hidden="true" />
            <span className="brand-name">OzBargainHunter</span>
          </div>
          <ThemeControl />
        </div>
        <div className="health-summary" data-health={health.tone}>
          <span className="health-label" aria-current="true">
            {health.label}
          </span>
          <span className="health-detail">
            Last checked: <time dateTime={lastChecked}>{formatMelbourne(lastChecked)}</time>
            {lastResponseClass !== '—' ? ` · ${lastResponseClass}` : ''}
            {backoffSeconds > 0 ? ` · backoff ${backoffSeconds}s` : ''}
          </span>
        </div>
      </header>
      {gateBanner}
      <AppNav />
      <main id="main-content" className="app-main">
        {children}
      </main>
      <footer className="app-footer">
        <span>OzBargainHunter — personal deal and classifieds watcher</span>
      </footer>
    </div>
  );
}
