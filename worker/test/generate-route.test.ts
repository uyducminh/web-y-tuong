import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { BriefV2Schema, defaultSite, type SiteJson, defaultAnalysis } from '@sme/schema';
import { makeTestDeps, TEST_ORIGIN } from './fakes';
import { handle } from '../src/index';
import { getJson, putJson } from '../src/kv';
import { runGenerateJob, type JobRecord } from '../src/jobs';
import { costToday } from '../src/ai/cost';
import type { Deps, Job, Session, SiteMeta } from '../src/types';

// Expected failure paths log via console.error; keep test output clean.
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

const usage = { input_tokens: 10, output_tokens: 10 };
const proposal = {
  summary: 'Tóm tắt', problems: ['p'], solution: 'Giải pháp',
  packages: [{ name: 'Cơ bản', priceVnd: 10_000_000, items: ['x'] }],
  roadmap: [{ step: '1', desc: 'd' }],
};
const API = 'https://api.test';
const SITE_ID_RE = /^[a-z0-9-]+-[a-z0-9]{6}$/;

function okClaude(siteOver: Partial<SiteJson> = {}) {
  return { callTool: vi.fn(async () => ({
    input: { site: { ...defaultSite('tpl-thu-lead', BriefV2Schema.parse({ ten_don_vi: 'HTX Mây Tre' }), 'x'), ...siteOver }, analysis: defaultAnalysis(BriefV2Schema.parse({ ten_don_vi: 'HTX Mây Tre' })) },
    usage,
  })) } as any;
}

type P = Deps['publisher'];
type RecPublisher = { create: Mock<P['create']>; update: Mock<P['update']>; status: Mock<P['status']>; remove: Mock<P['remove']> };
/** The trial flow must never touch GitHub: every publisher method throws if called. */
function recPublisher(): RecPublisher {
  const boom = (n: string) => async () => { throw new Error(`publisher.${n} must not be called`); };
  return {
    create: vi.fn<P['create']>(boom('create')), update: vi.fn<P['update']>(boom('update')),
    status: vi.fn<P['status']>(boom('status')), remove: vi.fn<P['remove']>(boom('remove')),
  };
}
const expectNoPublisher = (p: RecPublisher) => {
  for (const f of [p.create, p.update, p.status, p.remove]) expect(f).not.toHaveBeenCalled();
};

function mkDeps(over: Partial<Deps> = {}) {
  const sheet = { append: vi.fn<Deps['sheet']['append']>(async () => {}), update: vi.fn<Deps['sheet']['update']>(async () => {}) };
  const notify = { send: vi.fn<Deps['notify']['send']>(async () => {}) };
  const publisher = recPublisher();
  const deps = makeTestDeps({ claude: okClaude(), publisher, sheet, notify, ...over });
  return { deps, sheet, notify, publisher: deps.publisher as unknown as RecPublisher, claude: deps.claude as any };
}

function mkCtx() {
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext;
  return { ctx, flush: () => Promise.all(waits) };
}

async function seedSession(deps: Deps, id: string, opts: { uploads?: number; brief?: any } = {}) {
  const uploads: string[] = [];
  for (let i = 1; i <= (opts.uploads ?? 0); i++) {
    const path = `assets/${i}-anh.jpg`;
    uploads.push(path);
    await putJson(deps.kv, `up:${id}:${i}`, { path, mime: 'image/jpeg', base64: btoa(`img${i}`) });
  }
  const s: Session = {
    id, ip: '1.1.1.1', createdAt: '2026-11-08T04:00:00Z', turns: 9,
    brief: BriefV2Schema.parse(opts.brief ?? { muc_tieu_chinh: 'thu-lead', ten_don_vi: 'HTX Mây Tre Đan', da_xac_nhan: true }),
    messages: [], uploads, docsText: '',
  };
  await putJson(deps.kv, `sess:${id}`, s);
  return s;
}

const req = (method: string, path: string, body?: unknown) =>
  new Request(`${API}${path}`, { method, headers: { 'content-type': 'application/json', Origin: TEST_ORIGIN },
    body: body === undefined ? undefined : JSON.stringify(body) });

/** POST /api/jobs/:id/run once. */
async function run(deps: Deps, jobId: string) {
  const res = await handle(req('POST', `/api/jobs/${jobId}/run`, {}), deps, mkCtx().ctx);
  return { res, data: (await res.json()) as any };
}

/** Like the status page: call /run until it says something other than `run`. */
async function drive(deps: Deps, jobId: string) {
  let last: any;
  for (let i = 0; i < 6; i++) {
    last = (await run(deps, jobId)).data;
    if (last.next !== 'run') break;
  }
  return last;
}

