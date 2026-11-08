import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BriefV2Schema, defaultSite, defaultAnalysis } from '@sme/schema';
import { makeTestDeps } from './fakes';
import { getJson, putJson } from '../src/kv';
import { runDaily } from '../src/cron';
import { handle } from '../src/index';
import { jobIdxKey, queueKey, saveJob, loadJob, type JobRecord } from '../src/jobs';
import { expKey } from '../src/sites';
import type { Deps, Session, SiteMeta } from '../src/types';

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

const NOW = '2026-11-08T05:00:00.000Z';
const proposal = { summary: 's', problems: ['p'], solution: 'g', packages: [{ name: 'a', priceVnd: 10_000_000, items: ['x'] }], roadmap: [{ step: '1', desc: 'd' }] };

function mk(over: Partial<Deps> = {}) {
  const sheet = { append: vi.fn(async () => {}), update: vi.fn(async () => {}) };
  const notify = { send: vi.fn(async () => {}) };
  const publisher = {
    create: vi.fn(async (o: any) => ({ repo: o.repoName })), update: vi.fn(async () => {}),
    status: vi.fn(async () => ({ state: 'pending' as const })), remove: vi.fn(async (_repo: string) => {}),
  };
  const claude = { callTool: vi.fn(async () => ({
    input: { site: defaultSite('tpl-thu-lead', BriefV2Schema.parse({ ten_don_vi: 'X' }), 'x'), analysis: defaultAnalysis(BriefV2Schema.parse({ ten_don_vi: 'X' })) },
    usage: { input_tokens: 1, output_tokens: 1 } })) };
  const deps = makeTestDeps({ sheet, notify, publisher, claude: claude as any, ...over });
  return { deps, sheet, notify, publisher, claude };
}

async function seedSite(deps: Deps, id: string, o: Partial<SiteMeta> = {}) {
  const m: SiteMeta = { siteId: id, phone: '09' + id.length, leadKey: 'k', handoffKey: 'h', template: 'tpl-thu-lead',
    expires: '2026-11-01T00:00:00.000Z', revisions: 0, createdAt: '2026-10-01T00:00:00.000Z', name: 'n', analysisReady: true, ...o };
  await putJson(deps.kv, `site:${id}`, m);
  await putJson(deps.kv, expKey(m.expires, id), 1); // written at generate
  return m;
}

async function seedJob(deps: Deps, id: string, o: Partial<JobRecord> = {}, queued = false) {
  const sessionId = 's-' + id, siteId = 'demo-' + id;
  const s: Session = { id: sessionId, ip: '1', createdAt: NOW, turns: 9, brief: BriefV2Schema.parse({ muc_tieu_chinh: 'thu-lead', ten_don_vi: 'X', da_xac_nhan: true }), messages: [], uploads: [], docsText: '', jobId: id, siteId };
  await putJson(deps.kv, `sess:${sessionId}`, s);
  await seedSite(deps, siteId, { phone: '0912' + id, expires: '2027-01-01T00:00:00.000Z' });
  await putJson(deps.kv, `phone:0912${id}`, siteId);
  const job: JobRecord = { id, siteId, state: queued ? 'queued' : 'pending', kind: 'generate', sessionId, phone: '0912' + id, name: 'n',
    createdAt: NOW, stage: queued ? 'queued' : 'ai', stageAt: NOW, ...o };
  await saveJob(deps, job);
  await putJson(deps.kv, jobIdxKey(id), 1);
  if (queued) await putJson(deps.kv, queueKey(id), { jobId: id, createdAt: job.createdAt });
  return job;
}

