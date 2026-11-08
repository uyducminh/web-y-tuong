import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { BriefV2Schema, defaultSite, type SiteJson } from '@sme/schema';
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
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

function okClaude(siteOver: Partial<SiteJson> = {}) {
  return { callTool: vi.fn(async () => ({
    input: { site: { ...defaultSite('tpl-thu-lead', BriefV2Schema.parse({ ten_don_vi: 'HTX Mây Tre' }), 'x'), ...siteOver }, proposal },
    usage,
  })) } as any;
}

type P = Deps['publisher'];
type RecPublisher = { create: Mock<P['create']>; update: Mock<P['update']>; status: Mock<P['status']>; remove: Mock<P['remove']> };
function recPublisher(over: Partial<RecPublisher> = {}): RecPublisher {
  return {
    create: vi.fn<P['create']>(async (o) => ({ repo: o.repoName })),
    update: vi.fn<P['update']>(async () => {}),
    status: vi.fn<P['status']>(async () => ({ state: 'pending' })),
    remove: vi.fn<P['remove']>(async () => {}),
    ...over,
  };
}

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
  new Request(`https://api.test${path}`, { method, headers: { 'content-type': 'application/json', Origin: TEST_ORIGIN },
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

  it('404 for unknown session', async () => {
    const { deps } = mkDeps();
    const { res } = await generate(deps, { sessionId: 'nope', phone: '0912345678', name: 'Lan' });
    expect(res.status).toBe(404);
  });

  it('409 with the old link when the phone already has a demo', async () => {
    const { deps, publisher } = mkDeps();
    await seedSession(deps, 'sB');
    await putJson(deps.kv, 'phone:0912345678', 'demo-cu-abcd');
    await putJson(deps.kv, 'site:demo-cu-abcd', { siteId: 'demo-cu-abcd', repo: 'demo-cu-abcd', phone: '0912345678', leadKey: 'k',
      url: 'https://demo-org.github.io/demo-cu-abcd/', expires: '', paid: false, revisions: 0, createdAt: '', name: 'X' } satisfies SiteMeta);
    const { res, data } = await generate(deps, { sessionId: 'sB', phone: '0912 345 678', name: 'Lan' });
    expect(res.status).toBe(409);
    expect(data.error).toContain('Số điện thoại này đã có bản dùng thử');
    expect(data.url).toBe('https://demo-org.github.io/demo-cu-abcd/');
    expect(publisher.create).not.toHaveBeenCalled();
  });

  it('is idempotent per session: same jobId, publisher.create once', async () => {
    const { deps, publisher } = mkDeps();
    await seedSession(deps, 'sC');
    const a = await generate(deps, { sessionId: 'sC', phone: '0912345678', name: 'Lan' });
    const b = await generate(deps, { sessionId: 'sC', phone: '0912345678', name: 'Lan' });
    expect(a.res.status).toBe(200);
    expect(b.res.status).toBe(200);
    expect(a.data.jobId).toBeTruthy();
    expect(b.data.jobId).toBe(a.data.jobId);
    expect(publisher.create).toHaveBeenCalledTimes(1);
  });

  it('creates the demo: repo name, files, KV records, sheet + notify', async () => {
    const { deps, publisher, sheet, notify } = mkDeps();
    await seedSession(deps, 'sD', { uploads: 2 });
    const { res, data } = await generate(deps, { sessionId: 'sD', phone: '+84 912 345 678', name: 'Chị Lan' });
    expect(res.status).toBe(200);
    expect(publisher.create).toHaveBeenCalledTimes(1);
    const arg = publisher.create.mock.calls[0][0] as any;
    expect(arg.repoName).toMatch(/^demo-[a-z0-9-]{1,30}-[a-z0-9]{4}$/);
    expect(arg.repoName.startsWith('demo-htx-may-tre-dan-')).toBe(true);
    expect(arg.template).toBe('tpl-thu-lead');
    const paths = arg.files.map((f: any) => f.path);
    expect(paths.sort()).toEqual(['assets/1-anh.jpg', 'assets/2-anh.jpg', 'site.json']);
    expect(arg.files.find((f: any) => f.path === 'assets/2-anh.jpg').base64).toBe(btoa('img2'));
    const siteId = arg.repoName;
    const site = JSON.parse(unb64(arg.files.find((f: any) => f.path === 'site.json').base64));
    expect(site.siteId).toBe(siteId);
    expect(site.demo.checkoutUrl).toBe(`${TEST_ORIGIN}/proposal.html?site=${siteId}`);

    const meta = (await getJson<SiteMeta>(deps.kv, `site:${siteId}`))!;
    expect(meta.leadKey).toHaveLength(32);
    expect(meta).toMatchObject({ siteId, repo: siteId, phone: '0912345678', paid: false, revisions: 0, name: 'Chị Lan',
      createdAt: '2026-11-08T05:00:00.000Z', expires: '2026-12-08T05:00:00.000Z' });
    expect(await deps.kv.get('phone:0912345678')).toBe(JSON.stringify(siteId));
    expect((await getJson<any>(deps.kv, `sitejson:${siteId}`)).siteId).toBe(siteId);
    expect((await getJson<any>(deps.kv, `proposal:${siteId}`)).summary).toBe('Tóm tắt');
    const sess = (await getJson<Session>(deps.kv, 'sess:sD'))!;
    expect(sess.jobId).toBe(data.jobId);
    expect(sess.siteId).toBe(siteId);
    expect(sess.brief.meta?.auto).toBeDefined();
    const job = (await getJson<Job>(deps.kv, `job:${data.jobId}`))!;
    expect(job).toMatchObject({ id: data.jobId, siteId, state: 'pending' });

    expect(sheet.append).toHaveBeenCalledTimes(1);
    const row = sheet.append.mock.calls[0][0] as any;
    expect(row).toMatchObject({ ten: 'Chị Lan', sdt: '0912345678', nhu_cau: 'thu-lead', trang_thai: 'demo', siteId,
      link_demo: `https://demo-org.github.io/${siteId}/`, link_lead: `https://api.test/leads/${siteId}?key=${meta.leadKey}` });
    expect(row.thoi_gian).toBeTruthy();
    expect(notify.send).toHaveBeenCalledTimes(1);
    const text = notify.send.mock.calls[0][0] as string;
    expect(text).toContain('Chị Lan');
    expect(text).toContain('0912345678');
    expect(text).toContain(`https://demo-org.github.io/${siteId}/`);
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
    expect(publisher.create).not.toHaveBeenCalled();
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
    expect(job.state).toBe('pending');
    expect(publisher.create).toHaveBeenCalledTimes(1);
    expect(await deps.kv.get(`queue:${data.jobId}`)).toBeNull();
  });

  it('still creates a demo with default content when Claude is down', async () => {
    const claude = { callTool: vi.fn(async () => { throw new Error('claude 529'); }) } as any;
    const { deps, publisher } = mkDeps({ claude });
    await seedSession(deps, 'sG');
    const { res, data } = await generate(deps, { sessionId: 'sG', phone: '0912000333', name: 'Lan' });
    expect(res.status).toBe(200);
    expect(publisher.create).toHaveBeenCalledTimes(1);
    const siteId = (publisher.create.mock.calls[0][0] as any).repoName;
    expect((await getJson<any>(deps.kv, `sitejson:${siteId}`)).brand.name).toBe('HTX Mây Tre Đan');
    expect((await getJson<any>(deps.kv, `proposal:${siteId}`)).packages[0].priceVnd).toBeGreaterThanOrEqual(10_000_000);
    expect((await getJson<Job>(deps.kv, `job:${data.jobId}`))!.state).toBe('pending');
  });

  it('(a) unpublished job gives up after 10 min, releases the phone, and the same session can retry', async () => {
    const publisher = recPublisher({ create: vi.fn<P['create']>(async () => { throw new Error('gh down'); }) });
    const { deps, notify } = mkDeps({ publisher });
    await seedSession(deps, 'sH');
    const first = await generate(deps, { sessionId: 'sH', phone: '0912000444', name: 'Lan' });
    let job = (await getJson<JobRecord>(deps.kv, `job:${first.data.jobId}`))!;
    expect(job).toMatchObject({ state: 'pending', stage: 'publishing' });
    expect(notify.send).not.toHaveBeenCalled();

    const t0 = deps.now().getTime();
    deps.now = () => new Date(t0 + 11 * 60_000);
    const st = await status(deps, first.data.jobId);
    expect(st.state).toBe('failed');
    expect(st.error).toBeTruthy();
    expect(await deps.kv.get('phone:0912000444')).toBeNull();
    expect(notify.send).toHaveBeenCalledTimes(1);

    publisher.create.mockImplementation(async (o) => ({ repo: o.repoName }));
    const second = await generate(deps, { sessionId: 'sH', phone: '0912000444', name: 'Lan' });
    expect(second.res.status).toBe(200);
    expect(second.data.jobId).not.toBe(first.data.jobId);
    job = (await getJson<JobRecord>(deps.kv, `job:${second.data.jobId}`))!;
    expect(job).toMatchObject({ state: 'pending', stage: 'published' });
    expect(publisher.create).toHaveBeenCalledTimes(2);
  });
});

