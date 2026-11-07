import { defaultSite, type Proposal, type SiteJson } from '@sme/schema';
import type { Deps, Job, Session, SiteMeta } from '../types';
import { getJson, putJson } from '../kv';
import { fallbackProposal, generateContent, templateFor } from '../ai/generate';
import { overDailyCap } from '../ai/cost';
import { bumpStat } from '../sites';
import {
  type JobRecord, GAVE_UP_MSG, GEN_FAILED, SESSION_TTL_WITH_SITE, UNPUBLISHED_GIVE_UP_MS,
  jobIdxKey, loadJob, pagesUrl, publicJob, queueKey, quietly, saveJob, utf8ToBase64,
} from './record';
import {
  LEASE_AI_MS, LEASE_PUBLISH_MS, LeaseLostError, acquireLease, assertLease, leaseLive, releaseLease, saveLeased,
} from './lease';

/**
 * What the caller of POST /api/jobs/:id/run should do next:
 * run = call /run again now · wait = another runner holds the job or publishing failed transiently, call /run again in a few seconds ·
 * poll = published (Pages building) or queued (cron) → poll GET /api/status · done = ready/failed.
 */
export type RunNext = 'run' | 'wait' | 'poll' | 'done';
export type StageOutcome = { job: JobRecord; next: RunNext };

export class JobNotFoundError extends Error {
  constructor(id: string) { super(`job ${id} not found`); this.name = 'JobNotFoundError'; }
}

const nextFor = (job: JobRecord, busy = false): RunNext =>
  job.state === 'ready' || job.state === 'failed' ? 'done'
    : job.state === 'queued' || job.stage === 'published' ? 'poll'
      : busy ? 'wait' : 'run';

const newRunner = (deps: Deps, kind: string) => `${kind}-${deps.rand(12)}`;

/**
 * Runs exactly ONE stage of a generate job (queued/ai → ai_done → published), synchronously, under the job lease.
 * Called by POST /api/jobs/:id/run (the status page loops on it; a request whose client stays connected has no wall-clock
 * limit) and by the cron via runGenerateJob. Never depends on ctx.waitUntil.
 */
export async function runNextStage(deps: Deps, jobId: string, o: { runner?: string; giveUp?: boolean } = {}): Promise<StageOutcome> {
  const runner = o.runner ?? newRunner(deps, 'run');
  const job = await loadJob(deps, jobId);
  if (!job) throw new JobNotFoundError(jobId);
  if (job.kind !== 'generate' || nextFor(job) === 'done' || job.stage === 'published') return { job, next: nextFor(job) };
  if (leaseLive(deps, job) && job.runner !== runner) return { job, next: 'wait' };
  if (o.giveUp !== false && await giveUpIfStale(deps, job)) return { job, next: 'done' };
  if (job.state === 'queued' && await overDailyCap(deps)) return { job, next: 'poll' };

  try {
    return job.stage === 'queued' || job.stage === 'ai' ? await aiStage(deps, jobId, runner) : await publishStage(deps, jobId, runner);
  } catch (e) {
    const cur = (await loadJob(deps, jobId)) ?? job;
    if (e instanceof LeaseLostError) return { job: cur, next: nextFor(cur, true) };
    console.error('generate stage failed', e);
    if (cur.runner !== runner) return { job: cur, next: nextFor(cur, true) }; // someone else owns it now: leave it
    await failUnpublished(deps, cur, GEN_FAILED, (e as Error)?.message ?? String(e));
    return { job: cur, next: 'done' };
  }
}

/**
 * Drives a job through all remaining stages in one invocation (cron: scheduled handlers allow 15 minutes).
 * Stops when the job is published/queued/failed, another runner holds it, or publishing failed (retried later).
 */
export async function runGenerateJob(deps: Deps, jobId: string, o: { giveUp?: boolean } = {}): Promise<Job> {
  const runner = newRunner(deps, 'cron');
  let out: StageOutcome | null = null;
  for (let i = 0; i < 4; i++) {
    out = await runNextStage(deps, jobId, { runner, giveUp: o.giveUp });
    if (out.next !== 'run') break;
  }
  return publicJob(out!.job);
}

async function loadInputs(deps: Deps, job: JobRecord): Promise<{ s: Session; meta: SiteMeta }> {
  const s = await getJson<Session>(deps.kv, `sess:${job.sessionId}`);
  const meta = await getJson<SiteMeta>(deps.kv, `site:${job.siteId}`);
  if (!s || !meta) throw new Error(`missing session/site for job ${job.id}`);
  return { s, meta };
}

/** AI stage: content (or deterministic fallback when Claude is down) → session, sitejson:, proposal:; then ai_done. */
async function aiStage(deps: Deps, jobId: string, runner: string): Promise<StageOutcome> {
  const job = await acquireLease(deps, jobId, runner, LEASE_AI_MS);
  if (!job) return { job: (await loadJob(deps, jobId))!, next: 'wait' };
  const { s } = await loadInputs(deps, job);
  const now = deps.now().toISOString();
  job.state = 'pending'; job.startedAt ??= now; job.stage = 'ai'; job.stageAt = now;
  await saveLeased(deps, job, runner);
  await deps.kv.delete(queueKey(job.id));

  let site: SiteJson; let proposal: Proposal;
  try {
    ({ site, proposal } = await generateContent(deps, s, job.siteId));
  } catch (e) {
    console.error('generateContent failed, using defaults', e);
    site = defaultSite(templateFor(s.brief), s.brief, job.siteId, deps.now());
    proposal = fallbackProposal(deps, s.brief);
  }
  site = { ...site, demo: { ...site.demo, checkoutUrl: `${deps.config.webOrigin}/proposal.html?site=${job.siteId}` } };

  await assertLease(deps, job.id, runner); // a runner that lost the job must not overwrite newer content
  await putJson(deps.kv, `sess:${s.id}`, s, SESSION_TTL_WITH_SITE);
  await putJson(deps.kv, `sitejson:${job.siteId}`, site);
  await putJson(deps.kv, `proposal:${job.siteId}`, proposal);
  job.stage = 'ai_done'; job.stageAt = deps.now().toISOString();
  releaseLease(job);
  await saveLeased(deps, job, runner);
  return { job, next: 'run' };
}

