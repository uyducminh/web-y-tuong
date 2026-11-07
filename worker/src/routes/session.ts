import type { Deps, Session } from '../types';
import { getIp, errorJson, json, readJson } from '../http';
import { dayStamp, incr, putJson } from '../kv';
import { BriefSchema } from '@sme/schema';
import { bumpStat } from '../sites';

const SESSIONS_PER_IP_PER_DAY = 3;
const SESSION_TTL = 7 * 24 * 3600;

export async function createSession(req: Request, deps: Deps): Promise<Response> {
  const body = await readJson<{ turnstileToken?: string }>(req);
  if (!body || typeof body.turnstileToken !== 'string') return errorJson(400, 'Yêu cầu không hợp lệ.');
  const ip = getIp(req);
  if (!(await deps.turnstile.verify(body.turnstileToken, ip))) {
    return errorJson(403, 'Không xác minh được bạn là người thật. Vui lòng tải lại trang và thử lại.');
  }
  const now = deps.now();
  const count = await incr(deps.kv, `ip:${ip}:${dayStamp(now)}`, 2 * 24 * 3600);
  if (count > SESSIONS_PER_IP_PER_DAY) {
    return errorJson(429, 'Bạn đã tạo tối đa 3 phiên trong hôm nay. Vui lòng quay lại vào ngày mai.');
  }
  const id = deps.rand(24);
  const session: Session = {
    id, ip, createdAt: now.toISOString(), turns: 0,
    brief: BriefSchema.parse({}), messages: [], uploads: [], docsText: '',
  };
  await putJson(deps.kv, `sess:${id}`, session, SESSION_TTL);
  await bumpStat(deps, 'sessions');
  return json({ sessionId: id });
}
