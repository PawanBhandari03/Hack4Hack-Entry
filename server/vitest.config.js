import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/globalSetup.js'],
    setupFiles: ['./tests/setup.js'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false, // one shared Mongo; files run one after another
  },
});