async function status(deps: Deps, jobId: string) {
  const { ctx, flush } = mkCtx();
  const res = await handle(req('GET', `/api/status/${jobId}`), deps, ctx);
  await flush();
  return (await res.json()) as any;
}

describe('GET /api/status/:jobId', () => {
  it('becomes ready when Pages is built and stores the url on SiteMeta', async () => {
    const { deps, publisher } = mkDeps();
    await seedSession(deps, 'sI');
    const { data } = await generate(deps, { sessionId: 'sI', phone: '0912000555', name: 'Lan' });
    const siteId = (publisher.create.mock.calls[0][0] as any).repoName;
    publisher.status.mockResolvedValueOnce({ state: 'pending' });
    let res = await handle(req('GET', `/api/status/${data.jobId}`), deps, mkCtx().ctx);
    expect(await res.json()).toEqual({ id: data.jobId, siteId, state: 'pending' });
    publisher.status.mockResolvedValueOnce({ state: 'ready', url: `https://demo-org.github.io/${siteId}/` } as any);
    res = await handle(req('GET', `/api/status/${data.jobId}`), deps, mkCtx().ctx);
    expect(await res.json()).toEqual({ id: data.jobId, siteId, state: 'ready', url: `https://demo-org.github.io/${siteId}/` });
    expect((await getJson<SiteMeta>(deps.kv, `site:${siteId}`))!.url).toBe(`https://demo-org.github.io/${siteId}/`);
    expect(publisher.status).toHaveBeenCalledWith(siteId);
  });

  it('fails after 3 minutes pending and notifies the team', async () => {
    const { deps, notify } = mkDeps();
    await seedSession(deps, 'sJ');
    const { data } = await generate(deps, { sessionId: 'sJ', phone: '0912000666', name: 'Lan' });
    notify.send.mockClear();
    const t0 = deps.now().getTime();
    deps.now = () => new Date(t0 + 170_000);
    let body = (await (await handle(req('GET', `/api/status/${data.jobId}`), deps, mkCtx().ctx)).json()) as any;
    expect(body.state).toBe('pending');
    deps.now = () => new Date(t0 + 181_000);
    body = await (await handle(req('GET', `/api/status/${data.jobId}`), deps, mkCtx().ctx)).json();
    expect(body.state).toBe('failed');
    expect(body.error).toBeTruthy();
    expect(notify.send).toHaveBeenCalledTimes(1);
  });

  it('(b) Pages timeout counts from publishedAt, not startedAt', async () => {
    const { deps, notify, publisher } = mkDeps();
    const { siteId } = await seedSite(deps);
    const t = deps.now().getTime();
    const ago = (ms: number) => new Date(t - ms).toISOString();
    await putJson(deps.kv, 'job:jb', { id: 'jb', siteId, state: 'pending', kind: 'generate', sessionId: 'sR', phone: '0912345678',
      name: 'Lan', createdAt: ago(300_000), startedAt: ago(300_000), stage: 'published', stageAt: ago(60_000), publishedAt: ago(60_000) } satisfies JobRecord);
    expect((await status(deps, 'jb')).state).toBe('pending');
    expect(publisher.status).toHaveBeenCalledWith(siteId);
    expect(notify.send).not.toHaveBeenCalled();
    deps.now = () => new Date(t + 121_000);
    expect((await status(deps, 'jb')).state).toBe('failed');
    expect(notify.send).toHaveBeenCalledTimes(1);
    expect(await deps.kv.get('phone:0912345678')).toBeNull(); // never reserved here; and Pages timeout must not touch it
  });

  it('(c) status polling never runs a job; /run publishes an ai_done job without calling Claude', async () => {
    const claude = { callTool: vi.fn(async () => { throw new Error('Claude must not be called'); }) } as any;
    const { deps, publisher, sheet } = mkDeps({ claude });
    const { siteId } = await seedSite(deps);
    await putJson(deps.kv, 'phone:0912345678', siteId);
    const t = deps.now().getTime();
    const ago = (ms: number) => new Date(t - ms).toISOString();
    await putJson(deps.kv, 'job:jc', { id: 'jc', siteId, state: 'pending', kind: 'generate', sessionId: 'sR', phone: '0912345678',
      name: 'Lan', createdAt: ago(120_000), startedAt: ago(120_000), stage: 'ai_done', stageAt: ago(60_000) } satisfies JobRecord);
    expect((await status(deps, 'jc')).state).toBe('pending');
    expect(publisher.create).not.toHaveBeenCalled(); // GET /api/status is read-only for unpublished jobs

    const r = await run(deps, 'jc');
    expect(r.res.status).toBe(200);
    expect(r.data).toEqual({ id: 'jc', siteId, state: 'pending', next: 'poll' });
    expect(r.res.headers.get('access-control-allow-origin')).toBe(TEST_ORIGIN);
    expect(publisher.create).toHaveBeenCalledTimes(1);
    const arg = publisher.create.mock.calls[0][0];
    expect(arg.repoName).toBe(siteId);
    expect(arg.files.map((f) => f.path)).toEqual(['site.json']);
    expect(claude.callTool).not.toHaveBeenCalled();
    const job = (await getJson<JobRecord>(deps.kv, 'job:jc'))!;
    expect(job.stage).toBe('published');
    expect(job.publishedAt).toBe(new Date(t).toISOString());
    expect(job.runner).toBeUndefined();
    expect(sheet.append).toHaveBeenCalledTimes(1);
    expect(await deps.kv.get('phone:0912345678')).not.toBeNull();
    // a further /run on a published job is a no-op
    expect((await run(deps, 'jc')).data.next).toBe('poll');
    expect(publisher.create).toHaveBeenCalledTimes(1);
    expect(sheet.append).toHaveBeenCalledTimes(1);
  });

  it('404 for unknown job (status and run)', async () => {
    const { deps } = mkDeps();
    const res = await handle(req('GET', '/api/status/nope'), deps, mkCtx().ctx);
    expect(res.status).toBe(404);
    expect((await run(deps, 'nope')).res.status).toBe(404);
  });
});

