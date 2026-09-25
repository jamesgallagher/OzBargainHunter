import { readFileSync } from 'node:fs';
import { normalizeAppSecret } from './env-secret.js';

// FIX-B (measured-necessary and measured-sufficient, spec §5): read the
// `package.json` version without letting a failed read take the whole module
// down. The read is at module scope, so it runs the moment the module is
// imported. In the Next.js **server (webpack) bundle** `import.meta.url` is not
// a usable `file:` URL, so `readFileSync(new URL('../package.json', import.meta.url))`
// throws `ERR_INVALID_ARG_TYPE` as the module loads — which made the one route
// that imports this module (`app/delivery/test-send/route.js`) 500. The
// **worker runs unbundled** (a plain `node worker/main.js`), where the read
// still succeeds, so the worker keeps the real version; the fallback only ever
// triggers inside the server bundle.
function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    // The read failed (server bundle: `import.meta.url` is not a usable
    // `file:` URL). Return a fallback so the module still loads; the real
    // version is used wherever the read succeeds (the worker).
    return '0.0.0';
  }
}

const VERSION = readVersion();
const CONTACT_URL = 'https://ozb.gallagherhome.au';

const MIN_POLL_INTERVAL_SECONDS = 300;

const DEFAULTS = {
  OZB_DEALS_FEED_URL: 'https://www.ozbargain.com.au/deals/feed',
  OZB_FRONT_FEED_URL: 'https://www.ozbargain.com.au/feed',
  OZB_CLASSIFIEDS_URL: 'https://www.ozbargain.com.au/classified',
  OZB_USER_AGENT: `OzBargainHunter/${VERSION} (+${CONTACT_URL})`,
  OZB_POLL_INTERVAL_SECONDS: 300,
  OZB_CLASSIFIEDS_INTERVAL_SECONDS: 3600,
  // Access gate settings (design 3.7); the floors are enforced below.
  OZB_GATE_B1_MIN_HOURS: 24,
  OZB_GATE_B1_REPEAT_DAYS: 7,
  OZB_GATE_B2_BASE_MINUTES: 15,
  OZB_GATE_B5_CAP_HOURS: 6,
  OZB_DB_PATH: '/data/ozbargain.db',
  OZB_SNAPSHOT_PATH: '/data/ozbargain-snapshot.db',
  OZB_HEALTHCHECK_SECRET: '',
  // M-m3: the CSRF secret is validated here too (it is read by `lib/web/gate.js`
  // and the state-changing pages). An empty value is allowed — an unset
  // `OZB_CSRF_SECRET` fails closed at the CSRF layer (X10), so validation only
  // checks it is a string, not that it is non-empty.
  OZB_CSRF_SECRET: '',
  CF_ACCESS_TEAM_DOMAIN: '',
  CF_ACCESS_AUD: '',
  OZB_ICON_ROUTE_PUBLIC: false,
  OZB_ACCOUNT_COOKIE: '',
  MATRIX_HOMESERVER_URL: '',
  MATRIX_ACCESS_TOKEN: '',
  MATRIX_ROOM_ID: '',
  MATRIX_USER_ID: '',
  NTfy_URL: '',
  NTfy_TOKEN: '',
};

function parseIntValue(value, name) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) {
    throw new Error(`${name} must be an integer, got "${value}"`);
  }
  return n;
}

function parseBoolValue(value, name) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be "true" or "false", got "${value}"`);
}

function parseHttpUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL, got "${value}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${name} must use http(s), got "${value}"`);
  }
  return url.href;
}

/**
 * Read and validate the 9.1 environment configuration.
 * @param {object} env the environment map to read (defaults to process.env)
 * @returns {Readonly<Record<string, unknown>>} a frozen, validated config object
 */
