/**
 * The icon route (design 8.3, Open Item O15). The repository is private, so
 * the logo cannot be served from `raw.githubusercontent.com`; the Unraid
 * template's `<Icon>` field points at this route. The middleware exempts it
 * **only when `OZB_ICON_ROUTE_PUBLIC` is set** — otherwise it is gated like
 * any other path.
 *
 * A state-reading route (no CSRF).
 */

const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">' +
  '<rect width="256" height="256" rx="48" fill="#1a1a2e"/>' +
  '<text x="128" y="168" font-family="sans-serif" font-size="120" ' +
  'fill="#4ecca3" text-anchor="middle">O</text></svg>';

/**
 * The icon handler.
 * @returns {Response}
 */
export function GET() {
  return new Response(ICON_SVG, {
    headers: { 'Content-Type': 'image/svg+xml' },
  });
}