async function seedSite(deps: Deps, o: { revisions?: number; sessionId?: string } = {}) {
  const siteId = 'demo-htx-abcd';
  const s = await seedSession(deps, o.sessionId ?? 'sR');
  s.siteId = siteId; s.jobId = 'j0';
  await putJson(deps.kv, `sess:${s.id}`, s);
  await putJson(deps.kv, `site:${siteId}`, { siteId, repo: siteId, phone: '0912345678', leadKey: 'k'.repeat(32),
    url: `https://demo-org.github.io/${siteId}/`, expires: '2026-12-08T05:00:00.000Z', paid: false,
    revisions: o.revisions ?? 0, createdAt: '2026-11-08T05:00:00.000Z', name: 'Lan' } satisfies SiteMeta);
  const site = defaultSite('tpl-thu-lead', s.brief, siteId);
  site.demo.checkoutUrl = `${TEST_ORIGIN}/proposal.html?site=${siteId}`;
  await putJson(deps.kv, `sitejson:${siteId}`, site);
  await putJson(deps.kv, `proposal:${siteId}`, proposal);
  return { siteId, site };
}

const revise = async (deps: Deps, body: unknown) => {
  const res = await handle(req('POST', '/api/revise', body), deps, mkCtx().ctx);
  return { res, data: (await res.json()) as any };
};

