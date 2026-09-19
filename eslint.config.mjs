import next from '@next/eslint-plugin-next';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import importPlugin from 'eslint-plugin-import';
import jsxA11y from 'eslint-plugin-jsx-a11y';

/**
 * ESLint flat config.
 *
 * We build this from the individual plugins that `eslint-config-next` bundles
 * rather than importing its legacy (eslintrc) entry. The legacy entry runs
 * `@rushstack/eslint-patch/modern-module-resolution` at import time, which
 * throws on the installed ESLint 9.39.x when loaded from a flat config. The
 * plugins below are the same set, referenced directly, so the lint surface is
 * unchanged without touching the patch. `next lint` is not used.
 */
const eslintConfig = [
  {
    ignores: ['**/node_modules/**', '.next/**', 'out/**', 'fixtures/**'],
  },
  react.configs.flat.recommended,
  reactHooks.configs['recommended-latest'],
  next.flatConfig.recommended,
  importPlugin.flatConfigs.recommended,
  jsxA11y.flatConfigs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      'import/no-anonymous-default-export': 'warn',
      'react/no-unknown-property': 'off',
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'jsx-a11y/alt-text': [
        'warn',
        {
          elements: ['img'],
          img: ['Image'],
        },
      ],
      'jsx-a11y/aria-props': 'warn',
      'jsx-a11y/aria-proptypes': 'warn',
      'jsx-a11y/aria-unsupported-elements': 'warn',
      'jsx-a11y/role-has-required-aria-props': 'warn',
      'jsx-a11y/role-supports-aria-props': 'warn',
      'react/jsx-no-target-blank': 'off',
    },
  },
];

export default eslintConfig;
