export async function getJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw = await kv.get(key);
  return raw === null ? null : (JSON.parse(raw) as T);
}

export async function putJson(kv: KVNamespace, key: string, val: unknown, ttlSec?: number): Promise<void> {
  // KV requires expirationTtl >= 60
  await kv.put(key, JSON.stringify(val), ttlSec ? { expirationTtl: Math.max(60, Math.floor(ttlSec)) } : undefined);
}

/** Non-atomic counter (KV has no atomic incr); adequate for soft rate limits. */
export async function incr(kv: KVNamespace, key: string, ttlSec: number): Promise<number> {
  const cur = parseInt((await kv.get(key)) ?? '0', 10) || 0;
  const next = cur + 1;
  await kv.put(key, String(next), { expirationTtl: Math.max(60, Math.floor(ttlSec)) });
  return next;
}

/** yyyymmdd in UTC */
export function dayStamp(d: Date): string {
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}
