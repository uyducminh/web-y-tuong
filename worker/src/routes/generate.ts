import { defaultSite, normalizePhone, slugify, type Proposal, type SiteJson } from '@sme/schema';
import type { Deps, Job, Session, SiteMeta } from '../types';
import { errorJson, json, readJson } from '../http';
import { getJson, putJson } from '../kv';
import { fallbackProposal, generateContent, templateFor } from '../ai/generate';
import { overDailyCap } from '../ai/cost';
import {
  type JobRecord, PHONE_TTL, SESSION_TTL_WITH_SITE, STALL_MS, JOB_TTL,
  failUnpublished, loadJob, pagesUrl, publicJob, queueKey, quietly, saveJob, setStage, utf8ToBase64,
} from '../jobs';

const NO_SESSION = 'Không tìm thấy phiên trò chuyện. Vui lòng tải lại trang để bắt đầu lại.';
const BAD_PHONE = 'Số điện thoại không hợp lệ. Vui lòng nhập số di động 10 chữ số, ví dụ 0912 345 678.';
const BAD_NAME = 'Vui lòng nhập tên của bạn.';
const PHONE_USED = 'Số điện thoại này đã có bản dùng thử.';
const GEN_FAILED = 'Chưa tạo được bản dùng thử. Đội ngũ đã được thông báo và sẽ liên hệ với bạn sớm.';
const DAY_MS = 86_400_000;

type UploadRec = { path: string; mime: string; base64: string };

export async function postGenerate(req: Request, deps: Deps, ctx: ExecutionContext): Promise<Response> {
  const body = await readJson<{ sessionId?: unknown; phone?: unknown; name?: unknown }>(req);
  if (!body || typeof body.sessionId !== 'string' || !body.sessionId) return errorJson(400, 'Yêu cầu không hợp lệ.');
  const s = await getJson<Session>(deps.kv, `sess:${body.sessionId}`);
  if (!s) return errorJson(404, NO_SESSION);

  // Idempotent per session: return the existing job unless it failed before anything was published.
  if (s.jobId) {
    const prev = await loadJob(deps, s.jobId);
    if (prev && !(prev.state === 'failed' && prev.stage !== 'published')) return json({ jobId: prev.id });
  }

  const phone = typeof body.phone === 'string' ? normalizePhone(body.phone) : null;
  if (!phone) return errorJson(400, BAD_PHONE);
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
  if (!name) return errorJson(400, BAD_NAME);

  const existing = await getJson<string>(deps.kv, `phone:${phone}`);
  if (existing) {
    const old = await getJson<SiteMeta>(deps.kv, `site:${existing}`);
    return errorJson(409, PHONE_USED, { siteId: existing, url: old?.url ?? pagesUrl(deps.config, existing) });
  }

  const now = deps.now();
  const siteId = `demo-${slugify(s.brief.ten_don_vi?.trim() || name)}-${deps.rand(4)}`;
  const meta: SiteMeta = {
    siteId, repo: siteId, phone, leadKey: deps.rand(32),
    expires: new Date(now.getTime() + 30 * DAY_MS).toISOString(),
    paid: false, revisions: 0, createdAt: now.toISOString(), name,
  };
  // Reserve the phone first (1 demo per phone).
  await putJson(deps.kv, `phone:${phone}`, siteId, PHONE_TTL);
  await putJson(deps.kv, `site:${siteId}`, meta);

  const queued = await overDailyCap(deps);
  const job: JobRecord = {
    id: deps.rand(20), siteId, state: queued ? 'queued' : 'pending',
    kind: 'generate', sessionId: s.id, phone, name, createdAt: now.toISOString(),
    stage: 'queued', stageAt: now.toISOString(),
  };
  await saveJob(deps, job);
  s.jobId = job.id; s.siteId = siteId;
  await putJson(deps.kv, `sess:${s.id}`, s, SESSION_TTL_WITH_SITE);

  if (queued) {
    await putJson(deps.kv, queueKey(job.id), { jobId: job.id, createdAt: job.createdAt }, JOB_TTL);
    await quietly(() => deps.notify.send(`Xếp hàng tạo demo (vượt trần chi phí AI hôm nay): ${name} – ${phone} – ${siteId}`));
  } else {
    ctx.waitUntil(runGenerateJob(deps, job.id).catch((e) => console.error(e)));
  }
  return json({ jobId: job.id });
}

