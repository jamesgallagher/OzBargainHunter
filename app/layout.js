/**
 * The shared app layout (spec §7.1, §7.2, §7.4). A server component that:
 *
 * - imports the global stylesheet exactly once (D1);
 * - exports the root metadata (title template, description, application name,
 *   theme color through media descriptors, and a responsive viewport that does
 *   not disable user zoom);
 * - reads the live store state (last successful poll, response class, backoff)
 *   and derives the health summary — presentation only, no new persisted state;
 * - renders the pre-paint theme bootstrap script in <head> so the first paint
 *   is already the correct theme (AC-4); and
 * - composes the AppShell around the page content.
 *
 * `dynamic = 'force-dynamic'` is retained (spec §13): every screen is
 * server-rendered per request so `_csrf` is minted per request and the screens
 * reflect store state at request time.
 */

import { getStore } from '../lib/web/db.js';
import { systemClock } from '../lib/clock.js';
import { viewGate } from '../lib/gate/view.js';
import { VERSION } from '../lib/config.js';
import AppShell from './components/app-shell.js';
import { healthWithGate } from './components/ui.js';
import './globals.css';

export const dynamic = 'force-dynamic';

/**
 * Root metadata (spec §7.4).
 * @type {import('next').Metadata}
 */
export const metadata = {
  applicationName: 'OzBargainHunter',
  title: {
    default: 'Status · OzBargainHunter',
    template: '%s · OzBargainHunter',
  },
  description: 'Personal OzBargain deal and classifieds watcher',
  icons: {
    // The `?v=` query string cache-busts the icon: a new package version
    // changes the URL so browsers re-fetch the icon. The icon route stays
    // authenticated (not public) — the query string does not change that.
    icon: `/favicon.ico?v=${VERSION}`,
  },
  viewport: {
    width: 'device-width',
    initialScale: 1,
  },
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f4ed' },
    { media: '(prefers-color-scheme: dark)', color: '#12100d' },
  ],
};

/**
 * The pre-paint theme bootstrap. Runs before React hydrates so the resolved
 * theme is applied to the document root before the first paint. Storage access
 * is guarded with try/catch (private mode). It mirrors the resolution the
 * ThemeControl performs after hydration.
 */
const themeBootstrap = `
(function () {
  try {
    var key = 'ozb-theme';
    var pref = 'system';
    try {
      var v = localStorage.getItem(key);
      if (v === 'light' || v === 'dark' || v === 'system') pref = v;
    } catch (e) {}
    var theme = pref;
    if (pref === 'system') {
      theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    var root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.themePreference = pref;
    root.style.colorScheme = theme;
  } catch (e) {
    // Never block paint on a theme failure; the CSS default (light) applies.
  }
})();
`;

/**
 * The layout.
 * @param {{ children: React.ReactNode }} props
 * @returns {React.ReactElement}
 */
export default function Layout({ children }) {
  const store = getStore();
  const pollState = store.getPollState() ?? {};
  const lastChecked = pollState.last_success_at ?? 'never';
  const lastResponseClass = pollState.last_response_class ?? '—';
  const backoffSeconds = pollState.backoff_seconds ?? 0;
  // The access gate (design 3.7, chunk 2): read-only. `viewGate` never
  // writes — the lazy `cooling→probing` transition stays in the worker, so
  // a render with a stale cooling row must not touch the gate row or the
  // event table.
  const gate = viewGate(store.getGate(), store.getGateEvents({ limit: 50 }), systemClock().now());
  const health = healthWithGate(pollState, gate);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        <AppShell
          health={health}
          lastChecked={lastChecked}
          lastResponseClass={lastResponseClass}
          backoffSeconds={backoffSeconds}
          gate={gate}
        >
          {children}
        </AppShell>
      </body>
    </html>
  );
}
