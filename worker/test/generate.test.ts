import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BriefV2Schema, SiteSchema, defaultSite, defaultAnalysis, AnalysisSchema, type SiteJson } from '@sme/schema';
import { makeTestDeps } from './fakes';
import { generatePackage, reviseContent, RevisionFailedError, sanitizeAssets } from '../src/ai/generate';
import type { Session } from '../src/types';
import { getJson } from '../src/kv';
import { costToday } from '../src/ai/cost';
import { ClaudeError } from '../src/clients/claude';

const usage = { input_tokens: 1000, output_tokens: 200 };
const analysis = defaultAnalysis(BriefV2Schema.parse({ ten_don_vi: 'AI Name' }));
const mkSession = (brief: any = {}): Session => ({
  id: 's1', ip: '1.1.1.1', createdAt: '2026-11-08T00:00:00Z', turns: 3,
  brief: BriefV2Schema.parse(brief), messages: [], uploads: ['assets/1-a.jpg'], docsText: '',
});
const fake = (outs: any[]) => {
  const callTool = vi.fn(async () => ({ input: outs[Math.min(callTool.mock.calls.length - 1, outs.length - 1)], usage }));
  return { callTool } as any;
};
const goodSite = (over: any = {}) => ({ ...defaultSite('tpl-gioi-thieu', BriefV2Schema.parse({ ten_don_vi: 'AI Name' }), 'x'), ...over });

