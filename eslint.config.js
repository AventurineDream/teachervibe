// ESLint flat config for the TypeScript sources, unit tests and Playwright specs.
// Uses only the recommended rule sets: formatting belongs to Prettier (.prettierrc),
// and type-aware rules are left out so `npm run lint` needs no extra tsconfig pass.
// `tseslint.configs.recommended` already turns off no-undef for TypeScript files, so
// browser and Node globals need no declaration here.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'test-results/', 'playwright-report/'],
  },
  js.configs.recommended,
  tseslint.configs.recommended
);
