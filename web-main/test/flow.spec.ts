import { test, expect, type Page, type Route } from '@playwright/test';

type Call = { path: string; method: string; body: any; raw?: Buffer | null; at: number; done?: number };
type Handler = (call: Call, n: number) => { status?: number; json: unknown; delay?: number };

/** Mocks the Worker: every request to /api/** is answered by handlers[path-without-ids] and recorded. */
async function mockApi(page: Page, handlers: Record<string, Handler>): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const key = url.pathname.replace(/^\/api\/(status|proposal|jobs)\/.+$/, '/api/$1');
    let body: any = null;
    const ct = req.headers()['content-type'] || '';
    if (ct.includes('application/json')) body = req.postDataJSON();
    else if (req.postData()) body = 'multipart';
    const call: Call = { path: url.pathname, method: req.method(), body, raw: req.postDataBuffer(), at: Date.now() };
    calls.push(call);
    const h = handlers[key];
    if (!h) { await route.fulfill({ status: 404, json: { error: 'không có mock' } }); return; }
    const n = calls.filter((c) => c.path.startsWith(key)).length;
    const r = h(call, n);
    if (r.delay) await new Promise((res) => setTimeout(res, r.delay));
    call.done = Date.now();
    await route.fulfill({ status: r.status ?? 200, json: r.json });
  });
  return calls;
}

const session: Handler = () => ({ json: { sessionId: 'sess-1' } });
const chatReply = (over: Record<string, unknown> = {}): Handler => () => ({
  json: {
    reply: 'Chào bạn! Đơn vị của bạn tên là gì?', quickReplies: ['HTX Cà phê Cầu Đất', 'Cơ sở mây tre'],
    progress: { filled: 2, total: 10, missing: ['ten_don_vi'] }, turnsLeft: 11, mustGenerate: false, ...over,
  },
});
const NOTICE = 'Bản dùng thử là công khai, vui lòng không gửi thông tin nhạy cảm.';
const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

async function ownSession(page: Page, value: Record<string, unknown>) {
  await page.addInitScript((v) => sessionStorage.setItem('sme.session', JSON.stringify(v)), value);
}

test('trang chủ có 3 nút chọn nhu cầu dẫn vào trò chuyện', async ({ page }) => {
  await page.goto('/index.html');
  const needs = page.locator('[data-need]');
  await expect(needs).toHaveCount(3);
  await expect(page.getByText('10.000.000đ').first()).toBeVisible();
  await needs.first().click();
  await expect(page).toHaveURL(/chat\.html\?need=gioi-thieu/);
});

test('trò chuyện: 3 nút nhu cầu, câu trả lời, gợi ý nhanh, tiến độ và dòng nhắc', async ({ page }) => {
  const calls = await mockApi(page, { '/api/session': session, '/api/chat': chatReply() });
  await page.goto('/chat.html');
  await expect(page.getByText(NOTICE)).toBeVisible();
  const needs = page.locator('[data-need]');
  await expect(needs).toHaveCount(3);
  await needs.nth(2).click();
  await expect(page.getByText('Chào bạn! Đơn vị của bạn tên là gì?')).toBeVisible();
  await expect(page.getByRole('button', { name: 'HTX Cà phê Cầu Đất' })).toBeVisible();
  await expect(page.getByText('Đã đủ 2/10 thông tin')).toBeVisible();
  await expect(page.getByText(NOTICE)).toBeVisible();
  expect(calls.find((c) => c.path === '/api/session')!.body).toEqual({ turnstileToken: 'dev' });
  const chat = calls.find((c) => c.path === '/api/chat')!;
  expect(chat.body.sessionId).toBe('sess-1');
  expect(chat.body.text).toMatch(/bán hàng/i);

  // a quick reply sends its text as the next message
  await page.getByRole('button', { name: 'Cơ sở mây tre' }).click();
  await expect.poll(() => calls.filter((c) => c.path === '/api/chat').length).toBe(2);
  expect(calls.filter((c) => c.path === '/api/chat')[1].body.text).toBe('Cơ sở mây tre');
});

