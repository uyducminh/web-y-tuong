import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  BRIEF_KEYS, ProposalSchema, SiteSchema, SECTION_TYPES, briefProgress, defaultSite,
  type Brief, type Proposal, type SiteJson, type TemplateId,
} from '@sme/schema';
import type { Deps, Msg, Session } from '../types';
import { addCost, costMicroUsd } from './cost';

const GenOutSchema = z.object({ site: SiteSchema, proposal: ProposalSchema });
const EMIT_GEN = { name: 'emit_site', input_schema: zodToJsonSchema(GenOutSchema, { $refStrategy: 'none' }) as object };
const EMIT_REVISE = { name: 'emit_site', input_schema: zodToJsonSchema(z.object({ site: SiteSchema }), { $refStrategy: 'none' }) as object };

const TEMPLATE_BY_NEED: Record<string, TemplateId> = {
  'gioi-thieu': 'tpl-gioi-thieu', 'thu-lead': 'tpl-thu-lead', 'ban-hang': 'tpl-ban-hang',
};
export const templateFor = (brief: Brief): TemplateId => TEMPLATE_BY_NEED[brief.nhu_cau ?? ''] ?? 'tpl-gioi-thieu';

const MAX_TOKENS = 8000;

function genSystem(template: TemplateId, now: Date): string {
  return [
    'Bạn là chuyên gia thiết kế website cho doanh nghiệp nhỏ và hợp tác xã Việt Nam.',
    'Từ phiếu yêu cầu (brief) và nội dung tài liệu khách gửi, hãy gọi công cụ emit_site để trả về site (site.json) và proposal (đề xuất triển khai).',
    `Template bắt buộc: ${template}; schemaVersion = 1. Mọi chữ hiển thị cho khách phải bằng tiếng Việt có dấu.`,
    'Chỉ dùng ảnh trong danh sách ảnh đã tải lên (đường dẫn assets/...) hoặc URL https://; không bịa đường dẫn ảnh.',
    'Các mục brief trống: hãy tự đề xuất nội dung hợp lý, đừng bịa số điện thoại, địa chỉ hay chứng nhận.',
    `Loại section hợp lệ: ${SECTION_TYPES.join(', ')}.`,
    `proposal.packages: mỗi gói có priceVnd >= 10000000. Ngày hôm nay: ${now.toISOString().slice(0, 10)}.`,
  ].join('\n');
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Recursively drops string fields that reference unknown `assets/` files or other non-https relative refs for images. */
export function sanitizeAssets(site: SiteJson, uploads: string[]): SiteJson {
  const ok = new Set(uploads);
  const IMG_KEY = /image|logo|img|photo|avatar|thumb|src/i;
  const bad = (v: string, key: string | null): boolean => {
    if (v.startsWith('assets/')) return !ok.has(v);
    if (key !== null && IMG_KEY.test(key)) return !/^https:\/\//i.test(v) && /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(v) || /^(\.\.|\/|javascript:|data:|http:)/i.test(v);
    return false;
  };
  const walk = (v: unknown, key: string | null): unknown => {
    if (Array.isArray(v)) {
      // string items of an images-like array are filtered by the parent key
      return v.filter((x) => !(typeof x === 'string' && bad(x, key))).map((x) => walk(x, key));
    }
    if (isObj(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (typeof x === 'string' && bad(x, k)) continue;
        out[k] = walk(x, k);
      }
      return out;
    }
    return v;
  };
  return walk(site, null) as SiteJson;
}

function fallbackProposal(deps: Deps, brief: Brief): Proposal {
  const { config } = deps;
  const name = brief.ten_don_vi?.trim() || 'đơn vị của bạn';
  const pkgs = config.packages
    .filter((p) => config.allowTestPrice || p.priceVnd >= 10_000_000)
    .map((p) => ({ name: p.name, priceVnd: p.priceVnd, items: p.items }));
  const goal = brief.muc_tieu_web || 'giới thiệu và bán hàng hiệu quả hơn trên mạng';
  return {
    summary: `${name}${brief.nganh ? ` (${brief.nganh})` : ''} cần một website để ${goal}.`,
    problems: [
      brief.khach_hang_muc_tieu ? `Chưa tiếp cận tốt nhóm khách hàng: ${brief.khach_hang_muc_tieu}.` : 'Chưa có kênh trực tuyến chính thức để khách hàng tìm thấy.',
      'Thông tin sản phẩm và liên hệ chưa được trình bày thống nhất.',
    ],
    solution: `Xây dựng website chuyên nghiệp cho ${name}, tối ưu cho điện thoại, có thông tin liên hệ rõ ràng và tên miền riêng.`,
    packages: pkgs,
    roadmap: [
      { step: 'Chốt yêu cầu', desc: 'Xác nhận nội dung, hình ảnh và gói triển khai.' },
      { step: 'Hoàn thiện giao diện', desc: 'Chỉnh sửa theo góp ý và bổ sung nội dung chính thức.' },
      { step: 'Bàn giao', desc: 'Gắn tên miền, tối ưu hiển thị và hướng dẫn sử dụng.' },
    ],
  };
}

function mergeFallback(base: SiteJson, ai: unknown): SiteJson {
  if (!isObj(ai)) return base;
  const out: Record<string, unknown> = { ...base };
  const tops: [keyof SiteJson, z.ZodTypeAny][] = [
    ['brand', SiteSchema.shape.brand], ['contact', SiteSchema.shape.contact],
    ['seo', SiteSchema.shape.seo], ['hero', SiteSchema.shape.hero],
  ];
  for (const [k, schema] of tops) {
    const p = schema.safeParse(ai[k]);
    if (p.success) out[k] = p.data;
  }
  if (Array.isArray(ai.sections)) {
    const types = new Set<string>(SECTION_TYPES);
    const secs = ai.sections.filter((x) => isObj(x) && typeof x.type === 'string' && types.has(x.type));
    if (secs.length) out.sections = secs;
  }
  out.siteId = base.siteId; out.template = base.template; out.demo = base.demo; out.schemaVersion = 1;
  const final = SiteSchema.safeParse(out);
  return final.success ? final.data : base;
}

async function call<T>(deps: Deps, o: { system: string; messages: Msg[]; tool: { name: string; input_schema: object } }): Promise<unknown> {
  const model = deps.config.genModel;
  const { input, usage } = await deps.claude.callTool<T>({ model, ...o, maxTokens: MAX_TOKENS });
  await addCost(deps, costMicroUsd(model, usage, deps.config));
  return input;
}

/**
 * Generates site.json + proposal with one validated retry, then falls back to defaultSite merged with valid AI parts.
 * Side effect: sets `s.brief.meta.auto` to the BRIEF_KEYS that are empty at generation time (the caller must persist `s`).
 * Template is derived from `brief.nhu_cau` by code; siteId/template/demo always come from code.
 */
export async function generateContent(deps: Deps, s: Session, siteId: string)
  : Promise<{ site: SiteJson; proposal: Proposal; usedFallback: boolean }> {
  const missing = briefProgress(s.brief).missing.filter((k) => (BRIEF_KEYS as readonly string[]).includes(k));
  s.brief = { ...s.brief, meta: { ...(s.brief.meta ?? {}), auto: missing } };

  const template = templateFor(s.brief);
  const now = deps.now();
  const base = defaultSite(template, s.brief, siteId, now);
  const system = genSystem(template, now);
  const userMsg = `Brief:\n${JSON.stringify(s.brief)}\n\nẢnh đã tải lên: ${JSON.stringify(s.uploads)}\n\nNội dung tài liệu:\n${s.docsText || '(không có)'}`;
  const messages: Msg[] = [{ role: 'user', content: userMsg }];

  const force = (site: SiteJson): SiteJson =>
    sanitizeAssets({ ...site, siteId, template, demo: base.demo }, s.uploads);

  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    last = await call(deps, { system, messages, tool: EMIT_GEN });
    const parsed = GenOutSchema.safeParse(isObj(last) ? { ...last, site: isObj(last.site) ? { ...last.site, siteId, template, demo: base.demo } : last.site } : last);
    if (parsed.success) return { site: force(parsed.data.site), proposal: parsed.data.proposal, usedFallback: false };
    if (attempt === 0) {
      const err = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      messages.push({ role: 'assistant', content: JSON.stringify(last).slice(0, 4000) });
      messages.push({ role: 'user', content: `Kết quả chưa đúng schema (${err}). Hãy gọi lại emit_site với JSON đã sửa.` });
    }
  }
  const lastObj = isObj(last) ? last : {};
  const prop = ProposalSchema.safeParse(lastObj.proposal);
  return {
    site: force(mergeFallback(base, lastObj.site)),
    proposal: prop.success ? prop.data : fallbackProposal(deps, s.brief),
    usedFallback: true,
  };
}

