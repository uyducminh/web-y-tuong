import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { BriefSchema, defaultSite, type SiteJson } from '@sme/schema';
import { makeTestDeps, TEST_ORIGIN } from './fakes';
import { handle } from '../src/index';
import { getJson, putJson } from '../src/kv';
import { runGenerateJob } from '../src/routes/generate';
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
    input: { site: { ...defaultSite('tpl-thu-lead', BriefSchema.parse({ ten_don_vi: 'HTX Mây Tre' }), 'x'), ...siteOver }, proposal },
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
    brief: BriefSchema.parse(opts.brief ?? { nhu_cau: 'thu-lead', ten_don_vi: 'HTX Mây Tre Đan' }),
    messages: [], uploads, docsText: '',
  };
  await putJson(deps.kv, `sess:${id}`, s);
  return s;
}

const req = (method: string, path: string, body?: unknown) =>
  new Request(`https://api.test${path}`, { method, headers: { 'content-type': 'application/json', Origin: TEST_ORIGIN },
    body: body === undefined ? undefined : JSON.stringify(body) });

async function generate(deps: Deps, body: unknown) {
  const { ctx, flush } = mkCtx();
  const res = await handle(req('POST', '/api/generate', body), deps, ctx);
  await flush();
  return { res, data: (await res.json()) as any };
}

describe('POST /api/generate', () => {
  it('rejects an invalid phone with 400', async () => {
    const { deps } = mkDeps();
    await seedSession(deps, 'sA');
    const { res, data } = await generate(deps, { sessionId: 'sA', phone: '12345', name: 'Lan' });
    expect(res.status).toBe(400);
    expect(data.error).toMatch(/số điện thoại/i);
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

  it('marks the job failed and notifies when publishing fails', async () => {
    const publisher = recPublisher({ create: vi.fn<P['create']>(async () => { throw new Error('gh down'); }) });
    const { deps, notify } = mkDeps({ publisher });
    await seedSession(deps, 'sH');
    const { data } = await generate(deps, { sessionId: 'sH', phone: '0912000444', name: 'Lan' });
    const job = (await getJson<Job>(deps.kv, `job:${data.jobId}`))!;
    expect(job.state).toBe('failed');
    expect(job.error).toBeTruthy();
    expect(notify.send).toHaveBeenCalledTimes(1);
  });
});

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

  it('404 for unknown job', async () => {
    const { deps } = mkDeps();
    const res = await handle(req('GET', '/api/status/nope'), deps, mkCtx().ctx);
    expect(res.status).toBe(404);
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
    expect(await res.json()).toEqual({ proposal, site: { name: site.brand.name, url: `https://demo-org.github.io/${siteId}/` } });
    const miss = await handle(req('GET', '/api/proposal/demo-x-zzzz'), deps, mkCtx().ctx);
    expect(miss.status).toBe(404);
  });
});
