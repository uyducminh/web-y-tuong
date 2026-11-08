import { test, expect, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { BANG_GIA, makeXlsxBytes, XLSX_MIME } from './xlsx-fixture';

type Call = { path: string; method: string; body: any; raw?: Buffer | null; at: number; done?: number };
type Handler = (call: Call, n: number) => { status?: number; json: unknown; delay?: number };

/** /api/status/x → /api/status, /api/brief/<id> → /api/brief (but /api/brief/confirm stays itself). */
const keyOf = (p: string) => (p === '/api/brief/confirm' ? p : p.replace(/^\/api\/(status|proposal|jobs|brief)\/.+$/, '/api/$1'));

/** Mocks the Worker: every request to /api/** is answered by handlers[path-without-ids] and recorded. */
async function mockApi(page: Page, handlers: Record<string, Handler>): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const key = keyOf(url.pathname);
    let body: any = null;
    const ct = req.headers()['content-type'] || '';
    if (ct.includes('application/json')) body = req.postDataJSON();
    else if (req.postData()) body = 'multipart';
    const call: Call = { path: url.pathname, method: req.method(), body, raw: req.postDataBuffer(), at: Date.now() };
    calls.push(call);
    const h = handlers[key];
    if (!h) { await route.fulfill({ status: 404, json: { error: 'không có mock' } }); return; }
    const n = calls.filter((c) => keyOf(c.path) === key).length;
    const r = h(call, n);
    if (r.delay) await new Promise((res) => setTimeout(res, r.delay));
    call.done = Date.now();
    await route.fulfill({ status: r.status ?? 200, json: r.json });
  });
  return calls;
}

const LABELS = ['Đơn vị và ngành nghề', 'Sản phẩm và dịch vụ', 'Khách hàng', 'Mục tiêu website', 'Phong cách',
  'Website tham khảo', 'Tài liệu và hình ảnh', 'Liên hệ và xác nhận'];
const IDS = ['don_vi', 'san_pham', 'khach_hang', 'muc_tieu', 'phong_cach', 'tham_khao', 'tai_lieu', 'xac_nhan'];
const stepAt = (index: number) => ({ id: IDS[index - 1], index, label: LABELS[index - 1] });

const session: Handler = () => ({ json: { sessionId: 'sess-1' } });
const chatReply = (over: Record<string, unknown> = {}): Handler => () => ({
  json: {
    reply: 'Chào bạn! Đơn vị của bạn tên là gì?', quickReplies: ['HTX Cà phê Cầu Đất', 'Cơ sở mây tre'],
    step: stepAt(1), done: [], missing: ['ten_don_vi'], canConfirm: false, turnsLeft: 29, mustConfirm: false, ...over,
  },
});
const NOTICE = 'Bản dùng thử là công khai, vui lòng không gửi thông tin nhạy cảm.';
const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const GEN = { name: 'Tạo bản dùng thử', exact: true } as const;

const FULL_BRIEF = {
  ten_don_vi: 'HTX Cà phê Cầu Đất', loai_hinh: 'htx', nganh: 'Cà phê', dia_phuong: 'Đà Lạt, Lâm Đồng',
  san_pham: [{ ten: 'Cà phê Arabica rang mộc', gia: 180000 }, { ten: 'Trà atiso' }],
  diem_khac_biet: 'Trồng ở độ cao 1.600m, rang mộc', khach_hang_muc_tieu: 'Quán cà phê và khách mua quà',
  muc_tieu_chinh: 'ban-hang', hanh_dong_mong_muon: 'zalo', cam_giac: 'moc-mac', mau_chu_dao: '#8a5a2b',
  lien_he: { phone: '0912345678', address: 'Cầu Đất, Đà Lạt' }, meta: { askedOptional: ['tham_khao', 'tai_lieu'] },
};
const atConfirm = chatReply({
  reply: 'Mình đã đủ thông tin. Bạn xem lại bản tóm tắt nhé.', quickReplies: [],
  step: stepAt(8), done: IDS, missing: [], canConfirm: true, turnsLeft: 18,
});

async function ownSession(page: Page, value: Record<string, unknown>) {
  await page.addInitScript((v) => sessionStorage.setItem('sme.session', JSON.stringify(v)), value);
}

/** SheetJS is loaded from cdnjs in the page; tests serve the npm build instead (no network). */
const XLSX_JS = readFileSync(createRequire(import.meta.url).resolve('xlsx/dist/xlsx.full.min.js'));
async function serveSheetJs(page: Page) {
  let n = 0;
  await page.route('https://cdnjs.cloudflare.com/**', async (route) => {
    n++;
    await route.fulfill({ body: XLSX_JS, contentType: 'text/javascript' });
  });
  return () => n;
}

test('trang chủ có 3 nút chọn nhu cầu dẫn vào trò chuyện', async ({ page }) => {
  await page.goto('/index.html');
  const needs = page.locator('[data-need]');
  await expect(needs).toHaveCount(3);
  await expect(page.getByText('10.000.000đ').first()).toBeVisible();
  await needs.first().click();
  await expect(page).toHaveURL(/chat\.html\?need=gioi-thieu/);
});

