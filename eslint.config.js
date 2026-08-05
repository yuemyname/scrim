import tseslint from 'typescript-eslint';
import noNetwork from './eslint-rules/no-network.js';

const scrimPlugin = {
  rules: { 'no-network': noNetwork },
};

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    plugins: { scrim: scrimPlugin },
    rules: {
      'scrim/no-network': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true }],
    },
  },
  {
    // 유일한 예외: 모델 자산 로더. '/models/' 경로 fetch만 허용된다.
    files: ['src/core/assets.ts'],
    plugins: { scrim: scrimPlugin },
    rules: {
      'scrim/no-network': ['error', { allowModelFetch: true }],
    },
  },
);
