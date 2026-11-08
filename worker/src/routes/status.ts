import type { Deps } from '../types';
import { errorJson, json } from '../http';
import { giveUpIfStale, loadJob, publicJob } from '../jobs';

/**
 * Read-only status. Pending jobs are advanced by POST /api/jobs/:id/run (not here); this only gives one up
 * after 10 minutes without a live runner (phone released). A ready job's `url` is the package page.
 */
export async function getStatus(deps: Deps, jobId: string): Promise<Response> {
  const job = await loadJob(deps, jobId);
  if (!job) return errorJson(404, 'Không tìm thấy yêu cầu tạo demo này.');
  if (job.state === 'pending') await giveUpIfStale(deps, job); // updates job in place when it fails it
  return json(publicJob(job));
}
