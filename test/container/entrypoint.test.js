/**
 * Container behaviour that only exists on Linux: the POSIX supervisor
 * (`docker-entrypoint.sh`) forwarding signals and failing the container when
 * a child dies, and the smoke test's /data bind mount being usable by the
 * image's uid 1000. These need /bin/sh, POSIX signals and POSIX file modes,
 * so they run as `npm run test:container` in the Linux CI test job rather than
 * in `npm test`, which must pass on every developer platform.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSmokeDataDir } from '../../scripts/smoke-data-dir.mjs';
import { REPO_ROOT } from '../support/app-server.js';
import { waitFor } from '../support/integration.js';

describe('container: the smoke test data directory', () => {
  it('makes the bind-mounted data directory writable by the image user', () => {
    // The image runs as uid 1000 but the CI runner owns the host directory as
    // another uid, so a default mode 0700 temp directory leaves the worker
    // unable to open its database at all ("unable to open database file").
    const parent = mkdtempSync(join(tmpdir(), 'ozb-smoke-parent-'));
    try {
      const dataDir = createSmokeDataDir(parent);
      assert.equal(
        statSync(dataDir).mode & 0o777,
        0o777,
        'uid 1000 can read, write and search the host-owned /data bind mount',
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('container: the supervisor, run for real', () => {
  const dirs = [];

  /**
   * Two throwaway children. Each writes `<name>.ready` once its signal
   * handlers are installed, and `<name>.term` when it is asked to stop.
   */
  function fixtureDir() {
    const dir = mkdtempSync(join(tmpdir(), 'ozb-supervisor-'));
    dirs.push(dir);
    const child = (name, opts = {}) => {
      const script = [
        "const fs = require('node:fs');",
        `const marker = ${JSON.stringify(join(dir, `${name}.term`))};`,
        "process.on('SIGTERM', () => { fs.writeFileSync(marker, 'term'); process.exit(0); });",
        "process.on('SIGINT', () => { fs.writeFileSync(marker, 'int'); process.exit(0); });",
        `fs.writeFileSync(${JSON.stringify(join(dir, `${name}.ready`))}, 'ready');`,
        opts.exitAfterMs
          ? `setTimeout(() => { process.exit(${opts.exitCode}); }, ${opts.exitAfterMs});`
          : 'setTimeout(() => {}, 60000);',
      ].join(' ');
      const path = join(dir, `${name}.js`);
      writeFileSync(path, script);
      return path;
    };
    const ready = () => waitFor(
      () => existsSync(join(dir, 'server.ready')) && existsSync(join(dir, 'worker.ready')),
      { timeoutMs: 10_000, intervalMs: 20, what: 'both children to install their signal handlers' },
    );
    return { dir, child, ready };
  }

  /** Run the supervisor with two fake children. */
  function runSupervisor({ serverCmd, workerCmd }) {
    const child = spawn('/bin/sh', [join(REPO_ROOT, 'docker-entrypoint.sh')], {
      env: {
        ...process.env,
        OZB_NEXT_SERVER_CMD: serverCmd,
        OZB_WORKER_CMD: workerCmd,
        OZB_SUPERVISOR_POLL_SECONDS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    return {
      child,
      output: () => output,
      exited: new Promise((resolve) => child.once('exit', (code) => resolve({ code }))),
    };
  }

  it('forwards SIGTERM to both children and exits 0', async () => {
    const { child, ready } = fixtureDir();
    const supervisor = runSupervisor({
      serverCmd: `${process.execPath} ${child('server')}`,
      workerCmd: `${process.execPath} ${child('worker')}`,
    });
    try {
      await ready();
      supervisor.child.kill('SIGTERM');
      const { code } = await supervisor.exited;
      assert.equal(code, 0, 'a deliberate stop is not a failure');
      assert.match(supervisor.output(), /received TERM: forwarding/);
      assert.match(supervisor.output(), /both children stopped after TERM; exiting 0/);
    } finally {
      if (supervisor.child.exitCode === null) supervisor.child.kill('SIGKILL');
    }
  });

  it('takes the survivor down and exits non-zero when one child dies', async () => {
    const { dir, child } = fixtureDir();
    const supervisor = runSupervisor({
      // The "Next.js server" dies on its own after a moment.
      serverCmd: `${process.execPath} ${child('server', { exitAfterMs: 500, exitCode: 0 })}`,
      workerCmd: `${process.execPath} ${child('worker')}`,
    });
    try {
      const { code } = await supervisor.exited;
      assert.equal(code, 1, 'a child exiting on its own, even with status 0, fails the container');
      assert.match(supervisor.output(), /the Next\.js server exited on its own/);
      assert.match(supervisor.output(), /exiting non-zero/);
      // The survivor was signalled rather than abandoned.
      assert.ok(existsSync(join(dir, 'worker.term')), 'the worker was asked to stop when the server died');
    } finally {
      if (supervisor.child.exitCode === null) supervisor.child.kill('SIGKILL');
    }
  });

  it('honours SIGINT the same way as SIGTERM', async () => {
    const { child, ready } = fixtureDir();
    const supervisor = runSupervisor({
      serverCmd: `${process.execPath} ${child('server')}`,
      workerCmd: `${process.execPath} ${child('worker')}`,
    });
    try {
      await ready();
      supervisor.child.kill('SIGINT');
      const { code } = await supervisor.exited;
      assert.equal(code, 0);
      assert.match(supervisor.output(), /received INT/);
    } finally {
      if (supervisor.child.exitCode === null) supervisor.child.kill('SIGKILL');
    }
  });

  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
});