async function loadUploads(deps: Deps, s: Session): Promise<{ path: string; base64: string }[]> {
  const out: { path: string; base64: string }[] = [];
  for (let n = 1; n <= s.uploads.length; n++) {
    const u = await getJson<UploadRec>(deps.kv, `up:${s.id}:${n}`);
    if (u && s.uploads.includes(u.path)) out.push({ path: u.path, base64: u.base64 });
  }
  return out;
}

/**
 * Staged, resumable generate pipeline: queued → ai → ai_done → publishing → published.
 * Each call continues from the stored stage (AI output is persisted at ai_done, so publishing can resume without Claude).
 * Safe to call repeatedly: finished/failed jobs and stages touched within STALL_MS (another runner active) are left alone.
 * Used by POST /api/generate (waitUntil), GET /api/status (stall recovery) and the cron (queued jobs).
 */
export async function runGenerateJob(deps: Deps, jobId: string): Promise<Job> {
  const job = await loadJob(deps, jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  if (job.kind !== 'generate' || job.state === 'ready' || job.state === 'failed' || job.stage === 'published') return publicJob(job);
  const active = (job.stage === 'ai' || job.stage === 'publishing') && deps.now().getTime() - Date.parse(job.stageAt) <= STALL_MS;
  if (active) return publicJob(job);

  try {
    const s = await getJson<Session>(deps.kv, `sess:${job.sessionId}`);
    const meta = await getJson<SiteMeta>(deps.kv, `site:${job.siteId}`);
    if (!s || !meta) throw new Error(`missing session/site for job ${jobId}`);

    if (job.stage === 'queued' || job.stage === 'ai') {
      job.state = 'pending';
      job.startedAt ??= deps.now().toISOString();
      await setStage(deps, job, 'ai');
      await deps.kv.delete(queueKey(job.id));
      await runAi(deps, s, job.siteId);
      await setStage(deps, job, 'ai_done');
    }

    await setStage(deps, job, 'publishing');
    const site = await getJson<SiteJson>(deps.kv, `sitejson:${job.siteId}`);
    if (!site) throw new Error(`sitejson missing for ${job.siteId}`);
    const files = [{ path: 'site.json', base64: utf8ToBase64(JSON.stringify(site, null, 2)) }, ...(await loadUploads(deps, s))];
    try {
      await deps.publisher.create({ repoName: meta.repo, template: site.template, files });
    } catch (e) {
      // Leave the stage as `publishing`: the next status poll resumes after STALL_MS; status gives up after 10 minutes.
      console.error('publish failed, will resume', e);
      return publicJob(job);
    }
    await setStage(deps, job, 'published');

    const demoUrl = pagesUrl(deps.config, meta.repo);
    const leadUrl = `${deps.config.apiBase}/leads/${job.siteId}?key=${meta.leadKey}`;
    await quietly(() => deps.sheet.append({
      thoi_gian: deps.now().toISOString(), ten: job.name, sdt: job.phone, nhu_cau: s.brief.nhu_cau ?? '',
      link_demo: demoUrl, link_lead: leadUrl, trang_thai: 'demo', siteId: job.siteId,
    }));
    await quietly(() => deps.notify.send(
      `Demo mới: ${job.name} – ${job.phone}\nNhu cầu: ${s.brief.nhu_cau ?? '(chưa rõ)'}\nDemo: ${demoUrl}\nLead: ${leadUrl}`));
  } catch (e) {
    console.error('runGenerateJob failed', e);
    await failUnpublished(deps, job, GEN_FAILED, (e as Error)?.message ?? String(e));
  }
  return publicJob(job);
}

/** AI stage: content (or deterministic fallback when Claude is down) → session, sitejson:, proposal:. */
async function runAi(deps: Deps, s: Session, siteId: string): Promise<void> {
  let site: SiteJson; let proposal: Proposal;
  try {
    ({ site, proposal } = await generateContent(deps, s, siteId));
  } catch (e) {
    console.error('generateContent failed, using defaults', e);
    site = defaultSite(templateFor(s.brief), s.brief, siteId, deps.now());
    proposal = fallbackProposal(deps, s.brief);
  }
  await putJson(deps.kv, `sess:${s.id}`, s, SESSION_TTL_WITH_SITE);
  site = { ...site, demo: { ...site.demo, checkoutUrl: `${deps.config.webOrigin}/proposal.html?site=${siteId}` } };
  await putJson(deps.kv, `sitejson:${siteId}`, site);
  await putJson(deps.kv, `proposal:${siteId}`, proposal);
}
