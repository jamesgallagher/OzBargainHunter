/**
 * The single point where the login module touches Playwright (prompt 4.3).
 *
 * This is the only file outside `test/` and `scripts/` that imports
 * `playwright`. The architecture guard (4.12) asserts that invariant. The
 * import is dynamic so the module is loaded from `node_modules` at runtime
 * rather than bundled into the Next server build (`next.config.mjs` marks it
 * as a server-external package).
 */

/**
 * Launch a headless Chromium.
 *
 * @param {object} options the launch options (prompt 4.5: `{ headless: true,
 *   args: LAUNCH_ARGS }`)
 * @returns {Promise<object>} the Playwright `Browser`
 */
export async function launchChromium(options) {
  const { chromium } = await import('playwright');
  return chromium.launch(options);
}
