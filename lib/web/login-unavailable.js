/**
 * The 4.5 "unavailable" reason texts, shared by the page (server-side, to
 * compute the wizard's disabled reason) and the wizard (client-side, to map
 * the POST response's `data.reason`).
 *
 * Only the origin reasons are mapped here — the gate and B6-lock reasons are
 * computed by the page (they need the gate view and the lock view, which the
 * wizard does not have). When the login POST returns `unavailable` with an
 * origin `reason`, the wizard maps it to the same text the page would have
 * shown, so the wording is identical whether the reason is known at render
 * time or only at submit time.
 */

/**
 * The 4.5 text for an origin `reason`.
 * @param {string} reason the `data.reason` from the login response (or the
 *   page's origin `reason`)
 * @returns {string} the 4.5 text, or `''` when the reason is not an origin reason
 */
export function unavailableReasonText(reason) {
  switch (reason) {
    case 'origin_not_allowed':
      return 'Sign-in is unavailable: the classifieds URL is not an allowed OzBargain address.';
    case 'dev_mode_live_origin':
      return 'Sign-in is unavailable in dev mode while the classifieds URL points at the live site. Run the fixture server with --login.';
    default:
      return '';
  }
}