describe('POST /api/revise', () => {
  it('commits the new site.json and counts the revision', async () => {
    const { deps, publisher } = mkDeps({ claude: okClaude({ hero: { title: 'Tiêu đề mới', subtitle: 's', cta: 'c' } }) });
    const { siteId } = await seedSite(deps);
    const { res, data } = await revise(deps, { siteId, sessionId: 'sR', request: 'Đổi tiêu đề' });
    expect(res.status).toBe(200);
    expect(data.jobId).toBeTruthy();
    expect(publisher.update).toHaveBeenCalledTimes(1);
    const [repo, files, msg] = publisher.update.mock.calls[0] as any[];
    expect(repo).toBe(siteId);
    expect(files.map((f: any) => f.path)).toEqual(['site.json']);
    const site = JSON.parse(unb64(files[0].base64));
    expect(site.hero.title).toBe('Tiêu đề mới');
    expect(site.siteId).toBe(siteId);
    expect(site.demo.checkoutUrl).toBe(`${TEST_ORIGIN}/proposal.html?site=${siteId}`);
    expect(msg).toBeTruthy();
    expect((await getJson<SiteMeta>(deps.kv, `site:${siteId}`))!.revisions).toBe(1);
    expect((await getJson<any>(deps.kv, `sitejson:${siteId}`)).hero.title).toBe('Tiêu đề mới');
    const job = (await (await handle(req('GET', `/api/status/${data.jobId}`), deps, mkCtx().ctx)).json()) as any;
    expect(job.siteId).toBe(siteId);
  });

  it('the 4th revision returns 409', async () => {
    const { deps, publisher } = mkDeps();
    const { siteId } = await seedSite(deps, { revisions: 3 });
    const { res, data } = await revise(deps, { siteId, sessionId: 'sR', request: 'Đổi màu' });
    expect(res.status).toBe(409);
    expect(data.error).toMatch(/3 lượt sửa/);
    expect(publisher.update).not.toHaveBeenCalled();
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
    const { res } = await revise(deps, { siteId: 'demo-none-abcd', sessionId: 'sR', request: 'x' });
    expect(res.status).toBe(404);
  });

  it('422 without consuming a revision when the AI output stays invalid', async () => {
    const claude = { callTool: vi.fn(async () => ({ input: { site: { nope: 1 } }, usage })) } as any;
    const { deps, publisher } = mkDeps({ claude });
    const { siteId } = await seedSite(deps, { revisions: 1 });
    const { res, data } = await revise(deps, { siteId, sessionId: 'sR', request: 'Đổi màu' });
    expect(res.status).toBe(422);
    expect(data.error).toBeTruthy();
    expect(publisher.update).not.toHaveBeenCalled();
    expect((await getJson<SiteMeta>(deps.kv, `site:${siteId}`))!.revisions).toBe(1);
  });
});

