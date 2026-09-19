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

// Body evidence that design 3.5 names for a Cloudflare block: the ~17-byte
// "error code: 1010" text, "Just a moment...", or challenge-page markup.
// A Cloudflare block is identified from the BODY, never from the `server:`
// header — OzBargain sits behind Cloudflare on every response, so
// `server: cloudflare` is present on the application permission-denial 403
// (cls403.html) too. The two 403s share that header; only the body differs
// (17 bytes of CF text vs ~1 KB of OzBargain's own styled HTML).
const CLOUDFLARE_BODY_MARKERS = [
  'error code: 1010',
  'just a moment...',
  'cf-chl',
  'challenge-platform',
  'cf-browser-verification',
];

function isCloudflareBlock(status, body) {
  if (status !== 403) return false;
  const lowerBody = String(body ?? '').toLowerCase();
  return CLOUDFLARE_BODY_MARKERS.some((m) => lowerBody.includes(m));
}

/**
 * @param {{ status: number, headers?: Record<string, string>, body?: string }} response
 * @returns {{ class: string, retryAfterSeconds?: number }}
 */
export function classifyResponse(response) {
  const { status } = response;
  const headers = response.headers ?? {};
  const body = response.body ?? '';

  if (status === 200) {
    return { class: 'ok' };
  }

  if (status === 304) {
    return { class: 'not_modified' };
  }

  if (status === 403) {
    return { class: isCloudflareBlock(status, body) ? 'cloudflare_block' : 'permission_denied' };
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
