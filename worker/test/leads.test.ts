import { describe, it, expect } from 'vitest';
import { handle } from '../src/index';
import { makeTestDeps } from './fakes';
import { getJson, putJson } from '../src/kv';
import type { SiteMeta } from '../src/types';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const KEY = 'k'.repeat(32);
const GH = 'https://demo-org.github.io';

async function mkSite(deps: ReturnType<typeof makeTestDeps>, id = 'site1') {
  const meta: SiteMeta = { siteId: id, phone: '0900000000', leadKey: KEY, handoffKey: 'h'.repeat(32), template: 'tpl-thu-lead',
    expires: '2026-12-01', revisions: 0, createdAt: '2026-11-08', name: 'X', analysisReady: true };
  await putJson(deps.kv, `site:${id}`, meta);
}
const post = (id: string, body: unknown, ip = '1.2.3.4') => new Request(`https://w.test/lead/${id}`, {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip, Origin: GH } });
const get = (id: string, q: string) => new Request(`https://w.test/leads/${id}?${q}`);
const stored = (deps: any, id = 'site1') => getJson<{ at: string; fields: Record<string, string> }[]>(deps.kv, `leads:${id}`);

describe('POST /lead/:siteId', () => {
  it('stores a lead (demo-form payload shape) with CORS for the github.io origin', async () => {
    const deps = makeTestDeps(); await mkSite(deps);
    const res = await handle(post('site1', { name: 'An', phone: '09', note: 'hi', website: '' }), deps, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('access-control-allow-origin')).toBe(GH);
    const l = await stored(deps);
    expect(l).toHaveLength(1);
    expect(l![0].fields).toEqual({ name: 'An', phone: '09', note: 'hi' });
    expect(l![0].at).toBe(deps._fixedNow.toISOString());
  });
  it('accepts {fields} shape too', async () => {
    const deps = makeTestDeps(); await mkSite(deps);
    await handle(post('site1', { fields: { name: 'B' }, website: '' }), deps, ctx);
    expect((await stored(deps))![0].fields).toEqual({ name: 'B' });
  });
  it('honeypot: ok but not stored', async () => {
    const deps = makeTestDeps(); await mkSite(deps);
    const res = await handle(post('site1', { fields: { name: 'B' }, website: 'http://spam' }), deps, ctx);
    expect(await res.json()).toEqual({ ok: true });
    expect(await stored(deps)).toBeNull();
  });
  it('404 unknown site', async () => {
    const res = await handle(post('nope', { fields: { a: 'b' } }), makeTestDeps(), ctx);
    expect(res.status).toBe(404);
  });
  it('429 after 10 per hour per ip+site', async () => {
    const deps = makeTestDeps(); await mkSite(deps);
    for (let i = 0; i < 10; i++) expect((await handle(post('site1', { fields: { a: String(i) } }), deps, ctx)).status).toBe(200);
    expect((await handle(post('site1', { fields: { a: 'x' } }), deps, ctx)).status).toBe(429);
    expect((await handle(post('site1', { fields: { a: 'x' } }, '9.9.9.9'), deps, ctx)).status).toBe(200);
  });
  it('truncates values to 500, keys to 50, max 20 keys', async () => {
    const deps = makeTestDeps(); await mkSite(deps);
    const fields: Record<string, string> = { ['k'.repeat(80)]: 'v'.repeat(900) };
    for (let i = 0; i < 30; i++) fields['f' + i] = 'x';
    await handle(post('site1', { fields }), deps, ctx);
    const f = (await stored(deps))![0].fields;
    expect(Object.keys(f)).toHaveLength(20);
    expect(f['k'.repeat(50)]).toHaveLength(500);
  });
  it('keeps only the 500 newest', async () => {
    const deps = makeTestDeps(); await mkSite(deps);
    await putJson(deps.kv, 'leads:site1', Array.from({ length: 500 }, (_, i) => ({ at: 'old', fields: { n: String(i) } })));
    await handle(post('site1', { fields: { n: 'new' } }), deps, ctx);
    const l = (await stored(deps))!;
    expect(l).toHaveLength(500);
    expect(l.at(-1)!.fields.n).toBe('new');
    expect(l[0].fields.n).toBe('1');
  });
  it('400 on bad body', async () => {
    const deps = makeTestDeps(); await mkSite(deps);
    expect((await handle(post('site1', 'x'), deps, ctx)).status).toBe(400);
  });
});

describe('GET /leads/:siteId', () => {
  async function seeded() {
    const deps = makeTestDeps(); await mkSite(deps);
    await putJson(deps.kv, 'leads:site1', [
      { at: '2026-11-08T01:00:00.000Z', fields: { name: '<script>alert(1)</script>', note: 'a,"b"' } },
      { at: '2026-11-08T02:00:00.000Z', fields: { name: '=cmd|x', phone: '09' } },
    ]);
    return deps;
  }
  it('403 on wrong or missing key, 404 unknown site', async () => {
    const deps = await seeded();
    expect((await handle(get('site1', 'key=wrong'), deps, ctx)).status).toBe(403);
    expect((await handle(get('site1', ''), deps, ctx)).status).toBe(403);
    expect((await handle(get('nope', `key=${KEY}`), deps, ctx)).status).toBe(404);
  });
  it('403 when the site has no leadKey, even with an empty key', async () => {
    const deps = makeTestDeps();
    await putJson(deps.kv, 'site:nokey', { siteId: 'nokey', phone: '0', leadKey: '', handoffKey: '', template: 'tpl-thu-lead', expires: '',
      revisions: 0, createdAt: '', name: 'X', analysisReady: true } satisfies SiteMeta);
    expect((await handle(get('nokey', 'key='), deps, ctx)).status).toBe(403);
    expect((await handle(get('nokey', ''), deps, ctx)).status).toBe(403);
  });
  it('HTML escapes values and sets headers', async () => {
    const deps = await seeded();
    const res = await handle(get('site1', `key=${KEY}`), deps, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const h = await res.text();
    expect(h).not.toContain('<script>alert');
    expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(h).toContain('Thời gian');
    expect(h).toContain('Tải CSV');
  });
  it('CSV: BOM, CRLF, RFC4180 escaping, formula neutralised, headers', async () => {
    const deps = await seeded();
    const res = await handle(get('site1', `key=${KEY}&format=csv`), deps, ctx);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="leads-site1.csv"');
    const t = await res.text();
    expect(t.startsWith('﻿')).toBe(true);
    expect(t).toContain('\r\n');
    expect(t).toContain('"a,""b"""');
    expect(t).toContain("'=cmd|x");
    expect(t).not.toMatch(/,=cmd/);
  });
});
