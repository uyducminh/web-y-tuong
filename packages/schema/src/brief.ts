import { z } from 'zod';

export const BRIEF_KEYS = [
  'nhu_cau', 'ten_don_vi', 'nganh', 'san_pham_chinh', 'khach_hang_muc_tieu',
  'diem_manh', 'lien_he', 'mau_sac', 'muc_tieu_web', 'tham_khao',
] as const;

export const BriefSchema = z.object({
  nhu_cau: z.string().optional(),
  ten_don_vi: z.string().optional(),
  nganh: z.string().optional(),
  san_pham_chinh: z.string().optional(),
  khach_hang_muc_tieu: z.string().optional(),
  diem_manh: z.string().optional(),
  lien_he: z.object({
    phone: z.string().optional(),
    zalo: z.string().optional(),
    email: z.string().optional(),
    address: z.string().optional(),
  }).optional(),
  mau_sac: z.string().optional(),
  muc_tieu_web: z.string().optional(),
  tham_khao: z.string().optional(),
  meta: z.object({ auto: z.array(z.string()).optional() }).optional(),
});
export type Brief = z.infer<typeof BriefSchema>;

function isFilled(b: Brief, k: (typeof BRIEF_KEYS)[number]): boolean {
  const v = b[k];
  if (v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  return Object.values(v).some((x) => typeof x === 'string' && x.trim() !== '');
}

export function briefProgress(b: Brief): { filled: number; total: 10; missing: string[] } {
  const missing = BRIEF_KEYS.filter((k) => !isFilled(b, k));
  return { filled: BRIEF_KEYS.length - missing.length, total: 10, missing };
}

export const ProposalSchema = z.object({
  summary: z.string(),
  problems: z.array(z.string()),
  solution: z.string(),
  packages: z.array(z.object({
    name: z.string(),
    priceVnd: z.number().int().min(10_000_000),
    items: z.array(z.string()),
  })),
  roadmap: z.array(z.object({ step: z.string(), desc: z.string() })),
});
export type Proposal = z.infer<typeof ProposalSchema>;
