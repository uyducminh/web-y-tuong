import type { Config, Deps, Job } from './types';
import { getJson, putJson } from './kv';

/** Internal job record stored at `job:<id>`; the public API only ever returns the `Job` part. */
export type JobRecord = Job & {
  kind: 'generate' | 'revise';
  sessionId: string; phone: string; name: string;
  createdAt: string;
  /** Resumable pipeline stage; `stageAt` is updated on every transition. */
  stage: JobStage; stageAt: string;
  /** Set when the job first leaves `queued` (queued jobs start later than they are created). */
  startedAt?: string;
  /** Set when files are committed and Pages is requested; the 3-minute Pages timeout runs from here. */
  publishedAt?: string;
};

export type JobStage = 'queued' | 'ai' | 'ai_done' | 'publishing' | 'published';

export const JOB_TTL = 7 * 24 * 3600;
export const PHONE_TTL = 400 * 24 * 3600;
export const SESSION_TTL_WITH_SITE = 30 * 24 * 3600;
export const PAGES_TIMEOUT_MS = 3 * 60_000;
/** An unpublished stage untouched this long is considered stalled (waitUntil killed) and is resumed. */
export const STALL_MS = 45_000;
/** An unpublished job not done this long after it started is given up. */
export const UNPUBLISHED_GIVE_UP_MS = 10 * 60_000;

export const jobKey = (id: string) => `job:${id}`;
export const queueKey = (id: string) => `queue:${id}`;

export const loadJob = (deps: Deps, id: string) => getJson<JobRecord>(deps.kv, jobKey(id));
export const saveJob = (deps: Deps, job: JobRecord) => putJson(deps.kv, jobKey(job.id), job, JOB_TTL);

export function publicJob(j: JobRecord): Job {
  const out: Job = { id: j.id, siteId: j.siteId, state: j.state };
  if (j.url) out.url = j.url;
  if (j.error) out.error = j.error;
  return out;
}

export async function setStage(deps: Deps, job: JobRecord, stage: JobStage): Promise<void> {
  job.stage = stage; job.stageAt = deps.now().toISOString();
  if (stage === 'published') job.publishedAt = job.stageAt;
  await saveJob(deps, job);
}

/** Fails a job whose demo never went live: frees the phone (if still ours) so the customer can retry, and tells the team. */
export async function failUnpublished(deps: Deps, job: JobRecord, error: string, reason: string): Promise<void> {
  job.state = 'failed'; job.error = error;
  await saveJob(deps, job);
  if ((await getJson<string>(deps.kv, `phone:${job.phone}`)) === job.siteId) await deps.kv.delete(`phone:${job.phone}`);
  await quietly(() => deps.notify.send(`LỖI tạo demo ${job.siteId}: ${job.name} – ${job.phone}. ${reason}`));
}

export const pagesUrl = (config: Config, repo: string) => `https://${config.ghOrg.toLowerCase()}.github.io/${repo}/`;

/** Best-effort side calls (Sheet/Telegram) must never fail the job. */
export async function quietly(p: () => Promise<unknown>): Promise<void> {
  try { await p(); } catch (e) { console.error(e); }
}

export function utf8ToBase64(s: string): string {
  let bin = '';
  const bytes = new TextEncoder().encode(s);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
