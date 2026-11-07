import type { Deps, SiteMeta } from '../types';
import { errorJson, json } from '../http';
import { getJson, putJson } from '../kv';
import { PAGES_TIMEOUT_MS, loadJob, publicJob, quietly, saveJob } from '../jobs';

const TIMEOUT_MSG = 'Bản dùng thử đang mất nhiều thời gian hơn dự kiến. Đội ngũ đã được thông báo và sẽ gửi link cho bạn sớm.';

export async function getStatus(deps: Deps, jobId: string): Promise<Response> {
  const job = await loadJob(deps, jobId);
  if (!job) return errorJson(404, 'Không tìm thấy yêu cầu tạo demo này.');
  if (job.state !== 'pending') return json(publicJob(job));

  if (job.published) {
    let st: { state: 'pending' | 'ready'; url?: string } = { state: 'pending' };
    try { st = await deps.publisher.status(job.siteId); } catch (e) { console.error(e); }
    if (st.state === 'ready') {
      job.state = 'ready'; job.url = st.url;
      await saveJob(deps, job);
      const meta = await getJson<SiteMeta>(deps.kv, `site:${job.siteId}`);
      if (meta && st.url && meta.url !== st.url) await putJson(deps.kv, `site:${job.siteId}`, { ...meta, url: st.url });
      return json(publicJob(job));
    }
  }

  const since = Date.parse(job.startedAt ?? job.createdAt);
  if (deps.now().getTime() - since > PAGES_TIMEOUT_MS) {
    job.state = 'failed'; job.error = TIMEOUT_MSG;
    await saveJob(deps, job);
    await quietly(() => deps.notify.send(`Demo ${job.siteId} chưa sẵn sàng sau 3 phút (${job.kind}): ${job.name} – ${job.phone}. Cần kiểm tra GitHub Pages.`));
  }
  return json(publicJob(job));
}
