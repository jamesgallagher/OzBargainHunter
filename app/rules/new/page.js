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
import RuleForm from '../../components/rule-form.js';
import { PageHeader } from '../../components/ui.js';

export const metadata = { title: 'New rule' };

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
      <div className="breadcrumb"><a href="/rules">Rules</a><span className="sep">/</span><span>New rule</span></div>
      <PageHeader title="New rule" description="Create a term match or upvote threshold alert." />
      <div className="card form-card"><RuleForm mode="create" action="/rules/new/create" csrf={token} /></div>
    </section>
  );
}
