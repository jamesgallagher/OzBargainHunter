import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const VERSION = pkg.version;
const CONTACT_URL = 'https://ozb.gallagherhome.au';

const MIN_POLL_INTERVAL_SECONDS = 300;

const DEFAULTS = {
  OZB_DEALS_FEED_URL: 'https://www.ozbargain.com.au/deals/feed',
  OZB_FRONT_FEED_URL: 'https://www.ozbargain.com.au/feed',
  OZB_CLASSIFIEDS_URL: 'https://www.ozbargain.com.au/classified',
  OZB_USER_AGENT: `OzBargainHunter/${VERSION} (+${CONTACT_URL})`,
  OZB_POLL_INTERVAL_SECONDS: 300,
  OZB_CLASSIFIEDS_INTERVAL_SECONDS: 3600,
  OZB_DB_PATH: '/data/ozbargain.db',
  OZB_SNAPSHOT_PATH: '/data/ozbargain-snapshot.db',
  OZB_HEALTHCHECK_SECRET: '',
  CF_ACCESS_TEAM_DOMAIN: '',
  CF_ACCESS_AUD: '',
  OZB_ICON_ROUTE_PUBLIC: false,
  OZB_ACCOUNT_COOKIE: '',
  EMAIL_SMTP_HOST: '',
  EMAIL_SMTP_PORT: 0,
  EMAIL_SMTP_USER: '',
  EMAIL_SMTP_PASS: '',
  EMAIL_FROM: '',
  EMAIL_TO: '',
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

function parseOptionalInt(value, name) {
  if (value === '') return 0;
  return parseIntValue(value, name);
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

  const config = {
    OZB_DEALS_FEED_URL: parseHttpUrl(String(get('OZB_DEALS_FEED_URL')), 'OZB_DEALS_FEED_URL'),
    OZB_FRONT_FEED_URL: parseHttpUrl(String(get('OZB_FRONT_FEED_URL')), 'OZB_FRONT_FEED_URL'),
    OZB_CLASSIFIEDS_URL: parseHttpUrl(String(get('OZB_CLASSIFIEDS_URL')), 'OZB_CLASSIFIEDS_URL'),
    OZB_USER_AGENT: String(get('OZB_USER_AGENT')),
    OZB_POLL_INTERVAL_SECONDS: parseIntValue(String(get('OZB_POLL_INTERVAL_SECONDS')), 'OZB_POLL_INTERVAL_SECONDS'),
    OZB_CLASSIFIEDS_INTERVAL_SECONDS: parseIntValue(String(get('OZB_CLASSIFIEDS_INTERVAL_SECONDS')), 'OZB_CLASSIFIEDS_INTERVAL_SECONDS'),
    OZB_DB_PATH: String(get('OZB_DB_PATH')),
    OZB_SNAPSHOT_PATH: String(get('OZB_SNAPSHOT_PATH')),
    OZB_HEALTHCHECK_SECRET: String(get('OZB_HEALTHCHECK_SECRET')),
    CF_ACCESS_TEAM_DOMAIN: String(get('CF_ACCESS_TEAM_DOMAIN')),
    CF_ACCESS_AUD: String(get('CF_ACCESS_AUD')),
    OZB_ICON_ROUTE_PUBLIC: parseBoolValue(String(get('OZB_ICON_ROUTE_PUBLIC')), 'OZB_ICON_ROUTE_PUBLIC'),
    OZB_ACCOUNT_COOKIE: String(get('OZB_ACCOUNT_COOKIE')),
    EMAIL_SMTP_HOST: String(get('EMAIL_SMTP_HOST')),
    EMAIL_SMTP_PORT: parseOptionalInt(String(get('EMAIL_SMTP_PORT')), 'EMAIL_SMTP_PORT'),
    EMAIL_SMTP_USER: String(get('EMAIL_SMTP_USER')),
    EMAIL_SMTP_PASS: String(get('EMAIL_SMTP_PASS')),
    EMAIL_FROM: String(get('EMAIL_FROM')),
    EMAIL_TO: String(get('EMAIL_TO')),
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

  return Object.freeze(config);
}

export { DEFAULTS, MIN_POLL_INTERVAL_SECONDS, VERSION };
