'use client';

/**
 * LocalTime (spec §4.4, §6.1). The server fallback is the ISO value; after
 * hydration it renders the user's locale while preserving the absolute ISO
 * instant in `dateTime` and the accessible title (AC-7).
 *
 * The ISO instant is always present in the markup (the server render), so the
 * component is safe to render on the server and in `renderToStaticMarkup` —
 * the locale formatting is a client enhancement that only runs after
 * hydration.
 *
 * @param {{ iso: string, label?: string }} props
 */
import { useEffect, useState } from 'react';

export default function LocalTime({ iso, label }) {
  const [formatted, setFormatted] = useState('');

  useEffect(() => {
    if (!iso) return;
    function format() {
      try {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) {
          setFormatted(iso);
          return;
        }
        setFormatted(
          new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'medium',
          }).format(d),
        );
      } catch {
        setFormatted(iso);
      }
    }
    format();
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
