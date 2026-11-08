import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Same harness as demo.e2e.ts: real `wrangler dev --local`, KV seeded through the test-only route.
const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../templates/fixtures/${name}.json`, import.meta.url)), 'utf8')
    .replace(/\/fixtures\/img\/[a-z0-9]+\.svg/g, 'assets/1-anh.png'));
const nm = (p: string) => fileURLToPath(new URL(`../node_modules/${p}`, import.meta.url));
// 8x8 green PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR42mNk2M+AFTCOSlAoAQBp9QP5ZJmsIgAAAABJRU5ErkJggg==';
const FULL_MARKER = 'FULL-MARKER-pkg-e2e-4x8';
const HTML2CANVAS = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
const DOCX = 'https://cdn.jsdelivr.net/npm/docx@9.15.3/dist/index.iife.js';

const ANALYSIS = {
  free: {
    tom_tat_doanh_nghiep: 'Cơ sở Đặc sản Tây Bắc chuyên thịt trâu gác bếp, măng khô và mắc khén do bà con bản Phiêng làm theo cách truyền thống.',
    phan_tich_nhu_cau: 'Khách ở thành phố muốn mua đặc sản thật, có nguồn gốc rõ ràng. Website cần cho thấy quy trình làm và nhận đặt hàng qua Zalo nhanh.',
    khach_hang_muc_tieu: 'Dân văn phòng 25–45 tuổi ở Hà Nội, mua làm quà biếu dịp lễ Tết.',
    muc_tieu_website: ['Nhận đơn đặt hàng qua Zalo', 'Tạo niềm tin bằng hình ảnh bản làng thật'],
    phong_cach: { mo_ta: 'Mộc mạc, ấm áp, gần gũi với núi rừng.', bang_mau: ['#7A3E1D', '#E8A317', '#F4F5EF'] },
    nhan_xet_web_tham_khao: [{ nguon: 'dacsanvungmien.vn', diem_hoc_hoi: 'Ảnh sản phẩm lớn, giá hiện rõ.' }],
    so_do_trang: [
      { trang: 'Trang chủ', muc_dich: 'Giới thiệu cơ sở và sản phẩm nổi bật' },
      { trang: 'Sản phẩm', muc_dich: 'Danh sách đặc sản kèm giá' },
      { trang: 'Liên hệ', muc_dich: 'Gọi điện, nhắn Zalo, chỉ đường' },
    ],
  },
  full: {
    noi_dung_tung_trang: [{ trang: 'Trang chủ', cac_khoi: [{ tieu_de: FULL_MARKER, noi_dung: 'Nội dung chi tiết chỉ dành cho khách đã thanh toán.' }] }],
    ke_hoach_trien_khai: [{ buoc: 'Chốt nội dung', viec: ['Gửi ảnh thật'] }, { buoc: 'Đưa lên mạng', viec: ['Gắn tên miền'] }],
    goi_y_fanpage: ['Đăng ảnh bếp gác mỗi tuần'],
    viec_khach_can_chuan_bi: ['Logo', 'Ảnh sản phẩm'],
  },
};

async function seed(page: Page, id: string, opts: { paid?: boolean } = {}) {
  const site = fixture('shop-dac-san');
  const template = 'tpl-ban-hang';
  const meta = { siteId: id, phone: '0900000000', leadKey: 'k'.repeat(32), handoffKey: 'h'.repeat(32), template,
    expires: '2099-01-01T00:00:00.000Z', revisions: 0, createdAt: '2026-11-08T00:00:00.000Z', name: site.brand.name, analysisReady: true };
  const entries: { key: string; value: unknown }[] = [
    { key: `site:${id}`, value: meta },
    { key: `sitejson:${id}`, value: { ...site, siteId: id, template, hero: { ...site.hero, image: 'assets/1-anh.png' },
      demo: { badge: true, expires: '2099-01-01', checkoutUrl: '' } } },
    { key: `analysis:${id}`, value: ANALYSIS },
    { key: `asset:${id}:assets/1-anh.png`, value: { mime: 'image/png', base64: PNG } },
  ];
  if (opts.paid) entries.push({ key: `paid:${id}`, value: '1' });
  const res = await page.request.post('/__test/seed', { data: { entries } });
  expect(res.status()).toBe(200);
}

/** CDN scripts come from node_modules; any other off-origin request fails the test. */
async function wire(page: Page, o: { failCanvas?: boolean } = {}) {
  const errors: string[] = [];
  const cdn: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (r) => {
    const url = r.request().url();
    cdn.push(url);
    if (url === HTML2CANVAS && !o.failCanvas) return r.fulfill({ path: nm('html2canvas/dist/html2canvas.min.js'), contentType: 'text/javascript' });
    if (url === DOCX) return r.fulfill({ path: nm('docx/dist/index.iife.js'), contentType: 'text/javascript' });
    if (url === HTML2CANVAS) return r.abort();
    errors.push(`unexpected external request ${url}`);
    return r.abort();
  });
  await page.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return { errors, cdn };
}

test('unpaid: free analysis, locked full, demo link, packages; PNG and DOCX downloads', async ({ page }) => {
  const id = 'e2e-pkg-aaaaaa';
  const { errors, cdn } = await wire(page);
  await seed(page, id);
  await page.setViewportSize({ width: 1280, height: 900 });
  const res = await page.goto(`/package/${id}`);
  expect(res!.status()).toBe(200);
  expect(res!.headers()['x-robots-tag']).toBe('noindex, nofollow');

  await expect(page.locator('.cover h1')).toContainText('Đặc sản');
  const open = page.getByRole('link', { name: 'Mở website mẫu' }).first();
  await expect(open).toHaveAttribute('href', `http://127.0.0.1:8799/d/${id}/`);
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(page.locator('#phan-tich')).toContainText('thịt trâu gác bếp');
  await expect(page.locator('.locked')).toContainText('Mở khoá sau khi triển khai chính thức');
  await expect(page.locator('.pkg')).toHaveCount(2); // 'thu-re' is below the floor
  await expect(page.locator('.pkg').first()).toContainText('10.000.000đ');
  expect(await page.content()).not.toContain(FULL_MARKER);

  // Screenshots: html2canvas is fetched (lazily, when capture starts); docx is not fetched until "Tải Word".
  const mobileBtn = page.getByRole('link', { name: 'Tải ảnh điện thoại' });
  await expect(mobileBtn).toBeVisible({ timeout: 20_000 });
  expect(cdn).toContain(HTML2CANVAS);
  expect(cdn).not.toContain(DOCX);

  const [dl] = await Promise.all([page.waitForEvent('download'), mobileBtn.click()]);
  expect(dl.suggestedFilename()).toBe(`giao-dien-${id}-mobile.png`);
  const png = readFileSync((await dl.path())!);
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Tải ảnh máy tính' }).click()]);
  expect(dl2.suggestedFilename()).toBe(`giao-dien-${id}-desktop.png`);
  expect([...readFileSync((await dl2.path())!).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

  const [dl3] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), page.getByRole('button', { name: 'Tải Word (DOCX)' }).click()]);
  expect(dl3.suggestedFilename()).toBe(`phan-tich-${id}.docx`);
  const docx = readFileSync((await dl3.path())!);
  expect(docx.subarray(0, 2).toString('latin1')).toBe('PK');
  expect(docx.length).toBeGreaterThan(5_000); // has the screenshots embedded
  expect(cdn).toContain(DOCX);

  expect(await page.evaluate(() => (window as any).__csp)).toEqual([]);
  expect(errors).toEqual([]);
});

