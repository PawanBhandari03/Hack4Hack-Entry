import { defineConfig, devices } from '@playwright/test';

// Point at any running stack:
//   local dev:       BASE_URL=http://localhost:5173 API_URL=http://localhost:4000   (defaults)
//   docker compose:  BASE_URL=http://localhost:8080 API_URL=http://localhost:4000
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
