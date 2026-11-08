import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  ProposalSchema, SectionSchema, SiteSchema, defaultSite, stepState, templateFor,
  type BriefV2 as Brief, type Proposal, type SiteJson, type TemplateId,
} from '@sme/schema';
import type { Deps, Msg, Session } from '../types';
import { recordUsage } from './cost';
import { ClaudeError } from '../clients/claude';

const GenOutSchema = z.object({ site: SiteSchema, proposal: ProposalSchema });
const EMIT_GEN = { name: 'emit_site', input_schema: zodToJsonSchema(GenOutSchema, { $refStrategy: 'none' }) as object };
const EMIT_REVISE = { name: 'emit_site', input_schema: zodToJsonSchema(z.object({ site: SiteSchema }), { $refStrategy: 'none' }) as object };

const MAX_TOKENS = 8000;
/** Per Claude call (retries included). */
export const GEN_CALL_TIMEOUT_MS = 120_000;
/** Whole generateContent budget: the validation retry only gets what is left (keeps a /run request under the client's 180s timeout). */
export const GEN_TOTAL_BUDGET_MS = 170_000;
const MIN_RETRY_MS = 20_000;

function genSystem(template: TemplateId, now: Date, skeleton: SiteJson): string {
  return [
    'Bạn là chuyên gia thiết kế website cho doanh nghiệp nhỏ và hợp tác xã Việt Nam.',
    'Từ phiếu yêu cầu (brief) và nội dung tài liệu khách gửi, hãy gọi công cụ emit_site để trả về site (site.json) và proposal (đề xuất triển khai).',
    `Template bắt buộc: ${template}; schemaVersion = 1. Mọi chữ hiển thị cho khách phải bằng tiếng Việt có dấu.`,
    'Chỉ dùng ảnh trong danh sách ảnh đã tải lên (đường dẫn assets/...) hoặc URL https://; không bịa đường dẫn ảnh.',
    'Các mục brief trống: hãy tự đề xuất nội dung hợp lý, đừng bịa số điện thoại, địa chỉ hay chứng nhận.',
    'site phải theo ĐÚNG cấu trúc khung dưới đây: giữ nguyên các loại section, thứ tự và TÊN TRƯỜNG (ví dụ products.items[].name/desc/price/image, '
      + 'faq.items[].q/a, testimonials.items[].text/name, countdown.endsAt, about.body). Không thêm trường khác; '
      + 'có thể thêm phần tử vào items/images và thay nội dung chữ. price là số nguyên VND.',
    `Khung site.json cần điền:\n${JSON.stringify(skeleton)}`,
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

export function fallbackProposal(deps: Deps, brief: Brief): Proposal {
  const { config } = deps;
  const name = brief.ten_don_vi?.trim() || 'đơn vị của bạn';
  const pkgs = config.packages
    .filter((p) => config.allowTestPrice || p.priceVnd >= 10_000_000)
    .map((p) => ({ name: p.name, priceVnd: p.priceVnd, items: p.items }));
  const goal = brief.thanh_cong_la_gi || 'giới thiệu và bán hàng hiệu quả hơn trên mạng';
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
    // keep each section that matches its per-type schema exactly (same contract the renderer reads)
    const secs = ai.sections.flatMap((x) => { const p = SectionSchema.safeParse(x); return p.success ? [p.data] : []; });
    if (secs.length) out.sections = secs;
  }
  out.siteId = base.siteId; out.template = base.template; out.demo = base.demo; out.schemaVersion = 1;
  const final = SiteSchema.safeParse(out);
  if (final.success) return final.data;
  // retry the overlay without sections before giving up on the AI parts
  const noSections = SiteSchema.safeParse({ ...out, sections: base.sections });
  return noSections.success ? noSections.data : base;
}

/** One GEN_MODEL call; the cost is recorded whenever Anthropic billed it (also on a reply without tool_use), before any throw. */
async function call<T>(deps: Deps, o: { system: string; messages: Msg[]; tool: { name: string; input_schema: object }; timeoutMs?: number }): Promise<unknown> {
  const model = deps.config.genModel;
  let out;
  try {
    out = await deps.claude.callTool<T>({ model, ...o, maxTokens: MAX_TOKENS, timeoutMs: o.timeoutMs ?? GEN_CALL_TIMEOUT_MS });
  } catch (e) {
    if (e instanceof ClaudeError) await recordUsage(deps, model, e.usage);
    throw e;
  }
  await recordUsage(deps, model, out.usage); // never throws
  return out.input;
}

/**
 * Generates site.json + proposal with one validated retry, then falls back to defaultSite merged with valid AI parts.
 * Side effect: sets `s.brief.meta.auto` to the BRIEF_KEYS that are empty at generation time (the caller must persist `s`).
 * Template is derived from `brief.muc_tieu_chinh` by code; siteId/template/demo always come from code.
 */
export async function generateContent(deps: Deps, s: Session, siteId: string)
  : Promise<{ site: SiteJson; proposal: Proposal; usedFallback: boolean }> {
  const missing = stepState(s.brief).missing;
  s.brief = { ...s.brief, meta: { ...(s.brief.meta ?? {}), auto: missing } };

  const template = templateFor(s.brief);
  const now = deps.now();
  const base = defaultSite(template, s.brief, siteId, now);
  const system = genSystem(template, now, { ...base, demo: { ...base.demo, checkoutUrl: '' } });
  const userMsg = `Brief:\n${JSON.stringify(s.brief)}\n\nẢnh đã tải lên: ${JSON.stringify(s.uploads)}\n\nNội dung tài liệu:\n${s.docsText || '(không có)'}`;
  const messages: Msg[] = [{ role: 'user', content: userMsg }];

  const force = (site: SiteJson): SiteJson =>
    sanitizeAssets({ ...site, siteId, template, demo: base.demo }, s.uploads);

  const started = Date.now();
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = GEN_TOTAL_BUDGET_MS - (Date.now() - started);
    if (attempt > 0 && left < MIN_RETRY_MS) break; // no time for a validated retry: merge what we have
    last = await call(deps, { system, messages, tool: EMIT_GEN, timeoutMs: Math.min(GEN_CALL_TIMEOUT_MS, left) });
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

export class RevisionFailedError extends Error {
  constructor() { super('revision failed validation'); this.name = 'RevisionFailedError'; }
}

/** Applies a customer's edit request. siteId/template/demo are kept from the original. Throws RevisionFailedError after two invalid outputs (so callers need not consume a revision). */
export async function reviseContent(deps: Deps, site: SiteJson, request: string, uploads: string[]): Promise<SiteJson> {
  const system = [
    'Bạn là chuyên gia thiết kế website. Nhận site.json hiện tại và yêu cầu chỉnh sửa của khách, gọi công cụ emit_site với site.json mới đầy đủ.',
    'Chỉ thay đổi những gì khách yêu cầu. Chữ hiển thị bằng tiếng Việt có dấu. Chỉ dùng ảnh trong danh sách đã tải lên hoặc URL https://.',
  ].join('\n');
  const messages: Msg[] = [{ role: 'user', content:
    `site.json hiện tại:\n${JSON.stringify(site)}\n\nẢnh đã tải lên: ${JSON.stringify(uploads)}\n\nYêu cầu của khách:\n${request.slice(0, 2000)}` }];
  const started = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = GEN_TOTAL_BUDGET_MS - (Date.now() - started);
    if (attempt > 0 && left < MIN_RETRY_MS) break;
    const out = await call(deps, { system, messages, tool: EMIT_REVISE, timeoutMs: Math.min(GEN_CALL_TIMEOUT_MS, left) });
    const raw = isObj(out) && isObj(out.site) ? out.site : null;
    const parsed = SiteSchema.safeParse(raw ? { ...raw, siteId: site.siteId, template: site.template, demo: site.demo } : out);
    if (parsed.success) return sanitizeAssets(parsed.data, uploads);
    if (attempt === 0) {
      const err = parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      messages.push({ role: 'assistant', content: JSON.stringify(out).slice(0, 4000) });
      messages.push({ role: 'user', content: `Kết quả chưa đúng schema (${err}). Hãy gọi lại emit_site với JSON đã sửa.` });
    }
  }
  throw new RevisionFailedError();
}
