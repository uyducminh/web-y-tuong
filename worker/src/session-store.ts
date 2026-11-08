import type { Deps, Session } from './types';
import { getJson, putJson } from './kv';
import { SESSION_TTL_WITH_SITE } from './jobs/record';

export const SESSION_TTL = 7 * 24 * 3600;
export const sessKey = (id: string) => `sess:${id}`;

export const loadSession = (deps: Deps, id: string) => getJson<Session>(deps.kv, sessKey(id));

/**
 * Read-modify-write of `sess:<id>` with the read done RIGHT before the write, so a slow caller (a chat turn waiting on
 * Claude) never writes back a stale copy over concurrent uploads, docs, products or the confirm flag. `mutate` must be
 * synchronous and apply only the caller's own changes to the fresh session it is given. KV has no transactions, so this
 * narrows the race window to one read+write; it does not remove it. Returns null if the session is gone.
 * A session that already has a demo keeps the longer TTL.
 */
export async function updateSession<R>(deps: Deps, id: string, mutate: (s: Session) => R): Promise<{ s: Session; result: R } | null> {
  const s = await loadSession(deps, id);
  if (!s) return null;
  const result = mutate(s);
  await putJson(deps.kv, sessKey(id), s, s.siteId ? SESSION_TTL_WITH_SITE : SESSION_TTL);
  return { s, result };
}
