/**
 * Pure response classification (design 3.5).
 * classifyResponse returns exactly one of:
 *   ok, not_modified, cloudflare_block, permission_denied,
 *   not_found, rate_limited, transient
 *
 * Parse failure is NOT classified here. A body that will not parse is
 * still an `ok` response at the HTTP layer; card 2 marks it unparseable
 * after parsing.
 */

const CLOUDFLARE_MARKERS = ['error code: 1010', 'just a moment...'];

function isCloudflareBlock(status, headers, body) {
  if (status !== 403) return false;
  const server = (headers['server'] ?? '').toLowerCase();
  const lowerBody = body.toLowerCase();
  const hasMarker = CLOUDFLARE_MARKERS.some((m) => lowerBody.includes(m));
  // A Cloudflare block is a 403 with a tiny body (~17 bytes) and a
  // `server: cloudflare` header, or a body containing a known marker.
  // An application permission denial is a 403 with ~1 KB of styled HTML.
  // The two differ by two orders of magnitude in body size.
  return server === 'cloudflare' || hasMarker;
}

/**
 * @param {{ status: number, headers: Record<string, string>, body: string }} response
 * @returns {{ class: string, retryAfterSeconds?: number }}
 */
export function classifyResponse(response) {
  const { status, headers, body } = response;

  if (status === 200) {
    return { class: 'ok' };
  }

  if (status === 304) {
    return { class: 'not_modified' };
  }

  if (status === 403) {
    if (isCloudflareBlock(status, headers, body)) {
      return { class: 'cloudflare_block' };
    }
    return { class: 'permission_denied' };
  }

  if (status === 404) {
    return { class: 'not_found' };
  }

  if (status === 429 || status === 503) {
    const retryAfter = headers['retry-after'];
    let retryAfterSeconds;
    if (retryAfter !== undefined) {
      const n = Number.parseInt(retryAfter, 10);
      if (!Number.isNaN(n)) {
        retryAfterSeconds = n;
      }
    }
    return { class: 'rate_limited', retryAfterSeconds };
  }

  // 5xx and other non-2xx/3xx statuses are transient.
  return { class: 'transient' };
}