/** POST /api/generate; nothing runs in waitUntil, so (by default) drive the job like the status page does. */
async function generate(deps: Deps, body: unknown, o: { drive?: boolean } = {}) {
  const { ctx, flush } = mkCtx();
  const res = await handle(req('POST', '/api/generate', body), deps, ctx);
  await flush();
  const data = (await res.json()) as any;
  if (res.ok && data.jobId && o.drive !== false) await drive(deps, data.jobId);
  return { res, data };
}

const siteOfJob = async (deps: Deps, jobId: string) => (await getJson<JobRecord>(deps.kv, `job:${jobId}`))!.siteId;

describe('POST /api/generate', () => {
  it('rejects an invalid phone with 400', async () => {
    const { deps } = mkDeps();
    await seedSession(deps, 'sA');
    const { res, data } = await generate(deps, { sessionId: 'sA', phone: '12345', name: 'Lan' });
    expect(res.status).toBe(400);
    expect(data.error).toMatch(/số điện thoại/i);
  });

  it('409 when the brief is not confirmed (no job, no phone reservation)', async () => {
    const { deps } = mkDeps();
    await seedSession(deps, 'sU', { brief: { muc_tieu_chinh: 'thu-lead', ten_don_vi: 'HTX' } });
    const { res, data } = await generate(deps, { sessionId: 'sU', phone: '0912345678', name: 'Lan' });
    expect(res.status).toBe(409);
    expect(data.error).toBe('Vui lòng xác nhận thông tin trước khi tạo bản dùng thử.');
    expect(await deps.kv.get('phone:0912345678')).toBeNull();
  });

  it('a turn-30 default unit name (meta.auto) stays out of the siteId slug', async () => {
    const { deps } = mkDeps();
    await seedSession(deps, 'sAuto', { brief: { muc_tieu_chinh: 'thu-lead', ten_don_vi: 'Chị Lan', da_xac_nhan: true, meta: { auto: ['ten_don_vi'] } } });
    const { res, data } = await generate(deps, { sessionId: 'sAuto', phone: '0912345670', name: 'Chị Lan' }, { drive: false });
    expect(res.status).toBe(200);
    expect(await siteOfJob(deps, data.jobId)).toMatch(/^site-[a-z0-9]{6}$/);
  });

  it('404 for unknown session', async () => {
    const { deps } = mkDeps();
    const { res } = await generate(deps, { sessionId: 'nope', phone: '0912345678', name: 'Lan' });
    expect(res.status).toBe(404);
  });

  it('409 with the old package link when the phone already has a demo', async () => {
    const { deps, publisher } = mkDeps();
    await seedSession(deps, 'sB');
    await putJson(deps.kv, 'phone:0912345678', 'cu-abcdef');
    const { res, data } = await generate(deps, { sessionId: 'sB', phone: '0912 345 678', name: 'Lan' });
    expect(res.status).toBe(409);
    expect(data.error).toContain('Số điện thoại này đã có bản dùng thử');
    expect(data.url).toBe(`${API}/package/cu-abcdef`);
    expectNoPublisher(publisher);
  });

  it('is idempotent per session: same jobId, Claude called once', async () => {
    const { deps, claude } = mkDeps();
    await seedSession(deps, 'sC');
    const a = await generate(deps, { sessionId: 'sC', phone: '0912345678', name: 'Lan' });
    const b = await generate(deps, { sessionId: 'sC', phone: '0912345678', name: 'Lan' });
    expect(a.res.status).toBe(200);
    expect(b.res.status).toBe(200);
    expect(a.data.jobId).toBeTruthy();
    expect(b.data.jobId).toBe(a.data.jobId);
    expect(claude.callTool).toHaveBeenCalledTimes(1);
  });

  it('two /run calls take the job ai → ready and store demo, analysis and images in KV (no GitHub)', async () => {
    const { deps, publisher, sheet, notify } = mkDeps();
    await seedSession(deps, 'sD', { uploads: 2 });
    const { res, data } = await generate(deps, { sessionId: 'sD', phone: '+84 912 345 678', name: 'Chị Lan' }, { drive: false });
    expect(res.status).toBe(200);
    const jobId = data.jobId;
    const siteId = await siteOfJob(deps, jobId);
    expect(siteId).toMatch(SITE_ID_RE);
    expect(siteId).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(siteId.startsWith('htx-may-tre-dan-')).toBe(true);

    // While Claude runs, the job is at stage `ai`.
    const stagesSeen: string[] = [];
    const inner = okClaude();
    deps.claude = { callTool: vi.fn(async (...a: any[]) => {
      stagesSeen.push((await getJson<JobRecord>(deps.kv, `job:${jobId}`))!.stage);
      return inner.callTool(...a);
    }) } as any;

    const url = `${API}/package/${siteId}`;
    const first = await run(deps, jobId);
    expect(first.data).toEqual({ id: jobId, siteId, state: 'ready', url, next: 'done' });
    const second = await run(deps, jobId);
    expect(second.data).toEqual({ id: jobId, siteId, state: 'ready', url, next: 'done' });
    expect(stagesSeen).toEqual(['ai']);
    expect((deps.claude as any).callTool).toHaveBeenCalledTimes(1);

    const job = (await getJson<JobRecord>(deps.kv, `job:${jobId}`))!;
    expect(job).toMatchObject({ state: 'ready', stage: 'ready', url });
    expect(job.runner).toBeUndefined();
    expect(await deps.kv.get(`jobidx:${jobId}`)).toBeNull();
    expect(await deps.kv.get('stat:demos:20261108')).toBe('1');

    const meta = (await getJson<SiteMeta>(deps.kv, `site:${siteId}`))!;
    expect(meta.leadKey).toMatch(/^[a-z0-9]{32}$/);
    expect(meta.handoffKey).toMatch(/^[a-z0-9]{32}$/);
    expect(meta.handoffKey).not.toBe(meta.leadKey);
    expect(meta).toMatchObject({ siteId, phone: '0912345678', revisions: 0, name: 'Chị Lan', template: 'tpl-thu-lead',
      analysisReady: true, createdAt: '2026-11-08T05:00:00.000Z', expires: '2026-12-08T05:00:00.000Z' });
    expect(meta).not.toHaveProperty('repo');
    expect(await deps.kv.get('phone:0912345678')).toBe(JSON.stringify(siteId));

    const site = (await getJson<any>(deps.kv, `sitejson:${siteId}`))!;
    expect(site.siteId).toBe(siteId);
    expect(site.demo.checkoutUrl).toBe(`${TEST_ORIGIN}/proposal.html?site=${siteId}`);
    expect((await getJson<any>(deps.kv, `analysis:${siteId}`)).free.tom_tat_doanh_nghiep).toContain('HTX Mây Tre');
    // proposal: is still written for GET /api/proposal (web-main proposal page) until the package page replaces it.
    expect((await getJson<any>(deps.kv, `proposal:${siteId}`)).summary).toContain('HTX Mây Tre');

    // Images copied from up:<sessionId>:<n> (7-day TTL) to asset:<siteId>:<path>, living until the demo expires.
    expect(await getJson(deps.kv, `asset:${siteId}:assets/1-anh.jpg`)).toEqual({ mime: 'image/jpeg', base64: btoa('img1') });
    expect(await getJson(deps.kv, `asset:${siteId}:assets/2-anh.jpg`)).toEqual({ mime: 'image/jpeg', base64: btoa('img2') });
    const listed = (await deps.kv.list({ prefix: `asset:${siteId}:` })).keys;
    expect(listed.map((k) => k.name).sort()).toEqual([`asset:${siteId}:assets/1-anh.jpg`, `asset:${siteId}:assets/2-anh.jpg`]);
    const ttl = listed[0].expiration! - Date.now() / 1000;
    expect(Math.abs(ttl - 30 * 86_400)).toBeLessThan(600); // seconds until `expires` (fixed clock is 30 days before it)

    const sess = (await getJson<Session>(deps.kv, 'sess:sD'))!;
    expect(sess.jobId).toBe(jobId);
    expect(sess.siteId).toBe(siteId);

    expect(sheet.append).toHaveBeenCalledTimes(1);
    const row = sheet.append.mock.calls[0][0] as any;
    expect(row).toMatchObject({ ten: 'Chị Lan', sdt: '0912345678', nhu_cau: 'thu-lead', trang_thai: 'demo', siteId,
      link_demo: `${API}/d/${siteId}/`, link_lead: `${API}/leads/${siteId}?key=${meta.leadKey}` });
    expect(row.link_demo.endsWith(`/d/${siteId}/`)).toBe(true);
    expect(row.thoi_gian).toBeTruthy();
    expect(notify.send).toHaveBeenCalledTimes(1);
    const text = notify.send.mock.calls[0][0] as string;
    for (const s of ['Chị Lan', '0912345678', `${API}/d/${siteId}/`]) expect(text).toContain(s);
    expectNoPublisher(publisher);
  });

  it('persists brief:/docs: for the handoff page; assets get no TTL when the site is already paid at write time', async () => {
    const { deps } = mkDeps();
    const s = await seedSession(deps, 'sP', { uploads: 1 });
    await putJson(deps.kv, 'sess:sP', { ...s, docsText: 'Bảng giá' });
    const { data } = await generate(deps, { sessionId: 'sP', phone: '0912000124', name: 'Lan' }, { drive: false });
    const siteId = await siteOfJob(deps, data.jobId);
    await deps.kv.put(`paid:${siteId}`, '1'); // payment arrives during the AI stage
    expect((await run(deps, data.jobId)).data.state).toBe('ready');
    expect((await getJson<any>(deps.kv, `brief:${siteId}`)).ten_don_vi).toBe('HTX Mây Tre Đan');
    expect(await getJson(deps.kv, `docs:${siteId}`)).toBe('Bảng giá');
    const [k] = (await deps.kv.list({ prefix: `asset:${siteId}:` })).keys;
    expect(k.expiration).toBeUndefined();
  });

  it('asset TTL never drops below 60 s for a demo expiring very soon', async () => {
    const { deps } = mkDeps();
    await seedSession(deps, 'sT', { uploads: 1 });
    const { data } = await generate(deps, { sessionId: 'sT', phone: '0912000123', name: 'Lan' }, { drive: false });
    const siteId = await siteOfJob(deps, data.jobId);
    const meta = (await getJson<SiteMeta>(deps.kv, `site:${siteId}`))!;
    await putJson(deps.kv, `site:${siteId}`, { ...meta, expires: new Date(deps.now().getTime() + 5_000).toISOString() });
    expect((await run(deps, data.jobId)).data.state).toBe('ready');
    const [k] = (await deps.kv.list({ prefix: `asset:${siteId}:` })).keys;
    expect(k.expiration! - Date.now() / 1000).toBeGreaterThan(50);
    expect(k.expiration! - Date.now() / 1000).toBeLessThan(120);
  });

  it('queues the job without calling Claude when over the daily cap', async () => {
    const { deps, claude, publisher } = mkDeps();
    await putJson(deps.kv, 'cost:20261108', 999_000_000);
    await seedSession(deps, 'sE');
    const { res, data } = await generate(deps, { sessionId: 'sE', phone: '0912000111', name: 'Lan' });
    expect(res.status).toBe(200);
    const job = (await getJson<Job>(deps.kv, `job:${data.jobId}`))!;
    expect(job.state).toBe('queued');
    expect(await deps.kv.get(`queue:${data.jobId}`)).not.toBeNull();
    expect(claude.callTool).not.toHaveBeenCalled();
    expectNoPublisher(publisher);
    const st = await handle(req('GET', `/api/status/${data.jobId}`), deps, mkCtx().ctx);
    expect(((await st.json()) as any).state).toBe('queued');
  });

  it('runGenerateJob processes a queued job later (cron path)', async () => {
    const { deps, publisher } = mkDeps();
    await putJson(deps.kv, 'cost:20261108', 999_000_000);
    await seedSession(deps, 'sF');
    const { data } = await generate(deps, { sessionId: 'sF', phone: '0912000222', name: 'Lan' });
    await deps.kv.delete('cost:20261108');
    const job = await runGenerateJob(deps, data.jobId);
    expect(job).toMatchObject({ state: 'ready', url: `${API}/package/${job.siteId}` });
    expect(await deps.kv.get(`queue:${data.jobId}`)).toBeNull();
    expectNoPublisher(publisher);
  });

  it('still creates a demo with default content and analysis when Claude is down', async () => {
    const claude = { callTool: vi.fn(async () => { throw new Error('claude 529'); }) } as any;
    const { deps } = mkDeps({ claude });
    await seedSession(deps, 'sG');
    const { res, data } = await generate(deps, { sessionId: 'sG', phone: '0912000333', name: 'Lan' });
    expect(res.status).toBe(200);
    const siteId = await siteOfJob(deps, data.jobId);
    expect((await getJson<any>(deps.kv, `sitejson:${siteId}`)).brand.name).toBe('HTX Mây Tre Đan');
    expect((await getJson<any>(deps.kv, `analysis:${siteId}`)).free.tom_tat_doanh_nghiep).toContain('HTX Mây Tre Đan');
    expect((await getJson<any>(deps.kv, `proposal:${siteId}`)).packages[0].priceVnd).toBeGreaterThanOrEqual(10_000_000);
    expect((await getJson<Job>(deps.kv, `job:${data.jobId}`))!.state).toBe('ready');
  });

  it('a job not ready 10 minutes after it started is given up, releases the phone, and the same session can retry', async () => {
    const { deps, notify } = mkDeps();
    await seedSession(deps, 'sH');
    const first = await generate(deps, { sessionId: 'sH', phone: '0912000444', name: 'Lan' }, { drive: false });
    // A runner took it to `ai` and died (no lease left).
    const j = (await getJson<JobRecord>(deps.kv, `job:${first.data.jobId}`))!;
    await putJson(deps.kv, `job:${j.id}`, { ...j, stage: 'ai', startedAt: j.createdAt });
    expect(notify.send).not.toHaveBeenCalled();

    const t0 = deps.now().getTime();
    deps.now = () => new Date(t0 + 11 * 60_000);
    const st = await status(deps, first.data.jobId);
    expect(st.state).toBe('failed');
    expect(st.error).toBeTruthy();
    expect(await deps.kv.get('phone:0912000444')).toBeNull();
    expect(notify.send).toHaveBeenCalledTimes(1);

    const second = await generate(deps, { sessionId: 'sH', phone: '0912000444', name: 'Lan' });
    expect(second.res.status).toBe(200);
    expect(second.data.jobId).not.toBe(first.data.jobId);
    expect((await getJson<JobRecord>(deps.kv, `job:${second.data.jobId}`))!).toMatchObject({ state: 'ready', stage: 'ready' });
  });
});

