import { describe, it, expect } from 'vitest';
import { handle } from '../src/index';
import { makeTestDeps, TEST_ORIGIN } from './fakes';
import { getJson, putJson } from '../src/kv';
import type { Session } from '../src/types';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPG = [0xff, 0xd8, 0xff, 0xe0];
const WEBP = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50];

function bytes(head: number[], size = 64): Uint8Array<ArrayBuffer> {
  const u = new Uint8Array(size); u.set(head); return u;
}
async function mkSession(deps: ReturnType<typeof makeTestDeps>, id = 's1', extra: Partial<Session> = {}) {
  const s = { id, ip: '1.1.1.1', turns: 0, messages: [], brief: {}, uploads: [], docsText: '', ...extra } as unknown as Session;
  await putJson(deps.kv, `sess:${id}`, s, 3600);
  return s;
}
function upload(sessionId: string | null, data: Uint8Array<ArrayBuffer>, name: string, type: string) {
  const fd = new FormData();
  if (sessionId !== null) fd.set('sessionId', sessionId);
  fd.set('file', new File([data], name, { type }));
  return new Request('https://w.test/api/upload', { method: 'POST', body: fd, headers: { Origin: TEST_ORIGIN } });
}
const docs = (body: unknown) => new Request('https://w.test/api/docs', { method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', Origin: TEST_ORIGIN } });

describe('POST /api/upload', () => {
  it('404 for unknown session', async () => {
    const res = await handle(upload('nope', bytes(PNG), 'a.png', 'image/png'), makeTestDeps(), ctx);
    expect(res.status).toBe(404);
  });

  it.each([
    ['png', PNG, 'image/png', 'logo cửa hàng.png', 'assets/1-logo-cua-hang.png', 'image/png'],
    ['jpg', JPG, 'image/jpeg', 'Ảnh.JPG', 'assets/1-anh.jpg', 'image/jpeg'],
    ['webp', WEBP, 'image/webp', 'x.webp', 'assets/1-x.webp', 'image/webp'],
  ])('accepts %s, stores JSON in KV and appends to session', async (_n, head, type, name, path, mime) => {
    const deps = makeTestDeps(); await mkSession(deps);
    const res = await handle(upload('s1', bytes(head as number[]), name as string, type as string), deps, ctx);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).path).toBe(path);
    const v = await getJson<any>(deps.kv, 'up:s1:1');
    expect(v.path).toBe(path); expect(v.mime).toBe(mime);
    expect(atob(v.base64).length).toBe(64);
    expect((await getJson<Session>(deps.kv, 'sess:s1'))!.uploads).toEqual([path]);
  });

  it('extension comes from magic bytes, not filename', async () => {
    const deps = makeTestDeps(); await mkSession(deps);
    const res = await handle(upload('s1', bytes(JPG), 'pic.png', 'image/png'), deps, ctx);
    expect(((await res.json()) as any).path).toBe('assets/1-pic.jpg');
  });

  it('413 for the 11th file', async () => {
    const deps = makeTestDeps();
    await mkSession(deps, 's1', { uploads: Array.from({ length: 10 }, (_, i) => `assets/${i + 1}-a.png`) });
    const res = await handle(upload('s1', bytes(PNG), 'a.png', 'image/png'), deps, ctx);
    expect(res.status).toBe(413);
  });

  it('413 for 5MB + 1 byte, accepts exactly 5MB', async () => {
    const deps = makeTestDeps(); await mkSession(deps);
    const big = await handle(upload('s1', bytes(PNG, 5 * 1024 * 1024 + 1), 'a.png', 'image/png'), deps, ctx);
    expect(big.status).toBe(413);
    const ok = await handle(upload('s1', bytes(PNG, 5 * 1024 * 1024), 'a.png', 'image/png'), deps, ctx);
    expect(ok.status).toBe(200);
  });

  it('415 for image/gif', async () => {
    const deps = makeTestDeps(); await mkSession(deps);
    const res = await handle(upload('s1', bytes([0x47, 0x49, 0x46, 0x38]), 'a.gif', 'image/gif'), deps, ctx);
    expect(res.status).toBe(415);
  });

  it('415 for .png whose magic bytes are not PNG', async () => {
    const deps = makeTestDeps(); await mkSession(deps);
    const res = await handle(upload('s1', bytes([...new TextEncoder().encode('not an image at all')]), 'a.png'', 'image/png'), deps, ctx);
    expect(res.status).toBe(415);
  });

  it('415 for RIFF that is not WEBP', async () => {
    const deps = makeTestDeps(); await mkSession(deps);
    const wav = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45];
    const res = await handle(upload('s1', bytes(wav), 'a.webp', 'image/webp'), deps, ctx);
    expect(res.status).toBe(415);
  });

  it('400 when file missing', async () => {
    const deps = makeTestDeps(); await mkSession(deps);
    const fd = new FormData(); fd.set('sessionId', 's1');
    const res = await handle(new Request('https://w.test/api/upload', { method: 'POST', body: fd }), deps, ctx);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/docs', () => {
  it('404 unknown session', async () => {
    const res = await handle(docs({ sessionId: 'x', text: 'hi' }), makeTestDeps(), ctx);
    expect(res.status).toBe(404);
  });

  it('two calls totalling 9000 chars truncate to 8000 with separator', async () => {
    const deps = makeTestDeps(); await mkSession(deps);
    await handle(docs({ sessionId: 's1', text: 'a'.repeat(4000) }), deps, ctx);
    const res = await handle(docs({ sessionId: 's1', text: 'b'.repeat(5000) }), deps, ctx);
    expect(res.status).toBe(200);
    const s = await getJson<Session>(deps.kv, 'sess:s1');
    expect(s!.docsText.length).toBe(8000);
    expect(s!.docsText.slice(4000, 4002)).toBe('\n\n');
  });

  it('400 on empty text', async () => {
    const deps = makeTestDeps(); await mkSession(deps);
    expect((await handle(docs({ sessionId: 's1', text: '  ' }), deps, ctx)).status).toBe(400);
  });
});
