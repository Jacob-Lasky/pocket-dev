import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'about:blank',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
    // No pixel5-firefox project: Playwright Firefox doesn't support isMobile/hasTouch
    // (which the Pixel 5 device descriptor sets to true), so the context fails to
    // create. Mobile-shape coverage comes from the 360px-viewport test in smoke.spec.
  ],
});
