import type { Deps } from './types';
import { dayStamp, incr } from './kv';
import { quietly } from './jobs/record';

/**
 * `paid:<siteId>` (no TTL) is the source of truth for "this demo is paid". Only the PayOS webhook writes it and
 * nothing rewrites it, unlike `site:<id>` which the cron/revise/status rewrite from earlier reads.
 */
export const paidKey = (siteId: string) => `paid:${siteId}`;
export const isPaid = async (deps: Deps, siteId: string) => (await deps.kv.get(paidKey(siteId))) !== null;

/** Expiry index `exp:<yyyymmdd>:<siteId>` (no TTL): written at generate, deleted when paid or removed; the cron lists only due days. */
export const expKey = (expiresIso: string, siteId: string) => `exp:${dayStamp(new Date(expiresIso))}:${siteId}`;

export const STAT_TTL = 400 * 24 * 3600;
/** Funnel counters `stat:<name>:<yyyymmdd>` (non-atomic, best effort, never throws). */
export const bumpStat = (deps: Deps, name: 'sessions' | 'demos' | 'paid') =>
  quietly(() => incr(deps.kv, `stat:${name}:${dayStamp(deps.now())}`, STAT_TTL));
