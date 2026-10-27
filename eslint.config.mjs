import { createRequire } from 'node:module';

// Resolve the toolchain from the service currently being linted. Each
// microservice owns its lockfile and therefore its own ESLint installation.
const require = createRequire(`${process.cwd()}/package.json`);
const eslint = require('@eslint/js');
const typescriptEslint = require('typescript-eslint');
const globals = require('globals');

export default typescriptEslint.config(
  {
    ignores: ['**/coverage/**', '**/dist/**', '**/node_modules/**'],
  },
  eslint.configs.recommended,
  ...typescriptEslint.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', '**/test-utils/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    // Unit tests frequently model only the Prisma delegate methods they use;
    // production source remains strict about explicit any.
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
