'use client';

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation.js';

export default function ConfirmDialog({ title, body, action, csrf, destination = '/rules', triggerLabel = 'Delete' }) {
  const dialogRef = useRef(null);
  const triggerRef = useRef(null);
  const titleId = useId();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  function close() {
    dialogRef.current?.close();
    triggerRef.current?.focus();
  }

  async function submit(event) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError('');
    try {
      const response = await fetch(action, {
        method: 'POST',
        body: new URLSearchParams(new FormData(event.currentTarget)),
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error((text || `Request failed (${response.status})`).slice(0, 400));
      }
      dialogRef.current?.close();
      router.push(destination);
      router.refresh();
    } catch (caught) {
      setError(`Error: ${caught?.message ?? String(caught)}`.slice(0, 400));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="confirm-dialog-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-danger confirm-dialog-trigger"
        aria-haspopup="dialog"
        onClick={() => dialogRef.current?.showModal()}
      >
        {triggerLabel}
      </button>
      <dialog ref={dialogRef} className="confirm-dialog dialog" aria-labelledby={titleId} onCancel={close}>
        <h2 id={titleId}>{title}</h2>
        <p>{body}</p>
        <form className="rule-delete" method="POST" action={action} onSubmit={submit}>
          <input type="hidden" name="_csrf" value={csrf} />
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={close}>Cancel</button>
            <button type="submit" className="btn btn-danger" disabled={pending}>
              {pending ? 'Deleting…' : 'Delete rule'}
            </button>
          </div>
          {error ? <p className="async-form-error" role="alert">{error}</p> : null}
        </form>
      </dialog>
      <noscript>
        <form method="POST" action={action} className="rule-delete">
          <input type="hidden" name="_csrf" value={csrf} />
          <button type="submit" className="btn btn-danger">Delete rule</button>
        </form>
      </noscript>
    </div>
  );
}
