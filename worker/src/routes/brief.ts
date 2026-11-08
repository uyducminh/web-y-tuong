import { mergeBriefV2, stepState, STEP_LABELS, type BriefV2 } from '@sme/schema';
import type { Deps, Session } from '../types';
import { errorJson, json, readJson } from '../http';
import { getJson, putJson } from '../kv';

const TTL = 7 * 24 * 3600;
export const MAX_PRODUCTS = 60;
const NO_SESSION = 'Không tìm thấy phiên trò chuyện. Vui lòng tải lại trang để bắt đầu lại.';

export function briefView(brief: BriefV2) {
  const st = stepState(brief);
  return {
    step: { id: st.step, index: st.index, label: STEP_LABELS[st.step] },
    done: st.done, missing: st.missing, canConfirm: st.canConfirm,
  };
}

export async function getBrief(deps: Deps, sessionId: string): Promise<Response> {
  const s = await getJson<Session>(deps.kv, `sess:${sessionId}`);
  if (!s) return errorJson(404, NO_SESSION);
  return json({ brief: s.brief, ...briefView(s.brief) });
}

/** Only `phone` / `zalo` (non-empty strings) are taken from the confirm form. */
function confirmContact(v: unknown): { phone?: string; zalo?: string } | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: { phone?: string; zalo?: string } = {};
  for (const k of ['phone', 'zalo'] as const) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof x === 'string' && x.trim()) out[k] = x.trim().slice(0, 30);
  }
  return out.phone || out.zalo ? out : null;
}

/** The only place that sets da_xac_nhan = true (after merging the optional contact from the confirm form). */
export async function postConfirm(req: Request, deps: Deps): Promise<Response> {
  const body = await readJson<{ sessionId?: unknown; lien_he?: unknown }>(req);
  if (!body || typeof body.sessionId !== 'string' || !body.sessionId) return errorJson(400, 'Yêu cầu không hợp lệ.');
  const s = await getJson<Session>(deps.kv, `sess:${body.sessionId}`);
  if (!s) return errorJson(404, NO_SESSION);
  // The confirm form collects a phone/Zalo, so a customer without contact at turn 30 is not stuck.
  const contact = confirmContact(body.lien_he);
  if (contact) {
    s.brief = mergeBriefV2(s.brief, { lien_he: contact });
    await putJson(deps.kv, `sess:${s.id}`, s, TTL);
  }
  const st = stepState(s.brief);
  if (!st.canConfirm) return errorJson(409, 'Còn thiếu một số thông tin bắt buộc. Vui lòng bổ sung trước khi xác nhận.', { missing: st.missing });
  s.brief = { ...s.brief, da_xac_nhan: true };
  await putJson(deps.kv, `sess:${s.id}`, s, TTL);
  return json({ ok: true });
}

export async function postProducts(req: Request, deps: Deps): Promise<Response> {
  const body = await readJson<{ sessionId?: unknown; items?: unknown }>(req);
  if (!body || typeof body.sessionId !== 'string' || !body.sessionId || !Array.isArray(body.items)) {
    return errorJson(400, 'Yêu cầu không hợp lệ.');
  }
  const s = await getJson<Session>(deps.kv, `sess:${body.sessionId}`);
  if (!s) return errorJson(404, NO_SESSION);
  const items: { ten: string; gia?: number }[] = [];
  for (const it of body.items) {
    if (items.length >= MAX_PRODUCTS) break;
    const ten = typeof (it as any)?.ten === 'string' ? (it as any).ten.trim().slice(0, 200) : '';
    if (!ten) continue;
    const g = (it as any).gia;
    items.push(typeof g === 'number' && Number.isFinite(g) && g >= 0 ? { ten, gia: Math.round(g) } : { ten });
  }
  if (items.length) {
    s.brief = mergeBriefV2(s.brief, { san_pham: items });
    await putJson(deps.kv, `sess:${s.id}`, s, TTL);
  }
  return json({ count: items.length });
}
