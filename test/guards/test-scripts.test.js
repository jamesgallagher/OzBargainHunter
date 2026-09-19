import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('every test:* script carries --import ./test/support/no-network.js', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const testScripts = Object.entries(pkg.scripts).filter(([name]) => name.startsWith('test'));
  assert.ok(testScripts.length > 0, 'expected at least one test script');

  for (const [name, command] of testScripts) {
    assert.ok(
      command.includes('--import ./test/support/no-network.js'),
      `script "${name}" is missing --import ./test/support/no-network.js`,
    );
  }
});
