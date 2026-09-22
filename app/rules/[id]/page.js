import RuleForm from '../../components/rule-form.js';
import AsyncForm from '../../components/async-form.js';
import ConfirmDialog from '../../components/confirm-dialog.js';
import { EmptyState, Notice, PageHeader, ruleLabel } from '../../components/ui.js';
import Link from 'next/link.js';

export const metadata = { title: 'Edit rule' };

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
export default async function EditRulePage({ params, searchParams }) {
  const { getStore } = await import('../../../lib/web/db.js');
  const { generateCsrfToken } = await import('../../../lib/csrf.js');
  const store = getStore();
  const id = Number((await params).id ?? params.id);
  const rule = store.getRule(id);
  if (!rule) {
    return (
      <section>
        <PageHeader title="Rule not found" description="This rule may have been deleted." />
        <EmptyState title="Rule not found" body="Return to the rules list to choose another rule." action={<Link className="btn" href="/rules">Back to Rules</Link>} />
      </section>
    );
  }

  // Mint an unbound CSRF token (production relies on the token TTL, m3) for
  // the three forms (save, mute, delete).
  const secret = process.env.OZB_CSRF_SECRET ?? '';
  const token = secret ? await generateCsrfToken(secret) : '';
  const query = await searchParams;
  const notice = query?.notice;
  const confirmDelete = query?.confirm === 'delete';
  const label = ruleLabel(rule);

  return (
    <section>
      <div className="breadcrumb"><Link href="/rules">Rules</Link><span className="sep">/</span><span>Edit {label}</span></div>
      <PageHeader title={`Edit rule ${rule.id}`} description={label} />
      {notice === 'muted' ? (
        <Notice tone="warning" title="Rule muted">
          <p>Alerts for this rule are off.</p>
          <div className="notice-actions">
            {[['enable', 'Undo'], ['snooze24', 'Snooze 24 hours'], ['snooze7', 'Snooze 7 days']].map(([action, text]) => (
              <AsyncForm key={action} action={`/rules/${rule.id}/mute`} formClassName="inline-form" successMessage="Rule updated.">
                <input type="hidden" name="_csrf" value={token} /><input type="hidden" name="action" value={action} />
                <button className="btn" type="submit">{text}</button>
              </AsyncForm>
            ))}
          </div>
        </Notice>
      ) : null}
      {confirmDelete ? (
        <Notice tone="warning">
          <h2 className="notice-title">Confirm deletion of {label}</h2>
          <p>This permanently deletes the rule and cannot be undone.</p>
          <form method="POST" action={`/rules/${rule.id}/delete`} className="rule-delete-confirmation">
            <input type="hidden" name="_csrf" value={token} />
            <input type="hidden" name="confirm" value="delete" />
            <div className="notice-actions">
              <Link className="btn" href={`/rules/${rule.id}`}>Cancel</Link>
              <button className="btn btn-danger" type="submit">Confirm delete</button>
            </div>
          </form>
        </Notice>
      ) : null}
      <div className="card form-card">
        <RuleForm mode="edit" action={`/rules/${rule.id}/save`} csrf={token} className="rule-edit" initial={{ type: rule.type, term: rule.parameters?.term, threshold: rule.parameters?.threshold, cooldownSeconds: rule.cooldown_seconds, surfaces: rule.surfaces }} />
      </div>
      <div className="rule-actions">
        <AsyncForm action={`/rules/${rule.id}/mute`} formClassName="rule-mute" successMessage="Rule muted.">
          <input type="hidden" name="_csrf" value={token} /><input type="hidden" name="action" value="mute" /><input type="hidden" name="confirm" value="1" />
          <button className="btn" type="submit">Mute</button>
        </AsyncForm>
        <ConfirmDialog title={`Delete ${label}?`} body="This permanently deletes the rule and cannot be undone." action={`/rules/${rule.id}/delete`} confirmationAction={`/rules/${rule.id}`} csrf={token} />
      </div>
    </section>
  );
}
