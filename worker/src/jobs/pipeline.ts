import { defaultAnalysis, defaultSite, templateFor, type Analysis, type Proposal, type SiteJson } from '@sme/schema';
import type { Deps, Job, Session, SiteMeta } from '../types';
import { getJson, putJson } from '../kv';
import { fallbackProposal, generatePackage } from '../ai/generate';
import { overDailyCap } from '../ai/cost';
import { analysisKey, assetKey, bumpStat, demoUrl, packageUrl, ttlUntil } from '../sites';
import {
  type JobRecord, GAVE_UP_MSG, GEN_FAILED, SESSION_TTL_WITH_SITE, UNPUBLISHED_GIVE_UP_MS,
  jobIdxKey, loadJob, publicJob, queueKey, quietly, saveJob,
} from './record';
import { LEASE_AI_MS, LeaseLostError, acquireLease, assertLease, leaseLive, releaseLease, saveLeased } from './lease';

/**
 * What the caller of POST /api/jobs/:id/run should do next:
 * run = call /run again now · wait = another runner holds the job, call /run again in a few seconds ·
 * poll = queued (over the daily AI cap; the cron runs it) → poll GET /api/status · done = ready/failed.
 */
export type RunNext = 'run' | 'wait' | 'poll' | 'done';
export type StageOutcome = { job: JobRecord; next: RunNext };

export class JobNotFoundError extends Error {
  constructor(id: string) { super(`job ${id} not found`); this.name = 'JobNotFoundError'; }
}

const nextFor = (job: JobRecord, busy = false): RunNext =>
  job.state === 'ready' || job.state === 'failed' ? 'done'
    : job.state === 'queued' ? 'poll'
      : busy ? 'wait' : 'run';

const newRunner = (deps: Deps, kind: string) => `${kind}-${deps.rand(12)}`;

/**
 * Runs the next stage of a generate job (queued/ai → ready), synchronously, under the job lease.
 * Called by POST /api/jobs/:id/run (the status page loops on it; a request whose client stays connected has no wall-clock
 * limit) and by the cron via runGenerateJob. Never depends on ctx.waitUntil. Never calls the Publisher (no GitHub).
 */