describe('generatePackage', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('retries once after invalid output and uses the valid one', async () => {
    const claude = fake([{ site: { nope: 1 }, analysis }, { site: goodSite(), analysis }]);
    const deps = makeTestDeps({ claude });
    const r = await generatePackage(deps, mkSession({ ten_don_vi: 'A' }), 'site1');
    expect(claude.callTool).toHaveBeenCalledTimes(2);
    expect(r.usedFallback).toBe(false);
    expect(r.site.brand.name).toBe('AI Name');
    expect(r.site.siteId).toBe('site1');
    expect(SiteSchema.safeParse(r.site).success).toBe(true);
    expect(await costToday(deps)).toBe(2 * (1000 * 3 + 200 * 15));
  });

  it('falls back by merging valid AI parts into defaultSite', async () => {
    const bad = { site: { brand: { name: 'Tốt', color: '#112233' }, hero: { title: 1 }, contact: 5,
      sections: [{ type: 'faq', title: 'ok', items: [{ q: 'Q?', a: 'A' }] }, { type: 'faq', title: 'sai tên trường', items: [{ question: 'Q?', answer: 'A' }] },
        { type: 'testimonials', title: 'thiếu text', items: [{ quote: 'hay' }] }, { type: 'evil' }, 'x'], template: 'tpl-ban-hang', siteId: 'hack',
      demo: { badge: false } }, analysis: { bad: 1 } };
    const claude = fake([bad]);
    const deps = makeTestDeps({ claude });
    const r = await generatePackage(deps, mkSession({ muc_tieu_chinh: 'gioi-thieu', ten_don_vi: 'A', lien_he: { phone: '0900000001' } }), 'site1');
    expect(claude.callTool).toHaveBeenCalledTimes(2);
    expect(r.usedFallback).toBe(true);
    expect(SiteSchema.safeParse(r.site).success).toBe(true);
    expect(r.site.brand).toMatchObject({ name: 'Tốt', color: '#112233' });
    expect(r.site.hero.title).toBe('A');
    expect(r.site.contact.phone).toBe('0900000001');
    expect(r.site.sections).toEqual([{ type: 'faq', title: 'ok', items: [{ q: 'Q?', a: 'A' }] }]);
    expect(r.site.template).toBe('tpl-gioi-thieu');
    expect(r.site.siteId).toBe('site1');
    expect(r.site.demo.badge).toBe(true);
    expect(r.analysis).toEqual(defaultAnalysis(BriefV2Schema.parse({ muc_tieu_chinh: 'gioi-thieu', ten_don_vi: 'A', lien_he: { phone: '0900000001' } })));
  });

  it('fallback keeps valid brand and valid sections, drops malformed section', async () => {
    const bad = { site: { brand: { name: 'Tốt', color: '#112233' },
      sections: [{ type: 'faq', items: 'not-array' }, { type: 'about', title: 'ok', body: 'b' }] }, analysis: {} };
    const r = await generatePackage(makeTestDeps({ claude: fake([bad]) }), mkSession({ ten_don_vi: 'A' }), 's');
    expect(r.usedFallback).toBe(true);
    expect(r.site.brand.name).toBe('Tốt');
    expect(r.site.sections.map((x) => x.type)).toContain('about');
    expect(JSON.stringify(r.site.sections)).not.toContain('not-array');
  });

  it('chooses template by muc_tieu_chinh and ignores AI template', async () => {
    const cases: [string | undefined, string][] = [['thu-lead', 'tpl-thu-lead'], ['ban-hang', 'tpl-ban-hang'], ['gioi-thieu', 'tpl-gioi-thieu'], ['tim-dai-ly', 'tpl-thu-lead'], ['tuyen-dung', 'tpl-thu-lead'], [undefined, 'tpl-gioi-thieu']];
    for (const [nc, tpl] of cases) {
      const claude = fake([{ site: goodSite({ template: 'tpl-ban-hang' }), analysis }]);
      const r = await generatePackage(makeTestDeps({ claude }), mkSession(nc ? { muc_tieu_chinh: nc } : {}), 's');
      expect(r.site.template).toBe(tpl);
      expect(claude.callTool.mock.calls[0][0].tool.name).toBe('emit_package');
      expect(claude.callTool.mock.calls[0][0].model).toBe('claude-sonnet-5-5');
    }
  });

  it('marks empty brief keys in brief.meta.auto and sets demo expiry', async () => {
    const s = mkSession({ muc_tieu_chinh: 'ban-hang', ten_don_vi: 'A' });
    const r = await generatePackage(makeTestDeps({ claude: fake([{ site: goodSite(), analysis }]) }), s, 's');
    expect(s.brief.meta?.auto).toEqual(['loai_hinh', 'nganh', 'dia_phuong', 'san_pham', 'diem_khac_biet', 'khach_hang_muc_tieu', 'hanh_dong_mong_muon', 'cam_giac', 'lien_he.phone|zalo']);
    expect(r.site.demo).toEqual({ badge: true, expires: '2026-12-08', checkoutUrl: '' });
  });

  it('tells the AI the exact per-type section fields: tool schema + defaultSite skeleton in the prompt', async () => {
    const claude = fake([{ site: goodSite(), analysis }]);
    await generatePackage(makeTestDeps({ claude }), mkSession({ muc_tieu_chinh: 'thu-lead', ten_don_vi: 'HTX Mây' }), 's');
    const arg = claude.callTool.mock.calls[0][0];
    const schema = JSON.stringify(arg.tool.input_schema);
    for (const f of ['"desc"', '"price"', '"q"', '"a"', '"text"', '"endsAt"', '"body"', '"images"', '"button"']) expect(schema).toContain(f);
    expect(schema).toContain('"additionalProperties":false');
    expect(arg.system).toContain('Khung site.json');
    expect(arg.system).toContain('"type":"lead_form"');
    expect(arg.system).toContain('"type":"faq","title":"Câu hỏi thường gặp","items":[{"q":');
    expect(arg.system).toContain('HTX Mây');
  });

  it('records the cost of a billed reply without tool_use before falling back', async () => {
    const callTool = vi.fn(async () => { throw new ClaudeError('Claude returned no tool_use block', false, usage); });
    const deps = makeTestDeps({ claude: { callTool } as any });
    const r = await generatePackage(deps, mkSession(), 's');
    expect(r.usedFallback).toBe(true);
    expect(await costToday(deps)).toBe(2 * (1000 * 3 + 200 * 15));
  });

  it('drops unknown assets from generated site', async () => {
    const site = goodSite({ hero: { title: 't', subtitle: 's', cta: 'c', image: 'assets/9-khong-co.jpg' } });
    const r = await generatePackage(makeTestDeps({ claude: fake([{ site, analysis }]) }), mkSession(), 's');
    expect(r.site.hero.image).toBeUndefined();
  });
  it('analysis invalid but site valid: keeps AI site, uses defaultAnalysis', async () => {
    const b = { ten_don_vi: 'A' };
    const r = await generatePackage(makeTestDeps({ claude: fake([{ site: goodSite(), analysis: { free: 1 } }]) }), mkSession(b), 's');
    expect(r.site.brand.name).toBe('AI Name');
    expect(r.analysis).toEqual(defaultAnalysis(BriefV2Schema.parse(b)));
    expect(AnalysisSchema.safeParse(r.analysis).success).toBe(true);
  });

  it('attempt 1 invalid schema then attempt 2 times out: keeps attempt-1 valid parts, bills both', async () => {
    const first = { site: { brand: { name: 'Giữ lại', color: '#112233' }, hero: { title: 1 },
      sections: [{ type: 'faq', title: 'ok', items: [{ q: 'Q?', a: 'A' }] }, { type: 'faq', items: 'x' }] }, analysis: {} };
    let n = 0;
    const callTool = vi.fn(async () => { if (n++ === 0) return { input: first, usage }; throw new ClaudeError('timeout', true, usage); });
    const deps = makeTestDeps({ claude: { callTool } as any });
    const r = await generatePackage(deps, mkSession({ ten_don_vi: 'A' }), 's');
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(r.usedFallback).toBe(true);
    expect(r.site.brand).toMatchObject({ name: 'Giữ lại', color: '#112233' });
    expect(r.site.sections).toEqual([{ type: 'faq', title: 'ok', items: [{ q: 'Q?', a: 'A' }] }]);
    expect(await costToday(deps)).toBe(2 * (1000 * 3 + 200 * 15));
  });

  it('attempt 2 returns no site object: keeps attempt-1 brand and sections', async () => {
    const first = { site: { brand: { name: 'Giữ lại', color: '#112233' }, hero: { title: 1 },
      sections: [{ type: 'faq', title: 'ok', items: [{ q: 'Q?', a: 'A' }] }] }, analysis: {} };
    const r = await generatePackage(makeTestDeps({ claude: fake([first, { analysis }]) }), mkSession({ ten_don_vi: 'A' }), 's');
    expect(r.usedFallback).toBe(true);
    expect(r.site.brand).toMatchObject({ name: 'Giữ lại', color: '#112233' });
    expect(r.site.sections).toEqual([{ type: 'faq', title: 'ok', items: [{ q: 'Q?', a: 'A' }] }]);
  });

  it('site stays invalid but attempt-1 analysis is valid: keeps that analysis', async () => {
    const custom = { ...analysis, free: { ...analysis.free, tom_tat_doanh_nghiep: 'AI viết riêng' } };
    const r = await generatePackage(makeTestDeps({ claude: fake([{ site: { nope: 1 }, analysis: custom }, { site: { nope: 2 } }]) }), mkSession({ ten_don_vi: 'A' }), 's');
    expect(r.usedFallback).toBe(true);
    expect(r.analysis.free.tom_tat_doanh_nghiep).toBe('AI viết riêng');
  });

  it('both attempts throw: defaultSite + defaultAnalysis, no throw', async () => {
    const callTool = vi.fn(async () => { throw new ClaudeError('down', true, usage); });
    const b = { ten_don_vi: 'A' };
    const s = mkSession(b);
    const r = await generatePackage(makeTestDeps({ claude: { callTool } as any }), s, 'sid');
    expect(r.usedFallback).toBe(true);
    expect(r.site).toEqual(defaultSite('tpl-gioi-thieu', s.brief, 'sid', new Date('2026-11-08T00:00:00Z')));
    expect(r.analysis).toEqual(defaultAnalysis(s.brief));
  });

  it('puts san_pham list, skeleton and docsText in the prompt', async () => {
    const claude = fake([{ site: goodSite(), analysis }]);
    const s = mkSession({ muc_tieu_chinh: 'ban-hang', ten_don_vi: 'A', san_pham: [{ ten: 'Cà phê rang', gia: 180000 }, { ten: 'Mật ong' }] });
    s.docsText = 'x'.repeat(20_000);
    await generatePackage(makeTestDeps({ claude }), s, 's');
    const arg = claude.callTool.mock.calls[0][0];
    expect(arg.tool.name).toBe('emit_package');
    expect(Object.keys(arg.tool.input_schema.properties).sort()).toEqual(['analysis', 'site']);
    const user = arg.messages[0].content as string;
    expect(user).toContain('- Cà phê rang — 180000');
    expect(user).toContain('- Mật ong');
    expect(user).toContain('x'.repeat(20_000));
    expect(arg.system).toContain(JSON.stringify(defaultSite('tpl-ban-hang', s.brief, 's', new Date('2026-11-08T00:00:00Z')).sections[0]).slice(0, 20));
  });
});

