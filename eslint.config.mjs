import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['dist/', 'coverage/'] },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
  },
  {
    files: ['test/**/*.ts'],
    // Tests read untyped JSON bodies and pass the container through globalThis.
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
