import type { Deps } from '../types';
import { type JobRecord, loadJob, saveJob } from './record';

/**
 * Job lease: only the runner named in `job.runner` may advance a job until `job.leaseUntil`.
 * Overlapping runners (the status page's /run loop, the cron, a retry) skip a job with a live lease, and a runner
 * re-reads the record before every write and before side effects, stopping if it no longer holds the lease.
 * KV has no compare-and-swap, so acquisition is write-then-read-back (best effort, last write wins); together with
 * re-verification before each write this keeps stale runners from overwriting newer state.
 */
export const LEASE_AI_MS = 5 * 60_000; // > GEN_TOTAL_BUDGET_MS plus KV writes

export class LeaseLostError extends Error {
  constructor(jobId: string) { super(`lease lost for job ${jobId}`); this.name = 'LeaseLostError'; }
}

export const leaseLive = (deps: Deps, job: JobRecord): boolean =>
  !!job.leaseUntil && Date.parse(job.leaseUntil) > deps.now().getTime();

/** Takes the lease for `runner` unless another runner holds a live one. Returns the fresh record, or null if not acquired. */
export async function acquireLease(deps: Deps, jobId: string, runner: string, ms: number): Promise<JobRecord | null> {
  const job = await loadJob(deps, jobId);
  if (!job || (leaseLive(deps, job) && job.runner !== runner)) return null;
  job.runner = runner;
  job.leaseUntil = new Date(deps.now().getTime() + ms).toISOString();
  await saveJob(deps, job);
  const check = await loadJob(deps, jobId);
  return check && check.runner === runner ? check : null;
}

/** Throws LeaseLostError unless `runner` still holds the job (and nobody failed it meanwhile). */
export async function assertLease(deps: Deps, jobId: string, runner: string): Promise<void> {
  const fresh = await loadJob(deps, jobId);
  if (!fresh || fresh.runner !== runner || fresh.state === 'failed' || fresh.state === 'ready') throw new LeaseLostError(jobId);
}

/** Verifies the lease, then writes `job` (which may have released the lease by clearing runner/leaseUntil). */
export async function saveLeased(deps: Deps, job: JobRecord, runner: string): Promise<void> {
  await assertLease(deps, job.id, runner);
  await saveJob(deps, job);
}

export function releaseLease(job: JobRecord): void {
  delete job.runner; delete job.leaseUntil;
}
