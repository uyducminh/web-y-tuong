import { describe, it, expect, vi } from 'vitest';
import { handle } from '../src/index';
import { makeTestDeps, TEST_ORIGIN, testConfig } from './fakes';
import { getJson, putJson } from '../src/kv';
import { BriefV2Schema, STEP_LABELS } from '@sme/schema';
import type { Session, Msg } from '../src/types';
import { costMicroUsd, addCost, costToday, overDailyCap, COST_SHARDS } from '../src/ai/cost';
import { ClaudeError, makeClaudeClient } from '../src/clients/claude';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const post = (body: unknown) =>
  new Request('https://w.test/api/chat', { method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.1.1.1', Origin: TEST_ORIGIN } });

const get = (path: string) => new Request(`https://w.test${path}`, { headers: { Origin: TEST_ORIGIN } });
const FULL = { ten_don_vi: 'HTX A', loai_hinh: 'htx', nganh: 'nông sản', dia_phuong: 'Lâm Đồng', san_pham: [{ ten: 'Cà phê' }],
  diem_khac_biet: 'OCOP', khach_hang_muc_tieu: 'quán', muc_tieu_chinh: 'ban-hang', hanh_dong_mong_muon: 'zalo', cam_giac: 'moc-mac',
  meta: { askedOptional: ['tham_khao', 'tai_lieu'] } } as const;
const usage = { input_tokens: 1000, output_tokens: 200 };
type Reply = { reply: string; briefPatch: any; quickReplies: string[]; choices: any; askedOptional: string };
const fakeClaude = (replies: Partial<Reply>[] | ((i: number) => Partial<Reply>)) => {
  const calls: any[] = [];
  const callTool = vi.fn(async (o: any) => {
    calls.push(o);
    const r = typeof replies === 'function' ? replies(calls.length - 1) : replies[calls.length - 1] ?? {};
    return { input: { reply: 'Xin chào', briefPatch: {}, quickReplies: ['a', 'b'], ...r }, usage };
  });
  return { claude: { callTool } as any, calls, callTool };
};

async function seed(deps: ReturnType<typeof makeTestDeps>, over: Partial<Session> = {}) {
  const s: Session = { id: 'sess1', ip: '1.1.1.1', createdAt: '2026-11-08T00:00:00Z', turns: 0,
    brief: BriefV2Schema.parse({}), messages: [], uploads: [], docsText: '', ...over };
  await putJson(deps.kv, `sess:${s.id}`, s, 3600);
  return s;
}
const load = (deps: any) => getJson<Session>(deps.kv, 'sess:sess1');

describe('cost', () => {
  it('costMicroUsd uses per-model config prices', () => {
    expect(costMicroUsd('claude-haiku-5-5', usage, testConfig)).toBe(1000 * 1 + 200 * 5);
    expect(costMicroUsd('claude-sonnet-5-5', usage, testConfig)).toBe(1000 * 3 + 200 * 15);
    expect(costMicroUsd('unknown', usage, testConfig)).toBe(0);
  });
  it('addCost accumulates per UTC day across shards and overDailyCap triggers at cap', async () => {
    const deps = makeTestDeps();
    expect(await addCost(deps, 100, 0)).toBe(true);
    expect(await addCost(deps, 50, 1)).toBe(true);
    expect(await addCost(deps, 25, 1)).toBe(true);
    expect(await getJson<number>(deps.kv, 'cost:20261108:1')).toBe(75);
    await putJson(deps.kv, 'cost:20261108', 5); // unsharded key (manual override) is included
    expect(await costToday(deps)).toBe(180);
    expect(await overDailyCap(deps)).toBe(false);
    await addCost(deps, 10_000_000 - 180);
    expect(await overDailyCap(deps)).toBe(true);
    expect(COST_SHARDS).toBeGreaterThan(1);
  });

  it('addCost never throws (KV write limit) and reports false', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeTestDeps();
    deps.kv = new Proxy(deps.kv, { get(t, k) {
      const v = (t as any)[k];
      if (k === 'put') return async () => { throw new Error('KV PUT failed: 429 Too Many Requests'); };
      return typeof v === 'function' ? v.bind(t) : v;
    } });
    await expect(addCost(deps, 100)).resolves.toBe(false);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('POST /api/chat', () => {
  it('404 when session missing, 400 on bad body', async () => {
    const deps = makeTestDeps();
    const r = await handle(post({ sessionId: 'nope', text: 'hi' }), deps, ctx);
    expect(r.status).toBe(404);
    expect(((await r.json()) as any).error).toMatch(/[ạăâêôơưđáàảãéèíìóòúùý]/i);
    expect((await handle(post({ text: 1 }), deps, ctx)).status).toBe(400);
  });

  it('merges briefPatch, bumps turns, reports step/done/missing/canConfirm/turnsLeft', async () => {
    const f = fakeClaude([
      { briefPatch: { ten_don_vi: 'HTX Xanh', lien_he: { phone: '0900000001' } } },
      { briefPatch: { nganh: 'Nông sản', lien_he: { zalo: '0900000001' }, bogus: 1, cam_giac: 'kiểu-lạ' } },
    ]);
    const deps = makeTestDeps({ claude: f.claude });
    await seed(deps);
    let r = await handle(post({ sessionId: 'sess1', text: 'Xin chào' }), deps, ctx);
    expect(r.status).toBe(200);
    let b = (await r.json()) as any;
    expect(b.step).toEqual({ id: 'don_vi', index: 1, label: STEP_LABELS.don_vi });
    expect(b.done).toEqual(['xac_nhan']); // contact already present: done is data-driven, not order-driven
    expect(b.missing).toContain('loai_hinh');
    expect(b.canConfirm).toBe(false);
    expect(b.turnsLeft).toBe(29);
    expect(b.mustConfirm).toBe(false);
    expect(b.reply).toBe('Xin chào');
    expect(b.progress).toBeUndefined();
    r = await handle(post({ sessionId: 'sess1', text: 'tiếp' }), deps, ctx);
    b = (await r.json()) as any;
    expect(b.turnsLeft).toBe(28);
    const s = (await load(deps))!;
    expect(s.turns).toBe(2);
    expect(s.brief.lien_he).toEqual({ phone: '0900000001', zalo: '0900000001' });
    expect(s.brief.nganh).toBe('Nông sản');
    expect((s.brief as any).bogus).toBeUndefined();
    expect(s.brief.cam_giac).toBeUndefined();
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('one reply filling steps 1 and 2 moves step to khach_hang', async () => {
    const f = fakeClaude([{ briefPatch: { ten_don_vi: 'HTX A', loai_hinh: 'htx', nganh: 'nông sản', dia_phuong: 'Lâm Đồng',
      san_pham: [{ ten: 'Cà phê', gia: 90000 }], diem_khac_biet: 'OCOP' } }]);
    const deps = makeTestDeps({ claude: f.claude });
    await seed(deps);
    const b = (await (await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx)).json()) as any;
    expect(b.step.id).toBe('khach_hang');
    expect(b.step.index).toBe(3);
    expect(b.done).toEqual(['don_vi', 'san_pham']);
  });

  it('turn 30 returns mustConfirm; turn 31 is 409 without calling Claude', async () => {
    const f = fakeClaude([{}]);
    const deps = makeTestDeps({ claude: f.claude });
    await seed(deps, { turns: 29 });
    const b = (await (await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx)).json()) as any;
    expect(b.mustConfirm).toBe(true);
    expect(b.turnsLeft).toBe(0);
    const r = await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx);
    expect(r.status).toBe(409);
    expect(f.callTool).toHaveBeenCalledTimes(1);
  });

  it('system prompt: step label + missing of current step; wrap-up from turn 26 only', async () => {
    const f = fakeClaude(() => ({}));
    const deps = makeTestDeps({ claude: f.claude });
    await seed(deps, { turns: 24 });
    await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx); // turn 25
    await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx); // turn 26
    expect(f.calls[0].system).not.toContain('tóm tắt và chuyển sang bước 8');
    expect(f.calls[1].system).toContain('tóm tắt và chuyển sang bước 8');
    expect(f.calls[0].system).toContain(STEP_LABELS.don_vi);
    for (const k of ['ten_don_vi', 'loai_hinh', 'nganh', 'dia_phuong']) expect(f.calls[0].system).toContain(k);
    expect(f.calls[0].model).toBe(testConfig.chatModel);
    expect(f.calls[0].tool.name).toBeTruthy();
  });

  it('prompt follows the data-driven step (tham_khao asks link/ảnh; tai_lieu invites files)', async () => {
    const f = fakeClaude(() => ({}));
    const deps = makeTestDeps({ claude: f.claude });
    const { meta: _m, ...base } = FULL;
    await seed(deps, { brief: BriefV2Schema.parse(base) });
    await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx);
    expect(f.calls[0].system).toContain(STEP_LABELS.tham_khao);
    expect(f.calls[0].system).toMatch(/thích điểm gì/);
    await seed(deps, { brief: BriefV2Schema.parse({ ...base, meta: { askedOptional: ['tham_khao'] } }) });
    await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx);
    expect(f.calls[1].system).toContain(STEP_LABELS.tai_lieu);
    expect(f.calls[1].system).toMatch(/logo/);
  });

  it('caps choices at 8; passes kind/options through; drops malformed choices', async () => {
    const opts = Array.from({ length: 12 }, (_, i) => ({ value: 'v' + i, label: 'L' + i, hint: 'h' }));
    const f = fakeClaude([{ choices: { kind: 'multi', options: opts } }, { choices: { kind: 'nope', options: [] } as any }]);
    const deps = makeTestDeps({ claude: f.claude });
    await seed(deps);
    let b = (await (await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx)).json()) as any;
    expect(b.choices.kind).toBe('multi');
    expect(b.choices.options).toHaveLength(8);
    expect(b.choices.options[0]).toEqual({ value: 'v0', label: 'L0', hint: 'h' });
    b = (await (await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx)).json()) as any;
    expect(b.choices).toBeUndefined();
  });

  it('askedOptional is recorded only for tham_khao / tai_lieu', async () => {
    const f = fakeClaude([{ askedOptional: 'tham_khao' }, { askedOptional: 'muc_tieu' }, { askedOptional: 'tai_lieu' }]);
    const deps = makeTestDeps({ claude: f.claude });
    await seed(deps);
    for (let i = 0; i < 3; i++) await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx);
    expect((await load(deps))!.brief.meta?.askedOptional).toEqual(['tham_khao', 'tai_lieu']);
  });

  it('after confirmation, a chat turn that edits nganh resets da_xac_nhan', async () => {
    const f = fakeClaude([{ briefPatch: { nganh: 'thực phẩm' } }]);
    const deps = makeTestDeps({ claude: f.claude });
    await seed(deps, { brief: BriefV2Schema.parse({ ...FULL, lien_he: { zalo: '0912345678' }, da_xac_nhan: true }) });
    const r = await handle(get('/api/brief/sess1'), deps, ctx);
    expect(((await r.json()) as any).brief.da_xac_nhan).toBe(true);
    await handle(post({ sessionId: 'sess1', text: 'đổi ngành' }), deps, ctx);
    const b = (await (await handle(get('/api/brief/sess1'), deps, ctx)).json()) as any;
    expect(b.brief.da_xac_nhan).toBe(false);
    expect(b.brief.nganh).toBe('thực phẩm');
  });

  it('includes docsText (<=8000) in system prompt', async () => {
    const f = fakeClaude(() => ({}));
    const deps = makeTestDeps({ claude: f.claude });
    await seed(deps, { docsText: 'BANGGIA' + 'z'.repeat(9000) });
    await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx);
    const sys: string = f.calls[0].system;
    expect(sys).toContain('BANGGIA');
    expect(sys.split('z').length - 1).toBeLessThanOrEqual(8000);
  });

  it('caps quickReplies at 4 and truncates text at 2000 chars; sends last 20 messages', async () => {
    const f = fakeClaude([{ quickReplies: ['1', '2', '3', '4', '5', '6'] }]);
    const deps = makeTestDeps({ claude: f.claude });
    const messages: Msg[] = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i }));
    await seed(deps, { messages, turns: 3 });
    const b = (await (await handle(post({ sessionId: 'sess1', text: 'a'.repeat(3000) }), deps, ctx)).json()) as any;
    expect(b.quickReplies).toEqual(['1', '2', '3', '4']);
    const sent: Msg[] = f.calls[0].messages;
    expect(sent.length).toBeLessThanOrEqual(21);
    expect(sent[sent.length - 1]).toEqual({ role: 'user', content: 'a'.repeat(2000) });
    expect(sent[0].role).toBe('user');
  });

  it('daily cap -> {capped:true}, no Claude call, session untouched; cost recorded on success', async () => {
    const f = fakeClaude([{}]);
    const deps = makeTestDeps({ claude: f.claude });
    await seed(deps);
    await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx);
    expect(await costToday(deps)).toBe(1000 + 1000);
    await addCost(deps, 10_000_000);
    const r = await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx);
    expect(await r.json()).toEqual({ capped: true });
    expect(f.callTool).toHaveBeenCalledTimes(1);
    expect((await load(deps))!.turns).toBe(1);
  });

  it('a failing cost write after Claude billed does not fail the chat turn', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fakeClaude([{ reply: 'Đã ghi nhận' }]);
    const deps = makeTestDeps({ claude: f.claude });
    await seed(deps);
    const kv = deps.kv;
    deps.kv = new Proxy(kv, { get(t, k) {
      const v = (t as any)[k];
      if (k === 'put') return async (key: string, ...a: any[]) => {
        if (key.startsWith('cost:')) throw new Error('KV PUT failed: 429 Too Many Requests');
        return v.call(t, key, ...a);
      };
      return typeof v === 'function' ? v.bind(t) : v;
    } });
    const r = await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).reply).toBe('Đã ghi nhận');
    const s = (await load(deps))!;
    expect(s.turns).toBe(1);
    expect(s.messages.map((m) => m.content)).toEqual(['x', 'Đã ghi nhận']);
    errSpy.mockRestore();
  });

  it('a billed reply without tool_use is still counted as cost (and the turn answers 503)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const callTool = vi.fn(async () => { throw new ClaudeError('Claude returned no tool_use block', false, usage); });
    const deps = makeTestDeps({ claude: { callTool } as any });
    await seed(deps);
    const r = await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx);
    expect(r.status).toBe(503);
    expect(await costToday(deps)).toBe(1000 + 1000);
    expect((callTool.mock.calls[0] as any[])[0]).toMatchObject({ timeoutMs: 30_000 });
    errSpy.mockRestore();
  });

  it('503 Vietnamese message when Claude fails; turns and messages unchanged', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const callTool = vi.fn(async () => { throw new Error('boom'); });
    const deps = makeTestDeps({ claude: { callTool } as any });
    await seed(deps, { turns: 2 });
    const r = await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx);
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).error).toMatch(/[ạăâêôơưđáàảãéèíìóòúùý]/i);
    const s = (await load(deps))!;
    expect(s.turns).toBe(2);
    expect(s.messages).toEqual([]);
    errSpy.mockRestore();
  });
});

