import { z } from 'zod';
import type { TemplateId } from './site';

export const STEPS = ['don_vi', 'san_pham', 'khach_hang', 'muc_tieu', 'phong_cach', 'tham_khao', 'tai_lieu', 'xac_nhan'] as const;
export type StepId = (typeof STEPS)[number];

export const STEP_LABELS: Record<StepId, string> = {
  don_vi: 'Đơn vị và ngành nghề',
  san_pham: 'Sản phẩm và dịch vụ',
  khach_hang: 'Khách hàng',
  muc_tieu: 'Mục tiêu website',
  phong_cach: 'Phong cách',
  tham_khao: 'Website tham khảo',
  tai_lieu: 'Tài liệu và hình ảnh',
  xac_nhan: 'Liên hệ và xác nhận',
};

const str = z.string();
const stepId = z.enum(STEPS);

export const BriefV2Schema = z.object({
  ten_don_vi: str.optional(),
  loai_hinh: z.enum(['htx', 'cong-ty', 'ho-kd', 'khac']).optional(),
  nganh: str.optional(),
  dia_phuong: str.optional(),
  quy_mo: str.optional(),
  nam_thanh_lap: str.optional(),
  san_pham: z.array(z.object({
    ten: str, gia: z.number().optional(), mo_ta: str.optional(), anh: str.optional(),
  })).max(60).optional(),
  chung_nhan: z.array(str).optional(),
  diem_khac_biet: str.optional(),
  khach_hang_muc_tieu: str.optional(),
  khu_vuc_khach: str.optional(),
  kenh_ban_hien_tai: z.array(str).optional(),
  muc_tieu_chinh: z.enum(['gioi-thieu', 'ban-hang', 'thu-lead', 'tim-dai-ly', 'tuyen-dung']).optional(),
  hanh_dong_mong_muon: z.enum(['goi', 'zalo', 'dat-hang', 'dang-ky']).optional(),
  thanh_cong_la_gi: str.optional(),
  cam_giac: z.enum(['moc-mac', 'truyen-thong', 'hien-dai', 'sang-trong', 'tre-trung']).optional(),
  mau_chu_dao: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  co_logo: z.boolean().optional(),
  web_tham_khao: z.array(z.object({ url: str.optional(), anh: str.optional(), thich_diem_gi: str })).optional(),
  lien_he: z.object({
    phone: str.optional(), zalo: str.optional(), address: str.optional(),
    gio_mo_cua: str.optional(), fanpage: str.optional(),
  }).optional(),
  da_xac_nhan: z.boolean().optional(),
  meta: z.object({ auto: z.array(str).optional(), askedOptional: z.array(stepId).optional() }).optional(),
});
export type BriefV2 = z.infer<typeof BriefV2Schema>;

const filled = (v: unknown) => (typeof v === 'string' ? v.trim() !== '' : v != null);

function missingFor(b: BriefV2): Record<StepId, string[]> {
  const m = (keys: (keyof BriefV2)[]) => keys.filter((k) => !filled(b[k])) as string[];
  const contact = filled(b.lien_he?.phone) || filled(b.lien_he?.zalo) ? [] : ['lien_he.phone|zalo'];
  return {
    don_vi: m(['ten_don_vi', 'loai_hinh', 'nganh', 'dia_phuong']),
    san_pham: [...((b.san_pham ?? []).some((p) => filled(p.ten)) ? [] : ['san_pham']), ...m(['diem_khac_biet'])],
    khach_hang: m(['khach_hang_muc_tieu']),
    muc_tieu: m(['muc_tieu_chinh', 'hanh_dong_mong_muon']),
    phong_cach: m(['cam_giac']),
    tham_khao: [],
    tai_lieu: [],
    xac_nhan: contact,
  };
}

export function stepState(b: BriefV2): { step: StepId; index: number; done: StepId[]; missing: string[]; canConfirm: boolean } {
  const miss = missingFor(b);
  const asked = b.meta?.askedOptional ?? [];
  const isDone = (s: StepId) =>
    s === 'tham_khao' || s === 'tai_lieu' ? asked.includes(s) : miss[s].length === 0;
  const done = STEPS.filter(isDone);
  const step = STEPS.find((s) => !isDone(s)) ?? 'xac_nhan';
  const missing = STEPS.flatMap((s) => miss[s]);
  return { step, index: STEPS.indexOf(step) + 1, done, missing, canConfirm: missing.length === 0 };
}

const shape = BriefV2Schema.shape as Record<string, z.ZodTypeAny>;
const lienHeShape = (BriefV2Schema.shape.lien_he as z.ZodOptional<z.ZodObject<z.ZodRawShape>>).unwrap().shape;

export function mergeBriefV2(b: BriefV2, patch: unknown): BriefV2 {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return b;
  const out: Record<string, unknown> = { ...b };
  let changed = false;
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (k === 'da_xac_nhan' || !(k in shape) || v === undefined) continue;
    if (k === 'lien_he') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const lh: Record<string, unknown> = { ...(b.lien_he ?? {}) };
      for (const [lk, lv] of Object.entries(v)) {
        if (lk in lienHeShape && lienHeShape[lk]!.safeParse(lv).success) { lh[lk] = lv; changed = true; }
      }
      out.lien_he = lh;
      continue;
    }
    if (k === 'meta') {
      const r = shape.meta!.safeParse(v);
      if (!r.success || !r.data) continue;
      const cur = b.meta ?? {};
      const meta: Record<string, unknown> = { ...cur, ...r.data };
      if (r.data.askedOptional) meta.askedOptional = [...new Set([...(cur.askedOptional ?? []), ...r.data.askedOptional])];
      out.meta = meta;
      continue;
    }
    if (shape[k]!.safeParse(v).success) { out[k] = v; changed = true; }
  }
  if (changed && b.da_xac_nhan) out.da_xac_nhan = false;
  return out as BriefV2;
}

export function templateFor(b: BriefV2): TemplateId {
  switch (b.muc_tieu_chinh) {
    case 'ban-hang': return 'tpl-ban-hang';
    case 'thu-lead': case 'tim-dai-ly': case 'tuyen-dung': return 'tpl-thu-lead';
    default: return 'tpl-gioi-thieu';
  }
}