test('trò chuyện: nút nhu cầu, câu trả lời, gợi ý nhanh, thanh bước và dòng nhắc', async ({ page }) => {
  const calls = await mockApi(page, {
    '/api/session': session,
    '/api/chat': (c, n) => chatReply(n === 1 ? {} : { step: stepAt(3), done: ['don_vi', 'san_pham'], turnsLeft: 28 })(c, n),
  });
  await page.goto('/chat.html');
  await expect(page.getByText(NOTICE)).toBeVisible();
  await expect(page.locator('#step-now')).toHaveText('Bước 1/8 · Đơn vị và ngành nghề');
  const needs = page.locator('[data-need]');
  await expect(needs).toHaveCount(3);
  await needs.nth(2).click();
  await expect(page.getByText('Chào bạn! Đơn vị của bạn tên là gì?')).toBeVisible();
  await expect(page.getByText('Còn 29/30 lượt')).toBeVisible();
  expect(calls.find((c) => c.path === '/api/session')!.body).toEqual({ turnstileToken: 'dev' });
  const chat = calls.find((c) => c.path === '/api/chat')!;
  expect(chat.body.sessionId).toBe('sess-1');
  expect(chat.body.text).toMatch(/bán hàng/i);

  // a quick reply sends its text as the next message; the step bar follows step.index from the API
  await page.getByRole('button', { name: 'Cơ sở mây tre' }).click();
  await expect.poll(() => calls.filter((c) => c.path === '/api/chat').length).toBe(2);
  expect(calls.filter((c) => c.path === '/api/chat')[1].body.text).toBe('Cơ sở mây tre');
  await expect(page.locator('#step-now')).toHaveText('Bước 3/8 · Khách hàng');
  await page.locator('#stepbar summary').click();
  const items = page.locator('.step-list li');
  await expect(items).toHaveCount(8);
  await expect(items.nth(0)).toHaveClass(/is-done/);
  await expect(items.nth(1)).toHaveClass(/is-done/);
  await expect(items.nth(2)).toHaveAttribute('aria-current', 'step');
  await expect(items.nth(3)).not.toHaveClass(/is-done/);
  await expect(page.getByText(NOTICE)).toBeVisible();
});

test('?need= từ trang chủ tự gửi nhu cầu đầu tiên', async ({ page }) => {
  const calls = await mockApi(page, { '/api/session': session, '/api/chat': chatReply() });
  await page.goto('/chat.html?need=thu-lead');
  await expect(page.getByText('Chào bạn! Đơn vị của bạn tên là gì?')).toBeVisible();
  expect(calls.find((c) => c.path === '/api/chat')!.body.text).toMatch(/thông tin khách/i);
});

test('thẻ chọn một: bấm thẻ gửi đúng label; thẻ cũ bị gỡ', async ({ page }) => {
  const calls = await mockApi(page, {
    '/api/session': session,
    '/api/chat': (c, n) => chatReply(n === 1 ? {
      reply: 'Đơn vị của bạn là loại hình nào?',
      choices: { kind: 'single', options: [{ value: 'htx', label: 'Hợp tác xã' }, { value: 'ho-kd', label: 'Hộ kinh doanh', hint: 'Cơ sở gia đình' }] },
    } : {})(c, n),
  });
  await page.goto('/chat.html');
  await page.locator('[data-need]').first().click();
  const card = page.getByRole('button', { name: /Hộ kinh doanh/ });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Cơ sở gia đình');
  const box = await card.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(52); // big touch target
  await card.click();
  await expect.poll(() => calls.filter((c) => c.path === '/api/chat').length).toBe(2);
  expect(calls.filter((c) => c.path === '/api/chat')[1].body.text).toBe('Hộ kinh doanh');
  await expect(page.locator('.choices')).toHaveCount(0);
});

test('thẻ chọn nhiều: chọn 2 thẻ rồi bấm "Xong" gửi các label', async ({ page }) => {
  const calls = await mockApi(page, {
    '/api/session': session,
    '/api/chat': (c, n) => chatReply(n === 1 ? {
      reply: 'Hiện bạn đang bán qua kênh nào?',
      choices: { kind: 'multi', options: [{ value: 'zalo', label: 'Zalo' }, { value: 'fb', label: 'Facebook' }, { value: 'cho', label: 'Bán ở chợ' }] },
    } : {})(c, n),
  });
  await page.goto('/chat.html');
  await page.locator('[data-need]').first().click();
  const done = page.getByRole('button', { name: /^Xong/ });
  await expect(done).toBeDisabled();
  await page.getByRole('button', { name: 'Zalo' }).click();
  await page.getByRole('button', { name: 'Bán ở chợ' }).click();
  await expect(page.getByRole('button', { name: 'Zalo' })).toHaveAttribute('aria-pressed', 'true');
  await done.click();
  await expect.poll(() => calls.filter((c) => c.path === '/api/chat').length).toBe(2);
  expect(calls.filter((c) => c.path === '/api/chat')[1].body.text).toBe('Zalo, Bán ở chợ');
});

