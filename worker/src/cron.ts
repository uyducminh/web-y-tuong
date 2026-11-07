import type { Deps, SiteMeta } from './types';
import { getJson, putJson } from './kv';
import { giveUpIfStale, loadJob, queueKey, quietly } from './jobs';
import { overDailyCap } from './ai/cost';
import { runGenerateJob } from './routes/generate';

/** All keys under a prefix, following the KV list cursor. */
async function listKeys(kv: KVNamespace, prefix: string): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor });
    names.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return names;
}

/** Deletes expired unpaid demos (paid ones are never touched). Per-site errors are logged and retried on the next run. */
async function removeExpired(deps: Deps): Promise<number> {
  const now = deps.now().getTime();
  let removed = 0;
  for (const key of await listKeys(deps.kv, 'site:')) {
    try {
      const meta = await getJson<SiteMeta>(deps.kv, key);
      if (!meta || meta.paid || meta.removed || !(Date.parse(meta.expires) < now)) continue;
      await deps.publisher.remove(meta.repo); // publisher treats 404 (already gone) as success
      await putJson(deps.kv, key, { ...meta, removed: true });
      await quietly(() => deps.sheet.update(meta.siteId, { trang_thai: 'da_go' }));
      removed++;
    } catch (e) { console.error(`cron: remove ${key} failed`, e); }
  }
  return removed;
}

/** Re-drives pending generate jobs that were never published: give up after 10 minutes, otherwise resume. */
async function redriveAbandoned(deps: Deps): Promise<void> {
  for (const key of await listKeys(deps.kv, 'job:')) {
    try {
      const job = await loadJob(deps, key.slice('job:'.length));
      if (!job || job.kind !== 'generate' || job.state !== 'pending' || job.stage === 'published') continue;
      if (!(await giveUpIfStale(deps, job))) await runGenerateJob(deps, job.id);
    } catch (e) { console.error(`cron: redrive ${key} failed`, e); }
  }
}

/** Runs queued jobs in order until the daily AI cost cap is reached. Returns how many were run. */
async function processQueue(deps: Deps): Promise<number> {
  let processed = 0;
  for (const key of await listKeys(deps.kv, 'queue:')) {
    if (await overDailyCap(deps)) break;
    const jobId = key.slice('queue:'.length);
    try {
      const job = await loadJob(deps, jobId);
      if (job && job.state === 'queued') { processed++; await runGenerateJob(deps, jobId); }
    } catch (e) { console.error(`cron: queue ${jobId} failed`, e); }
    // Done with this entry once the job has left `queued` (or vanished); keep it if it is still waiting.
    const after = await loadJob(deps, jobId);
    if (!after || after.state !== 'queued') await deps.kv.delete(queueKey(jobId));
  }
  return processed;
}

export async function runDaily(deps: Deps): Promise<{ removed: number; processed: number }> {
  const removed = await removeExpired(deps);
  await redriveAbandoned(deps);
  const processed = await processQueue(deps);
  return { removed, processed };
}
