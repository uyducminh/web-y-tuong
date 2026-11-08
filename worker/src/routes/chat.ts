import { mergeBriefV2 } from '@sme/schema';
import type { Deps, Session } from '../types';
import { errorJson, json, readJson } from '../http';
import { getJson, putJson } from '../kv';
import { chatTurn, MAX_TEXT } from '../ai/chat';
import { overDailyCap } from '../ai/cost';
import { MAX_TURNS } from '../ai/prompts';
import { briefView } from './brief';

const SESSION_TTL = 7 * 24 * 3600;

export async function postChat(req: Request, deps: Deps): Promise<Response> {
  const body = await readJson<{ sessionId?: unknown; text?: unknown }>(req);
  if (!body || typeof body.sessionId !== 'string' || typeof body.text !== 'string' || !body.text.trim()) {
    return errorJson(400, 'Yêu cầu không hợp lệ.');
  }
  const s = await getJson<Session>(deps.kv, `sess:${body.sessionId}`);
  if (!s) return errorJson(404, 'Không tìm thấy phiên trò chuyện. Vui lòng tải lại trang để bắt đầu lại.');
  if (s.turns >= MAX_TURNS) {
    return errorJson(409, 'Đã hết số lượt trò chuyện. Vui lòng kiểm tra lại thông tin và bấm xác nhận.', { mustConfirm: true });
  }
  if (await overDailyCap(deps)) return json({ capped: true });

  const text = body.text.slice(0, MAX_TEXT);
  let r;
  try {
    r = await chatTurn(deps, s, text);
  } catch (e) {
    console.error(e);
    return errorJson(503, 'Trợ lý đang bận, vui lòng thử lại sau ít phút.');
  }
  let brief = mergeBriefV2(s.brief, r.briefPatch);
  if (r.askedOptional) brief = mergeBriefV2(brief, { meta: { askedOptional: [r.askedOptional] } });
  s.brief = brief;
  s.turns += 1;
  s.messages.push({ role: 'user', content: text }, { role: 'assistant', content: r.reply });
  await putJson(deps.kv, `sess:${s.id}`, s, SESSION_TTL);
  const v = briefView(s.brief);
  return json({
    reply: r.reply, quickReplies: r.quickReplies, ...(r.choices ? { choices: r.choices } : {}),
    step: v.step, done: v.done, missing: v.missing, canConfirm: v.canConfirm,
    turnsLeft: MAX_TURNS - s.turns, mustConfirm: s.turns >= MAX_TURNS,
  });
}
