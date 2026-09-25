/**
 * The Next.js server under test (card 5). This spawns the *production* runtime
 * the image ships — `.next/standalone/server.js`, the same entrypoint the
 * Dockerfile runs — as a child process, so the two-process assertions exercise
 * the real server rather than an in-process handler call.
 *
 * The build is produced on demand: a clean checkout has no `.next` (it is
 * gitignored), and CI job 2 runs `npm test` before anything builds the image,
 * so the suite builds it once and reuses it. The build is reused only when it
 * is newer than every source file that feeds it, so a stale build cannot mask a
 * middleware or route change.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root (this file lives in test/support/). */
export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Every directory that feeds the Next.js build output. */
const BUILD_INPUTS = ['app', 'lib', 'middleware.js', 'next.config.mjs', 'package.json', 'jsconfig.json'];

/** The newest mtime under a path (recursively for directories). */
function newestMtime(path) {
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.mtimeMs;
  let newest = stats.mtimeMs;
  for (const entry of readdirSync(path)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    newest = Math.max(newest, newestMtime(join(path, entry)));
  }
  return newest;
}

/**
 * Whether the existing standalone build is present and current.
 * @param {string} root
 * @returns {boolean}
 */
export function buildIsCurrent(root = REPO_ROOT) {
  const buildId = join(root, '.next', 'BUILD_ID');
  const server = join(root, '.next', 'standalone', 'server.js');
  if (!existsSync(buildId) || !existsSync(server)) return false;
  return newestInputMtime(root) <= statSync(buildId).mtimeMs;
}

/** The newest mtime across every build input. */
function newestInputMtime(root) {
  let newest = 0;
  for (const input of BUILD_INPUTS) {
    const path = join(root, input);
    if (existsSync(path)) newest = Math.max(newest, newestMtime(path));
  }
  return newest;
}

/**
 * A recorded build failure that no input has changed since. Retrying it would
 * spend the whole build time again only to fail the same way, once per suite
 * that needs the server, so it is reported immediately instead.
 */
function stickyBuildFailure(root, failedPath) {
  if (!existsSync(failedPath)) return null;
  if (statSync(failedPath).mtimeMs < newestInputMtime(root)) return null;
  return new Error(
    `next build failed and no build input has changed since, so it was not retried:\n${readFileSync(failedPath, 'utf8')}`,
  );
}

/**
 * Build the application if the existing output is missing or stale.
 *
 * Test files run in parallel processes and the Next.js build writes to one
 * shared `.next` directory, so two builds at once corrupt each other's output
 * (webpack's cache renames fail, and the server's route manifest can end up
 * truncated — the symptom is a build that "succeeds" and a server that cannot
 * start). Only one process may build; the others wait for the lock and then
 * accept the build it produced. A failed build is recorded, so every waiter
 * reports the same error instead of starting a second build.
 *
 * @param {string} root
 * @returns {Promise<{ built: boolean, ms: number }>}
 */
export async function ensureBuild(root = REPO_ROOT) {
  if (buildIsCurrent(root)) return { built: false, ms: 0 };

  const nextDir = join(root, '.next');
  const lockPath = join(nextDir, '.build.lock');
  const failedPath = join(nextDir, '.build.failed');
  const started = Date.now();
  mkdirSync(nextDir, { recursive: true });
  const sticky = stickyBuildFailure(root, failedPath);
  if (sticky) throw sticky;

  /** Take the lock exclusively, or report that another process holds it. */
  const takeLock = () => {
    try {
      closeSync(openSync(lockPath, 'wx'));
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      return false;
    }
  };
  const dropLock = () => rmSync(lockPath, { force: true });

  while (true) {
    if (takeLock()) {
      rmSync(failedPath, { force: true });
      try {
        const result = spawnSync(process.execPath, ['./node_modules/next/dist/bin/next', 'build'], {
          cwd: root,
          // Telemetry off, and the network guard loaded: the acceptance criterion
          // is a suite that reaches nothing but loopback, and the build is part
          // of the suite. The guard blocks every non-loopback host in this
          // process and in the workers it spawns, so a build that started
          // phoning home would fail here rather than quietly succeed.
          env: {
            ...process.env,
            NODE_ENV: 'production',
            NEXT_TELEMETRY_DISABLED: '1',
            NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import ./test/support/no-network.js']
              .filter(Boolean)
              .join(' '),
          },
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        });
        if (result.status !== 0) {
          const message = `next build failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`;
          writeFileSync(failedPath, message);
          throw new Error(message);
        }
        return { built: true, ms: Date.now() - started };
      } finally {
        dropLock();
      }
    }

    // Somebody else is building: wait for their result rather than racing them.
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (buildIsCurrent(root)) return { built: false, ms: Date.now() - started };
    if (existsSync(failedPath)) {
      throw new Error(`another process's next build failed:\n${readFileSync(failedPath, 'utf8')}`);
    }
    if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs > 15 * 60 * 1000) {
      dropLock(); // a killed process must not wedge every later run
    }
    if (Date.now() - started > 20 * 60 * 1000) {
      throw new Error('timed out waiting for another process to finish next build');
    }
  }
}

/**
 * Give the standalone server the static assets the Dockerfile also copies.
 * @param {string} root
 */
export function prepareStandaloneRuntime(root = REPO_ROOT) {
  const standalone = join(root, '.next', 'standalone');
  const staticSrc = join(root, '.next', 'static');
  if (existsSync(staticSrc)) {
    cpSync(staticSrc, join(standalone, '.next', 'static'), { recursive: true, force: true });
  }
  const publicSrc = join(root, 'public');
  if (existsSync(publicSrc)) {
    cpSync(publicSrc, join(standalone, 'public'), { recursive: true, force: true });
  }
  return standalone;
}

/**
 * Ask the OS for a free loopback port.
 * @returns {Promise<number>}
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Start the production Next.js server as a child process.
 *
 * Readiness is taken from the server's own stdout (`Ready in …`), **not** from
 * an HTTP request: the unwatched-poll test must be able to run this process to
 * completion without ever touching the application, and a liveness probe would
 * break that.
 *
 * @param {object} args
 * @param {Record<string, string>} args.env the environment for the child
 * @param {number} [args.port] the port to bind (a free one is chosen if absent)
 * @param {string} [args.root]
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, origin: string, port: number, output: () => string, stop: () => Promise<void> }>}
 */
export async function startAppServer({ env, port, root = REPO_ROOT } = {}) {
  await ensureBuild(root);
  const standalone = prepareStandaloneRuntime(root);
  const boundPort = port ?? (await freePort());

  const child = spawn(process.execPath, [join(standalone, 'server.js')], {
    cwd: standalone,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      PORT: String(boundPort),
      HOSTNAME: '127.0.0.1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const origin = `http://127.0.0.1:${boundPort}`;
  const ready = /(Ready in|Listening on)/;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the Next.js server never reported ready:\n${output}`));
    }, 60_000);
    const check = () => {
      if (ready.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', check);
    child.stderr.on('data', check);
    check();
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the Next.js server exited early (code ${code}):\n${output}`));
    });
  });

  return {
    child,
    origin,
    port: boundPort,
    output: () => output,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    },
  };
}
