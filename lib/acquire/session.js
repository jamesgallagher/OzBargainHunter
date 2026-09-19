/**
 * Classifieds session state (design 3.6).
 *
 * The authoritative session check is the `uid` embedded in the page's
 * `OzB_vars` object, not the status code: `uid == 0` means anonymous, any
 * non-zero value means authenticated. Three states are distinguished and
 * handled differently by the caller:
 *
 *   valid           — uid != 0 and /classified returned 200. Proceed.
 *   expired         — uid == 0, or the application permission-denial page.
 *                     Stop polling classifieds, latch off, raise a visible
 *                     alert. Clearing the latch is a deliberate UI act
 *                     (card 4), never automatic. Never retry in a loop.
 *   cloudflare_block— the Cloudflare block class. Stop all OzBargain
 *                     requests, long backoff, loud alert.
 *
 * There is no login flow (open item O21): v1 takes the session cookie from
 * settings. This module only classifies; it never logs in.
 */

/**
 * @param {{ class: string, uid: number, status?: number }} args
 * @returns {{ state: 'valid' | 'expired' | 'cloudflare_block' }}
 */
export function classifySession(args) {
  const { class: responseClass, uid } = args;

  // A Cloudflare block outranks everything: it stops all requests, not just
  // classifieds. It is identified from the response class (3.5), never the
  // status code.
  if (responseClass === 'cloudflare_block') {
    return { state: 'cloudflare_block' };
  }

  // The application permission-denial page is an invalid session regardless of
  // uid (on /classified it means the session is not entitled).
  if (responseClass === 'permission_denied') {
    return { state: 'expired' };
  }

  // The authoritative check: uid == 0 is anonymous (expired), non-zero is
  // authenticated (valid). This holds even on a 200 — a 200 with uid 0 is
  // expired, which is the trap the anon fixture exercises.
  if (uid === 0) {
    return { state: 'expired' };
  }

  return { state: 'valid' };
}
