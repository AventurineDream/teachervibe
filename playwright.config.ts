import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      // Phone-sized viewport without Chromium's mobile emulation: the headless
      // shell ignores isMobile (viewport meta, visual-viewport scale), which
      // breaks hit-testing on fixed bottom sheets. Layout breakpoints are
      // width-based, so a narrow desktop viewport exercises the same CSS.
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 } }
    }
  ]
});
