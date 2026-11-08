import { mergeBriefV2 } from '@sme/schema';
import type { Deps, Session } from '../types';
import { errorJson, json, readJson } from '../http';
import { loadSession, updateSession } from '../session-store';
import { chatTurn, MAX_TEXT } from '../ai/chat';
import { overDailyCap } from '../ai/cost';
import { MAX_TURNS } from '../ai/prompts';
import { briefView } from './brief';

export async function postChat(req: Request, deps: Deps): Promise<Response> {
  const body = await readJson<{ sessionId?: unknown; text?: unknown }>(req);
  if (!body || typeof body.sessionId !== 'string' || typeof body.text !== 'string' || !body.text.trim()) {
    return errorJson(400, 'Yêu cầu không hợp lệ.');
  }
  const s = await loadSession(deps, body.sessionId);
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
  // `meta` is code-owned: askedOptional only arrives through the dedicated field below.
  const patch = r.briefPatch && typeof r.briefPatch === 'object' && !Array.isArray(r.briefPatch)
    ? Object.fromEntries(Object.entries(r.briefPatch as Record<string, unknown>).filter(([k]) => k !== 'meta'))
    : r.briefPatch;
  // Claude may have taken up to ~30s: apply this turn's changes to a FRESH copy (uploads/docs/products/confirm may
  // have landed meanwhile) instead of writing back the copy read above.
  const saved = await updateSession(deps, s.id, (cur: Session) => {
    let brief = mergeBriefV2(cur.brief, patch);
    if (r.askedOptional) brief = mergeBriefV2(brief, { meta: { askedOptional: [r.askedOptional] } });
    cur.brief = brief;
    cur.turns += 1;
    cur.messages.push({ role: 'user', content: text }, { role: 'assistant', content: r.reply });
  });
  if (!saved) return errorJson(404, 'Không tìm thấy phiên trò chuyện. Vui lòng tải lại trang để bắt đầu lại.');
  const fresh = saved.s;
  const v = briefView(fresh.brief);
  return json({
    reply: r.reply, quickReplies: r.quickReplies, ...(r.choices ? { choices: r.choices } : {}),
    step: v.step, done: v.done, missing: v.missing, canConfirm: v.canConfirm,
    turnsLeft: MAX_TURNS - fresh.turns, mustConfirm: fresh.turns >= MAX_TURNS,
  });
}
