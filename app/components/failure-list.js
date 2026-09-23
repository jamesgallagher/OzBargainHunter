'use client';

/**
 * FailureList (spec §6.1, screen 1). Renders the recent-failures list
 * newest-first, defaulting to the ten most recent rows. "Show more" reveals
 * the next ten per click until every row is shown; "Clear failures" posts to
 * `/failures/clear` (a state-changing route gated on access + CSRF) and, on
 * success, refreshes the router so the server re-reads the now-empty store.
 *
 * Client component: it owns the "show more" reveal count. It is self-contained
 * (plain semantic HTML whose classes live in app/globals.css) so it can render
 * inside a server page; it imports only client components (LocalTime,
 * AsyncForm).
 *
 * @param {{
 *   failures: Array<{ id: number, failed_at: string, response_class: string, body: string }>,
 *   csrf: string
 * }} props
 */
import { useState } from 'react';
import AsyncForm from './async-form.js';
import LocalTime from './local-time.js';

const PAGE_SIZE = 10;

export default function FailureList({ failures, csrf }) {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  if (failures.length === 0) {
    return (
      <div className="empty-state">
        <p className="empty-title">No recent failures.</p>
        <p className="empty-body">Acquisition is not currently reporting errors.</p>
      </div>
    );
  }

  const visible = failures.slice(0, visibleCount);
  const hasMore = visibleCount < failures.length;

  return (
    <div>
      <ul className="failure-list">
        {visible.map((f) => (
          <li key={f.id} className="failure-row">
            <span className="failure-class">{f.response_class}</span>
            {f.failed_at ? (
              <span className="failure-time">
                <LocalTime iso={f.failed_at} />
              </span>
            ) : null}
            {f.body ? (
              <span className="failure-body">{String(f.body).slice(0, 200)}</span>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="failure-controls">
        {hasMore ? (
          <button
            type="button"
            className="btn"
            onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
          >
            Show more
          </button>
        ) : null}
        <AsyncForm
          action="/failures/clear"
          formClassName="inline-form"
          successMessage="Failures cleared."
        >
          <input type="hidden" name="_csrf" value={csrf} />
          <input type="hidden" name="confirm" value="delete" />
          <button type="submit" className="btn btn-danger">
            Clear failures
          </button>
        </AsyncForm>
      </div>
    </div>
  );
}
