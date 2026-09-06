/**
 * Lint configuration for the whole workspace.
 *
 * Beyond style, this file encodes one architectural rule that `09-CODEBASE-QUALITY.md` requires to
 * be *enforced* rather than remembered: the dependency direction. `engine` and `sandbox` must run in
 * Node with no DOM, so they may not import the app or the server; the server may not import
 * frontend code. Those are expressed as `no-restricted-imports` zones below, because a rule a linter
 * checks is a rule that survives a tired afternoon.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import svelteConfig from './apps/web/svelte.config.js';

/** Paths that never belong inside the framework-agnostic layers. */
const FRONTEND_AND_SERVER_ZONES = [
  { group: ['**/apps/web/**'], message: 'engine/sandbox must not depend on the web app.' },
  { group: ['**/apps/server/**'], message: 'engine/sandbox must not depend on the server.' },
  { group: ['@edu3d/web', '@edu3d/server'], message: 'Dependency direction is one-way.' },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.svelte-kit/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // Style is settled by config, not review (09). Correctness rules only below.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-console': 'off',
      'no-else-return': ['error', { allowElseIf: false }],
      'object-shorthand': ['error', 'always'],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // A caught error that is silently discarded is the failure mode 09 calls out by name.
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },

  // The framework-agnostic layers: no DOM globals, no downstream imports.
  {
    files: ['packages/engine/**/*.ts', 'packages/sandbox/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.worker },
    },
    rules: {
      'no-restricted-imports': ['error', { patterns: FRONTEND_AND_SERVER_ZONES }],
    },
  },

  // Contracts is the shared root of the dependency graph: it imports nothing of ours.
  {
    files: ['packages/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@edu3d/*'],
              message:
                'contracts is the root of the dependency graph and imports no workspace code.',
            },
          ],
        },
      ],
    },
  },

  // The server must never reach into frontend code.
  {
    files: ['apps/server/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/web/**', '@edu3d/web'],
              message: 'server must not import frontend code.',
            },
          ],
        },
      ],
    },
  },

  // Browser code.
  {
    files: ['apps/web/**/*.{ts,svelte,js}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  ...svelte.configs.recommended,
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        extraFileExtensions: ['.svelte'],
        parser: tseslint.parser,
        svelteConfig,
      },
    },
  },

  // Tests get to be pragmatic.
  {
    files: ['**/*.test.ts', '**/*.spec.ts', 'tests/**/*.ts', 'scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-imports': 'off',
    },
  },
);
