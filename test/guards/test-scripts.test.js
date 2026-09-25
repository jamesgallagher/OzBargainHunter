import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const testScripts = Object.entries(pkg.scripts).filter(([name]) => name.startsWith('test'));

test('every script that runs node --test carries the network guard and a test timeout', () => {
  const runners = testScripts.filter(([, command]) => command.includes('node --test'));
  assert.ok(runners.length > 0, 'expected at least one node --test script');

  for (const [name, command] of runners) {
    assert.ok(
      command.includes('--import ./test/support/no-network.js'),
      `script "${name}" is missing --import ./test/support/no-network.js`,
    );
    // A test with no timeout can hang the whole suite forever (node's default
    // is Infinity), which is how a Windows-only spawn bug once stalled npm test.
    assert.match(command, /--test-timeout=\d+/, `script "${name}" is missing --test-timeout`);
  }
});

test('every other test script only chains test scripts', () => {
  for (const [name, command] of testScripts) {
    if (command.includes('node --test')) continue;
    for (const step of command.split('&&').map((s) => s.trim())) {
      const match = step.match(/^npm run (\S+)$/);
      assert.ok(match, `script "${name}" step "${step}" must be "npm run <test script>"`);
      assert.ok(match[1].startsWith('test'), `script "${name}" chains non-test script "${match[1]}"`);
    }
  }
});