test('thẻ phong cách có khối màu minh hoạ, không dùng ảnh ngoài', async ({ page }) => {
  await mockApi(page, {
    '/api/session': session,
    '/api/chat': chatReply({
      reply: 'Bạn muốn website mang cảm giác thế nào?', step: stepAt(5), done: IDS.slice(0, 4),
      choices: { kind: 'single', options: [
        { value: 'moc-mac', label: 'Mộc mạc', hint: 'Gần gũi, màu đất' }, { value: 'truyen-thong', label: 'Truyền thống' },
        { value: 'hien-dai', label: 'Hiện đại' }, { value: 'sang-trong', label: 'Sang trọng' }, { value: 'tre-trung', label: 'Trẻ trung' }] },
    }),
  });
  await page.goto('/chat.html');
  await page.locator('[data-need]').first().click();
  await expect(page.locator('#step-now')).toHaveText('Bước 5/8 · Phong cách');
  const cards = page.locator('.choices-style .choice');
  await expect(cards).toHaveCount(5);
  await expect(cards.first().locator('.swatch i')).toHaveCount(4);
  const bg = await cards.first().locator('.swatch i').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  await expect(page.locator('.choices img')).toHaveCount(0);
});

test('nút tạo demo ẩn khi canConfirm là false; hiện khi mustConfirm', async ({ page }) => {
  await mockApi(page, {
    '/api/session': session,
    '/api/chat': (c, n) => chatReply(n === 1
      ? { step: stepAt(3), canConfirm: false }
      : { step: stepAt(8), done: IDS.slice(0, 7), canConfirm: false, missing: ['lien_he.phone|zalo'], turnsLeft: 0, mustConfirm: true })(c, n),
  });
  await page.goto('/chat.html');
  await expect(page.getByRole('button', GEN)).toBeHidden();
  await page.locator('[data-need]').first().click();
  await expect(page.getByText('Chào bạn! Đơn vị của bạn tên là gì?')).toBeVisible();
  await expect(page.getByRole('button', GEN)).toBeHidden();
  await page.locator('#msg').fill('HTX A');
  await page.locator('#send').click();
  await expect(page.getByRole('button', GEN)).toBeVisible();
  await expect(page.getByRole('button', GEN)).toHaveClass(/is-ready/);
  await expect(page.locator('#msg')).toBeDisabled();
  await expect(page.locator('#send')).toBeDisabled();
});

test('bước 8 và canConfirm: hiện bản tóm tắt; "Sửa" ở bước 2 gửi tin chat yêu cầu sửa', async ({ page }) => {
  const calls = await mockApi(page, {
    '/api/session': session,
    '/api/chat': (c, n) => (n === 1 ? atConfirm(c, n) : chatReply({ step: stepAt(2), reply: 'Bạn muốn sửa sản phẩm nào?' })(c, n)),
    '/api/brief': () => ({ json: { brief: FULL_BRIEF, step: stepAt(8), done: IDS, missing: [], canConfirm: true } }),
  });
  await page.goto('/chat.html');
  await page.locator('[data-need]').first().click();
  const sum = page.locator('#summary');
  await expect(sum).toBeVisible();
  await expect(sum.locator('.sum-step')).toHaveCount(8);
  await expect(sum).toContainText('HTX Cà phê Cầu Đất');
  await expect(sum).toContainText('Hợp tác xã');
  await expect(sum).toContainText('180.000đ');
  await expect(sum).toContainText('Mộc mạc, gần gũi');
  await expect(sum).toContainText('Nhắn Zalo');
  await expect(sum).toContainText('0912345678');
  await expect(page.getByRole('button', { name: 'Đúng rồi, tạo bản dùng thử' })).toBeVisible();
  await expect(page.getByRole('button', GEN)).toBeVisible();
  expect(calls.find((c) => c.path === '/api/brief/sess-1')).toBeTruthy();

  await page.getByRole('button', { name: 'Sửa bước 2: Sản phẩm và dịch vụ' }).click();
  await expect.poll(() => calls.filter((c) => c.path === '/api/chat').length).toBe(2);
  const edit = calls.filter((c) => c.path === '/api/chat')[1].body.text;
  expect(edit).toMatch(/sửa/i);
  expect(edit).toContain('Sản phẩm và dịch vụ');
  await expect(page.locator('#summary')).toHaveCount(0);
  await expect(page.getByRole('button', GEN)).toBeHidden();
});

test('xác nhận: form điền sẵn SĐT từ phiếu, gọi confirm (kèm lien_he) rồi generate, chuyển sang trang trạng thái', async ({ page }) => {
  const calls = await mockApi(page, {
    '/api/session': session,
    '/api/chat': atConfirm,
    '/api/brief': () => ({ json: { brief: FULL_BRIEF, step: stepAt(8), done: IDS, missing: [], canConfirm: true } }),
    '/api/brief/confirm': () => ({ json: { ok: true } }),
    '/api/generate': () => ({ json: { jobId: 'job1' }, delay: 600 }),
    '/api/jobs': () => ({ json: { id: 'job1', siteId: 'demo-a', state: 'pending', next: 'wait' }, delay: 5000 }),
  });
  await page.goto('/chat.html');
  await page.locator('[data-need]').first().click();
  await page.getByRole('button', { name: 'Đúng rồi, tạo bản dùng thử' }).click();
  await expect(page.getByLabel(/Số điện thoại/)).toHaveValue('0912345678');
  await page.getByLabel('Tên của bạn').fill('Chị Lan');
  await page.getByLabel(/Số điện thoại/).fill('0912 345 679');
  await page.getByRole('button', { name: 'Gửi và tạo bản dùng thử' }).click();
  const submit = page.locator('#gen-submit');
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveText('Đang gửi…');
  await submit.click({ force: true }).catch(() => {});
  await expect(page).toHaveURL(/status\.html\?job=job1/);
  const conf = calls.filter((c) => c.path === '/api/brief/confirm');
  expect(conf).toHaveLength(1);
  expect(conf[0].body).toEqual({ sessionId: 'sess-1', lien_he: { phone: '0912345679' }, name: 'Chị Lan' });
  const gens = calls.filter((c) => c.path === '/api/generate');
  expect(gens).toHaveLength(1);
  expect(gens[0].at).toBeGreaterThanOrEqual(conf[0].done!);
  expect(gens[0].body).toEqual({ sessionId: 'sess-1', phone: '0912345679', name: 'Chị Lan' });
  const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem('sme.session') || '{}'));
  expect(stored).toMatchObject({ sessionId: 'sess-1', jobId: 'job1' });
  expect(stored.revisionsLeft).toBeUndefined();
});