export async function runNextStage(deps: Deps, jobId: string, o: { runner?: string; giveUp?: boolean } = {}): Promise<StageOutcome> {
  const runner = o.runner ?? newRunner(deps, 'run');
  const job = await loadJob(deps, jobId);
  if (!job) throw new JobNotFoundError(jobId);
  if (job.kind !== 'generate' || nextFor(job) === 'done') return { job, next: nextFor(job) };
  if (leaseLive(deps, job) && job.runner !== runner) return { job, next: 'wait' };
  if (o.giveUp !== false && await giveUpIfStale(deps, job)) return { job, next: 'done' };
  if (job.state === 'queued' && await overDailyCap(deps)) return { job, next: 'poll' };

  try {
    return await aiStage(deps, jobId, runner);
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
 * Stops when the job is ready/queued/failed or another runner holds it.
 */
export async function runGenerateJob(deps: Deps, jobId: string, o: { giveUp?: boolean } = {}): Promise<Job> {
  const runner = newRunner(deps, 'cron');
  let out: StageOutcome | null = null;
  for (let i = 0; i < 3; i++) {
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

type Upload = { path: string; mime: string; base64: string };

/** The session's uploads still present at `up:<sessionId>:<n>` (7-day TTL) and listed in `s.uploads`. */
async function loadUploads(deps: Deps, s: Session): Promise<Upload[]> {
  const out: Upload[] = [];
  for (let n = 1; n <= s.uploads.length; n++) {
    const u = await getJson<Upload>(deps.kv, `up:${s.id}:${n}`);
    if (u && s.uploads.includes(u.path)) out.push({ path: u.path, mime: u.mime, base64: u.base64 });
  }
  return out;
}

/**
 * AI stage: content + analysis (or deterministic defaults when Claude is down) → KV, images copied to `asset:`,
 * SiteMeta updated; the job becomes ready and (once, under the lease) the Sheet row + Telegram notice go out.
 */
async function aiStage(deps: Deps, jobId: string, runner: string): Promise<StageOutcome> {
  const job = await acquireLease(deps, jobId, runner, LEASE_AI_MS);
  if (!job) return { job: (await loadJob(deps, jobId))!, next: 'wait' };
  const { s } = await loadInputs(deps, job);
  const now = deps.now().toISOString();
  job.state = 'pending'; job.startedAt ??= now; job.stage = 'ai'; job.stageAt = now;
  await saveLeased(deps, job, runner);
  await deps.kv.delete(queueKey(job.id));

  let site: SiteJson; let analysis: Analysis;
  try {
    ({ site, analysis } = await generatePackage(deps, s, job.siteId));
  } catch (e) {
    console.error('generatePackage failed, using defaults', e);
    site = defaultSite(templateFor(s.brief), s.brief, job.siteId, deps.now());
    analysis = defaultAnalysis(s.brief);
  }
  site = { ...site, demo: { ...site.demo, checkoutUrl: `${deps.config.webOrigin}/proposal.html?site=${job.siteId}` } };
  // Still read by GET /api/proposal (web-main proposal page) until the package page replaces it.
  const proposal: Proposal = fallbackProposal(deps, s.brief);
  const uploads = await loadUploads(deps, s);

  await assertLease(deps, job.id, runner); // a runner that lost the job must not overwrite newer content
  // Re-read SiteMeta right before rewriting it (expires/revisions may have changed while Claude ran).
  const meta = await getJson<SiteMeta>(deps.kv, `site:${job.siteId}`);
  if (!meta) throw new Error(`site record missing for ${job.siteId}`);
  const assetTtl = ttlUntil(deps, meta.expires);
  await putJson(deps.kv, `sess:${s.id}`, s, SESSION_TTL_WITH_SITE);
  await putJson(deps.kv, `sitejson:${job.siteId}`, site);
  await putJson(deps.kv, `proposal:${job.siteId}`, proposal);
  await putJson(deps.kv, analysisKey(job.siteId), analysis);
  for (const u of uploads) await putJson(deps.kv, assetKey(job.siteId, u.path), { mime: u.mime, base64: u.base64 }, assetTtl);
  await putJson(deps.kv, `site:${job.siteId}`, { ...meta, template: site.template, analysisReady: true } satisfies SiteMeta);

  job.state = 'ready'; job.stage = 'ready'; job.stageAt = deps.now().toISOString();
  job.url = packageUrl(deps.config, job.siteId);
  releaseLease(job);
  await saveLeased(deps, job, runner); // verifies the lease right before the one-time side effects below
  await quietly(() => deps.kv.delete(jobIdxKey(job.id)));
  await bumpStat(deps, 'demos');

  const demo = demoUrl(deps.config, job.siteId);
  const leadUrl = `${deps.config.apiBase}/leads/${job.siteId}?key=${meta.leadKey}`;
  await quietly(() => deps.sheet.append({
    thoi_gian: deps.now().toISOString(), ten: job.name, sdt: job.phone, nhu_cau: s.brief.muc_tieu_chinh ?? '',
    link_demo: demo, link_lead: leadUrl, trang_thai: 'demo', siteId: job.siteId,
  }));
  await quietly(() => deps.notify.send(
    `Demo mới: ${job.name} – ${job.phone}\nNhu cầu: ${s.brief.muc_tieu_chinh ?? '(chưa rõ)'}\nDemo: ${demo}\nBộ hồ sơ: ${job.url}\nLead: ${leadUrl}`));
  return { job, next: 'done' };
}

/** Fails a job that never became ready (caller holds the lease): frees the phone (if still ours) so the customer can retry, and tells the team. */
export async function failUnpublished(deps: Deps, job: JobRecord, error: string, reason: string): Promise<void> {
  job.state = 'failed'; job.error = error;
  releaseLease(job);
  await saveJob(deps, job);
  await quietly(() => deps.kv.delete(jobIdxKey(job.id)));
  if ((await getJson<string>(deps.kv, `phone:${job.phone}`)) === job.siteId) await deps.kv.delete(`phone:${job.phone}`);
  await quietly(() => deps.notify.send(`LỖI tạo demo ${job.siteId}: ${job.name} – ${job.phone}. ${reason}`));
}

/**
 * Gives up a pending job that is not ready 10 minutes after it started. Never while another runner holds a live
 * lease (it may be finishing); it takes the lease itself first so a runner starting meanwhile stops.
 * Returns true (and updates `job` in place) if it failed the job.
 */
export async function giveUpIfStale(deps: Deps, job: JobRecord): Promise<boolean> {
  if (job.state !== 'pending') return false;
  if (deps.now().getTime() - Date.parse(job.startedAt ?? job.createdAt) <= UNPUBLISHED_GIVE_UP_MS) return false;
  if (leaseLive(deps, job)) return false;
  const held = await acquireLease(deps, job.id, newRunner(deps, 'giveup'), LEASE_AI_MS);
  if (!held || held.state !== 'pending') return false;
  await failUnpublished(deps, held, GAVE_UP_MSG, `Quá 10 phút chưa tạo xong (dừng ở bước ${held.stage}).`);
  Object.assign(job, held);
  return true;
}