describe('runDaily expiry', () => {
  it('flags expired unpaid demos removed, updates sheet; skips paid, unexpired and already removed; never calls GitHub', async () => {
    const { deps, sheet, publisher } = mk();
    await seedSite(deps, 'old1');
    await seedSite(deps, 'paid1');
    await putJson(deps.kv, 'paid:paid1', { orderCode: 1 });
    await seedSite(deps, 'fresh1', { expires: '2026-12-01T00:00:00.000Z' });
    await seedSite(deps, 'gone1', { removed: true });
    const r = await runDaily(deps);
    expect(r).toEqual({ removed: 1, processed: 0 });
    expect(publisher.remove).not.toHaveBeenCalled();
    expect(sheet.update).toHaveBeenCalledTimes(1);
    expect(sheet.update).toHaveBeenCalledWith('old1', { trang_thai: 'da_go' });
    expect((await getJson<SiteMeta>(deps.kv, 'site:old1'))!.removed).toBe(true);
    expect((await getJson<SiteMeta>(deps.kv, 'site:paid1'))!.removed).toBeUndefined();
  });

  it('a failure on one site does not stop the others (and is retried next day)', async () => {
    const { deps } = mk();
    await seedSite(deps, 'a1'); await seedSite(deps, 'b1'); await seedSite(deps, 'c1');
    const kv = deps.kv;
    deps.kv = new Proxy(kv, { get(t, k) {
      const v = (t as any)[k];
      if (k === 'put') return (key: string, ...a: any[]) => { if (key === 'site:b1') throw new Error('boom'); return v.call(t, key, ...a); };
      return typeof v === 'function' ? v.bind(t) : v;
    } });
    const r = await runDaily(deps);
    expect(r.removed).toBe(2);
    expect((await getJson<SiteMeta>(deps.kv, 'site:b1'))!.removed).toBeUndefined();
    expect((await getJson<SiteMeta>(deps.kv, 'site:c1'))!.removed).toBe(true);
  });

  it('paginates through more than one KV list page of the expiry index', async () => {
    const { deps } = mk();
    for (let i = 0; i < 1005; i++) await putJson(deps.kv, `exp:20261101:m${i}`, 1); // sites already gone
    await seedSite(deps, 'zzz-old');
    expect((await runDaily(deps)).removed).toBe(1);
    expect((await deps.kv.list({ prefix: 'exp:' })).keys).toHaveLength(0); // all due entries consumed
  }, 60_000);

  it('reads only due days of the expiry index, never every site:', async () => {
    const { deps } = mk();
    await seedSite(deps, 'old1');
    await seedSite(deps, 'later1', { expires: '2026-12-01T00:00:00.000Z' });
    await putJson(deps.kv, 'site:noindex', { siteId: 'noindex', expires: '2026-10-01T00:00:00.000Z' } as any);
    const kv = deps.kv;
    const reads: string[] = [];
    deps.kv = new Proxy(kv, { get(t, k) {
      const v = (t as any)[k];
      if (k === 'get') return (key: string, ...a: any[]) => { reads.push(key); return v.call(t, key, ...a); };
      return typeof v === 'function' ? v.bind(t) : v;
    } });
    await runDaily(deps);
    expect((await getJson<SiteMeta>(kv, 'site:old1'))!.removed).toBe(true);
    expect(reads).not.toContain('site:later1');
    expect(reads).not.toContain('site:noindex');
    expect(await kv.get(expKey('2026-12-01T00:00:00.000Z', 'later1'))).not.toBeNull();
    expect(await kv.get(expKey('2026-11-01T00:00:00.000Z', 'old1'))).toBeNull();
  });

  it('never removes a demo whose paid: key exists, even if site: was rewritten with paid:false', async () => {
    const { deps } = mk();
    await seedSite(deps, 'raced1'); // e.g. a revise/cron rewrite of site: lost meta.paid
    await putJson(deps.kv, 'paid:raced1', { orderCode: 1 });
    expect((await runDaily(deps)).removed).toBe(0);
    expect((await getJson<SiteMeta>(deps.kv, 'site:raced1'))!.removed).toBeUndefined();
  });

  it('runs the queue before expiry', async () => {
    const { deps, sheet } = mk();
    const order: string[] = [];
    sheet.append.mockImplementation(async () => { order.push('demo'); });
    sheet.update.mockImplementation(async () => { order.push('remove'); });
    await seedSite(deps, 'old1');
    await seedJob(deps, 'q1', {}, true);
    await runDaily(deps);
    expect(order).toEqual(['demo', 'remove']);
  });
});