test('khi trợ lý đang trả lời: nút gửi tệp và nút "Gửi và tạo bản dùng thử" bị khoá, trả lời xong thì mở lại', async ({ page }) => {
  await mockApi(page, {
    '/api/session': session,
    '/api/chat': (c, n) => (n === 1 ? { ...atConfirm(c, n) } : { ...chatReply()(c, n), delay: 1500 }),
    '/api/brief': () => ({ json: { brief: FULL_BRIEF, step: stepAt(8), done: IDS, missing: [], canConfirm: true } }),
  });
  await page.goto('/chat.html');
  await page.locator('[data-need]').first().click();
  await page.getByRole('button', { name: 'Đúng rồi, tạo bản dùng thử' }).click();
  const file = page.locator('#file-btn');
  const submit = page.locator('#gen-submit');
  await expect(file).toBeEnabled();
  await expect(submit).toBeEnabled();
  await page.locator('#msg').fill('Mình muốn thêm một sản phẩm');
  await page.locator('#msg').press('Enter');
  await expect(file).toBeDisabled();
  await expect(submit).toBeDisabled();
  await expect(page.getByText('Chào bạn! Đơn vị của bạn tên là gì?')).toBeVisible();
  await expect(file).toBeEnabled();
  await expect(submit).toBeEnabled();
});

test('xác nhận bị 409 (thiếu mục): báo lỗi tiếng Việt, không gọi generate', async ({ page }) => {
  const calls = await mockApi(page, {
    '/api/session': session,
    '/api/chat': chatReply({ step: stepAt(8), done: IDS.slice(0, 7), canConfirm: false, missing: ['cam_giac'], turnsLeft: 0, mustConfirm: true }),
    '/api/brief': () => ({ json: { brief: {}, step: stepAt(5), done: [], missing: ['cam_giac'], canConfirm: false } }),
    '/api/brief/confirm': () => ({ status: 409, json: { error: 'Còn thiếu một số thông tin bắt buộc. Vui lòng bổ sung trước khi xác nhận.', missing: ['cam_giac'] } }),
  });
  await page.goto('/chat.html');
  await page.locator('[data-need]').first().click();
  await page.getByRole('button', GEN).click();
  await page.getByLabel('Tên của bạn').fill('Chị Lan');
  await page.getByLabel(/Số điện thoại/).fill('0912345678');
  await page.getByRole('button', { name: 'Gửi và tạo bản dùng thử' }).click();
  await expect(page.locator('#gen-error')).toContainText('Còn thiếu');
  await expect(page.locator('#gen-error')).toContainText('phong cách');
  expect(calls.filter((c) => c.path === '/api/generate')).toHaveLength(0);
});

test('thiếu SĐT thì không gửi được form', async ({ page }) => {
  const calls = await mockApi(page, {
    '/api/session': session, '/api/chat': atConfirm,
    '/api/brief': () => ({ json: { brief: { ...FULL_BRIEF, lien_he: {} }, step: stepAt(8), done: IDS, missing: [], canConfirm: true } }),
    '/api/brief/confirm': () => ({ json: { ok: true } }), '/api/generate': () => ({ json: { jobId: 'j1' } }),
  });
  await page.goto('/chat.html');
  await page.locator('[data-need]').first().click();
  await page.getByRole('button', GEN).click();
  await page.getByLabel('Tên của bạn').fill('Chị Lan');
  await page.getByRole('button', { name: 'Gửi và tạo bản dùng thử' }).click();
  await expect(page.locator('#gen-error')).toContainText('số điện thoại');
  await page.getByLabel(/Số điện thoại/).fill('12345');
  await page.getByRole('button', { name: 'Gửi và tạo bản dùng thử' }).click();
  await expect(page.locator('#gen-error')).toContainText('10 chữ số');
  expect(calls.filter((c) => c.path === '/api/generate' || c.path === '/api/brief/confirm')).toHaveLength(0);
});

