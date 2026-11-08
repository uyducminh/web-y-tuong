import { normalizePhone, templateFor } from '@sme/schema';
import type { Deps, Session, SiteMeta } from '../types';
import { errorJson, json, readJson } from '../http';
import { getJson, putJson } from '../kv';
import { overDailyCap } from '../ai/cost';
import { expKey, packageUrl, siteIdFor } from '../sites';
import {
  type JobRecord, JOBIDX_TTL, JOB_TTL, PHONE_TTL, SESSION_TTL_WITH_SITE,
  JobNotFoundError, jobIdxKey, loadJob, publicJob, queueKey, quietly, runNextStage, saveJob,
} from '../jobs';

const NO_SESSION = 'Không tìm thấy phiên trò chuyện. Vui lòng tải lại trang để bắt đầu lại.';
const BAD_PHONE = 'Số điện thoại không hợp lệ. Vui lòng nhập số di động 10 chữ số, ví dụ 0912 345 678.';
const BAD_NAME = 'Vui lòng nhập tên của bạn.';
const PHONE_USED = 'Số điện thoại này đã có bản dùng thử.';
const DAY_MS = 86_400_000;

/**
 * Creates the demo job and returns its id. It does NOT run the job: the status page drives it stage by stage with
 * POST /api/jobs/:jobId/run (ctx.waitUntil work is killed ~30s after the response); the cron picks up abandoned/queued jobs.
 */
export async function postGenerate(req: Request, deps: Deps): Promise<Response> {
  const body = await readJson<{ sessionId?: unknown; phone?: unknown; name?: unknown }>(req);
  if (!body || typeof body.sessionId !== 'string' || !body.sessionId) return errorJson(400, 'Yêu cầu không hợp lệ.');
  const s = await getJson<Session>(deps.kv, `sess:${body.sessionId}`);
  if (!s) return errorJson(404, NO_SESSION);

  // Idempotent per session: return the existing job unless it failed (a failed job never became ready: retry).
  if (s.jobId) {
    const prev = await loadJob(deps, s.jobId);
    if (prev && prev.state !== 'failed') return json({ jobId: prev.id });
  }

  if (!s.brief.da_xac_nhan) return errorJson(409, 'Vui lòng xác nhận thông tin trước khi tạo bản dùng thử.');

  const phone = typeof body.phone === 'string' ? normalizePhone(body.phone) : null;
  if (!phone) return errorJson(400, BAD_PHONE);
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
  if (!name) return errorJson(400, BAD_NAME);

  const existing = await getJson<string>(deps.kv, `phone:${phone}`);
  if (existing) return errorJson(409, PHONE_USED, { siteId: existing, url: packageUrl(deps.config, existing) });

  const now = deps.now();
  // A turn-30 default unit name (meta.auto) is not the customer's real name for the unit: keep it (and the person's
  // name it may come from) out of the URL — slugify('') falls back to 'site'.
  const autoName = s.brief.meta?.auto?.includes('ten_don_vi');
  const siteId = siteIdFor(autoName ? '' : s.brief.ten_don_vi?.trim() || name, deps.rand);
  const meta: SiteMeta = {
    siteId, phone, leadKey: deps.rand(32), handoffKey: deps.rand(32), template: templateFor(s.brief),
    expires: new Date(now.getTime() + 30 * DAY_MS).toISOString(),
    revisions: 0, createdAt: now.toISOString(), name, analysisReady: false,
  };
  // Reserve the phone first (1 demo per phone).
  await putJson(deps.kv, `phone:${phone}`, siteId, PHONE_TTL);
  await putJson(deps.kv, `site:${siteId}`, meta);
  await putJson(deps.kv, expKey(meta.expires, siteId), 1);

  const queued = await overDailyCap(deps);
  const job: JobRecord = {
    id: deps.rand(20), siteId, state: queued ? 'queued' : 'pending',
    kind: 'generate', sessionId: s.id, phone, name, createdAt: now.toISOString(),
    stage: 'queued', stageAt: now.toISOString(),
  };
  await saveJob(deps, job);
  await putJson(deps.kv, jobIdxKey(job.id), 1, JOBIDX_TTL);
  s.jobId = job.id; s.siteId = siteId;
  await putJson(deps.kv, `sess:${s.id}`, s, SESSION_TTL_WITH_SITE);

  if (queued) {
    await putJson(deps.kv, queueKey(job.id), { jobId: job.id, createdAt: job.createdAt }, JOB_TTL);
    await quietly(() => deps.notify.send(`Xếp hàng tạo demo (vượt trần chi phí AI hôm nay): ${name} – ${phone} – ${siteId}`));
  }
  return json({ jobId: job.id });
}

/** POST /api/jobs/:jobId/run — runs the job's next stage inside this request and returns the public Job plus `next`. */
export async function postRunJob(deps: Deps, jobId: string): Promise<Response> {
  try {
    const { job, next } = await runNextStage(deps, jobId);
    return json({ ...publicJob(job), next });
  } catch (e) {
    if (e instanceof JobNotFoundError) return errorJson(404, 'Không tìm thấy yêu cầu tạo demo này.');
    throw e;
  }
}
