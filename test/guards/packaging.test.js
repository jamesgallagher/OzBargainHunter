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
