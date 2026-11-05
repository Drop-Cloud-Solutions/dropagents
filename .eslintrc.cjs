/**
 * ESLint configuration for dropagents.
 *
 * The `import/no-restricted-paths` rule below is load-bearing: it enforces
 * v2's architectural direction (adapters → core, hosts → core; never the
 * reverse). Do not relax these zones without an ADR.
 */
module.exports = {
  root: true,
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module'
  },
  env: {
    node: true,
    es2022: true
  },
  plugins: ['import'],
  extends: ['eslint:recommended', 'plugin:import/recommended'],
  settings: {
    'import/resolver': {
      typescript: {
        project: './tsconfig.json',
        alwaysTryTypes: true
      },
      node: {
        extensions: ['.js', '.cjs', '.mjs', '.ts', '.tsx']
      }
    }
  },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    '.pipeline-workspace/',
    'shared/.cache/',
    '*.d.ts',
    // Generated: `npm run build:board` bundles board.ts + client/ into
    // this file with esbuild, and it is checked in so the board server
    // can serve it without a build step. Linting it produced 624 of the
    // repo's 768 errors — browser globals flagged as `no-undef` by the
    // node env, in code nobody writes by hand. Lint board.ts instead.
    'hosts/board-ui/board.js'
  ],
  rules: {
    // `while (true)` with an explicit break is the standard
    // ReadableStream read loop (`const { done } = await
    // reader.read(); if (done) break;`). Flagging it teaches
    // nothing and pushes people toward a contrived condition.
    'no-constant-condition': ['error', { checkLoops: false }],
    // Underscore means "required by a signature, deliberately unused" —
    // no-op port implementations, fakes, interface stubs. The convention
    // was already used throughout the codebase; the rule just was not
    // told about it, so ~100 intentional parameters read as errors and
    // buried the real ones.
    'no-unused-vars': [
      'error',
      {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }
    ],
    'import/no-restricted-paths': [
      'error',
      {
        zones: [
          {
            target: './core',
            from: './adapters',
            message:
              'core/ must not import from adapters/. The dependency direction is adapters → core.'
          },
          {
            target: './core',
            from: './hosts',
            message:
              'core/ must not import from hosts/. Hosts wire the system together; core stays pure.'
          }
        ]
      }
    ]
  },
  overrides: [
    {
      files: ['**/*.ts', '**/*.tsx'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module'
      },
      plugins: ['@typescript-eslint', 'import'],
      extends: ['plugin:@typescript-eslint/recommended', 'plugin:import/typescript'],
      rules: {
        // The TS plugin replaces the base rule, so the `^_` convention
        // has to be restated here — the root entry above does not carry
        // over to TypeScript files.
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            args: 'after-used',
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_'
          }
        ]
      }
    }
  ]
};
