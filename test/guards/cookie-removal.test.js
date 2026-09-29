/**
 * Card AC 7 (chunk 7): the removed account-cookie env variable must not be
 * named by any tracked file. The name is built from parts so this file never
 * contains the literal, and the scan covers every tracked file except the
 * historical documents.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The repository root: this file lives at <root>/test/guards/cookie-removal.test.js.
const root = path.resolve(import.meta.dirname, '..', '..');

// The forbidden name, built from parts so the guard does not match itself.
const NAME = ['OZB', 'ACCOUNT', 'COOKIE'].join('_');

// Historical documents (design, decisions, the brief, the research record and
// the card record): the guard scans everything else.
const HISTORICAL = new Set([
  'design.md',
  'decisions.md',
  'BRIEF.md',
  'rationale.md',
  'research.md',
  'cards.json',
  'feature_classifieds.md',
]);

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error) {
    throw new Error(`the cookie-removal guard could not run git (${result.error.message})`);
  }
  return result;
}

test('no tracked file names the removed env variable (card AC 7)', () => {
  const tracked = git(['ls-files']).stdout.split('\n').filter(Boolean);
  assert.ok(tracked.length > 0, 'git ls-files returned no files');
  for (const file of tracked) {
    if (HISTORICAL.has(file)) continue;
    const content = readFileSync(path.join(root, file), 'utf8');
    assert.ok(!content.includes(NAME), `${file} names ${NAME} — the env fallback was removed`);
  }
});

test('loadConfig has no key for the removed env variable, even when the environment sets it', async () => {
  const { loadConfig } = await import('../../lib/config.js');
  const config = loadConfig({ [NAME]: 'x' });
  assert.equal(config[NAME], undefined, 'loadConfig returns no such key');
  assert.ok(!Object.keys(config).includes(NAME), 'the key is absent from the config object');
});