describe('runDaily KV cleanup', () => {
  const seedData = async (deps: Deps, id: string) => {
    for (const k of [`sitejson:${id}`, `analysis:${id}`, `proposal:${id}`, `brief:${id}`, `docs:${id}`, `asset:${id}:assets/1-a.jpg`, `asset:${id}:assets/2-b.jpg`])
      await putJson(deps.kv, k, { x: 1 });
  };
  const keysOf = async (deps: Deps, id: string) => [
    ...(await deps.kv.list({ prefix: `sitejson:${id}` })).keys, ...(await deps.kv.list({ prefix: `analysis:${id}` })).keys,
    ...(await deps.kv.list({ prefix: `proposal:${id}` })).keys, ...(await deps.kv.list({ prefix: `asset:${id}:` })).keys,
    ...(await deps.kv.list({ prefix: `brief:${id}` })).keys, ...(await deps.kv.list({ prefix: `docs:${id}` })).keys].map((k) => k.name);

  it('deletes sitejson/analysis/proposal/assets (+ brief/docs) of an expired unpaid demo; /d/ then answers 410; no publisher call', async () => {
    const { deps, publisher } = mk();
    await seedSite(deps, 'old1'); await seedData(deps, 'old1');
    await runDaily(deps);
    expect(await keysOf(deps, 'old1')).toEqual([]);
    expect((await getJson<SiteMeta>(deps.kv, 'site:old1'))!.removed).toBe(true);
    const res = await handle(new Request('https://api.test/d/old1/'), deps, { waitUntil() {}, passThroughOnException() {} } as any);
    expect(res.status).toBe(410);
    expect(publisher.remove).not.toHaveBeenCalled();
  });

  it('keeps every key of a paid demo', async () => {
    const { deps } = mk();
    await seedSite(deps, 'paid1'); await seedData(deps, 'paid1');
    await putJson(deps.kv, 'paid:paid1', { orderCode: 1 });
    await runDaily(deps);
    expect((await keysOf(deps, 'paid1')).length).toBe(7);
  });

  it('does not touch another site whose id shares a prefix', async () => {
    const { deps } = mk();
    await seedSite(deps, 'old1'); await seedData(deps, 'old1');
    await seedData(deps, 'old10');
    await runDaily(deps);
    expect((await keysOf(deps, 'old10')).length).toBe(7);
  });
});

