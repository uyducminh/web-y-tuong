import { describe, it, expect } from 'vitest';
import { handle } from '../src/index';
import { makeTestDeps, TEST_ORIGIN } from './fakes';
import { getJson } from '../src/kv';
import { BriefV2Schema } from '@sme/schema';
import { vi } from 'vitest';
import type { Session } from '../src/types';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const post = (path: string, body: unknown, ip = '1.1.1.1', extra: Record<string, string> = {}) =>
  new Request('https://w.test' + path, { method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip, Origin: TEST_ORIGIN, ...extra } });

describe('POST /api/session', () => {
  it('403 when turnstile token invalid', async () => {
    const res = await handle(post('/api/session', { turnstileToken: 'bad' }, '2.2.2.2'), makeTestDeps(), ctx);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatch(/[ạăâêôơưđáàảãéèíìóòúùý]/i);
  });

  it('creates a session stored in KV with turns 0 and 7-day TTL', async () => {
    const deps = makeTestDeps();
    const putSpy = vi.spyOn(deps.kv, 'put');
    const res = await handle(post('/api/session', { turnstileToken: 'good' }, '3.3.3.3'), deps, ctx);
    expect(res.status).toBe(200);
    const { sessionId } = (await res.json()) as { sessionId: string };
    const s = await getJson<Session>(deps.kv, `sess:${sessionId}`);
    expect(s?.turns).toBe(0);
    expect(s?.ip).toBe('3.3.3.3');
    expect(s?.messages).toEqual([]);
    expect(s?.uploads).toEqual([]);
    expect(s?.docsText).toBe('');
    expect(s?.brief).toEqual(BriefV2Schema.parse({}));
    const call = putSpy.mock.calls.find((c) => c[0] === `sess:${sessionId}`);
    expect((call![2] as any).expirationTtl).toBe(7 * 24 * 3600);
    // funnel counter, ~400-day TTL
    expect(await deps.kv.get('stat:sessions:20261108')).toBe('1');
    const stat = putSpy.mock.calls.find((c) => c[0] === 'stat:sessions:20261108');
    expect((stat![2] as any).expirationTtl).toBe(400 * 24 * 3600);
  });

  it('429 with Vietnamese message from the 4th session of the same IP/day', async () => {
    const deps = makeTestDeps();
    for (let i = 0; i < 3; i++) {
      expect((await handle(post('/api/session', { turnstileToken: 'good' }, '4.4.4.4'), deps, ctx)).status).toBe(200);
    }
    const res = await handle(post('/api/session', { turnstileToken: 'good' }, '4.4.4.4'), deps, ctx);
    expect(res.status).toBe(429);
    expect(((await res.json()) as any).error).toContain('3 phiên');
    // another IP unaffected
    expect((await handle(post('/api/session', { turnstileToken: 'good' }, '5.5.5.5'), deps, ctx)).status).toBe(200);
  });

  it('400 on malformed body', async () => {
    const req = new Request('https://w.test/api/session', { method: 'POST', body: 'nope', headers: { 'CF-Connecting-IP': '6.6.6.6' } });
    expect((await handle(req, makeTestDeps(), ctx)).status).toBe(400);
  });
});

describe('router', () => {
  it('404 JSON for unknown route', async () => {
    const res = await handle(new Request('https://w.test/api/nope'), makeTestDeps(), ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(((await res.json()) as any).error).toBeTruthy();
  });

  it('CORS allows only config.webOrigin on /api/*', async () => {
    const deps = makeTestDeps();
    const ok = await handle(post('/api/session', { turnstileToken: 'bad' }, '7.7.7.7'), deps, ctx);
    expect(ok.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
    const nf = await handle(new Request('https://w.test/api/nope'), deps, ctx);
    expect(nf.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
    const pre = await handle(new Request('https://w.test/api/session', { method: 'OPTIONS',
      headers: { Origin: TEST_ORIGIN, 'Access-Control-Request-Method': 'POST' } }), deps, ctx);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');
    expect(pre.headers.get('access-control-allow-origin')).not.toBe('*');
    const evil = await handle(new Request('https://w.test/api/nope', { headers: { Origin: 'https://evil.test' } }), deps, ctx);
    expect(evil.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
    const evilPre = await handle(new Request('https://w.test/api/session', { method: 'OPTIONS', headers: { Origin: 'https://evil.test' } }), deps, ctx);
    expect(evilPre.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
  });
});
