import type { Deps, SiteMeta } from '../types';
import { errorJson, json } from '../http';
import { getJson, putJson } from '../kv';
import {
  PAGES_TIMEOUT_MS, STALL_MS, giveUpIfStale, loadJob, publicJob, quietly, saveJob,
} from '../jobs';
import { runGenerateJob } from './generate';

const TIMEOUT_MSG = 'Bản dùng thử đang mất nhiều thời gian hơn dự kiến. Đội ngũ đã được thông báo và sẽ gửi link cho bạn sớm.';

/**
 * Client polling drives recovery: a stalled unpublished job (waitUntil killed) is resumed in the background,
 * given up after 10 minutes (phone released); a published job fails if Pages is not built 3 minutes after publishing.
 */
export async function getStatus(deps: Deps, ctx: ExecutionContext, jobId: string): Promise<Response> {
  const job = await loadJob(deps, jobId);
  if (!job) return errorJson(404, 'Không tìm thấy yêu cầu tạo demo này.');
  if (job.state !== 'pending') return json(publicJob(job));
  const now = deps.now().getTime();

  if (job.stage !== 'published') {
    if (await giveUpIfStale(deps, job)) { /* failed and phone released */ }
    else if (now - Date.parse(job.stageAt) > STALL_MS) {
      ctx.waitUntil(runGenerateJob(deps, job.id).catch((e) => console.error(e)));
    }
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