describe('runDaily queue', () => {
  it('runs queued jobs in order until the daily cap is hit', async () => {
    const { deps, claude } = mk();
    await seedJob(deps, 'q1', {}, true);
    await seedJob(deps, 'q2', {}, true);
    await seedJob(deps, 'q3', {}, true);
    let calls = 0;
    // cap trips once two jobs have used the AI
    claude.callTool.mockImplementation(async () => {
      calls++;
      if (calls >= 2) await putJson(deps.kv, 'cost:20261108', 11e6);
      return { input: { site: defaultSite('tpl-thu-lead', BriefV2Schema.parse({ ten_don_vi: 'X' }), 'x'), analysis: defaultAnalysis(BriefV2Schema.parse({ ten_don_vi: 'X' })) }, usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const r = await runDaily(deps);
    expect(r.processed).toBe(2);
    for (const id of ['q1', 'q2']) {
      const j = await loadJob(deps, id);
      expect(j).toMatchObject({ state: 'ready', stage: 'ready' });
      expect(await deps.kv.get(queueKey(id))).toBeNull();
    }
    expect((await loadJob(deps, 'q3'))!.state).toBe('queued');
    expect(await deps.kv.get(queueKey('q3'))).not.toBeNull();
  });

  it('stops immediately when already over the cap', async () => {
    const { deps, claude } = mk();
    await putJson(deps.kv, 'cost:20261108', 11e6);
    await seedJob(deps, 'q1', {}, true);
    expect(await runDaily(deps)).toEqual({ removed: 0, processed: 0 });
    expect(claude.callTool).not.toHaveBeenCalled();
  });

  it('a failing queued job (missing session) fails, is dequeued, and the loop continues', async () => {
    const { deps, notify } = mk();
    await seedJob(deps, 'q1', {}, true);
    await deps.kv.delete('sess:s-q1');
    await seedJob(deps, 'q2', {}, true);
    const r = await runDaily(deps);
    expect(r.processed).toBe(2);
    expect((await loadJob(deps, 'q1'))!.state).toBe('failed');
    expect(await deps.kv.get(queueKey('q1'))).toBeNull();
    expect((await loadJob(deps, 'q2'))!.stage).toBe('ready');
    expect(notify.send).toHaveBeenCalled();
  });

  it('drops queue entries whose job record is gone', async () => {
    const { deps } = mk();
    await putJson(deps.kv, queueKey('ghost'), { jobId: 'ghost' });
    await runDaily(deps);
    expect(await deps.kv.get(queueKey('ghost'))).toBeNull();
  });
});

describe('runDaily abandoned jobs', () => {
  it('finishes an abandoned job (customer left the status page) instead of failing it', async () => {
    const { deps, publisher } = mk();
    await seedJob(deps, 'old', { stage: 'ai', startedAt: '2026-11-08T04:00:00.000Z', stageAt: '2026-11-08T04:00:00.000Z' });
    await runDaily(deps);
    const j = (await loadJob(deps, 'old'))!;
    expect(j).toMatchObject({ state: 'ready', stage: 'ready', url: 'https://api.test/package/demo-old' });
    expect(publisher.create).not.toHaveBeenCalled();
    expect(await deps.kv.get(jobIdxKey('old'))).toBeNull();
    expect(await deps.kv.get('phone:0912old')).not.toBeNull();
  });

  it('fails (releasing the phone) an old job that still cannot be finished', async () => {
    const { deps } = mk();
    await seedJob(deps, 'old', { stage: 'ai', startedAt: '2026-11-08T04:00:00.000Z', stageAt: '2026-11-08T04:00:00.000Z' });
    await deps.kv.delete('site:demo-old'); // inputs gone: the stage cannot complete
    await runDaily(deps);
    expect((await loadJob(deps, 'old'))!.state).toBe('failed');
    expect(await deps.kv.get('phone:0912old')).toBeNull();
    expect(await deps.kv.get(jobIdxKey('old'))).toBeNull();
  });

  it('resumes a recent stalled job', async () => {
    const { deps } = mk();
    await seedJob(deps, 'rec', { stage: 'ai', startedAt: '2026-11-08T04:56:00.000Z', stageAt: '2026-11-08T04:56:00.000Z' });
    await runDaily(deps);
    expect((await loadJob(deps, 'rec'))!.stage).toBe('ready');
  });

  it('skips a job with a live lease (a status-page runner is on it)', async () => {
    const { deps, publisher, claude } = mk();
    await seedJob(deps, 'busy', { stage: 'ai', startedAt: NOW, runner: 'run-x', leaseUntil: '2026-11-08T05:04:00.000Z' });
    await runDaily(deps);
    expect(claude.callTool).not.toHaveBeenCalled();
    expect(publisher.create).not.toHaveBeenCalled();
    expect((await loadJob(deps, 'busy'))!).toMatchObject({ state: 'pending', runner: 'run-x' });
  });

  it('leaves ready and failed jobs alone and drops their index entries', async () => {
    const { deps, claude } = mk();
    await seedJob(deps, 'pub', { state: 'ready', stage: 'ready' });
    await seedJob(deps, 'bad', { state: 'failed' });
    await runDaily(deps);
    expect(claude.callTool).not.toHaveBeenCalled();
    expect((await loadJob(deps, 'pub'))!.state).toBe('ready');
    expect(await deps.kv.get(jobIdxKey('pub'))).toBeNull();
    expect(await deps.kv.get(jobIdxKey('bad'))).toBeNull();
  });
});
