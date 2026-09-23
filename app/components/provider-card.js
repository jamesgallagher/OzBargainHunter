'use client';

import { useState } from 'react';
import AsyncForm from './async-form.js';
import { Badge } from './ui.js';

/**
 * One delivery-mechanism card (delivery mechanisms). Renders a single
 * mechanism (one provider per type) and manages its add / edit / view / delete
 * lifecycle:
 *
 * - **Not added** → an "Add {label} delivery" button reveals the add form.
 * - **Added** → View (read-only; sensitive values stay server-side), Edit
 *   (pre-filled form), and Delete (confirm-gated POST to `/delivery/delete`).
 *
 * Add and Edit both POST to `/delivery/save`; the fields are driven by the
 * mechanism's `fields` definition. Sensitive fields render as empty password
 * inputs in edit mode; stored values are never passed to this client component.
 *
 * @param {{
 *   mechanism: { kind: string, label: string, addLabel: string, fields: object[] },
 *   existing: { config: object, sensitiveConfigured: object, selected: boolean, enabled: boolean, consecutive_failures: number } | null,
 *   token: string
 * }} props
 */
export default function ProviderCard({ mechanism, existing, token }) {
  const [mode, setMode] = useState('summary');
  const { kind, label, addLabel, fields } = mechanism;
  const isSaved = !!existing;

  function fieldInput(field, value) {
    const id = `${kind}-${field.name}`;
    const type = field.sensitive ? 'password' : field.type;
    return (
      <div className="field" key={field.name}>
        <label htmlFor={id}>
          {field.label}
          {field.required ? ' *' : ''}
        </label>
        <input
          id={id}
          name={field.name}
          type={type}
          defaultValue={value}
          placeholder={field.sensitive && isSaved && existing.sensitiveConfigured[field.name]
            ? 'Leave blank to keep the saved value'
            : field.placeholder}
          autoComplete="off"
        />
        {field.help ? <span className="help">{field.help}</span> : null}
      </div>
    );
  }

  return (
    <article className="card provider-card">
      <div className="provider-head">
        <h2>{label}</h2>
        {isSaved ? (
          <>
            <Badge tone={existing.selected ? 'success' : 'neutral'}>
              {existing.selected ? 'Selected' : 'Not selected'}
            </Badge>
            <Badge tone={existing.enabled ? 'success' : 'warning'}>
              {existing.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
            <Badge tone={existing.consecutive_failures ? 'danger' : 'neutral'}>
              {existing.consecutive_failures} failures
            </Badge>
          </>
        ) : (
          <Badge tone="neutral">Not added</Badge>
        )}
      </div>

      {!isSaved ? (
        mode !== 'add' ? (
          <button className="btn btn-primary" type="button" onClick={() => setMode('add')}>
            {addLabel}
          </button>
        ) : (
          <AsyncForm
            action="/delivery/save"
            formClassName="provider-form"
            resetOnSuccess
            successMessage={`${label} added.`}
          >
            <input type="hidden" name="_csrf" value={token} />
            <input type="hidden" name="kind" value={kind} />
            {fields.map((f) => fieldInput(f, ''))}
            <label className="switch">
              <input type="checkbox" name="selected" defaultChecked /> Select {label}
            </label>
            <button className="btn btn-primary" type="submit">
              {addLabel}
            </button>
            <button className="btn" type="button" onClick={() => setMode('summary')}>
              Cancel
            </button>
          </AsyncForm>
        )
      ) : (
        <div>
          <div className="provider-actions">
            <button className="btn" type="button" onClick={() => setMode(mode === 'view' ? 'summary' : 'view')}>
              View
            </button>
            <button className="btn" type="button" onClick={() => setMode(mode === 'edit' ? 'summary' : 'edit')}>
              Edit
            </button>
            <AsyncForm
              action="/delivery/delete"
              formClassName="provider-delete"
              pendingLabel="Deleting…"
              successMessage={`${label} deleted.`}
            >
              <input type="hidden" name="_csrf" value={token} />
              <input type="hidden" name="kind" value={kind} />
              <input type="hidden" name="confirm" value="delete" />
              <button className="btn btn-danger" type="submit">
                Delete {label}
              </button>
            </AsyncForm>
          </div>

          {mode === 'view' ? (
            <div className="provider-view">
              {fields.map((f) => (
                <div className="field" key={f.name}>
                  <span className="field-label">{f.label}</span>
                  {f.sensitive ? (
                    <span className="mono">
                      {existing.sensitiveConfigured[f.name] ? 'Configured' : '(not set)'}
                    </span>
                  ) : (
                    <span className="mono">
                      {existing.config[f.name] ? existing.config[f.name] : '(not set)'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : null}

          {mode === 'edit' ? (
            <AsyncForm action="/delivery/save" formClassName="provider-form" successMessage={`${label} saved.`}>
              <input type="hidden" name="_csrf" value={token} />
              <input type="hidden" name="kind" value={kind} />
              {fields.map((f) => fieldInput(f, f.sensitive ? '' : existing.config[f.name] ?? ''))}
              <label className="switch">
                <input type="checkbox" name="selected" defaultChecked={existing.selected} /> Select {label}
              </label>
              <button className="btn btn-primary" type="submit">
                Save {label}
              </button>
              <button className="btn" type="button" onClick={() => setMode('summary')}>
                Cancel
              </button>
            </AsyncForm>
          ) : null}
        </div>
      )}
    </article>
  );
}
