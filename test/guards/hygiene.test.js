import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// The repository root: this file lives at <root>/test/guards/hygiene.test.js.
const root = path.resolve(import.meta.dirname, '..', '..');

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error) {
    throw new Error(`the hygiene guard could not run git (${result.error.message})`);
  }
  return result;
}

function checkIgnoreStatus(target) {
  return git(['check-ignore', '--no-index', '-q', target]).status;
}

test('local environment files are ignored', () => {
  for (const target of ['.env', '.env.local', '.env.production.local']) {
    assert.equal(checkIgnoreStatus(target), 0,
      `${target} is not ignored — the .gitignore environment rules have regressed`);
  }
});

test('the committed template stays committable', () => {
  assert.notEqual(checkIgnoreStatus('.env.example'), 0,
    '.env.example is ignored — the !.env.example negation was lost');
});

test('the in-repo pipeline worktree directory is ignored', () => {
  assert.equal(checkIgnoreStatus('.worktrees/'), 0,
    '.worktrees/ is not ignored — a stray `git add .` could stage another card\'s worktree');
});

test('no tracked path is a secret file', () => {
  const tracked = git(['ls-files']).stdout.split('\n').filter(Boolean);
  const envLike = tracked.filter((p) => /(^|\/)\.env/.test(p));
  for (const p of envLike) {
    assert.equal(p, '.env.example',
      `tracked path ${p} looks like a local environment file — if it is a deliberate template, the guard and .gitignore must be changed together`);
  }
  const secretPatterns = [
    /(^|\/)\.(netrc|npmrc)$/,
    /(^|\/)credentials[^/]*$/,
    /\.(pem|key|p12|pfx|jks|der|p8)$/,
    /(^|\/)id_(rsa|dsa|ecdsa|ed25519)/,
  ];
  for (const p of tracked) {
    for (const pattern of secretPatterns) {
      assert.ok(!pattern.test(p),
        `tracked path ${p} looks like key or credential material (${pattern}); ignore rules cannot untrack it`);
    }
  }
});