test('"Tải PDF" calls window.print(); print view hides buttons and shows the cover', async ({ page }) => {
  const id = 'e2e-pkg-bbbbbb';
  const { errors } = await wire(page);
  await page.addInitScript(() => { (window as any).__printed = 0; window.print = () => { (window as any).__printed++; }; });
  await seed(page, id);
  await page.goto(`/package/${id}`);
  await expect(page.getByRole('link', { name: 'Tải ảnh máy tính' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Tải PDF' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__printed)).toBe(1);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.print-cover')).toBeVisible();
  await expect(page.locator('.print-toc')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tải PDF' })).toBeHidden();
  await expect(page.locator('.shot img').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('paid: full analysis is shown, no lock', async ({ page }) => {
  const id = 'e2e-pkg-cccccc';
  const { errors } = await wire(page);
  await seed(page, id, { paid: true });
  await page.goto(`/package/${id}`);
  await expect(page.locator('#phan-tich')).toContainText(FULL_MARKER);
  await expect(page.locator('.locked')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('capture fails → download buttons hidden, "Mở website mẫu để xem" shown', async ({ page }) => {
  const id = 'e2e-pkg-dddddd';
  await wire(page, { failCanvas: true });
  await seed(page, id);
  await page.goto(`/package/${id}`);
  await expect(page.locator('.shot-fail').first()).toContainText('Mở website mẫu để xem', { timeout: 20_000 });
  await expect(page.getByRole('link', { name: 'Tải ảnh điện thoại' })).toHaveCount(0);
});

test('checkout: "Chọn gói" posts /api/checkout and goes to checkoutUrl', async ({ page }) => {
  const id = 'e2e-pkg-eeeeee';
  await wire(page);
  await seed(page, id);
  let body: any = null;
  await page.route('**/api/checkout', (r) => { body = r.request().postDataJSON(); return r.fulfill({ json: { checkoutUrl: 'http://127.0.0.1:8799/__paid-stub' } }); });
  await page.route('**/__paid-stub', (r) => r.fulfill({ contentType: 'text/html', body: '<p>payos</p>' }));
  await page.goto(`/package/${id}`);
  await page.locator('.pkg').first().getByRole('button').click();
  await page.waitForURL('**/__paid-stub');
  expect(body).toEqual({ siteId: id, packageId: 'co-ban' });
});

test('expired package page → 410', async ({ page }) => {
  const id = 'e2e-pkg-ffffff';
  await seed(page, id);
  await page.request.post('/__test/seed', { data: { entries: [{ key: `site:${id}`, value: {
    siteId: id, phone: '0900000000', leadKey: 'k'.repeat(32), handoffKey: 'h'.repeat(32), template: 'tpl-ban-hang',
    expires: '2020-01-01T00:00:00.000Z', revisions: 0, createdAt: '2019-12-01T00:00:00.000Z', name: 'Cũ', analysisReady: true } }] } });
  const res = await page.goto(`/package/${id}`);
  expect(res!.status()).toBe(410);
  await expect(page.locator('h1')).toHaveText('Bản dùng thử đã hết hạn');
});

// Visual review (not an assertion): PKG_SHOTS_DIR=/abs/dir pnpm exec playwright test package.e2e -g "visual review"
test('visual review screenshots (only with PKG_SHOTS_DIR)', async ({ page }) => {
  const dir = process.env.PKG_SHOTS_DIR;
  test.skip(!dir, 'set PKG_SHOTS_DIR to write screenshots');
  const id = 'e2e-pkg-visual';
  await wire(page);
  await seed(page, id);
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/package/${id}`);
    await expect(page.getByRole('link', { name: 'Tải ảnh máy tính' })).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `${dir}/package-${width}.png`, fullPage: true });
  }
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Tải ảnh điện thoại' }).click()]);
  await dl.saveAs(`${dir}/giao-dien-mobile.png`);
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Tải ảnh máy tính' }).click()]);
  await dl2.saveAs(`${dir}/giao-dien-desktop.png`);
  const [dl3] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Tải Word (DOCX)' }).click()]);
  await dl3.saveAs(`${dir}/phan-tich.docx`);
  await page.emulateMedia({ media: 'print' });
  await page.pdf({ path: `${dir}/print.pdf`, format: 'A4', preferCSSPageSize: true, printBackground: true });
});
