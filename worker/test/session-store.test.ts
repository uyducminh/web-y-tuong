import { describe, it, expect, vi } from 'vitest';
import { handle } from '../src/index';
import { makeTestDeps, TEST_ORIGIN } from './fakes';
import { getJson, putJson } from '../src/kv';
import { BriefV2Schema } from '@sme/schema';
import type { Session } from '../src/types';
import { updateSession } from '../src/session-store';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const jsonPost = (path: string, body: unknown) => new Request(`https://w.test${path}`, { method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.1.1.1', Origin: TEST_ORIGIN } });
function upload(name: string) {
  const u = new Uint8Array(64); u.set(PNG);
  const fd = new FormData();
  fd.set('sessionId', 'sess1');
  fd.set('file', new File([u], name, { type: 'image/png' }));
  return new Request('https://w.test/api/upload', { method: 'POST', body: fd, headers: { Origin: TEST_ORIGIN } });
}
const FULL = { ten_don_vi: 'HTX A', loai_hinh: 'htx', nganh: 'nông sản', dia_phuong: 'Lâm Đồng', san_pham: [{ ten: 'Cà phê' }],
  diem_khac_biet: 'OCOP', khach_hang_muc_tieu: 'quán', muc_tieu_chinh: 'ban-hang', hanh_dong_mong_muon: 'zalo', cam_giac: 'moc-mac',
  lien_he: { zalo: '0912345678' }, meta: { askedOptional: ['tham_khao', 'tai_lieu'] } };

async function seed(deps: ReturnType<typeof makeTestDeps>, brief: unknown = FULL) {
  const s: Session = { id: 'sess1', ip: '1.1.1.1', createdAt: '2026-11-08T00:00:00Z', turns: 3,
    brief: BriefV2Schema.parse(brief), messages: [], uploads: [], docsText: '' };
  await putJson(deps.kv, 'sess:sess1', s, 3600);
}
const load = (deps: ReturnType<typeof makeTestDeps>) => getJson<Session>(deps.kv, 'sess:sess1');

/** Claude whose reply is held until `release()` is called. */
function heldClaude(patch: unknown) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let started!: () => void;
  const called = new Promise<void>((r) => { started = r; });
  const callTool = vi.fn(async () => {
    started();
    await gate;
    return { input: { reply: 'Cảm ơn bạn', briefPatch: patch, quickReplies: ['a', 'b'] }, usage: { input_tokens: 1, output_tokens: 1 } };
  });
  return { claude: { callTool } as any, release, called };
}

describe('concurrent session writes', () => {
  it('upload + docs + products + confirm landing during a pending chat turn all survive; upload numbering does not collide', async () => {
    const h = heldClaude({});
    const deps = makeTestDeps({ claude: h.claude });
    await seed(deps);
    const chat = handle(jsonPost('/api/chat', { sessionId: 'sess1', text: 'xin chào' }), deps, ctx);
    await h.called;

    expect((await handle(upload('logo.png'), deps, ctx)).status).toBe(200);
    expect((await handle(jsonPost('/api/docs', { sessionId: 'sess1', text: 'Tài liệu giới thiệu' }), deps, ctx)).status).toBe(200);
    expect((await handle(jsonPost('/api/products', { sessionId: 'sess1', items: [{ ten: 'Trà', gia: 50000 }] }), deps, ctx)).status).toBe(200);
    expect((await handle(jsonPost('/api/brief/confirm', { sessionId: 'sess1' }), deps, ctx)).status).toBe(200);

    h.release();
    expect((await chat).status).toBe(200);
    const s = (await load(deps))!;
    expect(s.uploads).toEqual(['assets/1-logo.png']);
    expect(s.docsText).toBe('Tài liệu giới thiệu');
    expect(s.brief.san_pham).toEqual([{ ten: 'Trà', gia: 50000 }]);
    expect(s.brief.da_xac_nhan).toBe(true);
    expect(s.turns).toBe(4);
    expect(s.messages).toEqual([{ role: 'user', content: 'xin chào' }, { role: 'assistant', content: 'Cảm ơn bạn' }]);

    const r2 = await handle(upload('anh.png'), deps, ctx);
    expect(((await r2.json()) as any).path).toBe('assets/2-anh.png');
    expect(((await getJson<any>(deps.kv, 'up:sess1:1'))!).path).toBe('assets/1-logo.png');
    expect(((await getJson<any>(deps.kv, 'up:sess1:2'))!).path).toBe('assets/2-anh.png');
    expect((await load(deps))!.uploads).toEqual(['assets/1-logo.png', 'assets/2-anh.png']);
  });

  it('the chat patch is merged into the FRESH brief (a concurrent products import is kept; a real change still resets confirmation)', async () => {
    const h = heldClaude({ nganh: 'thực phẩm' });
    const deps = makeTestDeps({ claude: h.claude });
    await seed(deps);
    const chat = handle(jsonPost('/api/chat', { sessionId: 'sess1', text: 'đổi ngành' }), deps, ctx);
    await h.called;
    await handle(jsonPost('/api/products', { sessionId: 'sess1', items: [{ ten: 'Trà' }] }), deps, ctx);
    h.release();
    await chat;
    const s = (await load(deps))!;
    expect(s.brief.nganh).toBe('thực phẩm');
    expect(s.brief.san_pham).toEqual([{ ten: 'Trà' }]);
  });

  it('updateSession re-reads, applies the mutation and returns null for a missing session', async () => {
    const deps = makeTestDeps();
    expect(await updateSession(deps, 'nope', () => 1)).toBeNull();
    await seed(deps);
    const out = await updateSession(deps, 'sess1', (s) => { s.docsText = 'x'; return 7; });
    expect(out!.result).toBe(7);
    expect((await load(deps))!.docsText).toBe('x');
  });
});
