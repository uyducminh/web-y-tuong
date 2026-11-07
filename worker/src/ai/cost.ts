import type { Config, Deps } from '../types';
import { dayStamp, getJson, putJson } from '../kv';

/** Micro-USD (integer). Config prices are USD per million tokens == micro-USD per token. */
export function costMicroUsd(model: string, usage: { input_tokens: number; output_tokens: number }, config: Config): number {
  const pin = config.priceInPerMTok[model] ?? 0;
  const pout = config.priceOutPerMTok[model] ?? 0;
  return Math.round(usage.input_tokens * pin + usage.output_tokens * pout);
}

/**
 * KV allows ~1 write/second per key, so the daily total is sharded: writes go to a random `cost:<day>:<n>`,
 * reads sum the shards (plus the unsharded `cost:<day>`, kept for manual overrides).
 */
export const COST_SHARDS = 4;
const TTL = 2 * 24 * 3600;
const dayKey = (deps: Deps) => `cost:${dayStamp(deps.now())}`;
const shardKeys = (deps: Deps) => [dayKey(deps), ...Array.from({ length: COST_SHARDS }, (_, i) => `${dayKey(deps)}:${i}`)];
const pickShard = () => crypto.getRandomValues(new Uint8Array(1))[0] % COST_SHARDS;

/** Today's total in micro-USD (UTC day). */
export async function costToday(deps: Deps): Promise<number> {
  const vals = await Promise.all(shardKeys(deps).map((k) => getJson<number>(deps.kv, k)));
  return vals.reduce<number>((a, v) => a + (typeof v === 'number' ? v : 0), 0);
}

/**
 * Adds to today's total. Never throws: it runs after Anthropic has already billed, so a KV hiccup
 * (e.g. the per-key write rate limit) must not fail the customer's request. Returns false if not recorded.
 */
export async function addCost(deps: Deps, microUsd: number, shard: number = pickShard()): Promise<boolean> {
  if (!(microUsd > 0)) return true;
  const key = `${dayKey(deps)}:${shard}`;
  try {
    const cur = (await getJson<number>(deps.kv, key)) ?? 0;
    await putJson(deps.kv, key, cur + microUsd, TTL);
    return true;
  } catch (e) {
    console.error(`addCost failed (${microUsd} micro-USD not recorded)`, e);
    return false;
  }
}

/** Records the cost of one Claude call (no-op without usage). Never throws. */
export function recordUsage(deps: Deps, model: string, usage: { input_tokens: number; output_tokens: number } | undefined) {
  return usage ? addCost(deps, costMicroUsd(model, usage, deps.config)) : Promise.resolve(true);
}

export async function overDailyCap(deps: Deps): Promise<boolean> {
  return (await costToday(deps)) >= deps.config.dailyCapUsd * 1e6;
}