async function loadUploads(deps: Deps, s: Session): Promise<{ path: string; base64: string }[]> {
  const out: { path: string; base64: string }[] = [];
  for (let n = 1; n <= s.uploads.length; n++) {
    const u = await getJson<{ path: string; base64: string }>(deps.kv, `up:${s.id}:${n}`);
    if (u && s.uploads.includes(u.path)) out.push({ path: u.path, base64: u.base64 });
  }
  return out;
}

/** Publish stage: commit site.json + uploads; on success mark published, then (once, under the lease) sheet + Telegram. */
async function publishStage(deps: Deps, jobId: string, runner: string): Promise<StageOutcome> {
  const job = await acquireLease(deps, jobId, runner, LEASE_PUBLISH_MS);
  if (!job) return { job: (await loadJob(deps, jobId))!, next: 'wait' };
  const { s, meta } = await loadInputs(deps, job);
  const site = await getJson<SiteJson>(deps.kv, `sitejson:${job.siteId}`);
  if (!site) throw new Error(`sitejson missing for ${job.siteId}`);
  job.stage = 'publishing'; job.stageAt = deps.now().toISOString();
  await saveLeased(deps, job, runner);

  const files = [{ path: 'site.json', base64: utf8ToBase64(JSON.stringify(site, null, 2)) }, ...(await loadUploads(deps, s))];
  try {
    await deps.publisher.create({ repoName: meta.repo, template: site.template, files });
  } catch (e) {
    // Transient (GitHub down): stay at `publishing`, free the lease; the next /run (or cron) retries, give-up after 10 minutes.
    console.error('publish failed, will retry', e);
    releaseLease(job);
    await saveLeased(deps, job, runner);
    return { job, next: 'wait' };
  }
  job.stage = 'published'; job.stageAt = deps.now().toISOString(); job.publishedAt = job.stageAt;
  releaseLease(job);
  await saveLeased(deps, job, runner); // verifies the lease right before the one-time side effects below
  await quietly(() => deps.kv.delete(jobIdxKey(job.id)));
  await bumpStat(deps, 'demos');

  const demoUrl = pagesUrl(deps.config, meta.repo);
  const leadUrl = `${deps.config.apiBase}/leads/${job.siteId}?key=${meta.leadKey}`;
  await quietly(() => deps.sheet.append({
    thoi_gian: deps.now().toISOString(), ten: job.name, sdt: job.phone, nhu_cau: s.brief.nhu_cau ?? '',
    link_demo: demoUrl, link_lead: leadUrl, trang_thai: 'demo', siteId: job.siteId,
  }));
  await quietly(() => deps.notify.send(
    `Demo mới: ${job.name} – ${job.phone}\nNhu cầu: ${s.brief.nhu_cau ?? '(chưa rõ)'}\nDemo: ${demoUrl}\nLead: ${leadUrl}`));
  return { job, next: 'poll' };
}

/** Fails a job whose demo never went live (caller holds the lease): frees the phone (if still ours) so the customer can retry, and tells the team. */
export async function failUnpublished(deps: Deps, job: JobRecord, error: string, reason: string): Promise<void> {
  job.state = 'failed'; job.error = error;
  releaseLease(job);
  await saveJob(deps, job);
  await quietly(() => deps.kv.delete(jobIdxKey(job.id)));
  if ((await getJson<string>(deps.kv, `phone:${job.phone}`)) === job.siteId) await deps.kv.delete(`phone:${job.phone}`);
  await quietly(() => deps.notify.send(`LỖI tạo demo ${job.siteId}: ${job.name} – ${job.phone}. ${reason}`));
}

/**
 * Gives up a pending, unpublished job that has not finished 10 minutes after it started. Never while another runner
 * holds a live lease (it may be publishing); it takes the lease itself first so a runner starting meanwhile stops.
 * Returns true (and updates `job` in place) if it failed the job.
 */
export async function giveUpIfStale(deps: Deps, job: JobRecord): Promise<boolean> {
  if (job.state !== 'pending' || job.stage === 'published') return false;
  if (deps.now().getTime() - Date.parse(job.startedAt ?? job.createdAt) <= UNPUBLISHED_GIVE_UP_MS) return false;
  if (leaseLive(deps, job)) return false;
  const held = await acquireLease(deps, job.id, newRunner(deps, 'giveup'), LEASE_PUBLISH_MS);
  if (!held || held.state !== 'pending' || held.stage === 'published') return false;
  await failUnpublished(deps, held, GAVE_UP_MSG, `Quá 10 phút chưa đẩy lên GitHub (dừng ở bước ${held.stage}).`);
  Object.assign(job, held);
  return true;
}
