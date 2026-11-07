import type { Deps, SiteMeta } from '../types';
import { errorJson, json } from '../http';
import { getJson, putJson } from '../kv';
import { PAGES_TIMEOUT_MS, giveUpIfStale, loadJob, publicJob, quietly, saveJob } from '../jobs';

const TIMEOUT_MSG = 'Bản dùng thử đang mất nhiều thời gian hơn dự kiến. Đội ngũ đã được thông báo và sẽ gửi link cho bạn sớm.';

/**
 * Read-mostly status. Unpublished jobs are advanced by POST /api/jobs/:id/run (not here); this only gives one up
 * after 10 minutes without a live runner (phone released). A published job becomes ready when Pages is built,
 * or fails if it is not built 3 minutes after publishing.
 */
export async function getStatus(deps: Deps, jobId: string): Promise<Response> {
  const job = await loadJob(deps, jobId);
  if (!job) return errorJson(404, 'Không tìm thấy yêu cầu tạo demo này.');
  if (job.state !== 'pending') return json(publicJob(job));
  const now = deps.now().getTime();

  if (job.stage !== 'published') {
    await giveUpIfStale(deps, job); // updates job in place when it fails it
    return json(publicJob(job));
  }

  let st: { state: 'pending' | 'ready'; url?: string } = { state: 'pending' };
  try { st = await deps.publisher.status(job.siteId); } catch (e) { console.error(e); }
  if (st.state === 'ready') {
    job.state = 'ready'; job.url = st.url;
    await saveJob(deps, job);
    const meta = await getJson<SiteMeta>(deps.kv, `site:${job.siteId}`);
    if (meta && st.url && meta.url !== st.url) await putJson(deps.kv, `site:${job.siteId}`, { ...meta, url: st.url });
  } else if (now - Date.parse(job.publishedAt ?? job.stageAt) > PAGES_TIMEOUT_MS) {
    job.state = 'failed'; job.error = TIMEOUT_MSG;
    await saveJob(deps, job);
    await quietly(() => deps.notify.send(`Demo ${job.siteId} chưa sẵn sàng sau 3 phút kể từ khi đẩy lên (${job.kind}): ${job.name} – ${job.phone}. Cần kiểm tra GitHub Pages.`));
  }
  return json(publicJob(job));
}
