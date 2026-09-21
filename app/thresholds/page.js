/**
 * Screen 7 — Threshold configuration (design 7.1, 9.2). Editable. Each
 * threshold is its own rule with its own ID (6.5); the "always notify on
 * freebie" checkbox (6.6) is on by default.
 *
 * Server component.
 */

import { getStore } from '../../lib/web/db.js';
import { FREEBIE_SETTING_KEY } from '../../lib/notify/freebie.js';

/**
 * The thresholds page.
 * @returns {React.ReactElement}
 */
export default function ThresholdsPage() {
  const store = getStore();
  const rules = store.getRules().filter((r) => r.type === 'threshold');
  const freebieRaw = store.getSetting(FREEBIE_SETTING_KEY);
  const freebieOn = freebieRaw === null ? true : freebieRaw === '1';

  return (
    <section>
      <h2>Thresholds</h2>
      <table className="thresholds">
        <thead>
          <tr>
            <th>Threshold</th>
            <th>State</th>
            <th>Window</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.id}>
              <td>
                <a href={`/rules/${rule.id}`}>
                  {rule.parameters?.threshold}+ upvotes
                </a>
              </td>
              <td>{rule.state}</td>
              <td>{rule.parameters?.windowHours != null ? `${rule.parameters.windowHours} h` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form method="POST" action="/thresholds/freebie">
        <label>
          <input type="checkbox" name="freebie" defaultChecked={freebieOn} />
          Always notify on freebie
        </label>
        <button type="submit">Save</button>
      </form>
    </section>
  );
}