describe('claude client retries', () => {
  const okBody = { content: [{ type: 'tool_use', name: 't', input: { ok: 1 } }], usage };
  const opts = { model: 'm', system: 's', messages: [{ role: 'user' as const, content: 'x' }], tool: { name: 't', input_schema: {} }, maxTokens: 100 };
  const mk = (statuses: number[]) => {
    let i = 0;
    const fetch = vi.fn(async () => {
      const st = statuses[i++];
      return st === 200 ? new Response(JSON.stringify(okBody), { status: 200 }) : new Response('err', { status: st });
    });
    const sleeps: number[] = [];
    const client = makeClaudeClient({ apiKey: 'k', fetch: fetch as any, sleep: async (ms) => { sleeps.push(ms); } });
    return { client, fetch, sleeps };
  };

  it('succeeds after 2 failures with 500ms then 1500ms backoff', async () => {
    const { client, fetch, sleeps } = mk([500, 529, 200]);
    const r = await client.callTool<{ ok: number }>(opts);
    expect(r.input.ok).toBe(1);
    expect(r.usage).toEqual(usage);
    expect(sleeps).toEqual([500, 1500]);
    const [url, init] = fetch.mock.calls[0] as any;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('k');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 't' });
    expect(body.max_tokens).toBe(100);
  });

  it('throws after 3 failed attempts', async () => {
    const { client, fetch } = mk([500, 500, 500, 200]);
    await expect(client.callTool(opts)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('retries 429 and network errors, but not non-retryable 4xx', async () => {
    const r429 = mk([429, 200]);
    await expect(r429.client.callTool(opts)).resolves.toMatchObject({ input: { ok: 1 } });
    expect(r429.fetch).toHaveBeenCalledTimes(2);
    for (const st of [400, 401, 403, 404, 413]) {
      const m = mk([st, 200]);
      const err = await m.client.callTool(opts).catch((e) => e);
      expect(err).toBeInstanceOf(ClaudeError);
      expect(err.retryable).toBe(false);
      expect(m.fetch).toHaveBeenCalledTimes(1);
    }
    let n = 0;
    const net = makeClaudeClient({ apiKey: 'k', sleep: async () => {}, fetch: (async () => {
      if (n++ === 0) throw new TypeError('fetch failed');
      return new Response(JSON.stringify(okBody), { status: 200 });
    }) as any });
    await expect(net.callTool(opts)).resolves.toMatchObject({ input: { ok: 1 } });
    expect(n).toBe(2);
  });

  it('a reply without tool_use is not retried and carries the billed usage', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'xin chào' }], usage }), { status: 200 }));
    const client = makeClaudeClient({ apiKey: 'k', fetch: fetch as any, sleep: async () => {} });
    const err = await client.callTool(opts).catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeError);
    expect(err.usage).toEqual(usage);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('passes an AbortSignal timeout and does not retry a timed-out request', async () => {
    const seen: AbortSignal[] = [];
    const fetch = vi.fn(async (_u: string, init: any) => {
      seen.push(init.signal);
      return new Promise<Response>((_res, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)));
    });
    const client = makeClaudeClient({ apiKey: 'k', fetch: fetch as any, sleep: async () => {} });
    const err = await client.callTool({ ...opts, timeoutMs: 50 }).catch((e) => e);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(err).toBeInstanceOf(ClaudeError);
    expect(err.message).toMatch(/timed out/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