test('SĐT đã có bản dùng thử: hiện link bộ hồ sơ cũ', async ({ page }) => {
  await mockApi(page, {
    '/api/session': session, '/api/chat': atConfirm,
    '/api/brief': () => ({ json: { brief: FULL_BRIEF, step: stepAt(8), done: IDS, missing: [], canConfirm: true } }),
    '/api/brief/confirm': () => ({ json: { ok: true } }),
    '/api/generate': () => ({ status: 409, json: { error: 'Số điện thoại này đã có bản dùng thử.', siteId: 'demo-old', url: 'http://api.test/package/demo-old' } }),
  });
  await page.goto('/chat.html');
  await page.locator('[data-need]').first().click();
  await page.getByRole('button', GEN).click();
  await page.getByLabel('Tên của bạn').fill('Chị Lan');
  await page.getByRole('button', { name: 'Gửi và tạo bản dùng thử' }).click();
  await expect(page.locator('#gen-error')).toContainText('đã có bản dùng thử');
  await expect(page.locator('#gen-error a[href="http://api.test/package/demo-old"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Gửi và tạo bản dùng thử' })).toBeEnabled();
});

test('phiên hết hạn (404): lần gửi lại tạo phiên mới thay vì dùng lại id cũ', async ({ page }) => {
  const calls = await mockApi(page, {
    '/api/session': (_c, n) => ({ json: { sessionId: `sess-${n}` } }),
    '/api/chat': (c) => (c.body.sessionId === 'sess-1'
      ? { status: 404, json: { error: 'Không tìm thấy phiên trò chuyện. Vui lòng tải lại trang để bắt đầu lại.' } }
      : chatReply()(c, 1)),
  });
  await page.goto('/chat.html');
  await page.locator('[data-need]').first().click();
  await expect(page.locator('#chat-error')).toContainText('hết hạn');
  await expect(page.locator('#msg')).toHaveValue(/giới thiệu/); // text kept for retry
  await page.locator('#send').click();
  await expect(page.getByText('Chào bạn! Đơn vị của bạn tên là gì?')).toBeVisible();
  expect(calls.filter((c) => c.path === '/api/session')).toHaveLength(2);
  expect(calls.filter((c) => c.path === '/api/chat').map((c) => c.body.sessionId)).toEqual(['sess-1', 'sess-2']);
});

test('phiên hết hạn khi tải ảnh hoặc xác nhận: báo rõ và lần sau tạo phiên mới', async ({ page }) => {
  const gone = { status: 404, json: { error: 'Không tìm thấy phiên trò chuyện. Vui lòng tải lại trang để bắt đầu lại.' } };
  const calls = await mockApi(page, {
    '/api/session': (_c, n) => ({ json: { sessionId: `sess-${n}` } }),
    '/api/upload': (c, n) => (n === 1 ? gone : { json: { path: 'assets/1-a.png' } }),
    '/api/chat': chatReply({ step: stepAt(8), done: IDS.slice(0, 7), canConfirm: false, missing: ['lien_he.phone|zalo'], turnsLeft: 0, mustConfirm: true }),
    '/api/brief/confirm': () => gone,
  });
  await page.goto('/chat.html');
  const pick = () => page.locator('input[type=file]').setInputFiles([
    { name: 'a.png', mimeType: 'image/png', buffer: png }, { name: 'b.png', mimeType: 'image/png', buffer: png }]);
  await pick();
  await expect(page.locator('#chat-error')).toContainText('hết hạn');
  expect(calls.filter((c) => c.path === '/api/upload')).toHaveLength(1); // stops after the 404, no second upload on the dead id
  await pick();
  await expect(page.getByText('Đã nhận 2 ảnh')).toBeVisible();
  expect(calls.filter((c) => c.path === '/api/session')).toHaveLength(2);

  await page.locator('[data-need]').first().click();
  await page.getByRole('button', GEN).click();
  await page.getByLabel('Tên của bạn').fill('Chị Lan');
  await page.getByLabel(/Số điện thoại/).fill('0912345678');
  await page.getByRole('button', { name: 'Gửi và tạo bản dùng thử' }).click();
  await expect(page.locator('#chat-error')).toContainText('hết hạn');
  await expect(page.getByRole('button', GEN)).toBeHidden(); // a new session must answer again before confirming
  await expect(page.locator('#msg')).toBeEnabled();
  await page.locator('#msg').fill('HTX A');
  await page.locator('#send').click();
  await expect.poll(() => calls.filter((c) => c.path === '/api/session').length).toBe(3);
  await expect.poll(() => calls.filter((c) => c.path === '/api/chat').at(-1)!.body.sessionId).toBe('sess-3');
});

