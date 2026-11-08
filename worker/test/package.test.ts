import { describe, it, expect, vi } from 'vitest';
import { handle } from '../src/index';
import { makeTestDeps, testConfig } from './fakes';
import { putJson } from '../src/kv';
import { analysisKey, paidKey } from '../src/sites';
import type { SiteMeta } from '../src/types';
import { PACKAGE_FILES } from '../src/static/templates.gen';
import { PACKAGE_CSP } from '../src/routes/package';
import packageHtml from '../src/static/package/package.html?raw';
import packageJs from '../src/static/package/package.js?raw';
import packageCss from '../src/static/package/package.css?raw';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const ID = 'shop-x-abc123';
const FULL_MARKER = 'FULL-MARKER-pkg-5t2w-chi-danh-cho-khach-da-tra';
let current: ReturnType<typeof makeTestDeps>;
const req = (path: string, init?: RequestInit) => handle(new Request(`https://api.test${path}`, init), current, ctx);

const FREE = {
  tom_tat_doanh_nghiep: 'Shop X bán đặc sản.', phan_tich_nhu_cau: 'Cần bán online.', khach_hang_muc_tieu: 'Người ở thành phố',
  muc_tieu_website: ['Bán hàng'], phong_cach: { mo_ta: 'Mộc mạc', bang_mau: ['#2E7D32'] },
  nhan_xet_web_tham_khao: [], so_do_trang: [{ trang: 'Trang chủ', muc_dich: 'Giới thiệu' }],
};
const FULL = {
  noi_dung_tung_trang: [{ trang: 'Trang chủ', cac_khoi: [{ tieu_de: FULL_MARKER, noi_dung: 'x' }] }],
  ke_hoach_trien_khai: [{ buoc: 'Chốt nội dung', viec: ['Gửi ảnh'] }], goi_y_fanpage: [], viec_khach_can_chuan_bi: [],
};

async function seed(over: Partial<SiteMeta> = {}, opts: { paid?: boolean; config?: Partial<typeof testConfig>; analysis?: boolean } = {}) {
  current = makeTestDeps({ config: { ...testConfig, ...opts.config } });
  const meta: SiteMeta = { siteId: ID, phone: '0900000000', leadKey: 'k'.repeat(32), handoffKey: 'h'.repeat(32), template: 'tpl-ban-hang',
    expires: '2026-11-20T00:00:00.000Z', revisions: 0, createdAt: '2026-11-08T00:00:00.000Z', name: 'Shop X', analysisReady: true, ...over };
  await putJson(current.kv, `site:${ID}`, meta);
  if (opts.analysis !== false) await putJson(current.kv, analysisKey(ID), { free: FREE, full: FULL });
  else await current.kv.delete(analysisKey(ID));
  if (opts.paid) await current.kv.put(paidKey(ID), '1');
  else await current.kv.delete(paidKey(ID));
  return meta;
}

function expectNoindexHeaders(res: Response) {
  expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
}

describe('GET /api/package/:siteId', () => {
  it('unpaid: free only — no `full` key and no full marker anywhere in the JSON', async () => {
    await seed();
    const res = await req(`/api/package/${ID}`);
    expect(res.status).toBe(200);
    expectNoindexHeaders(res);
    const text = await res.text();
    expect(text).not.toContain(FULL_MARKER);
    expect(text).not.toContain('noi_dung_tung_trang');
    const body = JSON.parse(text);
    expect(body.analysis).toEqual({ free: FREE });
    expect('full' in body.analysis).toBe(false);
    expect(body.site).toEqual({ name: 'Shop X', expires: '2026-11-20T00:00:00.000Z', paid: false });
    expect(body.demoUrl).toBe(`https://api.test/d/${ID}/`);
  });

  it('query params are ignored (?tier=full, ?paid=1, ?full=1)', async () => {
    await seed();
    for (const q of ['?tier=full', '?paid=1&full=1', '?analysis=full']) {
      const text = await (await req(`/api/package/${ID}${q}`)).text();
      expect(text).not.toContain(FULL_MARKER);
      expect('full' in JSON.parse(text).analysis).toBe(false);
    }
  });

  it('SiteMeta.paid is not trusted: still free only', async () => {
    await seed({ paid: true });
    const text = await (await req(`/api/package/${ID}`)).text();
    expect(text).not.toContain(FULL_MARKER);
    expect(JSON.parse(text).site.paid).toBe(false);
  });

  it('paid:<id> → free + full', async () => {
    await seed({}, { paid: true });
    const body = await (await req(`/api/package/${ID}`)).json<any>();
    expect(body.analysis).toEqual({ free: FREE, full: FULL });
    expect(body.site.paid).toBe(true);
  });

  it('packages are filtered like checkout (below the minimum hidden; only id/name/priceVnd/items)', async () => {
    const packages = [
      { id: 're', name: 'Rẻ', priceVnd: 2_000, items: ['a'] },
      { id: 'co-ban', name: 'Cơ bản', priceVnd: 10_000_000, items: ['Website'] },
      { id: 'nang-cao', name: 'Nâng cao', priceVnd: 18_000_000, items: ['Website', 'Fanpage'] },
    ];
    await seed({}, { config: { packages } });
    const body = await (await req(`/api/package/${ID}`)).json<any>();
    expect(body.packages.map((p: any) => p.id)).toEqual(['co-ban', 'nang-cao']);
    expect(body.packages[0]).toEqual({ id: 'co-ban', name: 'Cơ bản', priceVnd: 10_000_000, items: ['Website'] });
    // the hidden package is also the one checkout refuses (checkout logs the rejected price)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const co = await req('/api/checkout', { method: 'POST', body: JSON.stringify({ siteId: ID, packageId: 're' }) });
    expect(co.status).toBe(400);
    expect(log).toHaveBeenCalledWith('package price rejected', 're', 2_000);
    log.mockRestore();

    await seed({}, { config: { packages, allowTestPrice: true } });
    const t = await (await req(`/api/package/${ID}`)).json<any>();
    expect(t.packages.map((p: any) => p.id)).toEqual(['re', 'co-ban', 'nang-cao']);
  });

  it('analysis not stored yet → analysis null', async () => {
    await seed({}, { analysis: false });
    const body = await (await req(`/api/package/${ID}`)).json<any>();
    expect(body.analysis).toBeNull();
  });

  it('expired + unpaid → 410; removed → 410; expired + paid → 200', async () => {
    await seed({ expires: '2026-11-01T00:00:00.000Z' });
    const r = await req(`/api/package/${ID}`);
    expect(r.status).toBe(410);
    expect(await r.text()).not.toContain(FULL_MARKER);
    await seed({ removed: true });
    expect((await req(`/api/package/${ID}`)).status).toBe(410);
    await seed({ expires: '2026-11-01T00:00:00.000Z' }, { paid: true });
    expect((await req(`/api/package/${ID}`)).status).toBe(200);
  });

  it('unknown site → 404; bad id → 404', async () => {
    await seed();
    expect((await req('/api/package/khong-co-abc123')).status).toBe(404);
    expect((await req('/api/package/BAD_ID')).status).toBe(404);
  });
});

