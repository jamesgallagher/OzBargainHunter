import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Pin the tracing root to this project. Otherwise Next infers it from the
  // nearest lockfile it finds walking up the tree, so a stray lockfile in a
  // parent folder (or a git worktree nested in another checkout) moves the
  // root, nests the standalone output and can fail the build outright.
  outputFileTracingRoot: fileURLToPath(new URL('.', import.meta.url)),
};

export default nextConfig;