test('tải Excel lên: đọc bằng SheetJS (tải lười), gọi /api/docs rồi /api/products', async ({ page }) => {
  const sheetJsLoads = await serveSheetJs(page);
  const calls = await mockApi(page, {
    '/api/session': session,
    '/api/docs': (c) => ({ json: { length: c.body.text.length } }),
    '/api/products': (c) => ({ json: { count: c.body.items.length } }),
  });
  await page.goto('/chat.html');
  await expect.poll(() => calls.length).toBe(1);
  expect(sheetJsLoads()).toBe(0); // not loaded until a spreadsheet is chosen
  await page.locator('input[type=file]').setInputFiles({ name: 'bang-gia.xlsx', mimeType: XLSX_MIME, buffer: Buffer.from(makeXlsxBytes({ 'Bảng giá': BANG_GIA })) });
  await expect(page.getByText(/Đã đọc bảng tính: bang-gia\.xlsx/)).toBeVisible();
  await expect(page.getByText(/4 sản phẩm/)).toBeVisible();
  expect(sheetJsLoads()).toBe(1);
  const docs = calls.find((c) => c.path === '/api/docs')!;
  expect(docs.body.sessionId).toBe('sess-1');
  expect(docs.body.text).toContain('Cà phê Arabica rang mộc | Gói 500g | 180.000đ');
  const prods = calls.find((c) => c.path === '/api/products')!;
  expect(prods.at).toBeGreaterThanOrEqual(docs.done!); // sequential
  expect(prods.body).toEqual({ sessionId: 'sess-1', items: [
    { ten: 'Cà phê Arabica rang mộc', gia: 180000 }, { ten: 'Cà phê Robusta Honey', gia: 150000 },
    { ten: 'Combo quà biếu Tết', gia: 1200000 }, { ten: 'Trà atiso', gia: 95000 }] });
});

test('bảng tính hỏng: báo lỗi tiếng Việt và mời nhập tay', async ({ page }) => {
  await serveSheetJs(page);
  const calls = await mockApi(page, { '/api/session': session });
  await page.goto('/chat.html');
  await page.locator('input[type=file]').setInputFiles({ name: 'hong.xlsx', mimeType: XLSX_MIME, buffer: Buffer.from('504b0304140000000800' + 'ff'.repeat(40), 'hex') });
  await expect(page.locator('#chat-error')).toContainText(/hong\.xlsx/);
  await expect(page.locator('#chat-error')).toContainText(/nhập/);
  expect(calls.filter((c) => c.path === '/api/docs' || c.path === '/api/products')).toHaveLength(0);
});

test('Turnstile: dùng token từ widget khi có site key', async ({ page }) => {
  await page.route('**/chat.html', async (route) => {
    const res = await route.fetch();
    const html = (await res.text()).replace('name="turnstile-sitekey" content=""', 'name="turnstile-sitekey" content="0xTEST"');
    await route.fulfill({ response: res, body: html });
  });
  await page.addInitScript(() => {
    (window as any).turnstile = { render: (_el: unknown, o: { callback: (t: string) => void }) => { setTimeout(() => o.callback('tok-1'), 10); return 'w1'; } };
  });
  const calls = await mockApi(page, { '/api/session': session });
  await page.goto('/chat.html');
  await expect.poll(() => calls.find((c) => c.path === '/api/session')?.body).toEqual({ turnstileToken: 'tok-1' });
});

test('chọn file .gif thì báo lỗi tiếng Việt ngay, không gọi API', async ({ page }) => {
  const calls = await mockApi(page, { '/api/session': session, '/api/upload': () => ({ json: { path: 'x' } }) });
  await page.goto('/chat.html');
  await expect.poll(() => calls.length).toBe(1); // session only
  await page.locator('input[type=file]').setInputFiles({ name: 'logo.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
  await expect(page.getByRole('alert')).toContainText('JPG, PNG hoặc WEBP');
  await page.waitForTimeout(200);
  expect(calls.filter((c) => c.path !== '/api/session')).toHaveLength(0);
});

test('ảnh quá 5MB bị chặn ở trình duyệt', async ({ page }) => {
  const calls = await mockApi(page, { '/api/session': session, '/api/upload': () => ({ json: { path: 'x' } }) });
  await page.goto('/chat.html');
  await page.locator('input[type=file]').setInputFiles({ name: 'to.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
  await expect(page.getByRole('alert')).toContainText('5MB');
  expect(calls.filter((c) => c.path === '/api/upload')).toHaveLength(0);
});

test('ảnh hợp lệ được tải lên lần lượt từng ảnh', async ({ page }) => {
  const calls = await mockApi(page, {
    '/api/session': session,
    '/api/upload': (_c, n) => ({ json: { path: `assets/${n}-anh.png` }, delay: 300 }),
  });
  await page.goto('/chat.html');
  await page.locator('input[type=file]').setInputFiles([
    { name: 'a.png', mimeType: 'image/png', buffer: png },
    { name: 'b.png', mimeType: 'image/png', buffer: png },
  ]);
  await expect(page.getByText('Đã nhận 2 ảnh')).toBeVisible();
  const ups = calls.filter((c) => c.path === '/api/upload');
  expect(ups).toHaveLength(2);
  expect(ups[1].at).toBeGreaterThanOrEqual(ups[0].done!); // sequential, never parallel
});

test('ảnh được thu nhỏ và mã hoá lại trên trình duyệt: JPEG nhỏ hơn, cạnh ≤ 1600px, không còn EXIF/GPS', async ({ page }) => {
  const calls = await mockApi(page, { '/api/session': session, '/api/upload': () => ({ json: { path: 'assets/1-anh.jpg' } }) });
  await page.goto('/chat.html');
  // A 3000×2000 photo-like JPEG with an EXIF (GPS) APP1 segment inserted after SOI.
  const b64 = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 3000; c.height = 2000;
    const x = c.getContext('2d')!;
    for (let i = 0; i < 4000; i++) { x.fillStyle = `hsl(${i % 360},70%,${30 + (i % 50)}%)`; x.fillRect((i * 37) % 3000, (i * 53) % 2000, 60, 40); }
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.95));
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const jpeg = Buffer.from(b64, 'base64');
  const exifBody = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from('GPSLatitude=11.94;GPSLongitude=108.44;'.repeat(4))]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (exifBody.length + 2) >> 8, (exifBody.length + 2) & 0xff]), exifBody]);
  const original = Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
  expect(original.length).toBeLessThan(5 * 1024 * 1024);
  await page.locator('input[type=file]').setInputFiles({ name: 'vuon-ca-phe.jpeg', mimeType: 'image/jpeg', buffer: original });
  await expect(page.getByText('Đã nhận 1 ảnh')).toBeVisible();
  const up = calls.find((c) => c.path === '/api/upload')!;
  const raw = up.raw!;
  const head = raw.indexOf('\r\n\r\n', raw.indexOf('name="file"'));
  const partHeaders = raw.subarray(raw.indexOf('name="file"'), head).toString('latin1');
  expect(partHeaders).toContain('filename="vuon-ca-phe.jpg"');
  expect(partHeaders).toMatch(/Content-Type: image\/jpeg/i);
  const body = raw.subarray(head + 4, raw.lastIndexOf(Buffer.from('\r\n--')));
  expect([...body.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]); // magic bytes the Worker sniffs
  expect(body.length).toBeLessThan(original.length);
  expect(body.includes(Buffer.from('Exif'))).toBe(false);
  expect(body.includes(Buffer.from('GPSLatitude'))).toBe(false);
  const dims = await page.evaluate(async (b) => {
    const bin = atob(b); const u8 = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([u8], { type: 'image/jpeg' }));
    return [bmp.width, bmp.height];
  }, body.toString('base64'));
  expect(dims).toEqual([1600, 1067]);
});