export function loadConfig(env = process.env) {
  const get = (name) => {
    const raw = env[name];
    if (raw === undefined || raw === '') {
      return DEFAULTS[name];
    }
    return raw;
  };

  // D7: the two application-generated secrets are normalized (surrounding
  // whitespace stripped) at the config boundary. A whitespace-only value
  // normalizes to empty and falls through to the default (fail closed).
  const getSecret = (name) => {
    const raw = env[name];
    if (raw === undefined) {
      return DEFAULTS[name];
    }
    const value = normalizeAppSecret(raw);
    if (value === '') {
      return DEFAULTS[name];
    }
    return value;
  };

  const config = {
    OZB_DEALS_FEED_URL: parseHttpUrl(String(get('OZB_DEALS_FEED_URL')), 'OZB_DEALS_FEED_URL'),
    OZB_FRONT_FEED_URL: parseHttpUrl(String(get('OZB_FRONT_FEED_URL')), 'OZB_FRONT_FEED_URL'),
    OZB_CLASSIFIEDS_URL: parseHttpUrl(String(get('OZB_CLASSIFIEDS_URL')), 'OZB_CLASSIFIEDS_URL'),
    OZB_USER_AGENT: String(get('OZB_USER_AGENT')),
    OZB_POLL_INTERVAL_SECONDS: parseIntValue(String(get('OZB_POLL_INTERVAL_SECONDS')), 'OZB_POLL_INTERVAL_SECONDS'),
    OZB_CLASSIFIEDS_INTERVAL_SECONDS: parseIntValue(String(get('OZB_CLASSIFIEDS_INTERVAL_SECONDS')), 'OZB_CLASSIFIEDS_INTERVAL_SECONDS'),
    OZB_GATE_B1_MIN_HOURS: parseIntValue(String(get('OZB_GATE_B1_MIN_HOURS')), 'OZB_GATE_B1_MIN_HOURS'),
    OZB_GATE_B1_REPEAT_DAYS: parseIntValue(String(get('OZB_GATE_B1_REPEAT_DAYS')), 'OZB_GATE_B1_REPEAT_DAYS'),
    OZB_GATE_B2_BASE_MINUTES: parseIntValue(String(get('OZB_GATE_B2_BASE_MINUTES')), 'OZB_GATE_B2_BASE_MINUTES'),
    OZB_GATE_B5_CAP_HOURS: parseIntValue(String(get('OZB_GATE_B5_CAP_HOURS')), 'OZB_GATE_B5_CAP_HOURS'),
    OZB_DB_PATH: String(get('OZB_DB_PATH')),
    OZB_SNAPSHOT_PATH: String(get('OZB_SNAPSHOT_PATH')),
    OZB_HEALTHCHECK_SECRET: getSecret('OZB_HEALTHCHECK_SECRET'),
    OZB_CSRF_SECRET: getSecret('OZB_CSRF_SECRET'),
    CF_ACCESS_TEAM_DOMAIN: String(get('CF_ACCESS_TEAM_DOMAIN')),
    CF_ACCESS_AUD: String(get('CF_ACCESS_AUD')),
    OZB_ICON_ROUTE_PUBLIC: parseBoolValue(String(get('OZB_ICON_ROUTE_PUBLIC')), 'OZB_ICON_ROUTE_PUBLIC'),
    OZB_ACCOUNT_COOKIE: String(get('OZB_ACCOUNT_COOKIE')),
    MATRIX_HOMESERVER_URL: String(get('MATRIX_HOMESERVER_URL')),
    MATRIX_ACCESS_TOKEN: String(get('MATRIX_ACCESS_TOKEN')),
    MATRIX_ROOM_ID: String(get('MATRIX_ROOM_ID')),
    MATRIX_USER_ID: String(get('MATRIX_USER_ID')),
    NTfy_URL: String(get('NTfy_URL')),
    NTfy_TOKEN: String(get('NTfy_TOKEN')),
  };

  if (config.OZB_POLL_INTERVAL_SECONDS < MIN_POLL_INTERVAL_SECONDS) {
    throw new Error(
      `OZB_POLL_INTERVAL_SECONDS must be at least ${MIN_POLL_INTERVAL_SECONDS} (never less than five minutes), got ${config.OZB_POLL_INTERVAL_SECONDS}`,
    );
  }

  // Access gate floors (design 3.7): the gate's durations have a minimum,
  // so a misconfigured value cannot cool the app for seconds. The message
  // names the key and the minimum, like the poll-interval check.
  const GATE_FLOORS = [
    ['OZB_GATE_B1_MIN_HOURS', 24],
    ['OZB_GATE_B1_REPEAT_DAYS', 7],
    ['OZB_GATE_B2_BASE_MINUTES', 15],
    ['OZB_GATE_B5_CAP_HOURS', 6],
  ];
  for (const [name, floor] of GATE_FLOORS) {
    if (config[name] < floor) {
      throw new Error(`${name} must be at least ${floor}, got ${config[name]}`);
    }
  }

  // X8: `OZB_POLL_INTERVAL_SECONDS_TEST_OVERRIDE` lets a test run a
  // short-interval two-process test without tripping the five-minute
  // minimum. It is read *after* the minimum check and, when set to a
  // positive integer, replaces the poll interval. It is a test-only escape
  // hatch: it does not lower the production minimum, it only lets a test
  // pin a short interval. The `NODE_ENV` reference the notes require is
  // here: the override is honoured only when `NODE_ENV` is `test`, so a
  // stray value in production is ignored.
  const overrideRaw = env.OZB_POLL_INTERVAL_SECONDS_TEST_OVERRIDE;
  if (overrideRaw !== undefined && overrideRaw !== '' && env.NODE_ENV === 'test') {
    const override = parseIntValue(overrideRaw, 'OZB_POLL_INTERVAL_SECONDS_TEST_OVERRIDE');
    if (override <= 0) {
      throw new Error(
        `OZB_POLL_INTERVAL_SECONDS_TEST_OVERRIDE must be a positive integer, got ${override}`,
      );
    }
    config.OZB_POLL_INTERVAL_SECONDS = override;
  }

  // The same test-only escape hatch for the client's pause between requests
  // (design 3.3). A test that runs the real worker process would otherwise
  // wait the production pause twice per poll cycle. Honoured only when
  // NODE_ENV is `test`; production always pauses DEFAULT_PAUSE_SECONDS.
  const pauseRaw = env.OZB_REQUEST_PAUSE_MS_TEST_OVERRIDE;
  if (pauseRaw !== undefined && pauseRaw !== '' && env.NODE_ENV === 'test') {
    const pauseMs = parseIntValue(pauseRaw, 'OZB_REQUEST_PAUSE_MS_TEST_OVERRIDE');
    if (pauseMs < 0) {
      throw new Error(`OZB_REQUEST_PAUSE_MS_TEST_OVERRIDE must be zero or positive, got ${pauseMs}`);
    }
    config.OZB_REQUEST_PAUSE_MS_TEST_OVERRIDE = pauseMs;
  }

  return Object.freeze(config);
}

export { DEFAULTS, MIN_POLL_INTERVAL_SECONDS, VERSION };
