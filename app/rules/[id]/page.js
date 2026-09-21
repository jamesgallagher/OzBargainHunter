/**
 * Screen 3 (edit) — Rule edit (design 7.1). Full CRUD over term text,
 * matching mode, cooldown and surfaces. Threshold rules are fixed to
 * deals-only and not editable.
 *
 * X9: the Mute and Delete controls are **siblings** of the edit form, not
 * nested inside it. A nested `<form>` start tag is dropped by HTML parsers,
 * so a Mute button inside the edit form would have submitted the edit (a
 * save) instead of posting to `/rules/<id>/mute`. The `<a onClick>` wrappers
 * were dead in a server component (no event handlers); they are removed.
 *
 * X1: the edit form posts to `/rules/<id>/save` (its own segment, so it does
 * not collide with this page in the build).
 *
 * Server component.
 *
 * @param {{ params: { id: string } }} props
 */
export default async function EditRulePage({ params }) {
  const { getStore } = await import('../../../lib/web/db.js');
  const { generateCsrfToken } = await import('../../../lib/csrf.js');
  const store = getStore();
  const id = Number((await params).id ?? params.id);
  const rule = store.getRule(id);
  if (!rule) {
    return <section><h2>Rule not found</h2></section>;
  }
  const isThreshold = rule.type === 'threshold';

  // Mint an unbound CSRF token (production relies on the token TTL, m3) for
  // the three forms (save, mute, delete).
  const secret = process.env.OZB_CSRF_SECRET ?? '';
  const token = secret ? await generateCsrfToken(secret) : '';

  return (
    <section>
      <h2>Edit rule {rule.id}</h2>
      <form method="POST" action={`/rules/${rule.id}/save`} className="rule-edit">
        <input type="hidden" name="_csrf" value={token} />
        <label>
          Term
          <input type="text" name="term" defaultValue={rule.parameters?.term ?? ''} disabled={isThreshold} />
        </label>
        <label>
          Threshold
          <input
            type="number"
            name="threshold"
            defaultValue={rule.parameters?.threshold ?? ''}
            disabled={!isThreshold}
          />
        </label>
        <label>
          Cooldown (seconds)
          <input type="number" name="cooldown_seconds" defaultValue={rule.cooldown_seconds} />
        </label>
        <label>
          Surfaces
          <select name="surfaces" defaultValue={rule.surfaces} disabled={isThreshold}>
            <option value="deals">deals</option>
            <option value="classifieds">classifieds</option>
            <option value="both">both</option>
          </select>
        </label>
        <p className="hint">{isThreshold ? 'Threshold rules are fixed to deals-only.' : ''}</p>
        <button type="submit">Save</button>
      </form>
      <form method="POST" action={`/rules/${rule.id}/mute`} className="rule-mute">
        <input type="hidden" name="_csrf" value={token} />
        <input type="hidden" name="action" value="mute" />
        <input type="hidden" name="confirm" value="1" />
        <button type="submit">Mute</button>
      </form>
      <form method="POST" action={`/rules/${rule.id}/delete`} className="rule-delete">
        <input type="hidden" name="_csrf" value={token} />
        <button type="submit">Delete</button>
      </form>
    </section>
  );
}