async function status(deps: Deps, jobId: string) {
  const { ctx, flush } = mkCtx();
  const res = await handle(req('GET', `/api/status/${jobId}`), deps, ctx);
  await flush();
  return (await res.json()) as any;
}

describe('GET /api/status/:jobId', () => {
  it('a ready job returns the package page url; nothing waits on Pages', async () => {
    const { deps, publisher } = mkDeps();
    await seedSession(deps, 'sI');
    const { data } = await generate(deps, { sessionId: 'sI', phone: '0912000555', name: 'Lan' });
    const siteId = await siteOfJob(deps, data.jobId);
    expect(await status(deps, data.jobId)).toEqual({ id: data.jobId, siteId, state: 'ready', url: `${API}/package/${siteId}` });
    // still ready much later (no Pages timeout any more)
    const t0 = deps.now().getTime();
    deps.now = () => new Date(t0 + 60 * 60_000);
    expect((await status(deps, data.jobId)).state).toBe('ready');
    expectNoPublisher(publisher);
  });

  it('status polling never runs a job', async () => {
    const { deps, claude } = mkDeps();
    await seedSession(deps, 'sJ');
    const { data } = await generate(deps, { sessionId: 'sJ', phone: '0912000666', name: 'Lan' }, { drive: false });
    const siteId = await siteOfJob(deps, data.jobId);
    expect(await status(deps, data.jobId)).toEqual({ id: data.jobId, siteId, state: 'pending' });
    expect(claude.callTool).not.toHaveBeenCalled();
  });

  it('404 for unknown job (status and run)', async () => {
    const { deps } = mkDeps();
    const res = await handle(req('GET', '/api/status/nope'), deps, mkCtx().ctx);
    expect(res.status).toBe(404);
    expect((await run(deps, 'nope')).res.status).toBe(404);
  });
});

