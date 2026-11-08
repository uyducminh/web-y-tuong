import { describe, it, expect } from 'vitest';
import { handle } from '../src/index';
import { makeTestDeps } from './fakes';
import { putJson } from '../src/kv';
import { analysisKey, assetKey } from '../src/sites';
import type { SiteMeta } from '../src/types';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const ID = 'htx-rau-abc123';
const KEY = 'h'.repeat(32);
const FULL = 'FULL-ANALYSIS-MARKER-91';

async function seed(over: Partial<SiteMeta> = {}) {
  const deps = makeTestDeps();
  const meta: SiteMeta = { siteId: ID, phone: '0900000000', leadKey: 'k'.repeat(32), handoffKey: KEY, template: 'tpl-ban-hang',
    expires: '2026-11-20T00:00:00.000Z', revisions: 0, createdAt: '2026-11-08T00:00:00.000Z', name: 'HTX Rau Sạch', analysisReady: true, ...over };
  await putJson(deps.kv, `site:${ID}`, meta);
  await putJson(deps.kv, `sitejson:${ID}`, { siteId: ID, hero: { title: 'Tiêu đề' } });
  await putJson(deps.kv, analysisKey(ID), { free: { summary: 'miễn phí' }, full: { secret: FULL } });
  await putJson(deps.kv, assetKey(ID, 'assets/1-anh.jpg'), { mime: 'image/jpeg', base64: btoa('JPEG') });
  await putJson(deps.kv, `brief:${ID}`, { ten_don_vi: 'HTX Rau Sạch', diem_khac_biet: '<script>alert(1)</script>' });
  await putJson(deps.kv, `docs:${ID}`, 'Bảng giá <b>x</b>');
  return { deps, meta };
}
const get = (deps: ReturnType<typeof makeTestDeps>, q: string, id = ID) =>
  handle(new Request(`https://api.test/handoff/${id}${q}`), deps, ctx);

describe('GET /handoff/:siteId', () => {
  it('403 without key, wrong key, and for an empty handoffKey (even with an empty key param)', async () => {
    const { deps } = await seed();
    expect((await get(deps, '')).status).toBe(403);
    expect((await get(deps, '?key=wrong')).status).toBe(403);
    const e = await seed({ handoffKey: '' });
    expect((await get(e.deps, '?key=')).status).toBe(403);
    expect((await get(e.deps, '')).status).toBe(403);
  });

  it('404 for an unknown site', async () => {
    const { deps } = await seed();
    expect((await get(deps, `?key=${KEY}`, 'khong-co-1')).status).toBe(404);
  });

  it('right key: escaped HTML with name, brief, site, analysis, docs, image links, noindex/no-store', async () => {
    const { deps } = await seed();
    const res = await get(deps, `?key=${KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('HTX Rau Sạch');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('Bảng giá &lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain(FULL);
    expect(html).toContain(`/d/${ID}/assets/1-anh.jpg`);
    expect(html).toContain(`handoff-${ID}.json`);
    expect(html).toContain('format=json');
  });

  it('format=json has brief, site, analysis (full), docsText and base64 images', async () => {
    const { deps } = await seed();
    const res = await get(deps, `?key=${KEY}&format=json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain(`handoff-${ID}.json`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const j: any = await res.json();
    expect(j.brief.ten_don_vi).toBe('HTX Rau Sạch');
    expect(j.site.siteId).toBe(ID);
    expect(j.analysis.full.secret).toBe(FULL);
    expect(j.docsText).toBe('Bảng giá <b>x</b>');
    expect(j.images).toEqual([{ path: 'assets/1-anh.jpg', mime: 'image/jpeg', base64: btoa('JPEG') }]);
  });
});
