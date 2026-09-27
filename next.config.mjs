import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Pin the tracing root to this project. Otherwise Next infers it from the
  // nearest lockfile it finds walking up the tree, so a stray lockfile in a
  // parent folder (or a git worktree nested in another checkout) moves the
  // root, nests the standalone output and can fail the build outright.
  outputFileTracingRoot: fileURLToPath(new URL('.', import.meta.url)),
  // Keep the Playwright packages external to the server bundle. Playwright
  // ships native browser binaries and drives Chromium as a child process at
  // runtime (chunk 5, `lib/ozb-login/`); bundling it into the Next.js server
  // output would break that and bloat the bundle, so it is required from
  // node_modules at runtime instead.
  serverExternalPackages: ['playwright', 'playwright-core'],
};

export default nextConfig;