describe('GET /api/proposal/:siteId', () => {
  it('returns the proposal with site name and url', async () => {
    const { deps } = mkDeps();
    const { siteId, site } = await seedSite(deps);
    const res = await handle(req('GET', `/api/proposal/${siteId}`), deps, mkCtx().ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      proposal, site: { name: site.brand.name, url: `https://demo-org.github.io/${siteId}/` },
      // purchasable packages (ids for POST /api/checkout; prices are what checkout charges)
      packages: [{ id: 'co-ban', name: 'Cơ bản', priceVnd: 10_000_000, items: ['Website'] }],
      paid: false,
    });
    await putJson(deps.kv, `paid:${siteId}`, { orderCode: 1 });
    expect(((await (await handle(req('GET', `/api/proposal/${siteId}`), deps, mkCtx().ctx)).json()) as any).paid).toBe(true);
    const miss = await handle(req('GET', '/api/proposal/demo-x-zzzz'), deps, mkCtx().ctx);
    expect(miss.status).toBe(404);
  });
});

describe('client-driven execution: POST /api/jobs/:jobId/run', () => {
  it('/api/generate does not run anything (no waitUntil); each /run executes exactly one stage', async () => {
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

    const a = await run(deps, jobId);
    expect(a.data).toEqual({ id: jobId, siteId, state: 'pending', next: 'run' });
    expect(claude.callTool).toHaveBeenCalledTimes(1);
    expect(claude.callTool.mock.calls[0][0].timeoutMs).toBe(120_000);
    expect(publisher.create).not.toHaveBeenCalled();
    job = (await getJson<JobRecord>(deps.kv, `job:${jobId}`))!;
    expect(job.stage).toBe('ai_done');
    expect(job.runner).toBeUndefined(); // lease released at the end of the stage
    expect(await costToday(deps)).toBe(10 * 3 + 10 * 15);

    const b = await run(deps, jobId);
    expect(b.data.next).toBe('poll');
    expect(publisher.create).toHaveBeenCalledTimes(1);
    expect(sheet.append).toHaveBeenCalledTimes(1);
    expect(await deps.kv.get(`jobidx:${jobId}`)).toBeNull();
    expect(await deps.kv.get('stat:demos:20261108')).toBe('1');
  });

  it('a queued job is not run while over the daily cap (next: poll)', async () => {
    const { deps, claude } = mkDeps();
    await putJson(deps.kv, 'cost:20261108', 999_000_000);
    await seedSession(deps, 'sL');
    const { data } = await generate(deps, { sessionId: 'sL', phone: '0912000888', name: 'Lan' }, { drive: false });
    expect((await run(deps, data.jobId)).data).toMatchObject({ state: 'queued', next: 'poll' });
    expect(claude.callTool).not.toHaveBeenCalled();
  });

  it('a publish failure keeps the stage, frees the lease and answers next: wait', async () => {
    const publisher = recPublisher({ create: vi.fn<P['create']>(async () => { throw new Error('gh 502'); }) });
    const { deps } = mkDeps({ publisher });
    await seedSession(deps, 'sM');
    const { data } = await generate(deps, { sessionId: 'sM', phone: '0912000999', name: 'Lan' }, { drive: false });
    expect((await run(deps, data.jobId)).data.next).toBe('run');
    expect((await run(deps, data.jobId)).data).toMatchObject({ state: 'pending', next: 'wait' });
    const job = (await getJson<JobRecord>(deps.kv, `job:${data.jobId}`))!;
    expect(job).toMatchObject({ stage: 'publishing', state: 'pending' });
    expect(job.runner).toBeUndefined();
    publisher.create.mockImplementation(async (o) => ({ repo: o.repoName }));
    expect((await run(deps, data.jobId)).data.next).toBe('poll');
  });
});