const SITE = 'htx-abcdef';
async function seedSite(deps: Deps, o: { revisions?: number; sessionId?: string; meta?: Partial<SiteMeta> } = {}) {
  const siteId = SITE;
  const s = await seedSession(deps, o.sessionId ?? 'sR');
  s.siteId = siteId; s.jobId = 'j0';
  await putJson(deps.kv, `sess:${s.id}`, s);
  await putJson(deps.kv, `site:${siteId}`, { siteId, phone: '0912345678', leadKey: 'k'.repeat(32), handoffKey: 'h'.repeat(32),
    template: 'tpl-thu-lead', expires: '2026-12-08T05:00:00.000Z', revisions: o.revisions ?? 0,
    createdAt: '2026-11-08T05:00:00.000Z', name: 'Lan', analysisReady: true, ...o.meta } satisfies SiteMeta);
  const site = defaultSite('tpl-thu-lead', s.brief, siteId);
  site.demo.checkoutUrl = `${TEST_ORIGIN}/proposal.html?site=${siteId}`;
  await putJson(deps.kv, `sitejson:${siteId}`, site);
  await putJson(deps.kv, `proposal:${siteId}`, proposal);
  const analysis = defaultAnalysis(s.brief);
  await putJson(deps.kv, `analysis:${siteId}`, analysis);
  return { siteId, site, analysis };
}