/** Applies a customer's edit request. siteId/template/demo are kept from the original. On two invalid outputs returns the original unchanged. */
export async function reviseContent(deps: Deps, site: SiteJson, request: string, uploads: string[]): Promise<SiteJson> {
  const system = [
    'Bạn là chuyên gia thiết kế website. Nhận site.json hiện tại và yêu cầu chỉnh sửa của khách, gọi công cụ emit_site với site.json mới đầy đủ.',
    'Chỉ thay đổi những gì khách yêu cầu. Chữ hiển thị bằng tiếng Việt có dấu. Chỉ dùng ảnh trong danh sách đã tải lên hoặc URL https://.',
  ].join('\n');
  const messages: Msg[] = [{ role: 'user', content:
    `site.json hiện tại:\n${JSON.stringify(site)}\n\nẢnh đã tải lên: ${JSON.stringify(uploads)}\n\nYêu cầu của khách:\n${request.slice(0, 2000)}` }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await call(deps, { system, messages, tool: EMIT_REVISE });
    const raw = isObj(out) && isObj(out.site) ? out.site : null;
    const parsed = SiteSchema.safeParse(raw ? { ...raw, siteId: site.siteId, template: site.template, demo: site.demo } : out);
    if (parsed.success) return sanitizeAssets(parsed.data, uploads);
    if (attempt === 0) {
      const err = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      messages.push({ role: 'assistant', content: JSON.stringify(out).slice(0, 4000) });
      messages.push({ role: 'user', content: `Kết quả chưa đúng schema (${err}). Hãy gọi lại emit_site với JSON đã sửa.` });
    }
  }
  return site;
}
