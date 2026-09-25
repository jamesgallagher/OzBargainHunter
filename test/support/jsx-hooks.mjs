import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'next/dist/build/swc/index.js';

// Transform only the Next.js server tree (app/ + middleware.js). Everything
// else loads normally. The app screens are JSX-in-.js; plain node cannot
// parse them, so we run them through Next's own swc with the automatic JSX
// runtime (matching how Next compiles them in production).
// Matched on the file: URL (always forward slashes), anchored to the repo root,
// so it behaves the same on Windows and never matches an app/ inside
// node_modules.
const REPO_ROOT_URL = new URL('../../', import.meta.url).href;
function isJsxTarget(url) {
  if (!url.startsWith(REPO_ROOT_URL)) return false;
  const rel = url.slice(REPO_ROOT_URL.length).split('?')[0];
  return (rel.startsWith('app/') && rel.endsWith('.js')) || rel === 'middleware.js';
}

const SWC_OPTS = {
  jsc: {
    parser: { syntax: 'ecmascript', jsx: true },
    transform: { react: { runtime: 'automatic' } },
  },
  module: { type: 'es6' },
};

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/navigation' || specifier === 'next/navigation.js') {
    return { url: new URL('./next-navigation-stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.css')) {
    return { format: 'module', source: 'export default {};', url, shortCircuit: true };
  }
  if (isJsxTarget(url)) {
    // Read the raw source ourselves. Calling nextLoad() on a JSX file would
    // throw a SyntaxError before we get a chance to transform it.
    const source = readFileSync(fileURLToPath(url), 'utf8');
    const { code } = transformSync(source, SWC_OPTS);
    return { format: 'module', source: code, url, shortCircuit: true };
  }
  return nextLoad(url, context);
}
