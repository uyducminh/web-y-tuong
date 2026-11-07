import { describe, it, expect, vi } from 'vitest';
import { handle } from '../src/index';
import { makeTestDeps, TEST_ORIGIN, testConfig } from './fakes';
import { getJson, putJson } from '../src/kv';
import { BriefSchema } from '@sme/schema';
import type { Session, Msg } from '../src/types';
import { costMicroUsd, addCost, overDailyCap } from '../src/ai/cost';
import { makeClaudeClient } from '../src/clients/claude';

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const post = (body: unknown) =>
  new Request('https://w.test/api/chat', { method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.1.1.1', Origin: TEST_ORIGIN } });

const usage = { input_tokens: 1000, output_tokens: 200 };
type Reply = { reply: string; briefPatch: any; quickReplies: string[]; readyToGenerate: boolean };
const fakeClaude = (replies: Partial<Reply>[] | ((i: number) => Partial<Reply>)) => {
  const calls: any[] = [];
  const callTool = vi.fn(async (o: any) => {
    calls.push(o);
    const r = typeof replies === 'function' ? replies(calls.length - 1) : replies[calls.length - 1] ?? {};
    return { input: { reply: 'Xin chào', briefPatch: {}, quickReplies: ['a', 'b'], readyToGenerate: false, ...r }, usage };
  });
  return { claude: { callTool } as any, calls, callTool };
};

async function seed(deps: ReturnType<typeof makeTestDeps>, over: Partial<Session> = {}) {
  const s: Session = { id: 'sess1', ip: '1.1.1.1', createdAt: '2026-11-08T00:00:00Z', turns: 0,
    brief: BriefSchema.parse({}), messages: [], uploads: [], docsText: '', ...over };
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
  it('addCost accumulates per UTC day and overDailyCap triggers at cap', async () => {
    const deps = makeTestDeps();
    expect(await addCost(deps, 100)).toBe(100);
    expect(await addCost(deps, 50)).toBe(150);
    expect(await getJson<number>(deps.kv, 'cost:20261108')).toBe(150);
    expect(await overDailyCap(deps)).toBe(false);
    await addCost(deps, 10_000_000 - 150);
    expect(await overDailyCap(deps)).toBe(true);
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

  it('merges briefPatch (lien_he one level deeper), bumps turns, reports progress', async () => {
    const f = fakeClaude([
      { briefPatch: { ten_don_vi: 'HTX Xanh', lien_he: { phone: '0900000001' } } },
      { briefPatch: { nganh: 'Nông sản', lien_he: { zalo: '0900000001' }, bogus: 1, mau_sac: 5 } },
    ]);
    const deps = makeTestDeps({ claude: f.claude });
    await seed(deps);
    let r = await handle(post({ sessionId: 'sess1', text: 'Xin chào' }), deps, ctx);
    expect(r.status).toBe(200);
    let b = (await r.json()) as any;
    expect(b.progress.filled).toBe(2);
    expect(b.turnsLeft).toBe(11);
    expect(b.mustGenerate).toBe(false);
    expect(b.reply).toBe('Xin chào');
    r = await handle(post({ sessionId: 'sess1', text: 'tiếp' }), deps, ctx);
    b = (await r.json()) as any;
    expect(b.progress.filled).toBe(3);
    const s = (await load(deps))!;
    expect(s.turns).toBe(2);
    expect(s.brief.lien_he).toEqual({ phone: '0900000001', zalo: '0900000001' });
    expect(s.brief.nganh).toBe('Nông sản');
    expect((s.brief as any).bogus).toBeUndefined();
    expect(s.brief.mau_sac).toBeUndefined(); // invalid patch key dropped
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('turn 12 returns mustGenerate; turn 13 is 409 without calling Claude', async () => {
    const f = fakeClaude([{}]);
    const deps = makeTestDeps({ claude: f.claude });
    await seed(deps, { turns: 11 });
    const b = (await (await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx)).json()) as any;
    expect(b.mustGenerate).toBe(true);
    expect(b.turnsLeft).toBe(0);
    const r = await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx);
    expect(r.status).toBe(409);
    expect(f.callTool).toHaveBeenCalledTimes(1);
  });

  it('system prompt: wrap-up instruction from turn 9 only, missing list always', async () => {
    const f = fakeClaude(() => ({}));
    const deps = makeTestDeps({ claude: f.claude });
    await seed(deps, { turns: 7 });
    await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx); // turn 8
    await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx); // turn 9
    expect(f.calls[0].system).not.toContain('tóm tắt và đề nghị tạo demo');
    expect(f.calls[1].system).toContain('tóm tắt và đề nghị tạo demo');
    expect(f.calls[0].system).toContain('ten_don_vi');
    expect(f.calls[0].model).toBe(testConfig.chatModel);
    expect(f.calls[0].tool.name).toBeTruthy();
  });

  it('includes docsText (<=8000) in system prompt', async () => {
    const f = fakeClaude(() => ({}));
    const deps = makeTestDeps({ claude: f.claude });
    await seed(deps, { docsText: 'BANGGIA' + 'z'.repeat(9000) });
    await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx);
    const sys: string = f.calls[0].system;
    expect(sys).toContain('BANGGIA');
    expect(sys.length).toBeLessThan(8000 + 6000);
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
    expect(await getJson<number>(deps.kv, 'cost:20261108')).toBe(1000 + 1000);
    await addCost(deps, 10_000_000);
    const r = await handle(post({ sessionId: 'sess1', text: 'x' }), deps, ctx);
    expect(await r.json()).toEqual({ capped: true });
    expect(f.callTool).toHaveBeenCalledTimes(1);
    expect((await load(deps))!.turns).toBe(1);
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
});
