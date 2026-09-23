'use client';

import { useState } from 'react';

/**
 * A read-only, masked value with a Show/Hide toggle. Used by the provider
 * "view" mode to display a sensitive field (e.g. the Brevo API key): it is
 * shown as a mask by default and revealed only when the user toggles it.
 *
 * @param {{ value: string, label: string }} props
 */
export default function RevealableValue({ value, label }) {
  const [visible, setVisible] = useState(false);
  const text = value ? (visible ? value : '••••••••••••') : '(not set)';
  return (
    <div className="reveal-row">
      <span className="mono">{text}</span>
      {value ? (
        <button
          type="button"
          className="btn"
          aria-label={visible ? `Hide ${label}` : `Show ${label}`}
          aria-pressed={visible}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      ) : null}
    </div>
  );
}
