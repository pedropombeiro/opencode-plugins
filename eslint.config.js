import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import prettierPlugin from 'eslint-plugin-prettier';
import unicornPlugin from 'eslint-plugin-unicorn';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    plugins: {
      prettier: prettierPlugin,
      unicorn: unicornPlugin,
    },
    rules: {
      'prettier/prettier': 'error',
      'no-console': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-lonely-if': 'error',
      'no-nested-ternary': 'error',
      'no-unneeded-ternary': 'error',
      'no-useless-return': 'error',
      'object-shorthand': 'error',
      'prefer-template': 'error',
      'unicorn/prefer-switch': ['error', { emptyDefaultCase: 'no-default-case' }],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'bun',
              importNames: ['$'],
              message: "Use exec from packages/_shared/ instead of Bun's $.",
            },
            {
              name: '@opencode/plugin',
              allowTypeImports: true,
              message: 'Import @opencode/plugin with import type only.',
            },
            {
              name: '@opencode/plugin/tui',
              allowTypeImports: true,
              message: 'Import @opencode/plugin/tui with import type only.',
            },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Bun',
          property: '$',
          message: 'Use exec from packages/_shared/ instead of Bun.$.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ConditionalExpression[test.type="UnaryExpression"][test.operator="!"]',
          message: 'Avoid negated ternary conditions; flip the condition and swap the branches.',
        },
        {
          selector: 'ConditionalExpression[test.type="BinaryExpression"][test.operator=/^!==?$/]',
          message: 'Avoid negated ternary conditions; flip the condition and swap the branches.',
        },
      ],
    },
  },
  {
    ignores: ['**/dist/**', 'node_modules/**'],
  },
);
