/**
 * Packaging invariants that nothing else would catch before deployment. The
 * image's runtime behaviour (health check, port, /data, access control) is
 * proven by running it in the CI smoke test, and the supervisor's by
 * `npm run test:container`; these two are static facts about the artefacts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS } from '../../lib/config.js';

const read = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

test('the image runs as the non-root user node, which owns /data', () => {
  const dockerfile = read('Dockerfile');
  const users = [...dockerfile.matchAll(/^USER (.+)$/gm)].map((m) => m[1].trim());
  assert.equal(users.at(-1), 'node', 'the final USER is node (uid 1000), never root');
  assert.match(dockerfile, /chown node:node \/data/);
});

test('the Unraid template exposes every environment variable the application reads', () => {
  const template = read('unraid/my-ozbargain-hunter.xml');
  for (const key of Object.keys(DEFAULTS)) {
    assert.match(template, new RegExp(`Target="${key}"`), `${key} is configurable in the template (lib/config.js reads it)`);
  }
});

test('the base image is node:24-bookworm-slim in every stage', () => {
  const dockerfile = read('Dockerfile');
  const bases = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
  assert.ok(bases.length >= 2, 'the build has a builder stage and a runtime stage');
  for (const base of bases) {
    assert.equal(base, 'node:24-bookworm-slim', `stage base ${base}: one libc across the build (a musl builder feeding a glibc runtime is a latent crash for native binaries like Chromium)`);
  }
  // A second guard on the instructions, not the prose (the header comment names
  // Alpine while explaining the move off it): no instruction may reference an
  // Alpine base anywhere, not just on a FROM line.
  const instructions = dockerfile.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(instructions, /alpine/i, 'no instruction may reference an Alpine base: the whole build is on glibc (node:24-bookworm-slim), so a musl image anywhere would be a latent crash for Chromium');
});

test('the browser is installed into the image with the pinned Playwright', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /^ENV PLAYWRIGHT_BROWSERS_PATH=\/ms-playwright$/m, 'the browser path is a runtime ENV, not a build ARG');
  assert.match(dockerfile, /node node_modules\/playwright\/cli\.js install --with-deps --only-shell chromium|npx --no-install playwright install --with-deps --only-shell chromium/, 'the install runs the pinned local CLI with --with-deps (apt, needs root) and --only-shell chromium');
  // The ordering check runs on the instructions, not the prose: a comment that
  // mentions the install must not stand in for the RUN that performs it.
  const instructions = dockerfile.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
  const install = instructions.search(/playwright(\/cli\.js)? install/);
  const user = instructions.search(/^USER node$/m);
  assert.ok(install !== -1 && user !== -1 && install < user, 'the install runs while the stage is still root, before the final USER node');
});

test('the browser adds no privilege to the container', () => {
  // Comments are stripped: the decision is recorded in them, and the guard
  // must check the instructions, not the prose.
  const instructions = read('Dockerfile').split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
  for (const token of ['--no-sandbox', 'chromiumSandbox', 'SYS_ADMIN', 'seccomp']) {
    assert.doesNotMatch(instructions, new RegExp(token, 'i'), `no instruction may grant the browser ${token}: Playwright's default no-sandbox launch is the decision, so no container-level override may appear`);
  }
});

test('playwright is a pinned production dependency', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies.playwright, '1.63.0', 'playwright is a production dependency at an exact pin (the image installs the browser from it)');
  assert.equal(pkg.devDependencies?.playwright, undefined, 'playwright is not also a dev dependency');
  const lock = JSON.parse(read('package-lock.json'));
  const entry = lock.packages['node_modules/playwright'];
  assert.equal(entry.version, '1.63.0', 'the lockfile pins the same version');
  assert.notEqual(entry.dev, true, 'the lockfile records playwright as a production dependency');
});

test('a local browser install cannot enter the build context', () => {
  assert.match(read('.dockerignore'), /^\.playwright-browsers$/m, 'a local .playwright-browsers must not stand in for the one the Dockerfile installs');
});

test('the build scripts stay out of the image', () => {
  // The source is the last token of a COPY line: COPY may carry flags
  // (--from, --chown) and several sources, but never a scripts directory.
  const sources = read('Dockerfile').split('\n')
    .filter((line) => line.startsWith('COPY '))
    .flatMap((line) => line.trimEnd().split(/\s+/).slice(1));
  for (const source of sources) {
    assert.ok(source !== 'scripts' && source !== '/app/scripts', `COPY ${source}: the build scripts are not part of the image`);
  }
});
