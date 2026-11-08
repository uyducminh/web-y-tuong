import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { handle } from '../src/index';
import { makeTestDeps, testConfig, TEST_ORIGIN } from './fakes';
import { getJson, putJson } from '../src/kv';
import { makePayosClient, payosDescription, webhookSignString } from '../src/clients/payos';
import { makeSheetClient } from '../src/clients/sheet';
import { makeTelegramNotifier } from '../src/clients/notify';
import { newOrderCode } from '../src/routes/checkout';
import { configFromEnv } from '../src/deps';
import type { Deps, SiteMeta } from '../src/types';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
// Expected failure paths log; keep test output clean.
beforeEach(() => { for (const m of ['error', 'warn'] as const) vi.spyOn(console, m).mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });
const KEY = 'checksum-key-test';
const hmac = (s: string) => createHmac('sha256', KEY).update(s).digest('hex');

type Call = { url: string; init: RequestInit; body: any };
function fakeFetch(respond: (c: Call) => unknown = () => ({ code: '00', desc: 'success', data: { checkoutUrl: 'https://pay.payos.vn/web/abc' } })) {
  const calls: Call[] = [];
  const fn = (async (url: any, init: any = {}) => {
    const c = { url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    const r = respond(c);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// ---------------------------------------------------------------- PayOS client
describe('payos client', () => {
  it('createLink signs amount&cancelUrl&description&orderCode&returnUrl (precomputed vector) and posts to PayOS', async () => {
    const f = fakeFetch();
    const p = makePayosClient({ clientId: 'cid', apiKey: 'akey', checksumKey: KEY, fetchFn: f.fn });
    const o = { orderCode: 123456789, amount: 10_000_000, description: 'SME demo-abc',
      returnUrl: 'https://web.test/thanks.html?site=demo-abc', cancelUrl: 'https://web.test/proposal.html?site=demo-abc' };
    const r = await p.createLink(o);
    expect(r).toEqual({ checkoutUrl: 'https://pay.payos.vn/web/abc' });
    expect(f.calls).toHaveLength(1);
    const c = f.calls[0];
    expect(c.url).toBe('https://api-merchant.payos.vn/v2/payment-requests');
    expect(c.init.method).toBe('POST');
    const h = new Headers(c.init.headers);
    expect(h.get('x-client-id')).toBe('cid');
    expect(h.get('x-api-key')).toBe('akey');
    expect(h.get('content-type')).toContain('application/json');
    const expected = hmac('amount=10000000&cancelUrl=https://web.test/proposal.html?site=demo-abc&description=SME demo-abc'
      + '&orderCode=123456789&returnUrl=https://web.test/thanks.html?site=demo-abc');
    expect(c.body).toEqual({ ...o, signature: expected });
  });

  it('createLink throws when PayOS answers code != 00 or without checkoutUrl', async () => {
    const o = { orderCode: 1, amount: 10_000_000, description: 'x', returnUrl: 'https://a', cancelUrl: 'https://b' };
    const bad = makePayosClient({ clientId: 'c', apiKey: 'a', checksumKey: KEY, fetchFn: fakeFetch(() => ({ code: '20', desc: 'bad' })).fn });
    await expect(bad.createLink(o)).rejects.toThrow();
    const noUrl = makePayosClient({ clientId: 'c', apiKey: 'a', checksumKey: KEY, fetchFn: fakeFetch(() => ({ code: '00', data: {} })).fn });
    await expect(noUrl.createLink(o)).rejects.toThrow();
  });

  it('verifyWebhook: sorted k=v over data (null → empty, objects → JSON), constant-time compare', () => {
    const p = makePayosClient({ clientId: 'c', apiKey: 'a', checksumKey: KEY, fetchFn: fakeFetch().fn });
    const data = { orderCode: 123, amount: 3000, description: 'VQRIO123', accountNumber: '12345678', reference: 'TF230204212323',
      transactionDateTime: '2023-02-04 18:25:00', currency: 'VND', paymentLinkId: '124c33293c43417ab7879e14c8d9eb18',
      code: '00', desc: 'Thành công', counterAccountBankId: '', counterAccountBankName: null, counterAccountName: undefined,
      virtualAccountName: '', extra: { b: 1 } };
    const str = 'accountNumber=12345678&amount=3000&code=00&counterAccountBankId=&counterAccountBankName=&counterAccountName='
      + '&currency=VND&desc=Thành công&description=VQRIO123&extra={"b":1}&orderCode=123&paymentLinkId=124c33293c43417ab7879e14c8d9eb18'
      + '&reference=TF230204212323&transactionDateTime=2023-02-04 18:25:00&virtualAccountName=';
    expect(webhookSignString(data)).toBe(str);
    const body = { code: '00', desc: 'success', success: true, data, signature: hmac(str) };
    expect(p.verifyWebhook(body)).toBe(true);
    expect(p.verifyWebhook({ ...body, signature: hmac(str).toUpperCase() })).toBe(false);
    expect(p.verifyWebhook({ ...body, data: { ...data, amount: 3001 } })).toBe(false);
    expect(p.verifyWebhook({ ...body, signature: hmac(str).slice(0, 63) })).toBe(false);
    expect(p.verifyWebhook({ ...body, signature: undefined })).toBe(false);
    expect(p.verifyWebhook({ ...body, data: null })).toBe(false);
    expect(p.verifyWebhook(null)).toBe(false);
    expect(p.verifyWebhook('x')).toBe(false);
  });

  it('payosDescription: ASCII only, 40 chars cut to 25', () => {
    const forty = 'A'.repeat(40);
    expect(payosDescription(forty)).toBe('A'.repeat(25));
    expect(payosDescription('Thanh toán Đồng Tháp')).toBe('Thanh toan Dong Thap');
    expect(payosDescription('SME demo-hop-tac-xa-rau-sach-ab12')).toHaveLength(25);
    expect(payosDescription('SME demo-hop-tac-xa-rau-sach-ab12')).toMatch(/^[\x20-\x7e]+$/);
  });
});

// ---------------------------------------------------------------- Sheet + notifier
describe('sheet client', () => {
  it('append/update POST {token, action, ...} to SHEET_URL', async () => {
    const f = fakeFetch(() => ({ ok: true }));
    const s = makeSheetClient({ url: 'https://script.test/exec', token: 'tok', fetchFn: f.fn });
    await s.append({ ten: 'An', so_tien: 5 });
    await s.update('demo-a', { trang_thai: 'da_thanh_toan' });
    expect(f.calls.map((c) => [c.url, c.init.method])).toEqual([['https://script.test/exec', 'POST'], ['https://script.test/exec', 'POST']]);
    expect(f.calls[0].body).toEqual({ token: 'tok', action: 'append', row: { ten: 'An', so_tien: 5 } });
    expect(f.calls[1].body).toEqual({ token: 'tok', action: 'update', siteId: 'demo-a', patch: { trang_thai: 'da_thanh_toan' } });
  });
  it('never throws (network error, ok:false) and is a no-op without URL', async () => {
    const boom = makeSheetClient({ url: 'https://s', token: 't', fetchFn: fakeFetch(() => new Error('down')).fn });
    await expect(boom.append({ a: 1 })).resolves.toBeUndefined();
    await expect(boom.update('x', { a: 'b' })).resolves.toBeUndefined();
    const notOk = makeSheetClient({ url: 'https://s', token: 't', fetchFn: fakeFetch(() => ({ ok: false, error: 'bad token' })).fn });
    await expect(notOk.append({ a: 1 })).resolves.toBeUndefined();
    const f = fakeFetch();
    await makeSheetClient({ url: undefined, token: 't', fetchFn: f.fn }).append({ a: 1 });
    expect(f.calls).toHaveLength(0);
  });
});

describe('telegram notifier', () => {
  it('sends {chat_id, text} to the Bot API', async () => {
    const f = fakeFetch(() => ({ ok: true }));
    await makeTelegramNotifier({ token: 'T0K', chatId: '-100', fetchFn: f.fn }).send('Xin chào');
    expect(f.calls[0].url).toBe('https://api.telegram.org/botT0K/sendMessage');
    expect(f.calls[0].body).toEqual({ chat_id: '-100', text: 'Xin chào' });
  });
  it('no-op without token/chat; never throws', async () => {
    const f = fakeFetch();
    await makeTelegramNotifier({ token: undefined, chatId: '1', fetchFn: f.fn }).send('x');
    await makeTelegramNotifier({ token: 't', chatId: '', fetchFn: f.fn }).send('x');
    expect(f.calls).toHaveLength(0);
    await expect(makeTelegramNotifier({ token: 't', chatId: '1', fetchFn: fakeFetch(() => new Error('x')).fn }).send('x')).resolves.toBeUndefined();
  });
});

describe('configFromEnv PACKAGES', () => {
  it('parses JSON array, invalid/non-array → []', () => {
    const pk = [{ id: 'co-ban', name: 'Cơ bản', priceVnd: 10_000_000, items: ['a'] }];
    expect(configFromEnv({ PACKAGES: JSON.stringify(pk) } as any).packages).toEqual(pk);
    expect(configFromEnv({ PACKAGES: '{bad' } as any).packages).toEqual([]);
    expect(configFromEnv({ PACKAGES: '{"id":"x"}' } as any).packages).toEqual([]);
    expect(configFromEnv({ ALLOW_TEST_PRICE: '1' } as any).allowTestPrice).toBe(true);
    expect(configFromEnv({} as any).allowTestPrice).toBe(false);
  });
});

// ---------------------------------------------------------------- routes
const META: SiteMeta = { siteId: 'rau-ab12cd', phone: '0912345678', leadKey: 'k'.repeat(32), handoffKey: 'h'.repeat(32),
  template: 'tpl-ban-hang', expires: '2026-12-08', revisions: 0, createdAt: '2026-11-08', name: 'HTX Rau Sạch', analysisReady: true };

function routeDeps(over: Partial<Deps> = {}) {
  const pf = fakeFetch();
  const sheetCalls: [string, Record<string, string>][] = [];
  const notes: string[] = [];
  const deps = makeTestDeps({
    payos: makePayosClient({ clientId: 'c', apiKey: 'a', checksumKey: KEY, fetchFn: pf.fn }),
    sheet: { append: async () => {}, update: async (id, p) => { sheetCalls.push([id, p]); } },
    notify: { send: async (t) => { notes.push(t); } },
    ...over,
  });
  return { deps, payosCalls: pf.calls, sheetCalls, notes };
}
let seq = 0;
async function mkSite(deps: Deps, patch: Partial<SiteMeta> = {}) {
  const meta = { ...META, siteId: `demo-rau-${++seq}`, ...patch };
  await putJson(deps.kv, `site:${meta.siteId}`, meta);
  return meta;
}
const checkout = (body: unknown) => new Request('https://w.test/api/checkout', {
  method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', Origin: TEST_ORIGIN } });
const webhook = (body: unknown) => new Request('https://w.test/webhook/payos', {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } });

function signedWebhook(orderCode: number, amount: number, extra: Record<string, unknown> = {}, code = '00') {
  const data = { orderCode, amount, description: 'SME', accountNumber: '1', reference: 'R1', transactionDateTime: '2026-11-08 12:00:00',
    currency: 'VND', paymentLinkId: 'pl', code, desc: 'success', counterAccountBankId: null, ...extra };
  return { code, desc: 'success', success: code === '00', data, signature: hmac(webhookSignString(data)) };
}

describe('POST /api/checkout', () => {
  it('creates a PayOS link with config price, stores order:<code>, CORS for web origin', async () => {
    const { deps, payosCalls } = routeDeps();
    const meta = await mkSite(deps);
    // client-sent amount must be ignored
    const res = await handle(checkout({ siteId: meta.siteId, packageId: 'co-ban', amount: 1000 }), deps, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ checkoutUrl: 'https://pay.payos.vn/web/abc' });
    expect(res.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
    const b = payosCalls[0].body;
    expect(b.amount).toBe(10_000_000);
    expect(b.returnUrl).toBe(`${TEST_ORIGIN}/thanks.html?site=${meta.siteId}`);
    expect(b.cancelUrl).toBe(`${TEST_ORIGIN}/proposal.html?site=${meta.siteId}`);
    expect(b.description.length).toBeLessThanOrEqual(25);
    expect(b.description).toMatch(/^[\x20-\x7e]+$/);
    expect(Number.isSafeInteger(b.orderCode) && b.orderCode > 0).toBe(true);
    const order = await getJson<any>(deps.kv, `order:${b.orderCode}`);
    expect(order).toEqual({ siteId: meta.siteId, packageId: 'co-ban', amount: 10_000_000, createdAt: deps.now().toISOString() });
  });

  it('unknown packageId → 400', async () => {
    const { deps, payosCalls } = routeDeps();
    const meta = await mkSite(deps);
    const res = await handle(checkout({ siteId: meta.siteId, packageId: 'khong-co' }), deps, ctx);
    expect(res.status).toBe(400);
    expect(payosCalls).toHaveLength(0);
  });

  it('paid:<siteId> → 409 even if site: says paid:false (rewritten by cron/revise)', async () => {
    const { deps, payosCalls } = routeDeps();
    const meta = await mkSite(deps);
    await putJson(deps.kv, `paid:${meta.siteId}`, { orderCode: 1 });
    const res = await handle(checkout({ siteId: meta.siteId, packageId: 'co-ban' }), deps, ctx);
    expect(res.status).toBe(409);
    expect(payosCalls).toHaveLength(0);
  });

  it('already paid site → 409', async () => {
    const { deps, payosCalls } = routeDeps();
    const meta = await mkSite(deps);
    await putJson(deps.kv, `paid:${meta.siteId}`, { orderCode: 1 }); // paid: is the only source of truth
    const res = await handle(checkout({ siteId: meta.siteId, packageId: 'co-ban' }), deps, ctx);
    expect(res.status).toBe(409);
    expect(payosCalls).toHaveLength(0);
  });

  it('expired unpaid or removed demo → 410 "Bản dùng thử đã hết hạn.", no order, no PayOS call; expired but paid → 409', async () => {
    const { deps, payosCalls } = routeDeps();
    const past = new Date(deps.now().getTime() - 1000).toISOString();
    for (const patch of [{ expires: past }, { removed: true }] as Partial<SiteMeta>[]) {
      const meta = await mkSite(deps, patch);
      const res = await handle(checkout({ siteId: meta.siteId, packageId: 'co-ban' }), deps, ctx);
      expect(res.status).toBe(410);
      expect(((await res.json()) as any).error).toBe('Bản dùng thử đã hết hạn.');
    }
    expect(payosCalls).toHaveLength(0);
    expect((await deps.kv.list({ prefix: 'order:' })).keys).toHaveLength(0);
    const paid = await mkSite(deps, { expires: past });
    await putJson(deps.kv, `paid:${paid.siteId}`, { orderCode: 1 });
    expect((await handle(checkout({ siteId: paid.siteId, packageId: 'co-ban' }), deps, ctx)).status).toBe(409);
  });

  it('unknown site → 404; bad body → 400', async () => {
    const { deps } = routeDeps();
    expect((await handle(checkout({ siteId: 'nope', packageId: 'co-ban' }), deps, ctx)).status).toBe(404);
    expect((await handle(checkout({ packageId: 'co-ban' }), deps, ctx)).status).toBe(400);
    expect((await handle(webhook('{bad'), deps, ctx)).status).toBe(200);
  });

  it('package price < 10.000.000 rejected unless allowTestPrice', async () => {
    const cheap = { ...testConfig, packages: [{ id: 'thu', name: 'Thử', priceVnd: 2000, items: [] }] };
    const a = routeDeps({ config: cheap });
    const m1 = await mkSite(a.deps);
    expect((await handle(checkout({ siteId: m1.siteId, packageId: 'thu' }), a.deps, ctx)).status).toBe(400);
    expect(a.payosCalls).toHaveLength(0);
    const b = routeDeps({ config: { ...cheap, allowTestPrice: true } });
    const m2 = await mkSite(b.deps);
    expect((await handle(checkout({ siteId: m2.siteId, packageId: 'thu' }), b.deps, ctx)).status).toBe(200);
    expect(b.payosCalls[0].body.amount).toBe(2000);
  });

  it('PayOS failure → 502, no dangling order', async () => {
    const pf = fakeFetch(() => ({ code: '231', desc: 'Đơn thanh toán đã tồn tại' }));
    const { deps } = routeDeps({ payos: makePayosClient({ clientId: 'c', apiKey: 'a', checksumKey: KEY, fetchFn: pf.fn }) });
    const meta = await mkSite(deps);
    const res = await handle(checkout({ siteId: meta.siteId, packageId: 'co-ban' }), deps, ctx);
    expect(res.status).toBe(502);
    expect(await getJson(deps.kv, `order:${pf.calls[0].body.orderCode}`)).toBeNull();
  });
});

describe('newOrderCode', () => {
  it('is Date.now()%1e9 * 100 + 2 random digits; retries when order:<code> exists', async () => {
    const { deps } = routeDeps();
    const base = (deps.now().getTime() % 1e9) * 100;
    await putJson(deps.kv, `order:${base + 7}`, { siteId: 'x' });
    const picks = [7, 7, 42];
    const code = await newOrderCode(deps, () => picks.shift()!);
    expect(code).toBe(base + 42);
    expect(Number.isSafeInteger(code)).toBe(true);
    expect(await getJson<any>(deps.kv, `order:${base + 7}`)).toEqual({ siteId: 'x' });
  });
  it('gives up after repeated collisions', async () => {
    const { deps } = routeDeps();
    const base = (deps.now().getTime() % 1e9) * 100;
    await putJson(deps.kv, `order:${base + 3}`, { siteId: 'x' });
    await expect(newOrderCode(deps, () => 3)).rejects.toThrow();
  });
});

describe('POST /webhook/payos', () => {
  async function mkOrder(deps: Deps, patch: Partial<SiteMeta> = {}, amount = 10_000_000) {
    const meta = await mkSite(deps, patch);
    const orderCode = 900000000 + ++seq;
    await putJson(deps.kv, `order:${orderCode}`, { siteId: meta.siteId, packageId: 'co-ban', amount, createdAt: '2026-11-08T05:00:00.000Z' });
    return { meta, orderCode };
  }
  const paidOf = async (deps: Deps, id: string) => (await deps.kv.get(`paid:${id}`)) !== null;

  it('valid signature + code 00 → paid, sheet updated, team notified (Vietnamese, formatted amount)', async () => {
    const { deps, sheetCalls, notes } = routeDeps();
    const { meta, orderCode } = await mkOrder(deps);
    const res = await handle(webhook(signedWebhook(orderCode, 10_000_000)), deps, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await paidOf(deps, meta.siteId)).toBe(true);
    expect(sheetCalls).toEqual([[meta.siteId, { trang_thai: 'da_thanh_toan', goi: 'Cơ bản', so_tien: '10000000',
      link_ban_giao: `https://api.test/handoff/${meta.siteId}?key=${meta.handoffKey}` }]]);
    expect(notes).toHaveLength(1);
    for (const s of ['HTX Rau Sạch', '0912345678', 'Cơ bản', '10.000.000đ', `https://api.test/d/${meta.siteId}/`,
      `https://api.test/handoff/${meta.siteId}?key=${meta.handoffKey}`]) expect(notes[0]).toContain(s);
  });

  it('rewrites every asset:<id>:* without TTL (and brief:/docs:), leaves other sites alone', async () => {
    const { deps } = routeDeps();
    const { meta, orderCode } = await mkOrder(deps);
    const other = `${meta.siteId}0`;
    for (const k of [`asset:${meta.siteId}:assets/1-a.jpg`, `asset:${meta.siteId}:assets/2-b.jpg`, `brief:${meta.siteId}`, `docs:${meta.siteId}`, `asset:${other}:assets/1-a.jpg`])
      await deps.kv.put(k, JSON.stringify({ mime: 'image/jpeg', base64: 'QQ==' }), { expirationTtl: 3600 });
    await handle(webhook(signedWebhook(orderCode, 10_000_000)), deps, ctx);
    for (const k of [`asset:${meta.siteId}:assets/1-a.jpg`, `asset:${meta.siteId}:assets/2-b.jpg`, `brief:${meta.siteId}`, `docs:${meta.siteId}`]) {
      const e = (await deps.kv.list({ prefix: k })).keys.find((x) => x.name === k)!;
      expect(e.expiration, k).toBeUndefined();
      expect(await deps.kv.get(k)).toContain('QQ==');
    }
    const o = (await deps.kv.list({ prefix: `asset:${other}:` })).keys[0];
    expect(o.expiration).toBeDefined();
  });

  it('does not rewrite site: when the site is already paid (no race with revise)', async () => {
    const { deps } = routeDeps();
    const { meta, orderCode } = await mkOrder(deps);
    await putJson(deps.kv, `paid:${meta.siteId}`, { orderCode: 1 });
    await putJson(deps.kv, `site:${meta.siteId}`, { ...meta, revisions: 5 });
    const puts: string[] = [];
    const kv = deps.kv;
    deps.kv = new Proxy(kv, { get(t, k) {
      const v = (t as any)[k];
      if (k === 'put') return (key: string, ...a: any[]) => { puts.push(key); return v.call(t, key, ...a); };
      return typeof v === 'function' ? v.bind(t) : v;
    } });
    const res = await handle(webhook(signedWebhook(orderCode, 10_000_000)), deps, ctx);
    expect(res.status).toBe(200);
    expect(puts).not.toContain(`site:${meta.siteId}`);
    expect((await getJson<SiteMeta>(kv, `site:${meta.siteId}`))!.revisions).toBe(5);
  });

  it('invalid signature → 200 {ok:true}, nothing changes', async () => {
    const { deps, sheetCalls, notes } = routeDeps();
    const { meta, orderCode } = await mkOrder(deps);
    const body = signedWebhook(orderCode, 10_000_000);
    body.signature = hmac('tampered');
    const res = await handle(webhook(body), deps, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await paidOf(deps, meta.siteId)).toBe(false);
    expect(await getJson(deps.kv, `paidorder:${orderCode}`)).toBeNull();
    expect(sheetCalls).toHaveLength(0);
    expect(notes).toHaveLength(0);
  });

  it('same orderCode twice → exactly one sheet.update and one notify.send', async () => {
    const { deps, sheetCalls, notes } = routeDeps();
    const { orderCode } = await mkOrder(deps);
    const body = signedWebhook(orderCode, 10_000_000);
    expect((await handle(webhook(body), deps, ctx)).status).toBe(200);
    expect((await handle(webhook(body), deps, ctx)).status).toBe(200);
    expect(sheetCalls).toHaveLength(1);
    expect(notes).toHaveLength(1);
    expect(await getJson(deps.kv, `paidorder:${orderCode}`)).not.toBeNull();
  });

  it('amount mismatch → not paid, but the team is alerted', async () => {
    const { deps, sheetCalls, notes } = routeDeps();
    const { meta, orderCode } = await mkOrder(deps);
    expect((await handle(webhook(signedWebhook(orderCode, 2000)), deps, ctx)).status).toBe(200);
    expect(await paidOf(deps, meta.siteId)).toBe(false);
    expect(await getJson(deps.kv, `paidorder:${orderCode}`)).toBeNull();
    expect(await getJson(deps.kv, `paid:${meta.siteId}`)).toBeNull();
    expect(sheetCalls).toHaveLength(0);
    expect(notes).toHaveLength(1);
    for (const x of ['không khớp', String(orderCode), '2000', '10.000.000đ', 'R1']) expect(notes[0]).toContain(x);
  });

  it('writes paid:<siteId> (no TTL), removes the expiry index entry, counts stat:paid', async () => {
    const { deps } = routeDeps();
    const { meta, orderCode } = await mkOrder(deps);
    await putJson(deps.kv, 'exp:20261208:' + meta.siteId, 1);
    await handle(webhook(signedWebhook(orderCode, 10_000_000)), deps, ctx);
    const paid = await deps.kv.getWithMetadata(`paid:${meta.siteId}`);
    expect(JSON.parse(paid.value!)).toMatchObject({ siteId: meta.siteId, orderCode, amount: 10_000_000, reference: 'R1' });
    const listed = (await deps.kv.list({ prefix: `paid:${meta.siteId}` })).keys[0];
    expect(listed.expiration).toBeUndefined();
    expect(await deps.kv.get('exp:20261208:' + meta.siteId)).toBeNull();
    expect(await deps.kv.get('stat:paid:20261108')).toBe('1');
  });

  it('sheet + notify happen BEFORE the paidorder marker; a KV failure after a valid signature alerts the team and answers 500, and the retry still notifies', async () => {
    const { deps, sheetCalls, notes } = routeDeps();
    const { meta, orderCode } = await mkOrder(deps);
    const realKv = deps.kv;
    let failMarker = true;
    const events: string[] = [];
    deps.kv = new Proxy(realKv, { get(t, k) {
      const v = (t as any)[k];
      if (k === 'put') return async (key: string, ...a: any[]) => {
        if (key.startsWith('paidorder:')) { events.push('marker'); if (failMarker) throw new Error('KV 429'); }
        return v.call(t, key, ...a);
      };
      return typeof v === 'function' ? v.bind(t) : v;
    } });
    deps.notify = { send: async (txt) => { events.push('notify'); notes.push(txt); } };
    const r1 = await handle(webhook(signedWebhook(orderCode, 10_000_000)), deps, ctx);
    expect(r1.status).toBe(500);
    expect(events.indexOf('notify')).toBeLessThan(events.indexOf('marker'));
    expect(sheetCalls).toHaveLength(1);
    expect(notes).toHaveLength(2); // paid notice + failure alert
    expect(notes[1]).toContain('CẢNH BÁO');
    for (const x of [String(orderCode), '10000000', 'R1']) expect(notes[1]).toContain(x);
    expect(await getJson(realKv, `paid:${meta.siteId}`)).not.toBeNull(); // already protected from the cron
    expect(await getJson(realKv, `paidorder:${orderCode}`)).toBeNull();

    failMarker = false; // PayOS retries
    const r2 = await handle(webhook(signedWebhook(orderCode, 10_000_000)), deps, ctx);
    expect(r2.status).toBe(200);
    expect(notes.filter((n) => n.startsWith('ĐÃ THANH TOÁN'))).toHaveLength(2); // duplicate notice is acceptable
    expect(await getJson(realKv, `paidorder:${orderCode}`)).not.toBeNull();
  });

  it('a KV read failure after a valid signature still alerts the team', async () => {
    const { deps, notes } = routeDeps();
    const { orderCode } = await mkOrder(deps);
    const realKv = deps.kv;
    deps.kv = new Proxy(realKv, { get(t, k) {
      const v = (t as any)[k];
      if (k === 'get') return async () => { throw new Error('KV down'); };
      return typeof v === 'function' ? v.bind(t) : v;
    } });
    const r = await handle(webhook(signedWebhook(orderCode, 10_000_000)), deps, ctx);
    expect(r.status).toBe(500);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(String(orderCode));
  });

  it('code != 00 → nothing changes', async () => {
    const { deps, sheetCalls, notes } = routeDeps();
    const { meta, orderCode } = await mkOrder(deps);
    await handle(webhook(signedWebhook(orderCode, 10_000_000, {}, '01')), deps, ctx);
    expect(await paidOf(deps, meta.siteId)).toBe(false);
    expect(sheetCalls.length + notes.length).toBe(0);
  });

  it('PayOS test webhook (orderCode 123, unknown) → 200, no changes', async () => {
    const { deps, sheetCalls, notes } = routeDeps();
    const res = await handle(webhook(signedWebhook(123, 3000)), deps, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await getJson(deps.kv, 'paidorder:123')).toBeNull();
    expect(sheetCalls.length + notes.length).toBe(0);
  });

  it('sheet/notify failures do not break the webhook; site is still marked paid', async () => {
    const { deps } = routeDeps({
      sheet: { append: async () => {}, update: async () => { throw new Error('sheet down'); } },
      notify: { send: async () => { throw new Error('tg down'); } },
    });
    const { meta, orderCode } = await mkOrder(deps);
    const res = await handle(webhook(signedWebhook(orderCode, 10_000_000)), deps, ctx);
    expect(res.status).toBe(200);
    expect(await paidOf(deps, meta.siteId)).toBe(true);
  });
});
