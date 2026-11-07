import type { Config, Deps } from '../types';
import { dayStamp, getJson, putJson } from '../kv';

/** Micro-USD (integer). Config prices are USD per million tokens == micro-USD per token. */
export function costMicroUsd(model: string, usage: { input_tokens: number; output_tokens: number }, config: Config): number {
  const pin = config.priceInPerMTok[model] ?? 0;
  const pout = config.priceOutPerMTok[model] ?? 0;
  return Math.round(usage.input_tokens * pin + usage.output_tokens * pout);
}

const key = (deps: Deps) => `cost:${dayStamp(deps.now())}`;

/** Adds to today's total (UTC day) and returns the new total. */
export async function addCost(deps: Deps, microUsd: number): Promise<number> {
  const total = ((await getJson<number>(deps.kv, key(deps))) ?? 0) + microUsd;
  await putJson(deps.kv, key(deps), total, 2 * 24 * 3600);
  return total;
}

export async function overDailyCap(deps: Deps): Promise<boolean> {
  const total = (await getJson<number>(deps.kv, key(deps))) ?? 0;
  return total >= deps.config.dailyCapUsd * 1e6;
}