test('?need= từ trang chủ tự gửi nhu cầu đầu tiên', async ({ page }) => {
  const calls = await mockApi(page, { '/api/session': session, '/api/chat': chatReply() });
  await page.goto('/chat.html?need=thu-lead');
  await expect(page.getByText('Đã đủ 2/10 thông tin')).toBeVisible();
  expect(calls.find((c) => c.path === '/api/chat')!.body.text).toMatch(/thông tin khách/i);
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
  await expect(page.getByText('Đã đủ 2/10 thông tin')).toBeVisible();
  expect(calls.filter((c) => c.path === '/api/session')).toHaveLength(2);
  expect(calls.filter((c) => c.path === '/api/chat').map((c) => c.body.sessionId)).toEqual(['sess-1', 'sess-2']);
});

test('phiên hết hạn khi tải ảnh hoặc tạo bản dùng thử: báo rõ và lần sau tạo phiên mới', async ({ page }) => {
  const gone = { status: 404, json: { error: 'Không tìm thấy phiên trò chuyện. Vui lòng tải lại trang để bắt đầu lại.' } };
  const calls = await mockApi(page, {
    '/api/session': (_c, n) => ({ json: { sessionId: `sess-${n}` } }),
    '/api/upload': (c, n) => (n === 1 ? gone : { json: { path: 'assets/1-a.png' } }),
    '/api/generate': () => gone,
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

  await page.getByRole('button', { name: 'Tạo bản dùng thử', exact: true }).click();
  await page.getByLabel('Tên của bạn').fill('Chị Lan');
  await page.getByLabel(/Số điện thoại/).fill('0912345678');
  await page.getByRole('button', { name: 'Gửi và tạo bản dùng thử' }).click();
  await expect(page.locator('#gen-error')).toContainText('hết hạn');
  await page.getByRole('button', { name: 'Gửi và tạo bản dùng thử' }).click();
  await expect.poll(() => calls.filter((c) => c.path === '/api/session').length).toBe(3);
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

test('turnsLeft 0: khoá ô nhập, nút "Tạo bản dùng thử" được tô nổi', async ({ page }) => {
  await mockApi(page, { '/api/session': session, '/api/chat': chatReply({ turnsLeft: 0, mustGenerate: true }) });
  await page.goto('/chat.html');
  const gen = page.getByRole('button', { name: 'Tạo bản dùng thử', exact: true });
  await expect(gen).not.toHaveClass(/is-ready/);
  await page.locator('[data-need]').first().click();
  await expect(page.getByText('Đã đủ 2/10 thông tin')).toBeVisible();
  await expect(page.locator('#msg')).toBeDisabled();
  await expect(page.locator('#send')).toBeDisabled();
  await expect(gen).toHaveClass(/is-ready/);
});

test('thiếu SĐT thì không gửi được form', async ({ page }) => {
  const calls = await mockApi(page, { '/api/session': session, '/api/generate': () => ({ json: { jobId: 'j1' } }) });
  await page.goto('/chat.html');
  await page.getByRole('button', { name: 'Tạo bản dùng thử', exact: true }).click();
  await page.getByLabel('Tên của bạn').fill('Chị Lan');
  await page.getByRole('button', { name: 'Gửi và tạo bản dùng thử' }).click();
  await expect(page.locator('#gen-error')).toContainText('số điện thoại');
  await page.getByLabel(/Số điện thoại/).fill('12345');
  await page.getByRole('button', { name: 'Gửi và tạo bản dùng thử' }).click();
  await expect(page.locator('#gen-error')).toContainText('10 chữ số');
  expect(calls.filter((c) => c.path === '/api/generate')).toHaveLength(0);
});

test('nút tạo bản dùng thử bị vô hiệu ngay sau lần bấm đầu, rồi chuyển sang trang trạng thái', async ({ page }) => {
  const calls = await mockApi(page, {
    '/api/session': session,
    '/api/generate': () => ({ json: { jobId: 'job1' }, delay: 600 }),
    '/api/status': () => ({ json: { id: 'job1', siteId: 'demo-a', state: 'pending' } }),
  });
  await page.goto('/chat.html');
  await page.getByRole('button', { name: 'Tạo bản dùng thử', exact: true }).click();
  await page.getByLabel('Tên của bạn').fill('Chị Lan');
  await page.getByLabel(/Số điện thoại/).fill('0912 345 678');
  await page.getByRole('button', { name: 'Gửi và tạo bản dùng thử' }).click();
  const submit = page.locator('#gen-submit'); // label changes to "Đang gửi…" while waiting
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveText('Đang gửi…');
  await submit.click({ force: true }).catch(() => {});
  await expect(page).toHaveURL(/status\.html\?job=job1/);
  const gens = calls.filter((c) => c.path === '/api/generate');
  expect(gens).toHaveLength(1);
  expect(gens[0].body).toEqual({ sessionId: 'sess-1', phone: '0912345678', name: 'Chị Lan' });
});

test('SĐT đã có bản dùng thử: hiện link bản cũ', async ({ page }) => {
  await mockApi(page, {
    '/api/session': session,
    '/api/generate': () => ({ status: 409, json: { error: 'Số điện thoại này đã có bản dùng thử.', siteId: 'demo-old', url: 'https://demo-org.github.io/demo-old/' } }),
  });
  await page.goto('/chat.html');
  await page.getByRole('button', { name: 'Tạo bản dùng thử', exact: true }).click();
  await page.getByLabel('Tên của bạn').fill('Chị Lan');
  await page.getByLabel(/Số điện thoại/).fill('0912345678');
  await page.getByRole('button', { name: 'Gửi và tạo bản dùng thử' }).click();
  await expect(page.locator('#gen-error')).toContainText('đã có bản dùng thử');
  await expect(page.locator('#gen-error a[href="https://demo-org.github.io/demo-old/"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Gửi và tạo bản dùng thử' })).toBeEnabled();
});

test('trang trạng thái hỏi lại đến khi ready, rồi hiện link demo, link đề xuất và ô sửa', async ({ page }) => {
  await ownSession(page, { sessionId: 'sess-1', jobId: 'job1' });
  const calls = await mockApi(page, {
    '/api/jobs': () => ({ json: { id: 'job1', siteId: 'demo-a', state: 'pending', next: 'poll' } }),
    '/api/status': (_c, n) => ({ json: n < 2
      ? { id: 'job1', siteId: 'demo-a', state: 'pending' }
      : { id: 'job1', siteId: 'demo-a', state: 'ready', url: 'https://demo-org.github.io/demo-a/' } }),
    '/api/revise': () => ({ json: { jobId: 'job2', revisionsLeft: 2 } }),
  });
  await page.goto('/status.html?job=job1');
  await expect(page.getByText(/Đang tạo bản dùng thử/)).toBeVisible();
  const demo = page.getByRole('link', { name: 'Mở bản dùng thử' });
  await expect(demo).toBeVisible({ timeout: 10_000 });
  await expect(demo).toHaveAttribute('href', 'https://demo-org.github.io/demo-a/');
  await expect(page.getByRole('link', { name: 'Xem đề xuất và báo giá' })).toHaveAttribute('href', 'proposal.html?site=demo-a');
  expect(calls.filter((c) => c.path === '/api/status/job1').length).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(3500);
  expect(calls.filter((c) => c.path === '/api/status/job1')).toHaveLength(2); // stopped polling

  await expect(page.getByText('Còn 3 lượt sửa')).toBeVisible();
  await page.getByLabel('Bạn muốn sửa gì?').fill('Đổi màu chủ đạo sang xanh lá');
  await page.getByRole('button', { name: 'Gửi yêu cầu sửa' }).click();
  await expect(page).toHaveURL(/status\.html\?job=job2/);
  const rev = calls.find((c) => c.path === '/api/revise')!;
  expect(rev.body).toEqual({ siteId: 'demo-a', sessionId: 'sess-1', request: 'Đổi màu chủ đạo sang xanh lá' });
});

test('trang trạng thái: không phải phiên của mình thì không có ô sửa; lỗi thì hiện lý do', async ({ page }) => {
  await mockApi(page, {
    '/api/jobs': () => ({ json: { id: 'job9', siteId: 'demo-b', state: 'ready', url: 'https://demo-org.github.io/demo-b/', next: 'done' } }),
  });
  await page.goto('/status.html?job=job9');
  await expect(page.getByRole('link', { name: 'Mở bản dùng thử' })).toBeVisible();
  await expect(page.getByLabel('Bạn muốn sửa gì?')).toHaveCount(0);

  await page.unrouteAll();
  await mockApi(page, { '/api/jobs': () => ({ json: { id: 'job8', siteId: 'demo-c', state: 'failed', error: 'Chưa tạo được bản dùng thử.', next: 'done' } }) });
  await page.goto('/status.html?job=job8');
  await expect(page.getByText('Chưa tạo được bản dùng thử.')).toBeVisible();
});

test('trang trạng thái tự chạy từng bước qua POST /api/jobs/:id/run (run → wait → poll) rồi mới hỏi /api/status', async ({ page }) => {
  const steps = [{ state: 'pending', next: 'run' }, { state: 'pending', next: 'wait' }, { state: 'pending', next: 'poll' }];
  const calls = await mockApi(page, {
    '/api/jobs': (_c, n) => ({ json: { id: 'job1', siteId: 'demo-a', ...steps[Math.min(n - 1, 2)] }, delay: n === 1 ? 400 : 0 }),
    '/api/status': () => ({ json: { id: 'job1', siteId: 'demo-a', state: 'ready', url: 'https://demo-org.github.io/demo-a/' } }),
  });
  await page.goto('/status.html?job=job1');
  await expect(page.getByText(/Đang tạo bản dùng thử/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Mở bản dùng thử' })).toBeVisible({ timeout: 15_000 });
  const runs = calls.filter((c) => c.path === '/api/jobs/job1/run');
  expect(runs).toHaveLength(3);
  for (const r of runs) expect(r.method).toBe('POST');
  expect(runs[1].at).toBeGreaterThanOrEqual(runs[0].done!); // one stage at a time, never parallel
  expect(runs[2].at - runs[1].done!).toBeGreaterThanOrEqual(2000); // 'wait' backs off
  const firstStatus = calls.find((c) => c.path === '/api/status/job1')!;
  expect(firstStatus.at).toBeGreaterThanOrEqual(runs[2].done!); // status polling only after 'poll'
});

test('trang trạng thái: /run lỗi mạng hoặc 5xx thì xem /api/status rồi chạy lại', async ({ page }) => {
  let n = 0;
  await page.route('**/api/jobs/**', async (route) => {
    n++;
    if (n === 1) { await route.abort('connectionreset'); return; }
    if (n === 2) { await route.fulfill({ status: 503, json: { error: 'bận' } }); return; }
    await route.fulfill({ json: { id: 'job1', siteId: 'demo-a', state: 'ready', url: 'https://demo-org.github.io/demo-a/', next: 'done' } });
  });
  let statusCalls = 0;
  await page.route('**/api/status/**', async (route) => {
    statusCalls++;
    await route.fulfill({ json: { id: 'job1', siteId: 'demo-a', state: 'pending' } });
  });
  await page.goto('/status.html?job=job1');
  await expect(page.getByRole('link', { name: 'Mở bản dùng thử' })).toBeVisible({ timeout: 15_000 });
  expect(n).toBe(3);
  expect(statusCalls).toBe(2);
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

const proposalData = {
  proposal: {
    summary: 'HTX Cà phê Cầu Đất cần website giới thiệu và nhận đơn sỉ.',
    problems: ['Khách ở xa khó tìm thông tin', 'Chưa có bảng giá rõ ràng'],
    solution: 'Website giới thiệu có bảng giá và nút đặt qua Zalo.',
    packages: [{ name: 'Cơ bản', priceVnd: 10_000_000, items: ['Website 5 trang'] }],
    roadmap: [{ step: 'Chốt yêu cầu', desc: 'Xác nhận nội dung.' }, { step: 'Bàn giao', desc: 'Gắn tên miền.' }],
  },
  site: { name: 'HTX Cà phê Cầu Đất', url: 'https://demo-org.github.io/demo-a/' },
  packages: [
    { id: 'co-ban', name: 'Cơ bản', priceVnd: 10_000_000, items: ['Website 5 trang', 'Tên miền 1 năm'] },
    { id: 'nang-cao', name: 'Nâng cao', priceVnd: 15_000_000, items: ['Thêm bán hàng'] },
  ],
};

test('trang đề xuất: gói giá dạng 10.000.000đ, nút In / Lưu PDF, thanh toán chuyển sang PayOS', async ({ page }) => {
  const calls = await mockApi(page, {
    '/api/proposal': () => ({ json: proposalData }),
    '/api/checkout': () => ({ json: { checkoutUrl: 'http://localhost:4173/thanks.html?site=demo-a' } }),
  });
  await page.goto('/proposal.html?site=demo-a');
  await expect(page.getByRole('heading', { name: /HTX Cà phê Cầu Đất/ })).toBeVisible();
  await expect(page.getByText('10.000.000đ', { exact: true })).toBeVisible();
  await expect(page.getByText('15.000.000đ', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'In / Lưu PDF' })).toBeVisible();
  await expect(page.getByText('Khách ở xa khó tìm thông tin')).toBeVisible();
  await page.getByRole('button', { name: 'Chọn gói Nâng cao' }).click();
  await expect(page).toHaveURL(/thanks\.html\?site=demo-a/);
  await expect(page.getByText(/liên hệ trong 24h/)).toBeVisible();
  expect(calls.find((c) => c.path === '/api/checkout')!.body).toEqual({ siteId: 'demo-a', packageId: 'nang-cao' });
});

test('nút In / Lưu PDF gọi window.print', async ({ page }) => {
  await mockApi(page, { '/api/proposal': () => ({ json: proposalData }) });
  await page.addInitScript(() => { (window as any).__printed = 0; window.print = () => { (window as any).__printed++; }; });
  await page.goto('/proposal.html?site=demo-a');
  await page.getByRole('button', { name: 'In / Lưu PDF' }).click();
  expect(await page.evaluate(() => (window as any).__printed)).toBe(1);
});

test.describe('375px', () => {
  test.use({ viewport: { width: 375, height: 740 } });
  for (const path of ['/index.html', '/chat.html', '/status.html?job=job1', '/proposal.html?site=demo-a', '/thanks.html?site=demo-a']) {
    test(`không tràn ngang: ${path}`, async ({ page }) => {
      await mockApi(page, {
        '/api/session': session, '/api/chat': chatReply(),
        '/api/jobs': () => ({ json: { id: 'job1', siteId: 'demo-a', state: 'ready', url: 'https://demo-org.github.io/demo-a-rat-dai-de-thu-tran-ngang/', next: 'done' } }),
        '/api/proposal': () => ({ json: proposalData }),
      });
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      if (path === '/chat.html') {
        await page.locator('[data-need]').first().click();
        await expect(page.getByText('Đã đủ 2/10 thông tin')).toBeVisible();
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});
