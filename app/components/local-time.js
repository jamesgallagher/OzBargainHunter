'use client';

/**
 * LocalTime (spec §4.4, §6.1). Renders the instant in Melbourne time
 * (Australia/Melbourne) on both the server and after hydration, preserving the
 * absolute ISO instant in `dateTime` and the accessible title (AC-7).
 *
 * `formatMelbourne` runs identically on the server (Node, full ICU) and in the
 * browser, so the server render already shows Melbourne time — there is no
 * raw-ISO fallback and no post-hydration flash. The component is therefore safe
 * to render on the server and in `renderToStaticMarkup`.
 *
 * @param {{ iso: string, label?: string }} props
 */
import { useEffect, useState } from 'react';
import { formatMelbourne } from '../../lib/time.js';

export default function LocalTime({ iso, label }) {
  const [formatted, setFormatted] = useState(() => formatMelbourne(iso));

  useEffect(() => {
    setFormatted(formatMelbourne(iso));
  }, [iso]);

  const display = formatted || iso;
  return (
    <span className="local-time">
      <time className="local-time-value" dateTime={iso} title={iso}>
        {display}
      </time>
      {label ? <span className="local-time-iso">{label}</span> : null}
    </span>
  );
}
