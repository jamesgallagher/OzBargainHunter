/**
 * Screen 3 (edit) — Rule edit (design 7.1). Full CRUD over term text,
 * matching mode, cooldown and surfaces. Threshold rules are fixed to
 * deals-only and not editable.
 *
 * Server component.
 *
 * @param {{ params: { id: string } }} props
 */
export default async function EditRulePage({ params }) {
  const { getStore } = await import('../../../lib/web/db.js');
  const store = getStore();
  const id = Number((await params).id ?? params.id);
  const rule = store.getRule(id);
  if (!rule) {
    return <section><h2>Rule not found</h2></section>;
  }
  const isThreshold = rule.type === 'threshold';
  return (
    <section>
      <h2>Edit rule {rule.id}</h2>
      <form method="POST" action={`/rules/${rule.id}`}>
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
        <a href={`/rules/${rule.id}/mute`} onClick={(e) => e.preventDefault()}>
          <form method="POST" action={`/rules/${rule.id}/mute`} style={{ display: 'inline' }}>
            <button type="submit">Mute</button>
          </form>
        </a>
        <a href={`/rules/${rule.id}/delete`} onClick={(e) => e.preventDefault()}>
          <form method="POST" action={`/rules/${rule.id}/delete`} style={{ display: 'inline' }}>
            <button type="submit">Delete</button>
          </form>
        </a>
      </form>
    </section>
  );
}
