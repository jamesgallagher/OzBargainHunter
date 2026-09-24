/**
 * Presentational, server-safe components for the OzBargainHunter UI (spec §4,
 * §5). No client state, no hooks, no external CSS framework — they render
 * semantic HTML whose classes are defined in app/globals.css.
 */

import Link from 'next/link.js';
import { formatMelbourne } from '../../lib/time.js';

/**
 * Derive an acquisition-health summary from the existing poll state
 * (spec §6.1). Presentation only — no new persisted state.
 *
 * The store's poll_state is snake_case:
 *   last_success_at, last_response_class, backoff_seconds, consecutive_failures
 *
 * Timestamps are shown in Australia/Melbourne time (spec §4.3 keeps storage
 * UTC; the zone is a display concern). `formatMelbourne` is a pure,
 * server-safe helper, so the banner renders Melbourne on the server too.
 */
export function healthFromPollState(poll) {
  if (!poll) {
    return { tone: 'waiting', label: 'Waiting', detail: 'No successful poll yet' };
  }
  const {
    last_success_at,
    last_response_class,
    backoff_seconds,
    consecutive_failures,
  } = poll;

  if (backoff_seconds && backoff_seconds > 0) {
    return {
      tone: 'backing-off',
      label: 'Backing off',
      detail: `Retry in ${backoff_seconds}s`,
    };
  }

  if (consecutive_failures && consecutive_failures > 0) {
    return {
      tone: 'attention',
      label: 'Attention',
      detail: `${consecutive_failures} failed polls`,
    };
  }

  if (last_success_at && last_response_class === 'ok') {
    return {
      tone: 'healthy',
      label: 'Healthy',
      detail: `Last success ${formatMelbourne(last_success_at)}`,
    };
  }

  return {
    tone: 'waiting',
    label: 'Waiting',
    detail: last_response_class ? `Last response ${last_response_class}` : 'No data yet',
  };
}

/**
 * Badge (spec §4.4): a status label. Colour is never the only cue — the text
 * label always accompanies the tone.
 */
export function Badge({ tone = 'neutral', children, className }) {
  return (
    <span className={`badge${className ? ` ${className}` : ''}`} data-tone={tone}>
      {children}
    </span>
  );
}

/**
 * HealthPill (spec §6.1): a compact acquisition-health indicator. Renders a
 * dot plus a text label; the tone is carried by data-health and the dot colour.
 */
export function HealthPill({ health, label, detail }) {
  return (
    <span className="health-pill" data-health={health} role="status">
      <span className="dot" aria-hidden="true" />
      <span>{label}</span>
      {detail ? <span className="detail">{detail}</span> : null}
    </span>
  );
}

/**
 * Card (spec §5): a surface container.
 */
export function Card({ children, className, as: Tag = 'section' }) {
  return (
    <Tag className={`card${className ? ` ${className}` : ''}`}>
      {children}
    </Tag>
  );
}

/**
 * PageHeader (spec §5.1): the title block for every screen.
 */
export function PageHeader({ title, description, action, actions }) {
  return (
    <header className="page-header">
      <div className="title-block">
        <h1>{title}</h1>
        {description ? <p className="description">{description}</p> : null}
      </div>
      {action || actions ? <div className="page-header-actions">{action ?? actions}</div> : null}
    </header>
  );
}

/**
 * StatCard (spec §6.1): a single metric on the Status screen.
 */
export function StatCard({ label, value, sub, tone }) {
  return (
    <div className="stat-card" data-tone={tone}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub ? <span className="stat-sub">{sub}</span> : null}
    </div>
  );
}

/**
 * EmptyState (spec §4.4): shown when a collection has no items.
 */
export function EmptyState({ title, body, action }) {
  return (
    <div className="empty-state">
      <p className="empty-title">{title}</p>
      {body ? <p className="empty-body">{body}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

/**
 * Notice (spec §4.4, §8): an inline message with a tone.
 */
export function Notice({ tone = 'info', title, children, actions }) {
  return (
    <div className="notice" data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
      {title ? <p className="notice-title">{title}</p> : null}
      {children ? <div className="notice-body">{children}</div> : null}
      {actions ? <div className="notice-actions">{actions}</div> : null}
    </div>
  );
}

export function Subnav({ label, links, activeHref }) {
  return (
    <nav className="subnav" aria-label={label}>
      {links.map((link) => (
        <Link
          className="tab"
          href={link.href}
          key={link.href}
          aria-current={link.href === activeHref ? 'page' : undefined}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Field (spec §4.3, §5.2): a labelled form control. The label is a real
 * <label> so it is associated with the control by `for`.
 */
export function Field({ id, label, help, children }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {help ? <span className="help">{help}</span> : null}
    </div>
  );
}

/**
 * Segmented (spec §6.3): a radio group rendered as a segmented control.
 */
export function Segmented({ name, value, options, onChange, disabled }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((opt) => (
        <label key={opt.value}>
          <input
            type="radio"
            name={name}
            value={opt.value}
            checked={value === opt.value}
            onChange={onChange}
            disabled={disabled}
          />
          {opt.label}
        </label>
      ))}
    </div>
  );
}

/**
 * Table (spec §4.4, §5.2): a semantic data table. On phone the <thead> is
 * visually hidden and each <td> carries a data-label so the row reads as a
 * stacked card (spec §5.2, D5).
 */
export function Table({ children, caption }) {
  return (
    <table className="data-table">
      {caption ? <caption>{caption}</caption> : null}
      {children}
    </table>
  );
}

export function DataTable({ columns, rows, className = '' }) {
  return (
    <table className={`data-table${className ? ` ${className}` : ''}`}>
      <thead>
        <tr>{columns.map((column) => <th scope="col" key={column}>{column}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, cellIndex) => (
              <td data-label={columns[cellIndex]} key={cellIndex}>
                <span className="cell-value">{cell}</span>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function stateTone(state) {
  if (state === 'enabled') return 'success';
  if (state === 'snoozed') return 'warning';
  if (state === 'muted') return 'danger';
  return 'neutral';
}

export function ruleLabel(rule) {
  return rule.type === 'threshold'
    ? `${rule.parameters?.threshold ?? '—'}+ upvotes`
    : rule.parameters?.term || `Rule ${rule.id}`;
}

export function Th({ children, scope = 'col' }) {
  return <th scope={scope}>{children}</th>;
}

export function Tr({ children }) {
  return <tr>{children}</tr>;
}

/**
 * Td (spec §5.2): a table cell. The `label` becomes the data-label shown on
 * phone; the value is wrapped in .cell-value so it right-aligns on phone.
 */
export function Td({ label, children }) {
  return (
    <td data-label={label}>
      <span className="cell-value">{children}</span>
    </td>
  );
}

/**
 * Button (spec §4.3): a ≥44px touch target.
 */
export function Button({ children, variant, type = 'button', ...rest }) {
  const cls =
    variant === 'primary'
      ? 'btn btn-primary'
      : variant === 'danger'
        ? 'btn btn-danger'
        : variant === 'ghost'
          ? 'btn btn-ghost'
          : 'btn';
  return (
    <button type={type} className={cls} {...rest}>
      {children}
    </button>
  );
}

export function LinkButton({ href, children, variant }) {
  const cls =
    variant === 'primary'
      ? 'btn btn-primary'
      : variant === 'danger'
        ? 'btn btn-danger'
        : 'btn';
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}
