import { mergeBriefV2, stepState, STEP_LABELS, type BriefV2 } from '@sme/schema';
import type { Deps, Session } from '../types';
import { errorJson, json, readJson } from '../http';
import { MAX_TURNS } from '../ai/prompts';
import { loadSession, updateSession } from '../session-store';

export const MAX_PRODUCTS = 60;
export const MAX_PRICE = 1e10;
const NO_SESSION = 'Không tìm thấy phiên trò chuyện. Vui lòng tải lại trang để bắt đầu lại.';

export function briefView(brief: BriefV2) {
  const st = stepState(brief);
  return {
    step: { id: st.step, index: st.index, label: STEP_LABELS[st.step] },
    done: st.done, missing: st.missing, canConfirm: st.canConfirm,
  };
}

export async function getBrief(deps: Deps, sessionId: string): Promise<Response> {
  const s = await loadSession(deps, sessionId);
  if (!s) return errorJson(404, NO_SESSION);
  return json({ brief: s.brief, ...briefView(s.brief) });
}

const CONTACT_PATH = 'lien_he.phone|zalo';
export const UNKNOWN_TEXT = 'Chưa rõ – đội ngũ sẽ đề xuất';
/** Turn-30 fallback for the unit name: never the "Chưa rõ…" placeholder (it is shown as the brand). */
export const UNIT_FALLBACK = 'Đơn vị của bạn';
const DEFAULTS: Record<string, (b: BriefV2, formName: string) => unknown> = {
  ten_don_vi: (_b, formName) => formName || UNIT_FALLBACK, nganh: () => UNKNOWN_TEXT, dia_phuong: () => UNKNOWN_TEXT,
  diem_khac_biet: () => UNKNOWN_TEXT, khach_hang_muc_tieu: () => UNKNOWN_TEXT,
  loai_hinh: () => 'khac', cam_giac: () => 'hien-dai', muc_tieu_chinh: () => 'gioi-thieu', hanh_dong_mong_muon: () => 'zalo',
  san_pham: (b) => [{ ten: b.ten_don_vi?.trim() || 'Sản phẩm chính' }],
};

function withDefaults(b: BriefV2, missing: string[], formName: string): BriefV2 {
  const patch: Record<string, unknown> = {};
  const auto: string[] = [];
  for (const k of missing) {
    const d = DEFAULTS[k];
    if (!d) continue;
    patch[k] = d(b, formName);
    auto.push(k);
  }
  if (!auto.length) return b;
  const merged = mergeBriefV2(b, patch);
  return { ...merged, meta: { ...merged.meta, auto: [...new Set([...(b.meta?.auto ?? []), ...auto])] } };
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
  const body = await readJson<{ sessionId?: unknown; lien_he?: unknown; name?: unknown }>(req);
  if (!body || typeof body.sessionId !== 'string' || !body.sessionId) return errorJson(400, 'Yêu cầu không hợp lệ.');
  // The confirm form collects a phone/Zalo, so a customer without contact at turn 30 is not stuck.
  const contact = confirmContact(body.lien_he);
  const formName = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
  const saved = await updateSession(deps, body.sessionId, (s: Session) => {
    if (contact) s.brief = mergeBriefV2(s.brief, { lien_he: contact });
    let st = stepState(s.brief);
    // Turn 30 (chat locked): a missing required field must not trap the customer — fill neutral defaults the team
    // will refine, recorded in meta.auto. Contact is never defaulted.
    if (!st.canConfirm && s.turns >= MAX_TURNS && !st.missing.includes(CONTACT_PATH)) {
      s.brief = withDefaults(s.brief, st.missing, formName);
      st = stepState(s.brief);
    }
    if (st.canConfirm) s.brief = { ...s.brief, da_xac_nhan: true };
    return st;
  });
  if (!saved) return errorJson(404, NO_SESSION);
  const st = saved.result;
  if (!st.canConfirm) return errorJson(409, 'Còn thiếu một số thông tin bắt buộc. Vui lòng bổ sung trước khi xác nhận.', { missing: st.missing });
  return json({ ok: true });
}

export async function postProducts(req: Request, deps: Deps): Promise<Response> {
  const body = await readJson<{ sessionId?: unknown; items?: unknown }>(req);
  if (!body || typeof body.sessionId !== 'string' || !body.sessionId || !Array.isArray(body.items)) {
    return errorJson(400, 'Yêu cầu không hợp lệ.');
  }
  const items: { ten: string; gia?: number }[] = [];
  for (const it of body.items) {
    if (items.length >= MAX_PRODUCTS) break;
    const ten = typeof (it as any)?.ten === 'string' ? (it as any).ten.trim().slice(0, 200) : '';
    if (!ten) continue;
    const g = (it as any).gia;
    // A price above MAX_PRICE is a parse error (e.g. a unit applied to the wrong number): keep the item, drop the price.
    items.push(typeof g === 'number' && Number.isFinite(g) && g >= 0 && g <= MAX_PRICE ? { ten, gia: Math.round(g) } : { ten });
  }
  const saved = await updateSession(deps, body.sessionId, (s: Session) => {
    if (items.length) s.brief = mergeBriefV2(s.brief, { san_pham: items });
  });
  if (!saved) return errorJson(404, NO_SESSION);
  return json({ count: items.length });
}
