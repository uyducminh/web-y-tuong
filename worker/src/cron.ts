import type { Deps, SiteMeta } from './types';
import { dayStamp, getJson, putJson } from './kv';
import { giveUpIfStale, jobIdxKey, leaseLive, loadJob, queueKey, quietly, runGenerateJob } from './jobs';
import { overDailyCap } from './ai/cost';
import { assetPrefix, briefKey, docsKey, isPaid, listKeys, analysisKey } from './sites';

/**
 * Daily cron (a scheduled invocation allows ~1000 KV operations). It never lists every `site:` or `job:` key:
 * expiry uses the `exp:<yyyymmdd>:<siteId>` index (only due days are read) and abandoned jobs use `jobidx:<jobId>`.
 */

/** Keys under a prefix in lexicographic order, page by page (KV list cursor), so callers can stop early. */
async function* keysUnder(kv: KVNamespace, prefix: string): AsyncGenerator<string> {
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) yield k.name;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

/** Runs queued jobs in order until the daily AI cost cap is reached. Returns how many were run. */
async function processQueue(deps: Deps): Promise<number> {
  let processed = 0;
  for await (const key of keysUnder(deps.kv, 'queue:')) {
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

/**
 * Finishes pending generate jobs whose customer left the status page (nobody calls /run any more): runs the remaining
 * stages, and only gives a job up (phone released) if it still is not ready. Jobs with a live lease are skipped.
 */
async function redriveAbandoned(deps: Deps): Promise<void> {
  for await (const key of keysUnder(deps.kv, 'jobidx:')) {
    const jobId = key.slice('jobidx:'.length);
    try {
      const job = await loadJob(deps, jobId);
      if (!job || job.kind !== 'generate' || job.state === 'failed' || job.state === 'ready') {
        await deps.kv.delete(jobIdxKey(jobId)); continue;
      }
      if (job.state !== 'pending' || leaseLive(deps, job)) continue; // queued → processQueue; leased → someone is on it
      await runGenerateJob(deps, jobId, { giveUp: false });
      const after = await loadJob(deps, jobId);
      if (after && after.state === 'pending') await giveUpIfStale(deps, after);
    } catch (e) { console.error(`cron: redrive ${jobId} failed`, e); }
  }
}

/**
 * Takes down expired unpaid demos (paid ones are never touched) by flagging `removed` (the /d/ page then answers 410).
 * The demo's KV data (sitejson, analysis, proposal, assets, brief, docs) is deleted; no publisher call (there is no repo).
 * Per-site errors are logged and retried on the next run.
 */
async function removeExpired(deps: Deps): Promise<number> {
  const now = deps.now().getTime();
  const today = dayStamp(deps.now());
  let removed = 0;
  for await (const key of keysUnder(deps.kv, 'exp:')) {
    const [, day, siteId] = key.split(':');
    if (!day || !siteId) { await deps.kv.delete(key); continue; }
    if (day > today) break; // sorted by day: nothing further is due
    try {
      const meta = await getJson<SiteMeta>(deps.kv, `site:${siteId}`);
      if (!meta || meta.removed) { await deps.kv.delete(key); continue; }
      if (!(Date.parse(meta.expires) < now)) continue; // due later today: next run
      // `paid:` is written by the webhook and never rewritten; check it right before the irreversible delete.
      if (await isPaid(deps, siteId)) { await deps.kv.delete(key); continue; }
      for (const k of [`sitejson:${siteId}`, analysisKey(siteId), `proposal:${siteId}`, briefKey(siteId), docsKey(siteId), ...(await listKeys(deps.kv, assetPrefix(siteId)))])
        await deps.kv.delete(k);
      await putJson(deps.kv, `site:${siteId}`, { ...meta, removed: true });
      await deps.kv.delete(key);
      await quietly(() => deps.sheet.update(meta.siteId, { trang_thai: 'da_go' }));
      removed++;
    } catch (e) { console.error(`cron: remove ${siteId} failed`, e); }
  }
  return removed;
}

export async function runDaily(deps: Deps): Promise<{ removed: number; processed: number }> {
  const processed = await processQueue(deps);
  await redriveAbandoned(deps);
  const removed = await removeExpired(deps);
  return { removed, processed };
}
