import { defineConfig } from '@playwright/test';

const PORT = 4173;
export default defineConfig({
  testDir: './test',
  testMatch: /.*\.spec\.ts/,
  reporter: 'list',
  timeout: 20_000,
  fullyParallel: true,
  use: { channel: 'chrome', headless: true, baseURL: `http://localhost:${PORT}`, locale: 'vi-VN' },
  webServer: { command: `node test/serve.mjs ${PORT}`, url: `http://localhost:${PORT}/index.html`, reuseExistingServer: true },
});
