import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30000,
  // Each test gets its own pdServer / pdStaticServer fixture instance on a
  // random port (see fixtures.js), so parallel workers don't collide.
  fullyParallel: true,
  workers: 2,
  use: {
    baseURL: 'about:blank',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
    // WebKit project is load-bearing: Safari's CSS engine has interpreted
    // `word-break: break-word` differently than Chromium/Firefox in the
    // past (treats it like `overflow-wrap: break-word`, only breaking at
    // natural opportunities). Without webkit in the matrix, Safari-only
    // mobile-UI regressions ship green. See render.spec.js wrap test.
    { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
    // No pixel5-firefox project: Playwright Firefox doesn't support isMobile/hasTouch
    // (which the Pixel 5 device descriptor sets to true), so the context fails to
    // create. Mobile-shape coverage comes from the 360px-viewport tests that build
    // their own context with viewport overrides.
  ],
});