const WAIT_STEPS = ['Đang phân tích ngành nghề và khách hàng', 'Đang viết nội dung website', 'Đang dựng giao diện', 'Đang soạn bản phân tích'];

test('trang trạng thái: 4 bước chờ có dấu tích, thanh tiến độ, rồi chuyển tới trang bộ hồ sơ khi ready', async ({ page }) => {
  await ownSession(page, { sessionId: 'sess-1', jobId: 'job1' });
  await page.route('http://api.test/**', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>Bộ hồ sơ dùng thử</h1>' }));
  await page.clock.install();
  const calls = await mockApi(page, {
    '/api/jobs': (_c, n) => (n < 3
      ? { json: { id: 'job1', siteId: 'x', state: 'pending', next: 'run' }, delay: 200 }
      : { json: { id: 'job1', siteId: 'x', state: 'ready', url: 'http://api.test/package/x', next: 'done' } }),
  });
  await page.goto('/status.html?job=job1');
  const items = page.locator('.wait-steps li');
  await expect(items).toHaveCount(4);
  for (let i = 0; i < 4; i++) await expect(items.nth(i)).toContainText(WAIT_STEPS[i]);
  await expect(page.getByText('Khoảng 1–2 phút, vui lòng giữ trang này mở')).toBeVisible();
  await expect(page.getByRole('progressbar')).toBeVisible();
  await expect(items.nth(0)).toHaveAttribute('aria-current', 'step');
  // time moves the ticks forward even while one long /run is in flight
  await page.clock.runFor(30_000);
  await expect(items.nth(0)).toHaveClass(/is-done/);
  await page.clock.resume();
  // the owner's session id travels in the hash (never sent to the server) so the package page can show "Sửa"
  await page.waitForURL('http://api.test/package/x#s=sess-1', { timeout: 10_000 });
  await expect(page.getByRole('heading', { name: 'Bộ hồ sơ dùng thử' })).toBeVisible();
  expect(calls.filter((c) => c.path === '/api/jobs/job1/run').length).toBe(3);
});

test('trang trạng thái tự chạy từng bước qua POST /api/jobs/:id/run (run → wait → poll) rồi mới hỏi /api/status', async ({ page }) => {
  await page.route('http://api.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>ok</h1>' }));
  const steps = [{ state: 'pending', next: 'run' }, { state: 'pending', next: 'wait' }, { state: 'pending', next: 'poll' }];
  const calls = await mockApi(page, {
    '/api/jobs': (_c, n) => ({ json: { id: 'job1', siteId: 'demo-a', ...steps[Math.min(n - 1, 2)] }, delay: n === 1 ? 400 : 0 }),
    '/api/status': (_c, n) => ({ json: n < 2
      ? { id: 'job1', siteId: 'demo-a', state: 'pending' }
      : { id: 'job1', siteId: 'demo-a', state: 'ready', url: 'http://api.test/package/demo-a' } }),
  });
  await page.goto('/status.html?job=job1');
  await page.waitForURL('http://api.test/package/demo-a', { timeout: 15_000 }); // not the owner's browser: no #s=
  expect(new URL(page.url()).hash).toBe('');
  const runs = calls.filter((c) => c.path === '/api/jobs/job1/run');
  expect(runs).toHaveLength(3);
  for (const r of runs) expect(r.method).toBe('POST');
  expect(runs[1].at).toBeGreaterThanOrEqual(runs[0].done!); // one stage at a time, never parallel
  expect(runs[2].at - runs[1].done!).toBeGreaterThanOrEqual(2000); // 'wait' backs off
  const firstStatus = calls.find((c) => c.path === '/api/status/job1')!;
  expect(firstStatus.at).toBeGreaterThanOrEqual(runs[2].done!); // status polling only after 'poll'
  expect(calls.filter((c) => c.path === '/api/status/job1')).toHaveLength(2);
});

