import type { Config, Deps, Job } from '../types';
import { getJson, putJson } from '../kv';

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
  /** Lease: the runner currently executing a stage, until `leaseUntil` (ISO). See jobs/lease.ts. */
  runner?: string; leaseUntil?: string;
};

export type JobStage = 'queued' | 'ai' | 'ai_done' | 'publishing' | 'published';

export const JOB_TTL = 7 * 24 * 3600;
export const PHONE_TTL = 400 * 24 * 3600;
export const SESSION_TTL_WITH_SITE = 30 * 24 * 3600;
export const PAGES_TIMEOUT_MS = 3 * 60_000;
/** An unpublished job not done this long after it started (and not leased by a live runner) is given up. */
export const UNPUBLISHED_GIVE_UP_MS = 10 * 60_000;
/** Index of unpublished generate jobs for the cron (instead of listing every `job:`); deleted when published/failed. */
export const JOBIDX_TTL = 24 * 3600;

export const jobKey = (id: string) => `job:${id}`;
export const queueKey = (id: string) => `queue:${id}`;
export const jobIdxKey = (id: string) => `jobidx:${id}`;

export const loadJob = (deps: Deps, id: string) => getJson<JobRecord>(deps.kv, jobKey(id));
export const saveJob = (deps: Deps, job: JobRecord) => putJson(deps.kv, jobKey(job.id), job, JOB_TTL);

export function publicJob(j: JobRecord): Job {
  const out: Job = { id: j.id, siteId: j.siteId, state: j.state };
  if (j.url) out.url = j.url;
  if (j.error) out.error = j.error;
  return out;
}

export const pagesUrl = (config: Config, repo: string) => `https://${config.ghOrg.toLowerCase()}.github.io/${repo}/`;

/** Best-effort side calls (Sheet/Telegram/stats) must never fail the job. */
export async function quietly(p: () => Promise<unknown>): Promise<void> {
  try { await p(); } catch (e) { console.error(e); }
}

export function utf8ToBase64(s: string): string {
  let bin = '';
  const bytes = new TextEncoder().encode(s);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const GAVE_UP_MSG = 'Chưa tạo được bản dùng thử. Đội ngũ đã được thông báo; bạn có thể bấm tạo lại.';
export const GEN_FAILED = 'Chưa tạo được bản dùng thử. Đội ngũ đã được thông báo và sẽ liên hệ với bạn sớm.';