describe('job lease', () => {
  const jobAt = (deps: Deps, siteId: string, o: Partial<JobRecord> = {}): JobRecord => {
    const t = deps.now().getTime();
    return { id: 'jl', siteId, state: 'pending', kind: 'generate', sessionId: 'sR', phone: '0912345678', name: 'Lan',
      createdAt: new Date(t - 60_000).toISOString(), startedAt: new Date(t - 60_000).toISOString(),
      stage: 'ai_done', stageAt: new Date(t - 60_000).toISOString(), ...o };
  };
  const later = (deps: Deps, ms: number) => new Date(deps.now().getTime() + ms).toISOString();

  it('a second runner skips a job whose lease is live (no publish, no sheet/notify), and takes over once it expires', async () => {
    const { deps, publisher, sheet, notify } = mkDeps();
    const { siteId } = await seedSite(deps);
    await putJson(deps.kv, 'job:jl', jobAt(deps, siteId, { stage: 'publishing', runner: 'other', leaseUntil: later(deps, 60_000) }));
    expect((await run(deps, 'jl')).data).toMatchObject({ state: 'pending', next: 'wait' });
    expect((await runGenerateJob(deps, 'jl')).state).toBe('pending');
    expect(publisher.create).not.toHaveBeenCalled();
    expect(sheet.append).not.toHaveBeenCalled();
    expect(notify.send).not.toHaveBeenCalled();

    const t0 = deps.now().getTime();
    deps.now = () => new Date(t0 + 61_000);
    expect((await run(deps, 'jl')).data.next).toBe('poll');
    expect(publisher.create).toHaveBeenCalledTimes(1);
  });

  it('a runner that lost its lease mid-stage cannot write its (stale) results', async () => {
    const { deps } = mkDeps();
    const { siteId } = await seedSite(deps);
    await deps.kv.delete(`sitejson:${siteId}`); await deps.kv.delete(`proposal:${siteId}`);
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
    expect(await deps.kv.get(`sitejson:${siteId}`)).toBeNull();
    expect(await deps.kv.get(`proposal:${siteId}`)).toBeNull();
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
    await putJson(deps.kv, 'job:jl', jobAt(deps, siteId, { stage: 'publishing', createdAt: old, startedAt: old,
      runner: 'publisher-1', leaseUntil: later(deps, 90_000) }));
    expect((await status(deps, 'jl')).state).toBe('pending');
    expect((await run(deps, 'jl')).data.state).toBe('pending');
    expect(await deps.kv.get('phone:0912345678')).not.toBeNull();
    expect(notify.send).not.toHaveBeenCalled();

    deps.now = () => new Date(t + 91_000);
    const st = await status(deps, 'jl');
    expect(st.state).toBe('failed');
    expect(await deps.kv.get('phone:0912345678')).toBeNull();
    expect(notify.send).toHaveBeenCalledTimes(1);
    // the old runner coming back cannot mark it published
    expect((await run(deps, 'jl')).data).toMatchObject({ state: 'failed', next: 'done' });
  });
});
