/**
 * Screen 3 (create) — Rule create (design 7.1). Full CRUD over term text,
 * matching mode, cooldown and surfaces.
 *
 * Server component (the form posts to `/rules/new`).
 */

/**
 * The rule-create page.
 * @returns {React.ReactElement}
 */
export default function NewRulePage() {
  return (
    <section>
      <h2>New rule</h2>
      <form method="POST" action="/rules/new">
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
