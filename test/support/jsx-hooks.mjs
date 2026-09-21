import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'next/dist/build/swc/index.js';

// Transform only the Next.js server tree (app/ + middleware.js). Everything
// else loads normally. The app screens are JSX-in-.js; plain node cannot
// parse them, so we run them through Next's own swc with the automatic JSX
// runtime (matching how Next compiles them in production).
const JSX_TARGET = /\/app\/.*\.js$|\/middleware\.js$/;

const SWC_OPTS = {
  jsc: {
    parser: { syntax: 'ecmascript', jsx: true },
    transform: { react: { runtime: 'automatic' } },
  },
  module: { type: 'es6' },
};

export function load(url, context, nextLoad) {
  if (url.startsWith('file:') && JSX_TARGET.test(fileURLToPath(url))) {
    // Read the raw source ourselves. Calling nextLoad() on a JSX file would
    // throw a SyntaxError before we get a chance to transform it.
    const source = readFileSync(fileURLToPath(url), 'utf8');
    const { code } = transformSync(source, SWC_OPTS);
    return { format: 'module', source: code, url, shortCircuit: true };
  }
  return nextLoad(url, context);
}
