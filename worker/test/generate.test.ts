import { describe, it, expect, vi } from 'vitest';
import { BriefV2Schema, SiteSchema, defaultSite, type SiteJson } from '@sme/schema';
import { makeTestDeps } from './fakes';
import { generateContent, reviseContent, RevisionFailedError, sanitizeAssets } from '../src/ai/generate';
import type { Session } from '../src/types';
import { getJson } from '../src/kv';
import { costToday } from '../src/ai/cost';
import { ClaudeError } from '../src/clients/claude';

const usage = { input_tokens: 1000, output_tokens: 200 };
const proposal = {
  summary: 's', problems: ['p'], solution: 'sol',
  packages: [{ name: 'Cơ bản', priceVnd: 10_000_000, items: ['x'] }],
  roadmap: [{ step: '1', desc: 'd' }],
};
const mkSession = (brief: any = {}): Session => ({
  id: 's1', ip: '1.1.1.1', createdAt: '2026-11-08T00:00:00Z', turns: 3,
  brief: BriefV2Schema.parse(brief), messages: [], uploads: ['assets/1-a.jpg'], docsText: '',
});
const fake = (outs: any[]) => {
  const callTool = vi.fn(async () => ({ input: outs[Math.min(callTool.mock.calls.length - 1, outs.length - 1)], usage }));
  return { callTool } as any;
};
const goodSite = (over: any = {}) => ({ ...defaultSite('tpl-gioi-thieu', BriefV2Schema.parse({ ten_don_vi: 'AI Name' }), 'x'), ...over });

describe('generateContent', () => {
  it('retries once after invalid output and uses the valid one', async () => {
    const claude = fake([{ site: { nope: 1 }, proposal }, { site: goodSite(), proposal }]);
    const deps = makeTestDeps({ claude });
    const r = await generateContent(deps, mkSession({ ten_don_vi: 'A' }), 'site1');
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
      demo: { badge: false } }, proposal: { bad: 1 } };
    const claude = fake([bad]);
    const deps = makeTestDeps({ claude });
    const r = await generateContent(deps, mkSession({ muc_tieu_chinh: 'gioi-thieu', ten_don_vi: 'A', lien_he: { phone: '0900000001' } }), 'site1');
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
    expect(r.proposal.packages[0].priceVnd).toBeGreaterThanOrEqual(10_000_000);
  });

  it('fallback keeps valid brand and valid sections, drops malformed section', async () => {
    const bad = { site: { brand: { name: 'Tốt', color: '#112233' },
      sections: [{ type: 'faq', items: 'not-array' }, { type: 'about', title: 'ok', body: 'b' }] }, proposal: {} };
    const r = await generateContent(makeTestDeps({ claude: fake([bad]) }), mkSession({ ten_don_vi: 'A' }), 's');
    expect(r.usedFallback).toBe(true);
    expect(r.site.brand.name).toBe('Tốt');
    expect(r.site.sections.map((x) => x.type)).toContain('about');
    expect(JSON.stringify(r.site.sections)).not.toContain('not-array');
  });

  it('fallback proposal filters sub-minimum packages unless allowTestPrice', async () => {
    const cfg = { ...makeTestDeps().config, packages: [
      { id: 'a', name: 'Rẻ', priceVnd: 500_000, items: ['i'] }, { id: 'b', name: 'Chuẩn', priceVnd: 12_000_000, items: ['i'] }] };
    let r = await generateContent(makeTestDeps({ claude: fake([{}]), config: cfg }), mkSession(), 's');
    expect(r.proposal.packages.map((p) => p.name)).toEqual(['Chuẩn']);
    r = await generateContent(makeTestDeps({ claude: fake([{}]), config: { ...cfg, allowTestPrice: true } }), mkSession(), 's');
    expect(r.proposal.packages.map((p) => p.name)).toEqual(['Rẻ', 'Chuẩn']);
  });

  it('chooses template by muc_tieu_chinh and ignores AI template', async () => {
    const cases: [string | undefined, string][] = [['thu-lead', 'tpl-thu-lead'], ['ban-hang', 'tpl-ban-hang'], ['gioi-thieu', 'tpl-gioi-thieu'], ['tim-dai-ly', 'tpl-thu-lead'], ['tuyen-dung', 'tpl-thu-lead'], [undefined, 'tpl-gioi-thieu']];
    for (const [nc, tpl] of cases) {
      const claude = fake([{ site: goodSite({ template: 'tpl-ban-hang' }), proposal }]);
      const r = await generateContent(makeTestDeps({ claude }), mkSession(nc ? { muc_tieu_chinh: nc } : {}), 's');
      expect(r.site.template).toBe(tpl);
      expect(claude.callTool.mock.calls[0][0].tool.name).toBe('emit_site');
      expect(claude.callTool.mock.calls[0][0].model).toBe('claude-sonnet-5-5');
    }
  });

  it('marks empty brief keys in brief.meta.auto and sets demo expiry', async () => {
    const s = mkSession({ muc_tieu_chinh: 'ban-hang', ten_don_vi: 'A' });
    const r = await generateContent(makeTestDeps({ claude: fake([{ site: goodSite(), proposal }]) }), s, 's');
    expect(s.brief.meta?.auto).toEqual(['loai_hinh', 'nganh', 'dia_phuong', 'san_pham', 'diem_khac_biet', 'khach_hang_muc_tieu', 'hanh_dong_mong_muon', 'cam_giac', 'lien_he.phone|zalo']);
    expect(r.site.demo).toEqual({ badge: true, expires: '2026-12-08', checkoutUrl: '' });
  });

  it('tells the AI the exact per-type section fields: tool schema + defaultSite skeleton in the prompt', async () => {
    const claude = fake([{ site: goodSite(), proposal }]);
    await generateContent(makeTestDeps({ claude }), mkSession({ muc_tieu_chinh: 'thu-lead', ten_don_vi: 'HTX Mây' }), 's');
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
    await expect(generateContent(deps, mkSession(), 's')).rejects.toBeInstanceOf(ClaudeError);
    expect(await costToday(deps)).toBe(1000 * 3 + 200 * 15);
  });

  it('drops unknown assets from generated site', async () => {
    const site = goodSite({ hero: { title: 't', subtitle: 's', cta: 'c', image: 'assets/9-khong-co.jpg' } });
    const r = await generateContent(makeTestDeps({ claude: fake([{ site, proposal }]) }), mkSession(), 's');
    expect(r.site.hero.image).toBeUndefined();
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
