import { describe, it, expect } from 'vitest';
import { handle } from '../src/index';
import { makeTestDeps } from './fakes';
import { putJson } from '../src/kv';
import { assetKey, analysisKey, paidKey } from '../src/sites';
import type { SiteMeta } from '../src/types';
import fixture from '../../templates/fixtures/shop-dac-san.json';
import { TEMPLATE_FILES, SHARED } from '../src/static/templates.gen';
import renderJs from '../../templates/_shared/render.js?raw';
import baseCss from '../../templates/_shared/base.css?raw';
import banHangHtml from '../../templates/tpl-ban-hang/index.html?raw';
import banHangTheme from '../../templates/tpl-ban-hang/theme.css?raw';
import thuLeadHtml from '../../templates/tpl-thu-lead/index.html?raw';
import thuLeadTheme from '../../templates/tpl-thu-lead/theme.css?raw';
import gioiThieuHtml from '../../templates/tpl-gioi-thieu/index.html?raw';
import gioiThieuTheme from '../../templates/tpl-gioi-thieu/theme.css?raw';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const ID = 'shop-x-abc123';
const FULL_MARKER = 'FULL-MARKER-7f3k-chi-danh-cho-khach-da-tra';
const req = (path: string, init?: RequestInit) => handle(new Request(`https://api.test${path}`, init), deps0(), ctx);
let current: ReturnType<typeof makeTestDeps>;
const deps0 = () => current;

async function seed(over: Partial<SiteMeta> = {}, opts: { paid?: boolean } = {}) {
  current = makeTestDeps({ config: { ...makeTestDeps().config, contactPhone: '0912 345 678', platformName: 'Web Làng' } });
  const meta: SiteMeta = { siteId: ID, phone: '0900000000', leadKey: 'k'.repeat(32), handoffKey: 'h'.repeat(32), template: 'tpl-ban-hang',
    expires: '2026-11-20T00:00:00.000Z', revisions: 0, createdAt: '2026-11-08T00:00:00.000Z', name: 'Shop X', analysisReady: true, ...over };
  await putJson(current.kv, `site:${ID}`, meta);
  await putJson(current.kv, `sitejson:${ID}`, { ...fixture, siteId: ID, hero: { ...fixture.hero, image: 'assets/1-anh.jpg' },
    demo: { badge: true, expires: '2026-11-20', checkoutUrl: 'https://web.test/proposal.html?site=x' } });
  await putJson(current.kv, analysisKey(ID), { free: { summary: 'tóm tắt miễn phí' }, full: { secret: FULL_MARKER } });
  await putJson(current.kv, assetKey(ID, 'assets/1-anh.jpg'), { mime: 'image/jpeg', base64: btoa('\xff\xd8\xff\xe0JPEG') });
  if (opts.paid) await current.kv.put(paidKey(ID), '1');
  return meta;
}

function expectDemoHeaders(res: Response) {
  expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
}

