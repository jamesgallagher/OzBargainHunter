'use client';

/**
 * The primary tab strip (spec §3.1, §7.1). A page-navigation tab strip —
 * `<nav aria-label="Primary">` with Next `<Link>` — not an ARIA tablist
 * (spec §3.1). Active state is derived from `usePathname()` only, so deep
 * links and Back/Forward cannot desynchronise the shell (spec §3.4).
 *
 * Clicking a tab is a Next App Router transition: it preserves browser
 * history and does not create a second document navigation (spec §3.4, AC-2).
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The four persistent primary tabs (spec §3.1).
 * @type {{ label: string, href: string, activeFor: string[] }[]}
 */
const PRIMARY_TABS = [
  { label: 'Status', href: '/', activeFor: ['/'] },
  {
    label: 'Rules',
    href: '/rules',
    activeFor: ['/rules', '/rules/new', '/rules/'],
  },
  {
    label: 'Activity',
    href: '/alerts',
    activeFor: ['/alerts', '/suppressions'],
  },
  {
    label: 'Settings',
    href: '/thresholds',
    activeFor: ['/thresholds', '/delivery', '/classifieds-session'],
  },
];

/**
 * Is a tab active for the given pathname? `/rules/123` is active for the
 * Rules tab via its `/rules/` prefix; `/` is exact.
 * @param {string} href
 * @param {string[]} activeFor
 * @param {string} pathname
 * @returns {boolean}
 */
function isActive(href, activeFor, pathname) {
  if (pathname === href) return true;
  for (const prefix of activeFor) {
    if (prefix !== href && pathname.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * The primary tab strip.
 */
export default function AppNav() {
  const pathname = usePathname() ?? '/';
  return (
    <nav className="primary-tabs" aria-label="Primary">
      {PRIMARY_TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className="tab"
          aria-current={isActive(tab.href, tab.activeFor, pathname) ? 'page' : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
