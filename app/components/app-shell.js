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

import AppNav from './app-nav.js';
import ThemeControl from './theme-control.js';

/**
 * The application shell.
 * @param {{
 *   children: React.ReactNode,
 *   health: { label: string, detail: string, tone: string },
 *   lastChecked: string,
 *   lastResponseClass: string,
 *   backoffSeconds: number,
 * }} props
 */
export default function AppShell({
  children,
  health,
  lastChecked,
  lastResponseClass,
  backoffSeconds,
}) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="app-header">
        <div className="brand-row">
          <div className="brand">
            <img src="/logo.svg" alt="" width="32" height="32" aria-hidden="true" />
            <span className="brand-name">OzBargainHunter</span>
          </div>
          <ThemeControl />
        </div>
        <div className="health-summary" data-health={health.tone}>
          <span className="health-label" aria-current="true">
            {health.label}
          </span>
          <span className="health-detail">
            Last checked: {lastChecked}
            {lastResponseClass !== '—' ? ` · ${lastResponseClass}` : ''}
            {backoffSeconds > 0 ? ` · backoff ${backoffSeconds}s` : ''}
          </span>
        </div>
      </header>
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