test('trang trạng thái: /run lỗi mạng hoặc 5xx thì xem /api/status rồi chạy lại', async ({ page }) => {
  await page.route('http://api.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>ok</h1>' }));
  let n = 0;
  await page.route('**/api/jobs/**', async (route) => {
    n++;
    if (n === 1) { await route.abort('connectionreset'); return; }
    if (n === 2) { await route.fulfill({ status: 503, json: { error: 'bận' } }); return; }
    await route.fulfill({ json: { id: 'job1', siteId: 'demo-a', state: 'ready', url: 'http://api.test/package/demo-a', next: 'done' } });
  });
  let statusCalls = 0;
  await page.route('**/api/status/**', async (route) => {
    statusCalls++;
    await route.fulfill({ json: { id: 'job1', siteId: 'demo-a', state: 'pending' } });
  });
  await page.goto('/status.html?job=job1');
  await page.waitForURL('http://api.test/package/demo-a', { timeout: 15_000 });
  expect(n).toBe(3);
  expect(statusCalls).toBe(2);
});

test('trang trạng thái: lỗi thì hiện lý do; xếp hàng thì báo gửi trong 24h', async ({ page }) => {
  await mockApi(page, { '/api/jobs': () => ({ json: { id: 'job8', siteId: 'demo-c', state: 'failed', error: 'Chưa tạo được bản dùng thử.', next: 'done' } }) });
  await page.goto('/status.html?job=job8');
  await expect(page.getByText('Chưa tạo được bản dùng thử.')).toBeVisible();
  await expect(page.locator('.wait-steps')).toHaveCount(0);

  await page.unrouteAll();
  await mockApi(page, {
    '/api/jobs': () => ({ json: { id: 'job7', siteId: 'demo-d', state: 'queued', next: 'poll' } }),
    '/api/status': () => ({ json: { id: 'job7', siteId: 'demo-d', state: 'queued' } }),
  });
  await page.goto('/status.html?job=job7');
  await expect(page.getByText(/24h/)).toBeVisible();
});

test('trang trạng thái: job ready không có url thì vẫn tới /package/<siteId>; url lạ (javascript:) bị chặn', async ({ page }) => {
  await mockApi(page, { '/api/jobs': () => ({ json: { id: 'job9', siteId: 'demo-b', state: 'ready', url: 'javascript:alert(1)', next: 'done' } }) });
  await page.route('**/package/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>gói</h1>' }));
  await page.goto('/status.html?job=job9');
  await page.waitForURL(/\/package\/demo-b$/);
});

test('proposal.html (link cũ) chuyển hướng sang trang bộ hồ sơ của Worker, giữ tham số site', async ({ page }) => {
  await page.route('**/proposal.html*', async (route) => {
    const res = await route.fetch();
    const html = (await res.text()).replace('name="api-base" content=""', 'name="api-base" content="http://api.test"');
    await route.fulfill({ response: res, body: html });
  });
  await page.route('http://api.test/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>gói</h1>' }));
  await page.goto('/proposal.html?site=demo-a');
  await page.waitForURL('http://api.test/package/demo-a');
});

test.describe('375px', () => {
  test.use({ viewport: { width: 375, height: 740 } });
  for (const path of ['/index.html', '/chat.html', '/chat.html#tom-tat', '/status.html?job=job1', '/thanks.html?site=demo-a']) {
    test(`không tràn ngang: ${path}`, async ({ page }) => {
      await mockApi(page, {
        '/api/session': session,
        '/api/chat': path.endsWith('#tom-tat') ? atConfirm : chatReply({
          step: stepAt(5), choices: { kind: 'single', options: [
            { value: 'moc-mac', label: 'Mộc mạc', hint: 'Gần gũi, màu đất, chất liệu tự nhiên' }, { value: 'truyen-thong', label: 'Truyền thống' },
            { value: 'hien-dai', label: 'Hiện đại' }, { value: 'sang-trong', label: 'Sang trọng' }, { value: 'tre-trung', label: 'Trẻ trung, năng động rất dài để thử tràn' }] } }),
        '/api/brief': () => ({ json: { brief: { ...FULL_BRIEF, san_pham: [{ ten: 'Sản phẩm có cái tên rất rất dài để thử xem có tràn ngang không nhé', gia: 123456789 }] },
          step: stepAt(8), done: IDS, missing: [], canConfirm: true } }),
        '/api/jobs': () => ({ json: { id: 'job1', siteId: 'demo-a', state: 'pending', next: 'wait' }, delay: 10_000 }),
      });
      await page.goto(path);
      await page.waitForLoadState('domcontentloaded');
      if (path.startsWith('/chat.html')) {
        await page.locator('[data-need]').first().click();
        await expect(page.locator(path.endsWith('#tom-tat') ? '#summary' : '.choices')).toBeVisible();
        await page.locator('#stepbar summary').click();
      }
      if (path.startsWith('/status')) await expect(page.locator('.wait-steps li')).toHaveCount(4);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});
