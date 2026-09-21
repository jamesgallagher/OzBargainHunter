import { register } from 'node:module';

// Register the JSX transform hook for the Next.js server tree. Loaded via
// `--import` before the test files, so any app/*.js (JSX-in-.js) is
// transformed by Next's own swc before node tries to parse it.
register('./jsx-hooks.mjs', import.meta.url);
