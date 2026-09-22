/**
 * Packaging assertions (card 5, design 10.4, 10.6). None of these need Docker,
 * so they run on any machine and inside `npm test`.
 *
 * Two kinds of assertion live here:
 *
 *   * **Static** — the Dockerfile, the supervisor, the CI workflow and the
 *     Unraid template are read and their required properties asserted. A
 *     packaging artefact is code: `:latest` reaching the host depends on the
 *     workflow's gating, and the container's state surviving a restart depends
 *     on the bind mount, so both are checked rather than trusted.
 *   * **Behavioural** — `docker-entrypoint.sh` is *run*, with two throwaway
 *     children, and its two contracts are proved: a forwarded SIGTERM reaches
 *     both children and the supervisor exits 0, and one child dying takes the
 *     survivor down and exits non-zero. That is the difference between a
 *     container that restarts when its poller dies and one that looks like a
 *     quiet day forever (6.7).
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS } from '../../lib/config.js';
import { createSmokeDataDir } from '../../scripts/smoke-data-dir.mjs';
import { REPO_ROOT } from '../support/app-server.js';

const read = (relative) => readFileSync(join(REPO_ROOT, relative), 'utf8');

const DOCKERFILE = read('Dockerfile');
const ENTRYPOINT = read('docker-entrypoint.sh');
const CI = read('.github/workflows/ci.yml');
const UNRAID = read('unraid/my-ozbargain-hunter.xml');
const SMOKE = read('scripts/smoke-image.mjs');

/** Every top-level job name in the workflow, in file order. */
function jobNames(yaml) {
  const names = [];
  let inJobs = false;
  for (const line of yaml.split('\n')) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    const match = /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

/** The text of one job block. */
function jobBlock(yaml, name) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.ok(start >= 0, `job "${name}" exists`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[a-zA-Z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

describe('integration: the packaging artefacts', () => {
  describe('Dockerfile', () => {
    it('is a multi-stage build on node:24-alpine', () => {
      const stages = DOCKERFILE.match(/^FROM .*$/gm) ?? [];
      assert.ok(stages.length >= 2, `multi-stage, got ${stages.length} stages`);
      for (const stage of stages) {
        assert.match(stage, /FROM node:24-alpine/);
      }
    });

    it('runs as a non-root user', () => {
      const user = /^USER (.+)$/m.exec(DOCKERFILE);
      assert.ok(user, 'a USER instruction is present');
      const value = user[1].trim();
      assert.ok(!['root', '0'].includes(value), `USER must not be root (got "${value}")`);
      assert.equal(value, 'node', 'the image uses the non-root user node (uid 1000)');
      // The same user owns /data, so the image runs without a bind mount too.
      assert.match(DOCKERFILE, /chown node:node \/data/);
    });

    it('exposes port 8000', () => {
      assert.match(DOCKERFILE, /^EXPOSE 8000$/m);
    });

    it('carries OCI labels including the image source', () => {
      assert.match(DOCKERFILE, /org\.opencontainers\.image\.source="https:\/\/github\.com\/jamesgallagher\/OzBargainHunter"/);
      for (const label of ['title', 'description', 'licenses', 'version']) {
        assert.match(DOCKERFILE, new RegExp(`org\\.opencontainers\\.image\\.${label}=`));
      }
    });

    it('declares a healthcheck on 127.0.0.1:8000/healthz with the container-local secret', () => {
      const healthcheck = /^HEALTHCHECK[\s\S]*?(?=\n[A-Z][A-Z ]*[A-Z]\b)/m.exec(DOCKERFILE);
      assert.ok(healthcheck, 'a HEALTHCHECK instruction is present');
      const block = healthcheck[0];
      assert.match(block, /127\.0\.0\.1:8000\/healthz/);
      assert.match(block, /x-healthcheck-secret/);
      assert.match(block, /OZB_HEALTHCHECK_SECRET/);
    });

    it('keeps all persistent state on the bind mount at /data', () => {
      assert.match(DOCKERFILE, /OZB_DB_PATH=\/data\//);
      assert.match(DOCKERFILE, /OZB_SNAPSHOT_PATH=\/data\//);
      assert.match(DOCKERFILE, /VOLUME \["\/data"\]/);
      // The Next.js standalone output lives under /app, never under /data.
      assert.match(DOCKERFILE, /COPY --from=builder[^\n]*\/app\/\.next\/standalone\/ \.\//);
      assert.match(DOCKERFILE, /COPY --from=builder[^\n]*\/app\/\.next\/static\/ \.\/\.next\/static\//);
    });

    it('enters through the supervisor', () => {
      assert.match(DOCKERFILE, /^ENTRYPOINT \["\/usr\/local\/bin\/docker-entrypoint\.sh"\]$/m);
      assert.match(DOCKERFILE, /COPY --from=builder[^\n]*docker-entrypoint\.sh/);
    });
  });

  describe('docker-entrypoint.sh', () => {
    it('is POSIX sh with a strict preamble', () => {
      assert.ok(ENTRYPOINT.startsWith('#!/bin/sh'), 'the shebang is POSIX sh, not bash');
      assert.match(ENTRYPOINT, /^set -eu$/m);
      assert.ok(!/^\s*wait\s+-n/m.test(ENTRYPOINT), 'busybox sh has no wait -n');
    });

    it('starts both processes', () => {
      assert.match(ENTRYPOINT, /node \/app\/server\.js/);
      assert.match(ENTRYPOINT, /node \/app\/worker\/main\.js/);
    });

    it('traps and forwards SIGTERM and SIGINT to both children', () => {
      assert.match(ENTRYPOINT, /^trap 'forward_shutdown TERM' TERM$/m);
      assert.match(ENTRYPOINT, /^trap 'forward_shutdown INT' INT$/m);
      const forward = /forward_shutdown\(\)[\s\S]*?\n}/.exec(ENTRYPOINT);
      assert.ok(forward, 'the forwarding function exists');
      assert.match(forward[0], /kill -"\$signal" "\$NEXT_PID"/);
      assert.match(forward[0], /kill -"\$signal" "\$WORKER_PID"/);
    });

    it('exits non-zero when either child exits on its own', () => {
      assert.match(ENTRYPOINT, /exit "\$STATUS"/);
      assert.match(ENTRYPOINT, /kill -TERM "\$SURVIVOR_PID"/, 'the survivor is stopped, not abandoned');
      assert.match(ENTRYPOINT, /SURVIVOR_PID="\$NEXT_PID"/, 'the worker dying takes the server down');
      assert.match(ENTRYPOINT, /SURVIVOR_PID="\$WORKER_PID"/, 'the server dying takes the worker down');
    });
  });

  describe('.github/workflows/ci.yml', () => {
    it('has the five jobs in order', () => {
      assert.deepEqual(jobNames(CI), ['lint', 'test', 'build', 'smoke', 'publish']);
    });

    it('runs on every trigger, including pull requests', () => {
      assert.match(CI, /^on:\s*$/m);
      assert.match(CI, /^ {2}push:\s*$/m);
      assert.match(CI, /^ {2}pull_request:\s*$/m);
    });

    it('cancels superseded runs, keyed on the branch reference', () => {
      assert.match(CI, /concurrency:\s*\n\s*group: ci-\$\{\{ github\.ref \}\}/);
      assert.match(CI, /cancel-in-progress: true/);
    });

    it('installs with npm ci on node 24', () => {
      // lint, test and smoke run node; the build job installs inside the image.
      assert.equal((CI.match(/npm ci/g) ?? []).length, 3, 'every job that runs node installs from the lockfile');
      assert.equal((CI.match(/node-version: '24'/g) ?? []).length, 3);
    });

    it('lints and tests before building', () => {
      const lint = jobBlock(CI, 'lint');
      assert.match(lint, /npm run lint/);
      const test = jobBlock(CI, 'test');
      assert.match(test, /npm test/);
      assert.match(jobBlock(CI, 'build'), /needs: \[lint, test\]/);
    });

    it('builds linux/amd64 only, on every trigger, with the Actions cache', () => {
      const build = jobBlock(CI, 'build');
      assert.match(build, /platforms: linux\/amd64/);
      assert.match(build, /cache-from: type=gha/);
      assert.match(build, /cache-to: type=gha,mode=max/);
      assert.match(build, /load: true/);
      assert.ok(!/push: true/.test(build), 'the build job never pushes; publish is the only job that does');
      assert.ok(!/needs:/.test(build.split('\n').filter((l) => l.includes('pull_request')).join('')), 'the build runs on pull requests too');
    });

    it('smoke tests the image that was built', () => {
      const smoke = jobBlock(CI, 'smoke');
      assert.match(smoke, /needs: \[build\]/);
      assert.match(smoke, /download-artifact/);
      assert.match(smoke, /docker load/);
      // The card names the command: `npm run smoke:image` (which runs
      // scripts/smoke-image.mjs), so the script and the package script stay
      // wired together.
      assert.match(smoke, /^        run: npm run smoke:image$/m);
      assert.match(smoke, /OZB_SMOKE_IMAGE/);
    });

    it('publishes only on main, and only after all four jobs passed', () => {
      const publish = jobBlock(CI, 'publish');
      assert.match(publish, /needs: \[lint, test, build, smoke\]/);
      assert.match(publish, /if: github\.ref == 'refs\/heads\/main'/);
      assert.match(publish, /github\.event_name == 'push'/);
    });

    it('publishes exactly two tags to ghcr.io, and no beta or semantic-version tags', () => {
      assert.match(CI, /GHCR_IMAGE: ghcr\.io\/jamesgallagher\/ozbargainhunter/, 'the package name (10.5)');
      const publish = jobBlock(CI, 'publish');
      const tags = publish.match(/docker tag /g) ?? [];
      assert.equal(tags.length, 2, 'exactly two tags are created');
      assert.match(publish, /docker tag "\$\{\{ env\.IMAGE_NAME \}\}" "\$\{\{ env\.GHCR_IMAGE \}\}:latest"/);
      assert.match(publish, /:main-\$\{SHORT_SHA\}"/);
      assert.match(publish, /docker push "\$\{\{ env\.GHCR_IMAGE \}\}:latest"/);
      assert.match(publish, /docker push "\$\{\{ env\.GHCR_IMAGE \}\}:main-/);
      assert.equal((publish.match(/docker push /g) ?? []).length, 2, 'and exactly two are pushed');
      for (const tag of ['beta', 'stable', 'v1', 'semver']) {
        assert.ok(!new RegExp(`:${tag}`).test(publish), `no :${tag} tag`);
      }
      assert.match(publish, /docker\/login-action/);
      assert.match(publish, /secrets\.GITHUB_TOKEN/);
    });

    it('is parseable YAML: no unquoted ": " inside a value', () => {
      // A colon followed by a space inside a plain scalar starts a nested
      // mapping, so `- name: push: tags` is not YAML and GitHub refuses the
      // whole file — one bad line and the pipeline never runs. (The check also
      // confirms the near-miss is *fine*: `name: push :latest and :main-<sha>`
      // is valid, because a colon not followed by a space is allowed in a plain
      // scalar. Verified against js-yaml.)
      for (const [index, line] of CI.split('\n').entries()) {
        const match = /^\s*(?:- )?[A-Za-z_][\w.-]*:\s*(\S.*)$/.exec(line);
        if (!match) continue;
        const value = match[1].trim();
        if (/^["'|>[{]/.test(value)) continue; // quoted, block scalar, flow
        assert.ok(
          !value.includes(': '),
          `line ${index + 1} has an unquoted ": " in a value: ${line.trim()}`,
        );
      }
    });

    it('never points the smoke test at the live site', () => {
      assert.ok(!/https?:\/\/www\.ozbargain\.com\.au/.test(CI), 'the workflow does not configure the real feed');
      assert.ok(!/OZB_DEALS_FEED_URL/.test(CI), 'the feed URLs come from the fixture server, never from the workflow');
    });
  });

  describe('scripts/smoke-image.mjs', () => {
    /** A top-level `const NAME = <number>;` from the smoke script. */
    const smokeConstant = (name) => {
      const match = new RegExp(`^const ${name} = ([0-9_]+);$`, 'm').exec(SMOKE);
      assert.ok(match, `${name} is declared as a plain number`);
      return Number(match[1].replaceAll('_', ''));
    };

    it('waits longer than one poll interval for the container to go healthy', () => {
      // The worker's schedulers start with `runImmediately: false`
      // (lib/scheduler.js), so its first deal-poll beat is due one whole
      // interval *after* start, and /healthz stays 503 until that poll has
      // committed (design 3.7). A health window shorter than the interval
      // therefore can never see a healthy container, however well the image
      // works: the original fixed 180 s window outlived the container on run
      // 35610785899 and would have failed the same way on a healthy one.
      assert.match(
        SMOKE,
        /const HEALTH_TIMEOUT_MS = \(POLL_INTERVAL_SECONDS \+ HEALTH_TIMEOUT_SLACK_SECONDS\) \* 1000;/,
        'the health window is derived from the poll interval, not pinned',
      );
      assert.match(
        SMOKE,
        /OZB_POLL_INTERVAL_SECONDS: String\(POLL_INTERVAL_SECONDS\)/,
        'the container is given the same interval the window is sized for',
      );
      const interval = smokeConstant('POLL_INTERVAL_SECONDS');
      const slack = smokeConstant('HEALTH_TIMEOUT_SLACK_SECONDS');
      assert.ok(
        slack >= 60,
        `the window leaves the poll cycle and Docker's health beat at least a minute of slack, got ${slack}s`,
      );
      assert.ok(
        slack > 0 && interval >= DEFAULTS.OZB_POLL_INTERVAL_SECONDS,
        `the smoke run keeps the production interval: ${interval}s`,
      );
    });

    it('makes the bind-mounted data directory writable by the image user', () => {
      // The image runs as uid 1000 but the CI runner owns the host directory as
      // another uid, so a default mode 0700 temp directory leaves the worker
      // unable to open its database at all ("unable to open database file").
      assert.match(
        SMOKE,
        /const dataDir = createSmokeDataDir\(\);/,
        'the smoke test mounts the helper directory at /data',
      );
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

  describe('unraid/my-ozbargain-hunter.xml', () => {
    it('names the container and points at the moving tag', () => {
      assert.match(UNRAID, /<Name>ozbargain-hunter<\/Name>/);
      assert.match(UNRAID, /<Repository>ghcr\.io\/jamesgallagher\/ozbargainhunter:latest<\/Repository>/);
      // A pinned tag would never produce an update from Unraid's point of view.
      assert.ok(!/main-[0-9a-f]{7}<\/Repository>/.test(UNRAID));
    });

    it('maps the appdata directory to /data and publishes 7171 to 8000', () => {
      assert.match(UNRAID, /Target="\/data"[^>]*>\/mnt\/user\/appdata\/ozbargain-hunter\/</);
      assert.match(UNRAID, /Target="8000"[^>]*Type="Port"/);
      assert.match(UNRAID, /Target="8000"[^>]*>7171</);
    });

    it('restarts unless-stopped and pins the time zone explicitly', () => {
      assert.match(UNRAID, /<ExtraParams>--restart unless-stopped<\/ExtraParams>/);
      assert.match(UNRAID, /Target="TZ"[^>]*>Australia\/Sydney</);
    });

    it('carries every 9.1 environment variable the application reads', () => {
      for (const key of Object.keys(DEFAULTS)) {
        assert.match(
          UNRAID,
          new RegExp(`Target="${key}"`),
          `${key} is configurable in the template (lib/config.js reads it)`,
        );
      }
    });

    it('keeps credentials masked', () => {
      for (const key of ['OZB_HEALTHCHECK_SECRET', 'OZB_CSRF_SECRET', 'EMAIL_SMTP_PASS', 'MATRIX_ACCESS_TOKEN', 'NTfy_TOKEN', 'OZB_ACCOUNT_COOKIE']) {
        const block = new RegExp(`<Config[^>]*Target="${key}"[^>]*>`).exec(UNRAID);
        assert.ok(block, `${key} is present`);
        assert.match(block[0], /Mask="true"/, `${key} is masked in the UI`);
      }
    });

    it('uses the canonical public icon URL', () => {
      const icon = /<Icon>(.*)<\/Icon>/.exec(UNRAID);
      assert.ok(icon, 'an Icon element is present');
      assert.equal(
        icon[1],
        'https://raw.githubusercontent.com/jamesgallagher/OzBargainHunter/main/assets/logo/icon-256.png',
      );
      assert.doesNotMatch(UNRAID, /ozb-icon-hosting\.invalid/);
    });
  });

  describe('the supervisor, run for real', () => {
    const dirs = [];

    /** Two throwaway children: each writes a marker when it is asked to stop. */
    function fixtureDir() {
      const dir = mkdtempSync(join(tmpdir(), 'ozb-supervisor-'));
      dirs.push(dir);
      const child = (name, opts = {}) => {
        const script = [
          "const fs = require('node:fs');",
          `const marker = ${JSON.stringify(join(dir, `${name}.term`))};`,
          "process.on('SIGTERM', () => { fs.writeFileSync(marker, 'term'); process.exit(0); });",
          "process.on('SIGINT', () => { fs.writeFileSync(marker, 'int'); process.exit(0); });",
          opts.exitAfterMs
            ? `setTimeout(() => { process.exit(${opts.exitCode}); }, ${opts.exitAfterMs});`
            : 'setTimeout(() => {}, 60000);',
        ].join(' ');
        const path = join(dir, `${name}.js`);
        writeFileSync(path, script);
        return path;
      };
      return { dir, child };
    }

    /**
     * Run the supervisor with two fake children.
     * @returns {{ child: import('node:child_process').ChildProcess, exited: Promise<{code:number|null}> }}
     */
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
      const { child } = fixtureDir();
      const supervisor = runSupervisor({
        serverCmd: `${process.execPath} ${child('server')}`,
        workerCmd: `${process.execPath} ${child('worker')}`,
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        supervisor.child.kill('SIGTERM');
        const { code } = await Promise.race([
          supervisor.exited,
          new Promise((_, reject) => setTimeout(() => reject(new Error(`the supervisor did not exit:\n${supervisor.output()}`)), 15_000)),
        ]);
        assert.equal(code, 0, 'a deliberate stop is not a failure');
        assert.match(supervisor.output(), /received TERM: forwarding/);
        assert.match(supervisor.output(), /both children stopped after TERM; exiting 0/);
      } finally {
        if (supervisor.child.exitCode === null) supervisor.child.kill('SIGKILL');
      }
    });

    it('takes the survivor down and exits non-zero when one child dies', async () => {
      const { dir, child } = fixtureDir();
      const workerMarker = join(dir, 'worker.term');
      const supervisor = runSupervisor({
        // The "Next.js server" dies on its own after a moment.
        serverCmd: `${process.execPath} ${child('server', { exitAfterMs: 500, exitCode: 0 })}`,
        workerCmd: `${process.execPath} ${child('worker')}`,
      });
      try {
        const { code } = await Promise.race([
          supervisor.exited,
          new Promise((_, reject) => setTimeout(() => reject(new Error(`the supervisor did not exit:\n${supervisor.output()}`)), 20_000)),
        ]);
        assert.notEqual(code, 0, 'a child exiting on its own must not produce a successful container');
        assert.equal(code, 1, 'an exit status of 0 from the child still becomes a failure');
        assert.match(supervisor.output(), /the Next\.js server exited on its own/);
        assert.match(supervisor.output(), /exiting non-zero/);
        // The survivor was signalled rather than abandoned.
        assert.ok(existsSync(workerMarker), 'the worker was asked to stop when the server died');
      } finally {
        if (supervisor.child.exitCode === null) supervisor.child.kill('SIGKILL');
      }
    });

    it('honours SIGINT the same way as SIGTERM', async () => {
      const { child } = fixtureDir();
      const supervisor = runSupervisor({
        serverCmd: `${process.execPath} ${child('server')}`,
        workerCmd: `${process.execPath} ${child('worker')}`,
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        supervisor.child.kill('SIGINT');
        const { code } = await Promise.race([
          supervisor.exited,
          new Promise((_, reject) => setTimeout(() => reject(new Error(`no exit:\n${supervisor.output()}`)), 15_000)),
        ]);
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
});

