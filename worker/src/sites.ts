import { slugify } from '@sme/schema';
import type { Config, Deps, SiteMeta } from './types';
import { dayStamp, incr } from './kv';
import { quietly } from './jobs/record';

/**
 * `paid:<siteId>` (no TTL) is the source of truth for "this demo is paid". Only the PayOS webhook writes it and
 * nothing rewrites it, unlike `site:<id>` which the cron/revise rewrite from earlier reads.
 */
export const paidKey = (siteId: string) => `paid:${siteId}`;
export const isPaid = async (deps: Deps, siteId: string) => (await deps.kv.get(paidKey(siteId))) !== null;

/** Expiry index `exp:<yyyymmdd>:<siteId>` (no TTL): written at generate, deleted when paid or removed; the cron lists only due days. */
export const expKey = (expiresIso: string, siteId: string) => `exp:${dayStamp(new Date(expiresIso))}:${siteId}`;

/** `<slug>-<6 random [a-z0-9]>`; slugify caps the slug at 30 chars, so this always matches ^[a-z0-9-]{1,64}$. */
export const siteIdFor = (name: string, rand: (n: number) => string): string => `${slugify(name)}-${rand(6)}`;

/** Demo image copied from `up:<sessionId>:<n>`: `{ mime, base64 }`, living until the demo expires. */
export const assetKey = (siteId: string, path: string) => `asset:${siteId}:${path}`;
/** Full Analysis (free + full). `full` must never reach an unpaid client. */
export const analysisKey = (siteId: string) => `analysis:${siteId}`;

/** Trailing slash: the page lives at /d/<id>/ (relative site.json/assets resolve there); /d/<id> is only a 301 to it. */
export const demoUrl = (config: Config, siteId: string) => `${config.apiBase}/d/${siteId}/`;
export const packageUrl = (config: Config, siteId: string) => `${config.apiBase}/package/${siteId}`;

/** Seconds from now until the demo expires (KV minimum TTL is 60 s). */
export const ttlUntil = (deps: Deps, expiresIso: string) =>
  Math.max(60, Math.floor((Date.parse(expiresIso) - deps.now().getTime()) / 1000));

export const TRIAL_GONE = 'Bản dùng thử đã hết hạn.';
/** The trial is over: removed by the cron, or past `expires` and not paid (`paid:` key). */
export async function trialGone(deps: Deps, meta: SiteMeta): Promise<boolean> {
  if (meta.removed) return true;
  if (!(deps.now().getTime() > Date.parse(meta.expires))) return false;
  return !(await isPaid(deps, meta.siteId));
}

export const STAT_TTL = 400 * 24 * 3600;
/** Funnel counters `stat:<name>:<yyyymmdd>` (non-atomic, best effort, never throws). */
export const bumpStat = (deps: Deps, name: 'sessions' | 'demos' | 'paid') =>
  quietly(() => incr(deps.kv, `stat:${name}:${dayStamp(deps.now())}`, STAT_TTL));
