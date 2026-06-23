import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'dist/**', '**/.agent-factory/**'],
    setupFiles: ['./tests/setup.ts'],
  },
});
