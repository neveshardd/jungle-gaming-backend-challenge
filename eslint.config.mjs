import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Money must never be represented as a JS number: forbid parseFloat/Number on amounts by convention
      'no-restricted-globals': ['error', { name: 'parseFloat', message: 'Never parse monetary values as floats; use Money.' }],
    },
  },
);