describe('sanitizeAssets', () => {
  it('drops unknown assets, keeps uploads and https URLs, recursive', () => {
    const site = goodSite({
      brand: { name: 'a', color: '#000000', logo: 'assets/1-a.jpg' },
      hero: { title: 't', subtitle: 's', cta: 'c', image: 'assets/9-khong-co.jpg' },
      sections: [{ type: 'products', items: [{ name: 'n', image: 'https://x.test/a.png' }, { name: 'm', image: 'assets/zz.png' }, { name: 'o', image: '../evil.png' }] },
        { type: 'gallery', images: ['assets/1-a.jpg', 'assets/nope.jpg'] }],
    }) as SiteJson;
    const out: any = sanitizeAssets(site, ['assets/1-a.jpg']);
    expect(out.hero.image).toBeUndefined();
    expect(out.brand.logo).toBe('assets/1-a.jpg');
    expect(out.sections[0].items[0].image).toBe('https://x.test/a.png');
    expect(out.sections[0].items[1].image).toBeUndefined();
    expect(out.sections[0].items[2].image).toBeUndefined();
    expect(out.sections[1].images).toEqual(['assets/1-a.jpg']);
    expect(site.hero.image).toBe('assets/9-khong-co.jpg'); // input not mutated
  });
});

describe('reviseContent', () => {
  it('keeps siteId, template and demo from the original', async () => {
    const orig = { ...defaultSite('tpl-thu-lead', BriefV2Schema.parse({ ten_don_vi: 'A' }), 'keep', new Date('2026-11-08')), demo: { badge: true, expires: '2026-12-01', checkoutUrl: 'https://pay' } };
    const claude = fake([{ site: { ...orig, siteId: 'other', template: 'tpl-ban-hang', demo: { badge: false, expires: '2030-01-01', checkoutUrl: '' }, brand: { name: 'Mới', color: '#abcdef' } } }]);
    const r = await reviseContent(makeTestDeps({ claude }), orig, 'đổi tên', []);
    expect(r.siteId).toBe('keep');
    expect(r.template).toBe('tpl-thu-lead');
    expect(r.demo).toEqual(orig.demo);
    expect(r.brand.name).toBe('Mới');
  });
  it('throws RevisionFailedError when output invalid after retry', async () => {
    const orig = defaultSite('tpl-ban-hang', BriefV2Schema.parse({}), 'k', new Date('2026-11-08'));
    const claude = fake([{ site: { junk: 1 } }]);
    await expect(reviseContent(makeTestDeps({ claude }), orig, 'x', [])).rejects.toBeInstanceOf(RevisionFailedError);
    expect(claude.callTool).toHaveBeenCalledTimes(2);
  });
});
