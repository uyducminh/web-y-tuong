import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: /.*\.spec\.ts/,
  globalSetup: './test/visual.setup.ts',
  fullyParallel: true,
  reporter: 'list',
  use: { channel: 'chrome', headless: true },
});
