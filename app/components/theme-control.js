'use client';

/**
 * Theme control (spec §7.2). Three logical states: `system` (default when no
 * choice is stored), `light`, `dark`. The control cycles through them and its
 * accessible name includes the current choice (AC-4).
 *
 * - Persists only the preference string under `localStorage['ozb-theme']`.
 * - Resolves `system` with `matchMedia('(prefers-color-scheme: dark)')` and
 *   subscribes to changes while in system mode.
 * - Sets `document.documentElement.dataset.theme` to the resolved light/dark
 *   and `data-theme-preference` to the logical preference.
 *
 * The same resolution is performed before paint by the inline bootstrap
 * script in the layout, so the first paint is already correct and choosing a
 * theme never flashes back (AC-4). No theme or identity data is sent over the
 * network.
 */
import { useEffect, useState } from 'react';

const STORAGE_KEY = 'ozb-theme';
const ORDER = ['system', 'light', 'dark'];

/**
 * Read the stored preference, defaulting to `system`.
 * @returns {'system'|'light'|'dark'}
 */
function readPreference() {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // Storage may be unavailable (private mode); fall through to system.
  }
  return 'system';
}

/**
 * Resolve a preference to a concrete theme.
 * @param {'system'|'light'|'dark'} preference
 * @returns {'light'|'dark'}
 */
function resolve(preference) {
  if (preference === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return preference;
}

/**
 * Apply a resolved theme to the document root.
 * @param {'light'|'dark'} theme
 * @param {'system'|'light'|'dark'} preference
 */
function apply(theme, preference) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
}

/**
 * The theme control.
 */
export default function ThemeControl() {
  const [preference, setPreference] = useState('system');

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    let current = readPreference();
    setPreference(current);
    apply(resolve(current), current);

    const onSystemChange = () => {
      // Only re-resolve while in system mode (spec §7.2).
      if (readPreference() === 'system') {
        apply(resolve('system'), 'system');
      }
    };
    mq.addEventListener('change', onSystemChange);
    return () => mq.removeEventListener('change', onSystemChange);
  }, []);

  function cycle() {
    const next = ORDER[(ORDER.indexOf(preference) + 1) % ORDER.length];
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore storage failures; the in-memory state still applies.
    }
    setPreference(next);
    apply(resolve(next), next);
  }

  return (
    <button
      type="button"
      className="theme-control"
      onClick={cycle}
      aria-label={`Theme: ${preference}. Activate to switch.`}
      title={`Theme: ${preference}`}
    >
      <span className="theme-control-label" aria-hidden="true">
        {preference === 'system' ? '⚙︎ System' : preference === 'light' ? '☀︎ Light' : '☾ Dark'}
      </span>
    </button>
  );
}
