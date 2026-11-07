import type { SiteJson } from '@sme/schema';
import type { Deps, Session, SiteMeta } from '../types';
import { errorJson, json, readJson } from '../http';
import { getJson, putJson } from '../kv';
import { RevisionFailedError, reviseContent } from '../ai/generate';
import { overDailyCap } from '../ai/cost';
import { type JobRecord, saveJob, utf8ToBase64 } from '../jobs';

export const MAX_REVISIONS = 3;
const MAX_REQUEST_CHARS = 2000;
const TRY_LATER = 'Chưa sửa được bản dùng thử lúc này. Vui lòng thử lại sau ít phút.';

export async function postRevise(req: Request, deps: Deps): Promise<Response> {
  const body = await readJson<{ siteId?: unknown; sessionId?: unknown; request?: unknown }>(req);
  const request = typeof body?.request === 'string' ? body.request.trim() : '';
  if (!body || typeof body.siteId !== 'string' || typeof body.sessionId !== 'string' || !request) {
    return errorJson(400, 'Vui lòng nhập nội dung bạn muốn sửa.');
  }
  if (request.length > MAX_REQUEST_CHARS) return errorJson(400, `Yêu cầu sửa tối đa ${MAX_REQUEST_CHARS} ký tự.`);

  const meta = await getJson<SiteMeta>(deps.kv, `site:${body.siteId}`);
  if (!meta) return errorJson(404, 'Không tìm thấy bản dùng thử này.');
  const s = await getJson<Session>(deps.kv, `sess:${body.sessionId}`);
  if (!s || s.siteId !== meta.siteId) return errorJson(403, 'Bạn không có quyền sửa bản dùng thử này.');
  if (meta.revisions >= MAX_REVISIONS) return errorJson(409, `Bạn đã dùng hết ${MAX_REVISIONS} lượt sửa bản dùng thử.`);
  const current = await getJson<SiteJson>(deps.kv, `sitejson:${meta.siteId}`);
  if (!current) return errorJson(409, 'Bản dùng thử đang được tạo. Vui lòng thử lại sau ít phút.');
  if (await overDailyCap(deps)) return errorJson(503, 'Hệ thống đang quá tải. Vui lòng thử lại vào ngày mai.');

  let site: SiteJson;
  try {
    site = await reviseContent(deps, current, request, s.uploads);
  } catch (e) {
    if (e instanceof RevisionFailedError) {
      return errorJson(422, 'Chưa áp dụng được yêu cầu sửa này. Bạn hãy diễn đạt lại ngắn gọn hơn; lượt sửa chưa bị tính.');
    }
    console.error(e);
    return errorJson(503, TRY_LATER);
  }

  const n = meta.revisions + 1;
  try {
    await deps.publisher.update(meta.repo, [{ path: 'site.json', base64: utf8ToBase64(JSON.stringify(site, null, 2)) }], `Sửa bản dùng thử lần ${n}`);
  } catch (e) {
    console.error(e);
    return errorJson(503, TRY_LATER);
  }
  await putJson(deps.kv, `sitejson:${meta.siteId}`, site);
  await putJson(deps.kv, `site:${meta.siteId}`, { ...meta, revisions: n });

  const now = deps.now().toISOString();
  const job: JobRecord = {
    id: deps.rand(20), siteId: meta.siteId, state: 'pending', kind: 'revise',
    sessionId: s.id, phone: meta.phone, name: meta.name, createdAt: now, stage: 'published', stageAt: now, startedAt: now, publishedAt: now,
  };
  await saveJob(deps, job);
  return json({ jobId: job.id, revisionsLeft: MAX_REVISIONS - n });
}
