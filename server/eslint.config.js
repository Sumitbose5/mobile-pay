import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'src/db/migrations'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  { files: ['src/db/migrate.ts', 'src/db/seed.ts', 'src/db/reset.ts', 'scripts/*.ts'], rules: { 'no-console': 'off' } },
);
