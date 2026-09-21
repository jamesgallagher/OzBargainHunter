/**
 * Screen 3 (create) — Rule create (design 7.1). Full CRUD over term text,
 * matching mode, cooldown and surfaces.
 *
 * X1: the form posts to `/rules/new/create` (its own segment, so the create
 * handler does not collide with this page in the build).
 *
 * Server component.
 */

import { generateCsrfToken } from '../../../lib/csrf.js';

/**
 * The rule-create page.
 * @returns {Promise<React.ReactElement>}
 */
export default async function NewRulePage() {
  // Mint an unbound CSRF token (production relies on the token TTL, m3).
  const secret = process.env.OZB_CSRF_SECRET ?? '';
  const token = secret ? await generateCsrfToken(secret) : '';

  return (
    <section>
      <h2>New rule</h2>
      <form method="POST" action="/rules/new/create">
        <input type="hidden" name="_csrf" value={token} />
        <label>
          Type
          <select name="type" defaultValue="match">
            <option value="match">match</option>
            <option value="threshold">threshold</option>
          </select>
        </label>
        <label>
          Term
          <input type="text" name="term" />
        </label>
        <label>
          Threshold
          <input type="number" name="threshold" min="1" />
        </label>
        <label>
          Cooldown (seconds)
          <input type="number" name="cooldown_seconds" defaultValue="0" />
        </label>
        <label>
          Surfaces
          <select name="surfaces" defaultValue="deals">
            <option value="deals">deals</option>
            <option value="classifieds">classifieds</option>
            <option value="both">both</option>
          </select>
        </label>
        <button type="submit">Create</button>
      </form>
    </section>
  );
}
