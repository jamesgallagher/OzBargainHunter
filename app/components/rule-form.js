'use client';

/**
 * RuleForm (spec §6.3, §7.1). One shared client component for rule create and
 * edit, fed by server data and a server-minted CSRF token.
 *
 * - The rule type control is a labelled two-option segmented control; changing
 *   it reactively reveals only Term (match) or Threshold (threshold).
 * - Threshold fixes Surfaces to deals and shows the explanation next to the
 *   read-only value; match exposes the surfaces select.
 * - Fields have persistent labels, short help text and inline error regions.
 * - Browser validation pins threshold >= 1 and cooldown >= 0; the server
 *   remains authoritative.
 * - Submit sends `fetch(FormData)` to the existing action. While pending it
 *   disables only this form's submit, preserves entered values, and shows
 *   "Creating…"/"Saving…". On 2xx create it navigates to `/rules/<id>`; on
 *   2xx save it refreshes the route and announces "Rule saved"; on non-2xx it
 *   keeps the page and displays the response text in an error notice. It never
 *   navigates to raw JSON.
 * - Without JavaScript the form still POSTs to the same action (native submit).
 *
 * @param {{
 *   mode: 'create'|'edit',
 *   action: string,
 *   csrf: string,
 *   initial?: { type?: string, term?: string, threshold?: number, cooldownSeconds?: number, surfaces?: string },
 *   className?: string,
 * }} props
 */
import { useRouter } from 'next/navigation.js';
import { useId, useState } from 'react';

const SURFACES = [
  { value: 'deals', label: 'Deals' },
  { value: 'classifieds', label: 'Classifieds' },
  { value: 'both', label: 'Both' },
];

export default function RuleForm({ mode, action, csrf, initial, className = '' }) {
  const router = useRouter();
  const [type, setType] = useState(initial?.type === 'threshold' ? 'threshold' : 'match');
  const [term, setTerm] = useState(initial?.term ?? '');
  const [threshold, setThreshold] = useState(
    initial?.threshold != null ? String(initial.threshold) : '',
  );
  const [surfaces, setSurfaces] = useState(initial?.surfaces ?? 'deals');
  const [cooldown, setCooldown] = useState(
    initial?.cooldownSeconds != null ? String(initial.cooldownSeconds) : '0',
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const errorId = useId();

  async function handleSubmit(event) {
    event.preventDefault();
    if (pending) return;
    setError('');
    setSaved(false);

    const form = event.currentTarget;
    const formData = new FormData(form);
    setPending(true);

    try {
      const response = await fetch(action, {
        method: 'POST',
        body: new URLSearchParams(formData),
        credentials: 'same-origin',
      });

      if (response.ok) {
        let data = {};
        try {
          data = await response.json();
        } catch {
          // Non-JSON 2xx; fall through to refresh.
        }
        if (mode === 'create') {
          const id = data.id != null ? data.id : null;
          if (id != null) {
            router.push(`/rules/${id}`);
          } else {
            router.refresh();
          }
        } else {
          setSaved(true);
          router.refresh();
        }
      } else {
        const text = await response.text().catch(() => '');
        setError(`Error: ${(text || `Request failed (${response.status})`).slice(0, 400)}`);
      }
    } catch (err) {
      setError(`Error: ${err?.message ?? String(err)}`.slice(0, 400));
    } finally {
      setPending(false);
    }
  }

  const isThreshold = type === 'threshold';
  const pendingLabel = mode === 'create' ? 'Creating…' : 'Saving…';

  return (
    <form className={`rule-form ${className}`.trim()} method="POST" action={action} onSubmit={handleSubmit}>
      <input type="hidden" name="_csrf" value={csrf} />

      <div className="field">
        <span className="field-label" id="type-label">
          Rule type
        </span>
        <div className="segmented" role="group" aria-labelledby="type-label">
          <label className="segmented-option">
            <input
              type="radio"
              name="type"
              value="match"
              checked={!isThreshold}
              onChange={() => setType('match')}
            />
            <span>Match a term</span>
          </label>
          <label className="segmented-option">
            <input
              type="radio"
              name="type"
              value="threshold"
              checked={isThreshold}
              onChange={() => setType('threshold')}
            />
            <span>Upvote threshold</span>
          </label>
        </div>
        <p className="field-help">
          {isThreshold
            ? 'Alert when a deal reaches or exceeds an upvote threshold.'
            : 'Alert when a deal title or body matches a term.'}
        </p>
      </div>

      {isThreshold ? (
        <div className="field">
          <label className="field-label" htmlFor="threshold">
            Threshold (minimum upvotes)
          </label>
          <input
            id="threshold"
            type="number"
            name="threshold"
            min="1"
            required
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            className="field-input"
          />
          <p className="field-help">Must be at least 1.</p>
        </div>
      ) : (
        <div className="field">
          <label className="field-label" htmlFor="term">
            Term
          </label>
          <input
            id="term"
            type="text"
            name="term"
            required
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            className="field-input"
            autoComplete="off"
          />
          <p className="field-help">A word or phrase to watch for.</p>
        </div>
      )}

      <div className="field">
        <label className="field-label" htmlFor="cooldown">
          Cooldown (seconds)
        </label>
        <input
          id="cooldown"
          type="number"
          name="cooldown_seconds"
          min="0"
          required
          value={cooldown}
          onChange={(e) => setCooldown(e.target.value)}
          className="field-input"
        />
        <p className="field-help">Minimum seconds between alerts for this rule. 0 allows every match.</p>
      </div>

      <div className="field">
        {isThreshold ? (
          <>
            <span className="field-label">Surfaces</span>
            <input
              type="text"
              name="surfaces"
              value="deals"
              readOnly
              className="field-input"
              aria-readonly="true"
            />
            <p className="field-help">Threshold rules are fixed to deals.</p>
          </>
        ) : (
          <>
            <label className="field-label" htmlFor="surfaces">
              Surfaces
            </label>
            <select
              id="surfaces"
              name="surfaces"
              value={surfaces}
              onChange={(e) => setSurfaces(e.target.value)}
              className="field-input"
            >
              {SURFACES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <p className="field-help">Where the rule applies.</p>
          </>
        )}
      </div>

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? pendingLabel : mode === 'create' ? 'Create' : 'Save'}
        </button>
      </div>

      <div className="async-form-status" aria-live="polite">
        {pending ? <span className="async-form-pending">{pendingLabel}</span> : null}
        {saved ? (
          <span className="async-form-success" role="status">
            Rule saved
          </span>
        ) : null}
        {error ? (
          <span className="async-form-error" role="alert" id={errorId}>
            {error}
          </span>
        ) : null}
      </div>
    </form>
  );
}
