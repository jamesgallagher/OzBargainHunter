/**
 * The browser identity (feature card decision 6, as proven by the chunk 3 spike).
 *
 * The login browser presents as an ordinary desktop Chrome: a standard Chrome
 * User-Agent (no `HeadlessChrome`), `en-AU` locale, `Australia/Melbourne`
 * time zone, a normal desktop window size. What stays forbidden (decision 6):
 * stealth or fingerprint-masking plugins, captcha or challenge solving, proxies
 * or identity rotation, and retrying after a block.
 *
 * All of this is pure: no browser, no I/O. `performLogin` (index.js) applies
 * it.
 */

/**
 * The launch arguments for the headless Chromium (prompt 4.5).
 *
 * The first six are the spike's proven set. `--disable-dev-shm-usage` is added
 * because Docker's default `/dev/shm` is 64 MB; it changes where Chromium keeps
 * shared memory, not what the site sees.
 *
 * Never add `--no-sandbox` (Playwright's default already handles it; chunk 4
 * decision) and never add stealth or automation-masking flags.
 */
export const LAUNCH_ARGS = Object.freeze([
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-dev-shm-usage',
]);

/**
 * The context options (prompt 4.5). A fresh non-persistent context from
 * `browser.newContext(...)`. Forbidden: `launchPersistentContext`, a profile
 * directory, tracing, video, screenshots, HAR, `storageState` save, stealth
 * plugins, `navigator` patches, `addInitScript`.
 */
export const CONTEXT_OPTIONS = Object.freeze({
  locale: 'en-AU',
  timezoneId: 'Australia/Melbourne',
  viewport: { width: 1366, height: 768 },
  acceptDownloads: false,
  permissions: [],
});

/**
 * Build the standard Chrome User-Agent for the running browser's major version
 * and platform.
 *
 * The real platform is used because the container is Linux, and a Windows
 * User-Agent over a Linux `navigator.platform` would be an inconsistency.
 * Deriving the major version from the running browser means a Playwright
 * upgrade can never leave the User-Agent claiming a different version.
 *
 * @param {string} major the browser's major version (`browser.version().split('.')[0]`)
 * @param {string} platform `process.platform`
 * @returns {string} the User-Agent
 */
export function buildChromeUserAgent(major, platform) {
  const version = `${major}.0.0.0`;
  if (platform === 'win32') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  }
  if (platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}