const revise = async (deps: Deps, body: unknown) => {
  const res = await handle(req('POST', '/api/revise', body), deps, mkCtx().ctx);
  return { res, data: (await res.json()) as any };
};

describe('POST /api/revise', () => {
  it('updates sitejson: only, counts the revision and returns a ready Job immediately', async () => {
    const { deps, publisher } = mkDeps({ claude: okClaude({ hero: { title: 'Tiêu đề mới', subtitle: 's', cta: 'c' } }) });
    const { siteId, analysis } = await seedSite(deps);
    const { res, data } = await revise(deps, { siteId, sessionId: 'sR', request: 'Đổi tiêu đề' });
    expect(res.status).toBe(200);
    expect(data.jobId).toBeTruthy();
    expect(data).toEqual({ jobId: data.jobId, id: data.jobId, siteId, state: 'ready', url: `${API}/package/${siteId}`, revisionsLeft: 2 });
    const site = (await getJson<any>(deps.kv, `sitejson:${siteId}`))!;
    expect(site.hero.title).toBe('Tiêu đề mới');
    expect(site.siteId).toBe(siteId);
    expect(site.demo.checkoutUrl).toBe(`${TEST_ORIGIN}/proposal.html?site=${siteId}`);
    expect((await getJson<SiteMeta>(deps.kv, `site:${siteId}`))!.revisions).toBe(1);
    expect(await getJson(deps.kv, `analysis:${siteId}`)).toEqual(analysis); // revise never touches the analysis
    expect(await status(deps, data.jobId)).toEqual({ id: data.jobId, siteId, state: 'ready', url: `${API}/package/${siteId}` });
    expectNoPublisher(publisher);
  });

  it('the 4th revision returns 409', async () => {
    const { deps, claude } = mkDeps();
    const { siteId } = await seedSite(deps, { revisions: 3 });
    const { res, data } = await revise(deps, { siteId, sessionId: 'sR', request: 'Đổi màu' });
    expect(res.status).toBe(409);
    expect(data.error).toMatch(/3 lượt sửa/);
    expect(claude.callTool).not.toHaveBeenCalled();
  });

  it('410 "Bản dùng thử đã hết hạn" when the demo expired unpaid', async () => {
    const { deps, claude } = mkDeps();
    const { siteId, site } = await seedSite(deps, { meta: { expires: '2026-11-08T04:59:59.000Z' } });
    const { res, data } = await revise(deps, { siteId, sessionId: 'sR', request: 'Đổi màu' });
    expect(res.status).toBe(410);
    expect(data.error).toContain('Bản dùng thử đã hết hạn');
    expect(claude.callTool).not.toHaveBeenCalled();
    expect(await getJson(deps.kv, `sitejson:${siteId}`)).toEqual(site);
    expect((await getJson<SiteMeta>(deps.kv, `site:${siteId}`))!.revisions).toBe(0);
  });

  it('410 when the demo was removed, even before its expiry date', async () => {
    const { deps, claude } = mkDeps();
    const { siteId } = await seedSite(deps, { meta: { removed: true } });
    const { res, data } = await revise(deps, { siteId, sessionId: 'sR', request: 'Đổi màu' });
    expect(res.status).toBe(410);
    expect(data.error).toContain('Bản dùng thử đã hết hạn');
    expect(claude.callTool).not.toHaveBeenCalled();
  });

  it('an expired but paid demo (paid: key) can still be revised', async () => {
    const { deps } = mkDeps();
    const { siteId } = await seedSite(deps, { meta: { expires: '2026-11-01T00:00:00.000Z' } });
    await putJson(deps.kv, `paid:${siteId}`, { orderCode: 1 });
    const { res } = await revise(deps, { siteId, sessionId: 'sR', request: 'Đổi màu' });
    expect(res.status).toBe(200);
  });

  it('403 when the session does not own the site', async () => {
    const { deps } = mkDeps();
    const { siteId } = await seedSite(deps);
    await seedSession(deps, 'other');
    const { res } = await revise(deps, { siteId, sessionId: 'other', request: 'Đổi màu' });
    expect(res.status).toBe(403);
  });

  it('404 for unknown site', async () => {
    const { deps } = mkDeps();
    const { res } = await revise(deps, { siteId: 'none-abcdef', sessionId: 'sR', request: 'x' });
    expect(res.status).toBe(404);
  });

  it('422 without consuming a revision when the AI output stays invalid', async () => {
    const claude = { callTool: vi.fn(async () => ({ input: { site: { nope: 1 } }, usage })) } as any;
    const { deps } = mkDeps({ claude });
    const { siteId, site } = await seedSite(deps, { revisions: 1 });
    const { res, data } = await revise(deps, { siteId, sessionId: 'sR', request: 'Đổi màu' });
    expect(res.status).toBe(422);
    expect(data.error).toBeTruthy();
    expect((await getJson<SiteMeta>(deps.kv, `site:${siteId}`))!.revisions).toBe(1);
    expect(await getJson(deps.kv, `sitejson:${siteId}`)).toEqual(site);
  });
});

