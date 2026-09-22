/**
 * Normalize the two application-generated secrets — `OZB_HEALTHCHECK_SECRET`
 * and `OZB_CSRF_SECRET`. Both are Sponsor-generated random strings, and
 * surrounding whitespace has no valid semantic meaning (D7). This is the single
 * pure helper every application boundary uses before a comparison, signing, or
 * verification use of one of those two variables.
 *
 * It is used **only** for the two application-generated secrets. The
 * provider-owned opaque credentials (`OZB_ACCOUNT_COOKIE`, `EMAIL_SMTP_PASS`,
 * `MATRIX_ACCESS_TOKEN`, `NTfy_TOKEN`) and any presented header or generated
 * CSRF token are read byte-exact and are never passed through here.
 *
 * An empty or whitespace-only value normalizes to empty and continues to fail
 * closed at the consuming boundary.
 *
 * @param {string|undefined|null} value the raw configured secret
 * @returns {string} the trimmed secret (empty when unset or whitespace-only)
 */
export function normalizeAppSecret(value) {
  return String(value ?? '').trim();
}
