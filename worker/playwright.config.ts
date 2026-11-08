import { defineConfig } from '@playwright/test';

// e2e for the self-hosted demo: real `wrangler dev --local` (local KV), seeded through the test-only route,
// which exists only because ALLOW_TEST_SEED=1 is passed here (never in wrangler.toml).
export const E2E_PORT = 8799;
// Two sellable packages and one below the 10.000.000đ floor (must not be shown on /package/).
const PACKAGES = JSON.stringify([
  { id: 'co-ban', name: 'Cơ bản', priceVnd: 10_000_000, items: ['Website 5 trang theo bản mẫu', 'Gắn tên miền .vn 1 năm', 'Chỉnh sửa 2 lần'] },
  { id: 'tron-goi', name: 'Trọn gói', priceVnd: 18_000_000, items: ['Mọi thứ trong gói Cơ bản', 'Viết nội dung từng trang', 'Hướng dẫn Fanpage', 'Hỗ trợ 6 tháng'] },
  { id: 'thu-re', name: 'Thử giá thấp', priceVnd: 2_000, items: ['Không được hiện'] },
]);
const BASE = `http://127.0.0.1:${E2E_PORT}`;
export default defineConfig({
  testDir: './test',
  testMatch: /.*\.e2e\.ts/,
  reporter: 'list',
  timeout: 30_000,
  use: { channel: 'chrome', headless: true, baseURL: BASE, locale: 'vi-VN' },
  webServer: {
    command: `wrangler dev --local --ip 127.0.0.1 --port ${E2E_PORT} --persist-to .wrangler/e2e-state --var ALLOW_TEST_SEED:1 --var API_BASE:${BASE} --var CONTACT_PHONE:0912345678 --var 'PACKAGES:${PACKAGES}'`,
    port: E2E_PORT,
    reuseExistingServer: false,
    timeout: 90_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
