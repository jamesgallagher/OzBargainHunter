'use client';

import { useState } from 'react';

export default function SecretField({ id, name, placeholder }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="reveal-row">
      <input
        id={id}
        type={visible ? 'text' : 'password'}
        name={name}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck="false"
      />
      <button
        type="button"
        className="btn"
        aria-label={visible ? 'Hide session cookie' : 'Show session cookie'}
        aria-pressed={visible}
        onClick={() => setVisible((value) => !value)}
      >
        {visible ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
