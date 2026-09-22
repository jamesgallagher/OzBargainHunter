/**
 * The icon route (design 8.3, Open Item O15). The repository is private, so
 * the logo cannot be served from `raw.githubusercontent.com`; the Unraid
 * template's `<Icon>` field points at this route. The middleware exempts it
 * **only when `OZB_ICON_ROUTE_PUBLIC` is set** — otherwise it is gated like
 * any other path.
 *
 * A state-reading route (no CSRF).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The icon handler.
 * @returns {Response}
 */
export function GET() {
  const icon = readFileSync(join(process.cwd(), 'public', 'logo.svg'), 'utf8');
  return new Response(icon, {
    headers: { 'Content-Type': 'image/svg+xml' },
  });
}