describe('GET /api/proposal/:siteId', () => {
  it('returns the proposal with site name and demo url', async () => {
    const { deps } = mkDeps();
    const { siteId, site } = await seedSite(deps);
    const res = await handle(req('GET', `/api/proposal/${siteId}`), deps, mkCtx().ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      proposal, site: { name: site.brand.name, url: `${API}/d/${siteId}/` },
      // purchasable packages (ids for POST /api/checkout; prices are what checkout charges)
      packages: [{ id: 'co-ban', name: 'Cơ bản', priceVnd: 10_000_000, items: ['Website'] }],
      paid: false,
    });
    await putJson(deps.kv, `paid:${siteId}`, { orderCode: 1 });
    expect(((await (await handle(req('GET', `/api/proposal/${siteId}`), deps, mkCtx().ctx)).json()) as any).paid).toBe(true);
    const miss = await handle(req('GET', '/api/proposal/x-zzzzzz'), deps, mkCtx().ctx);
    expect(miss.status).toBe(404);
  });
});

describe('client-driven execution: POST /api/jobs/:jobId/run', () => {
  it('/api/generate does not run anything (no waitUntil); one /run runs the AI stage to ready', async () => {
    const { deps, publisher, claude, sheet } = mkDeps();
    await seedSession(deps, 'sK', { uploads: 1 });
    const waits: unknown[] = [];
    const ctx = { waitUntil: (p: unknown) => { waits.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext;
    const res = await handle(req('POST', '/api/generate', { sessionId: 'sK', phone: '0912000777', name: 'Lan' }), deps, ctx);
    const { jobId } = (await res.json()) as any;
    expect(waits).toHaveLength(0);
    expect(claude.callTool).not.toHaveBeenCalled();
    expect(await deps.kv.get(`jobidx:${jobId}`)).not.toBeNull();
    let job = (await getJson<JobRecord>(deps.kv, `job:${jobId}`))!;
    expect(job).toMatchObject({ state: 'pending', stage: 'queued' });
    const siteId = job.siteId;
    expect(await deps.kv.get(`exp:20261208:${siteId}`)).not.toBeNull();
    const meta = (await getJson<SiteMeta>(deps.kv, `site:${siteId}`))!;
    expect(meta.analysisReady).toBe(false);
    expect(meta.handoffKey).toMatch(/^[a-z0-9]{32}$/); // created with the site record

    const a = await run(deps, jobId);
    expect(a.data).toEqual({ id: jobId, siteId, state: 'ready', url: `${API}/package/${siteId}`, next: 'done' });
    expect(claude.callTool).toHaveBeenCalledTimes(1);
    expect(claude.callTool.mock.calls[0][0].timeoutMs).toBe(120_000);
    job = (await getJson<JobRecord>(deps.kv, `job:${jobId}`))!;
    expect(job.stage).toBe('ready');
    expect(job.runner).toBeUndefined(); // lease released at the end of the stage
    expect(await costToday(deps)).toBe(10 * 3 + 10 * 15);
    expect(sheet.append).toHaveBeenCalledTimes(1);

    const b = await run(deps, jobId); // no-op
    expect(b.data.next).toBe('done');
    expect(claude.callTool).toHaveBeenCalledTimes(1);
    expect(sheet.append).toHaveBeenCalledTimes(1);
    expect((await getJson<SiteMeta>(deps.kv, `site:${siteId}`))!.handoffKey).toBe(meta.handoffKey);
    expectNoPublisher(publisher);
  });

  it('a queued job is not run while over the daily cap (next: poll)', async () => {
    const { deps, claude } = mkDeps();
    await putJson(deps.kv, 'cost:20261108', 999_000_000);
    await seedSession(deps, 'sL');
    const { data } = await generate(deps, { sessionId: 'sL', phone: '0912000888', name: 'Lan' }, { drive: false });
    expect((await run(deps, data.jobId)).data).toMatchObject({ state: 'queued', next: 'poll' });
    expect(claude.callTool).not.toHaveBeenCalled();
  });

  it('an unexpected stage error fails the job, releases the phone and notifies the team', async () => {
    const { deps, notify } = mkDeps();
    await seedSession(deps, 'sM');
    const { data } = await generate(deps, { sessionId: 'sM', phone: '0912000999', name: 'Lan' }, { drive: false });
    await deps.kv.delete('sess:sM');
    expect((await run(deps, data.jobId)).data).toMatchObject({ state: 'failed', next: 'done' });
    expect(await deps.kv.get('phone:0912000999')).toBeNull();
    expect(notify.send).toHaveBeenCalledTimes(1);
  });
});

describe('job lease', () => {
  const jobAt = (deps: Deps, siteId: string, o: Partial<JobRecord> = {}): JobRecord => {
    const t = deps.now().getTime();
    return { id: 'jl', siteId, state: 'pending', kind: 'generate', sessionId: 'sR', phone: '0912345678', name: 'Lan',
      createdAt: new Date(t - 60_000).toISOString(), startedAt: new Date(t - 60_000).toISOString(),
      stage: 'ai', stageAt: new Date(t - 60_000).toISOString(), ...o };
  };
  const later = (deps: Deps, ms: number) => new Date(deps.now().getTime() + ms).toISOString();

  it('a second runner skips a job whose lease is live (no AI, no sheet/notify), and takes over once it expires', async () => {
    const { deps, claude, sheet, notify } = mkDeps();
    const { siteId } = await seedSite(deps);
    await putJson(deps.kv, 'job:jl', jobAt(deps, siteId, { runner: 'other', leaseUntil: later(deps, 60_000) }));
    expect((await run(deps, 'jl')).data).toMatchObject({ state: 'pending', next: 'wait' });
    expect((await runGenerateJob(deps, 'jl')).state).toBe('pending');
    expect(claude.callTool).not.toHaveBeenCalled();
    expect(sheet.append).not.toHaveBeenCalled();
    expect(notify.send).not.toHaveBeenCalled();

    const t0 = deps.now().getTime();
    deps.now = () => new Date(t0 + 61_000);
    expect((await run(deps, 'jl')).data).toMatchObject({ state: 'ready', next: 'done' });
    expect(claude.callTool).toHaveBeenCalledTimes(1);
  });

  it('a runner that lost its lease mid-stage cannot write its (stale) results', async () => {
    const { deps, sheet } = mkDeps();
    const s = await seedSession(deps, 'sR', { uploads: 1 });
    const siteId = SITE;
    await putJson(deps.kv, `site:${siteId}`, { siteId, phone: '0912345678', leadKey: 'k'.repeat(32), handoffKey: 'h'.repeat(32),
      template: 'tpl-thu-lead', expires: '2026-12-08T05:00:00.000Z', revisions: 0, createdAt: '2026-11-08T05:00:00.000Z',
      name: 'Lan', analysisReady: false } satisfies SiteMeta);
    expect(s.uploads).toHaveLength(1);
    await putJson(deps.kv, 'job:jl', jobAt(deps, siteId, { stage: 'queued', state: 'pending' }));
    // While runner A waits on Claude, its lease is taken over by runner B.
    const claude = { callTool: vi.fn(async () => {
      const j = (await getJson<JobRecord>(deps.kv, 'job:jl'))!;
      await putJson(deps.kv, 'job:jl', { ...j, runner: 'B', leaseUntil: later(deps, 300_000), stageAt: 'B-was-here' });
      return okClaude().callTool();
    }) } as any;
    deps.claude = claude;
    const r = await run(deps, 'jl');
    expect(r.data).toMatchObject({ state: 'pending', next: 'wait' });
    for (const k of [`sitejson:${siteId}`, `proposal:${siteId}`, `analysis:${siteId}`, `asset:${siteId}:assets/1-anh.jpg`]) {
      expect(await deps.kv.get(k)).toBeNull();
    }
    expect((await getJson<SiteMeta>(deps.kv, `site:${siteId}`))!.analysisReady).toBe(false);
    expect(sheet.append).not.toHaveBeenCalled();
    const job = (await getJson<JobRecord>(deps.kv, 'job:jl'))!;
    expect(job).toMatchObject({ runner: 'B', stageAt: 'B-was-here', stage: 'ai' });
    expect(await costToday(deps)).toBeGreaterThan(0); // the billed call is still counted
  });

  it('give-up (status, run, cron) is skipped while a runner holds a live lease; it fails the job once the lease is gone', async () => {
    const { deps, notify } = mkDeps();
    const { siteId } = await seedSite(deps);
    await putJson(deps.kv, 'phone:0912345678', siteId);
    const t = deps.now().getTime();
    const old = new Date(t - 20 * 60_000).toISOString();
    await putJson(deps.kv, 'job:jl', jobAt(deps, siteId, { createdAt: old, startedAt: old,
      runner: 'run-1', leaseUntil: later(deps, 90_000) }));
    expect((await status(deps, 'jl')).state).toBe('pending');
    expect((await run(deps, 'jl')).data.state).toBe('pending');
    expect(await deps.kv.get('phone:0912345678')).not.toBeNull();
    expect(notify.send).not.toHaveBeenCalled();

    deps.now = () => new Date(t + 91_000);
    const st = await status(deps, 'jl');
    expect(st.state).toBe('failed');
    expect(await deps.kv.get('phone:0912345678')).toBeNull();
    expect(notify.send).toHaveBeenCalledTimes(1);
    // the old runner coming back cannot mark it ready
    expect((await run(deps, 'jl')).data).toMatchObject({ state: 'failed', next: 'done' });
  });
});
