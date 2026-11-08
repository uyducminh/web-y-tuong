import { describe, it, expect } from 'vitest';
import { handle } from '../src/index';
import { makeTestDeps, TEST_ORIGIN } from './fakes';
import { getJson, putJson } from '../src/kv';
import type { Session } from '../src/types';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://w.test${path}`, { method, headers: { 'content-type': 'application/json', Origin: TEST_ORIGIN },
    body: body === undefined ? undefined : JSON.stringify(body) });

const FULL = { ten_don_vi: 'HTX A', loai_hinh: 'htx', nganh: 'nông sản', dia_phuong: 'Lâm Đồng', san_pham: [{ ten: 'Cà phê' }],
  diem_khac_biet: 'OCOP', khach_hang_muc_tieu: 'quán', muc_tieu_chinh: 'ban-hang', hanh_dong_mong_muon: 'zalo', cam_giac: 'moc-mac',
  meta: { askedOptional: ['tham_khao', 'tai_lieu'] } };

async function seed(deps: ReturnType<typeof makeTestDeps>, brief: any = {}) {
  const s = { id: 's1', ip: '1.1.1.1', createdAt: '2026-11-08T00:00:00Z', turns: 0, brief, messages: [], uploads: [], docsText: '' } as Session;
  await putJson(deps.kv, 'sess:s1', s, 3600);
}
const load = (deps: any) => getJson<Session>(deps.kv, 'sess:s1');

describe('GET /api/brief/:sessionId', () => {
  it('404 unknown, otherwise brief + step state', async () => {
    const deps = makeTestDeps();
    expect((await handle(req('GET', '/api/brief/nope'), deps, ctx)).status).toBe(404);
    await seed(deps, FULL);
    const b = (await (await handle(req('GET', '/api/brief/s1'), deps, ctx)).json()) as any;
    expect(b.brief.ten_don_vi).toBe('HTX A');
    expect(b.step).toEqual({ id: 'xac_nhan', index: 8, label: 'Liên hệ và xác nhận' });
    expect(b.missing).toEqual(['lien_he.phone|zalo']);
    expect(b.canConfirm).toBe(false);
    expect(b.done).toHaveLength(7);
  });
});

describe('POST /api/brief/confirm', () => {
  it('409 with missing lien_he.phone|zalo; ok when complete; sets da_xac_nhan', async () => {
    const deps = makeTestDeps();
    await seed(deps, FULL);
    let r = await handle(req('POST', '/api/brief/confirm', { sessionId: 's1' }), deps, ctx);
    expect(r.status).toBe(409);
    const j = (await r.json()) as any;
    expect(j.error).toMatch(/[ạăâêôơưđáàảãéèíìóòúùý]/i);
    expect(j.missing).toContain('lien_he.phone|zalo');
    expect((await load(deps))!.brief.da_xac_nhan).toBeFalsy();
    await seed(deps, { ...FULL, lien_he: { phone: '0912345678' } });
    r = await handle(req('POST', '/api/brief/confirm', { sessionId: 's1' }), deps, ctx);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect((await load(deps))!.brief.da_xac_nhan).toBe(true);
  });
  it('optional lien_he {phone, zalo} is merged before the canConfirm check', async () => {
    const deps = makeTestDeps();
    await seed(deps, FULL);
    const r = await handle(req('POST', '/api/brief/confirm', { sessionId: 's1', lien_he: { phone: '0912345678' } }), deps, ctx);
    expect(r.status).toBe(200);
    const b = (await load(deps))!.brief;
    expect(b.lien_he).toEqual({ phone: '0912345678' });
    expect(b.da_xac_nhan).toBe(true);
  });
  it('lien_he keeps existing contact fields; only phone/zalo accepted; invalid shapes ignored', async () => {
    const deps = makeTestDeps();
    await seed(deps, { ...FULL, lien_he: { address: 'Cầu Đất' } });
    let r = await handle(req('POST', '/api/brief/confirm', { sessionId: 's1', lien_he: { address: 'Khác', fanpage: 'x' } }), deps, ctx);
    expect(r.status).toBe(409); // address/fanpage are not accepted here, and there is still no phone/zalo
    expect((await load(deps))!.brief.lien_he).toEqual({ address: 'Cầu Đất' });
    r = await handle(req('POST', '/api/brief/confirm', { sessionId: 's1', lien_he: 'abc' }), deps, ctx);
    expect(r.status).toBe(409);
    r = await handle(req('POST', '/api/brief/confirm', { sessionId: 's1', lien_he: { zalo: '0987654321', phone: 5 } }), deps, ctx);
    expect(r.status).toBe(200);
    expect((await load(deps))!.brief.lien_he).toEqual({ address: 'Cầu Đất', zalo: '0987654321' });
  });
  it('a 409 after merging still persists the contact given', async () => {
    const deps = makeTestDeps();
    const { cam_giac, ...noStyle } = FULL;
    await seed(deps, noStyle);
    const r = await handle(req('POST', '/api/brief/confirm', { sessionId: 's1', lien_he: { phone: '0912345678' } }), deps, ctx);
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).missing).toEqual(['cam_giac']);
    const b = (await load(deps))!.brief;
    expect(b.lien_he).toEqual({ phone: '0912345678' });
    expect(b.da_xac_nhan).toBeFalsy();
  });
  it('400 bad body, 404 unknown session', async () => {
    const deps = makeTestDeps();
    expect((await handle(req('POST', '/api/brief/confirm', {}), deps, ctx)).status).toBe(400);
    expect((await handle(req('POST', '/api/brief/confirm', { sessionId: 'x' }), deps, ctx)).status).toBe(404);
  });
});

describe('POST /api/products', () => {
  it('stores at most 60 items; invalid gia dropped; resets confirmation', async () => {
    const deps = makeTestDeps();
    await seed(deps, { ...FULL, lien_he: { zalo: '0912345678' }, da_xac_nhan: true });
    const items: any[] = Array.from({ length: 70 }, (_, i) => ({ ten: 'SP' + i, gia: 1000 }));
    items[0] = { ten: 'Âm', gia: -5 };
    items[1] = { ten: 'Chữ', gia: 'abc' };
    items[2] = { ten: '  ' };
    const r = await handle(req('POST', '/api/products', { sessionId: 's1', items }), deps, ctx);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).count).toBe(60);
    const b = (await load(deps))!.brief;
    expect(b.san_pham).toHaveLength(60);
    expect(b.san_pham![0]).toEqual({ ten: 'Âm' });
    expect(b.san_pham![1]).toEqual({ ten: 'Chữ' });
    expect(b.san_pham![2]).toEqual({ ten: 'SP3', gia: 1000 });
    expect(b.da_xac_nhan).toBe(false);
  });
  it('400 bad body, 404 unknown session', async () => {
    const deps = makeTestDeps();
    expect((await handle(req('POST', '/api/products', { sessionId: 's1', items: 'x' }), deps, ctx)).status).toBe(400);
    expect((await handle(req('POST', '/api/products', { sessionId: 'x', items: [] }), deps, ctx)).status).toBe(404);
  });
});