describe('GET /d/:siteId', () => {
  it('redirects /d/<id> to /d/<id>/ (301) so relative site.json and assets/ resolve under /d/<id>/', async () => {
    await seed();
    const res = await req(`/d/${ID}`);
    expect(res.status).toBe(301);
    expect(new URL(res.headers.get('location')!, 'https://api.test').pathname).toBe(`/d/${ID}/`);
    expectDemoHeaders(res);
  });

  it('serves the template HTML with inline css/js, meta tags and demo headers', async () => {
    await seed();
    const res = await req(`/d/${ID}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expectDemoHeaders(res);
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'self'; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'");
    const html = await res.text();
    expect(html).toContain('<meta name="lead-endpoint" content="https://api.test">');
    expect(html).toContain('<meta name="platform-name" content="Web Làng">');
    expect(html).toContain('<body class="tpl-ban-hang">');
    expect(html).toContain('<link rel="icon" href="data:,">');
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toContain("from './render.js'");
    expect(html).toContain(SHARED.baseCss);
    expect(html).toContain(TEMPLATE_FILES['tpl-ban-hang'].theme);
    expect(html).toContain('export async function boot');
    const js = html.slice(html.indexOf('<script type="module">'), html.lastIndexOf('</script>'));
    expect(js).toContain('export async function boot');
    expect(js.trimEnd().endsWith('boot();')).toBe(true);
    expect(html).not.toContain(FULL_MARKER);
  });

  it('uses the template from meta.template', async () => {
    await seed({ template: 'tpl-thu-lead' });
    const html = await (await req(`/d/${ID}/`)).text();
    expect(html).toContain('<body class="tpl-thu-lead">');
    expect(html).toContain(TEMPLATE_FILES['tpl-thu-lead'].theme);
  });

  it('escapes the platform name in the meta tag', async () => {
    await seed();
    current = { ...current, config: { ...current.config, platformName: 'A"><script>x</script>' } };
    const html = await (await req(`/d/${ID}/`)).text();
    expect(html).toContain('<meta name="platform-name" content="A&quot;&gt;&lt;script&gt;x&lt;/script&gt;">');
  });

  it('site.json: 200 with brand.name, checkoutUrl = packageUrl, never analysis.full', async () => {
    await seed();
    const res = await req(`/d/${ID}/site.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expectDemoHeaders(res);
    const text = await res.text();
    expect(text).not.toContain(FULL_MARKER);
    const s = JSON.parse(text);
    expect(s.brand.name).toBe(fixture.brand.name);
    expect(s.demo.checkoutUrl).toBe(`https://api.test/package/${ID}`);
  });

  it('assets: 200 bytes with stored mime; unknown asset 404', async () => {
    await seed();
    const res = await req(`/d/${ID}/assets/1-anh.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expectDemoHeaders(res);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(Uint8Array.from('\xff\xd8\xff\xe0JPEG', (c) => c.charCodeAt(0)));
    const miss = await req(`/d/${ID}/assets/khong-co.jpg`);
    expect(miss.status).toBe(404);
    expectDemoHeaders(miss);
    expect((await req(`/d/${ID}/assets/..%2Fx.jpg`)).status).toBe(404);
  });

  it('expired and unpaid → 410 page with CONTACT_PHONE (page, site.json and assets)', async () => {
    await seed({ expires: '2026-11-01T00:00:00.000Z' });
    const res = await req(`/d/${ID}/`);
    expect(res.status).toBe(410);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expectDemoHeaders(res);
    const html = await res.text();
    expect(html).toContain('Bản dùng thử đã hết hạn');
    expect(html).toContain('0912 345 678');
    expect(html).not.toContain(FULL_MARKER);
    expect((await req(`/d/${ID}/site.json`)).status).toBe(410);
    expect((await req(`/d/${ID}/assets/1-anh.jpg`)).status).toBe(410);
  });

  it('expired but paid (paid:<id>) → still 200', async () => {
    await seed({ expires: '2026-11-01T00:00:00.000Z' }, { paid: true });
    expect((await req(`/d/${ID}/`)).status).toBe(200);
    expect((await req(`/d/${ID}/site.json`)).status).toBe(200);
  });

  it('SiteMeta.paid is not trusted for gating', async () => {
    await seed({ expires: '2026-11-01T00:00:00.000Z', paid: true });
    expect((await req(`/d/${ID}/`)).status).toBe(410);
  });

  it('removed → 410', async () => {
    await seed({ removed: true });
    const res = await req(`/d/${ID}/`);
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('Bản dùng thử đã hết hạn');
  });

  it('unknown site → 404; bad siteId format → 404', async () => {
    await seed();
    const miss = await req('/d/khong-ton-tai-zzzzzz/');
    expect(miss.status).toBe(404);
    expectDemoHeaders(miss);
    expect((await req('/d/ABC../')).status).toBe(404);
    expect((await req('/d/ABC..')).status).toBe(404);
    expect((await req(`/d/${'a'.repeat(65)}/`)).status).toBe(404);
  });

  it('HEAD/other paths under /d/ are 404, never the analysis', async () => {
    await seed();
    for (const p of [`/d/${ID}/analysis.json`, `/d/${ID}/assets/`, `/d/${ID}/x/site.json`]) {
      const res = await req(p);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(FULL_MARKER);
    }
  });
});

describe('CORS for /lead/* is the Worker origin', () => {
  it('OPTIONS /lead/:id allows new URL(apiBase).origin', async () => {
    await seed();
    const res = await req(`/lead/${ID}`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://api.test');
  });
});

describe('test seed route', () => {
  const body = JSON.stringify({ entries: [{ key: 'site:zz-seed01', value: { a: 1 } }] });
  it('404 when ALLOW_TEST_SEED is unset', async () => {
    await seed();
    const res = await req('/__test/seed', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(404);
    expect(await current.kv.get('site:zz-seed01')).toBeNull();
  });
  it('writes KV entries when allowTestSeed', async () => {
    await seed();
    current = { ...current, config: { ...current.config, allowTestSeed: true } };
    const res = await req('/__test/seed', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    expect(await current.kv.get('site:zz-seed01', 'json')).toEqual({ a: 1 });
  });
});

describe('templates.gen.ts matches current template sources', () => {
  it('SHARED and TEMPLATE_FILES equal the files in templates/', () => {
    expect(SHARED).toEqual({ renderJs, baseCss });
    expect(TEMPLATE_FILES).toEqual({
      'tpl-ban-hang': { html: banHangHtml, theme: banHangTheme },
      'tpl-thu-lead': { html: thuLeadHtml, theme: thuLeadTheme },
      'tpl-gioi-thieu': { html: gioiThieuHtml, theme: gioiThieuTheme },
    });
  });
});
