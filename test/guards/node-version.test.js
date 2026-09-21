import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the Node major version is at least 24', () => {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  assert.ok(
    major >= 24,
    `Node.js >= 24 is required (engines floor), but the current version is ${process.versions.node}`,
  );
});