describe('GET /package/:siteId', () => {
  it('serves the package page with noindex/no-store/no-referrer and the package CSP', async () => {
    await seed();
    const res = await req(`/package/${ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expectNoindexHeaders(res);
    expect(res.headers.get('content-security-policy')).toBe(PACKAGE_CSP);
    expect(PACKAGE_CSP).toContain("script-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net");
    expect(PACKAGE_CSP).toContain("frame-src 'self'");
    expect(PACKAGE_CSP).toContain("img-src 'self' data: blob:");
    expect(PACKAGE_CSP).not.toContain('unsafe-eval');
    const html = await res.text();
    expect(html).toContain('<html lang="vi">');
    expect(html).toContain('src="/package/_/package.js"');
    expect(html).toContain('href="/package/_/package.css"');
    expect(html).toContain('Web Làng');
    expect(html).not.toContain(FULL_MARKER);
  });

  it('paid site: the HTML itself still never carries analysis data', async () => {
    await seed({}, { paid: true });
    expect(await (await req(`/package/${ID}`)).text()).not.toContain(FULL_MARKER);
  });

  it('escapes the platform name', async () => {
    await seed({}, { config: { platformName: 'A"><script>x</script>' } });
    const html = await (await req(`/package/${ID}`)).text();
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('A&quot;&gt;&lt;script&gt;x&lt;/script&gt;');
  });

  it('expired + unpaid → 410 page with CONTACT_PHONE; removed → 410', async () => {
    await seed({ expires: '2026-11-01T00:00:00.000Z' });
    const res = await req(`/package/${ID}`);
    expect(res.status).toBe(410);
    expectNoindexHeaders(res);
    const html = await res.text();
    expect(html).toContain('Bản dùng thử đã hết hạn');
    expect(html).toContain('0912 345 678');
    await seed({ removed: true });
    expect((await req(`/package/${ID}`)).status).toBe(410);
  });

  it('unknown site → 404; bad id → 404; trailing junk → 404', async () => {
    await seed();
    expect((await req('/package/khong-co-abc123')).status).toBe(404);
    expect((await req('/package/BAD_ID')).status).toBe(404);
    expect((await req(`/package/${ID}/x`)).status).toBe(404);
  });

  it('static files: /package/_/package.js|css with proper types; unknown → 404', async () => {
    await seed();
    const js = await req('/package/_/package.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(js.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await js.text()).toBe(PACKAGE_FILES.js);
    const css = await req('/package/_/package.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toMatch(/^text\/css/);
    expect(await css.text()).toBe(PACKAGE_FILES.css);
    expect((await req('/package/_/x.js')).status).toBe(404);
  });

  it('package.js renders data with textContent only (no innerHTML / insertAdjacentHTML / document.write)', () => {
    expect(PACKAGE_FILES.js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

describe('embedded package files', () => {
  it('templates.gen.ts PACKAGE_FILES match worker/src/static/package sources', () => {
    expect(PACKAGE_FILES.html).toBe(packageHtml);
    expect(PACKAGE_FILES.js).toBe(packageJs);
    expect(PACKAGE_FILES.css).toBe(packageCss);
  });
});
