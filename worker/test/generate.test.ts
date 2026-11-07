import { describe, it, expect, vi } from 'vitest';
import { BriefSchema, SiteSchema, defaultSite, type SiteJson } from '@sme/schema';
import { makeTestDeps } from './fakes';
import { generateContent, reviseContent, RevisionFailedError, sanitizeAssets } from '../src/ai/generate';
import type { Session } from '../src/types';
import { getJson } from '../src/kv';

const usage = { input_tokens: 1000, output_tokens: 200 };
const proposal = {
  summary: 's', problems: ['p'], solution: 'sol',
  packages: [{ name: 'Cơ bản', priceVnd: 10_000_000, items: ['x'] }],
  roadmap: [{ step: '1', desc: 'd' }],
};
const mkSession = (brief: any = {}): Session => ({
  id: 's1', ip: '1.1.1.1', createdAt: '2026-11-08T00:00:00Z', turns: 3,
  brief: BriefSchema.parse(brief), messages: [], uploads: ['assets/1-a.jpg'], docsText: '',
});
const fake = (outs: any[]) => {
  const callTool = vi.fn(async () => ({ input: outs[Math.min(callTool.mock.calls.length - 1, outs.length - 1)], usage }));
  return { callTool } as any;
};
const goodSite = (over: any = {}) => ({ ...defaultSite('tpl-gioi-thieu', BriefSchema.parse({ ten_don_vi: 'AI Name' }), 'x'), ...over });

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
    expect(await getJson<number>(deps.kv, 'cost:20261108')).toBe(2 * (1000 * 3 + 200 * 15));
  });

  it('falls back by merging valid AI parts into defaultSite', async () => {
    const bad = { site: { brand: { name: 'Tốt', color: '#112233' }, hero: { title: 1 }, contact: 5,
      sections: [{ type: 'faq', title: 'ok' }, { type: 'evil' }, 'x'], template: 'tpl-ban-hang', siteId: 'hack',
      demo: { badge: false } }, proposal: { bad: 1 } };
    const claude = fake([bad]);
    const deps = makeTestDeps({ claude });
    const r = await generateContent(deps, mkSession({ nhu_cau: 'gioi-thieu', ten_don_vi: 'A', lien_he: { phone: '0900000001' } }), 'site1');
    expect(claude.callTool).toHaveBeenCalledTimes(2);
    expect(r.usedFallback).toBe(true);
    expect(SiteSchema.safeParse(r.site).success).toBe(true);
    expect(r.site.brand).toMatchObject({ name: 'Tốt', color: '#112233' });
    expect(r.site.hero.title).toBe('A');
    expect(r.site.contact.phone).toBe('0900000001');
    expect(r.site.sections).toEqual([{ type: 'faq', title: 'ok' }]);
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

  it('chooses template by nhu_cau and ignores AI template', async () => {
    const cases: [string | undefined, string][] = [['thu-lead', 'tpl-thu-lead'], ['ban-hang', 'tpl-ban-hang'], ['gioi-thieu', 'tpl-gioi-thieu'], ['khac', 'tpl-gioi-thieu'], [undefined, 'tpl-gioi-thieu']];
    for (const [nc, tpl] of cases) {
      const claude = fake([{ site: goodSite({ template: 'tpl-ban-hang' }), proposal }]);
      const r = await generateContent(makeTestDeps({ claude }), mkSession(nc ? { nhu_cau: nc } : {}), 's');
      expect(r.site.template).toBe(tpl);
      expect(claude.callTool.mock.calls[0][0].tool.name).toBe('emit_site');
      expect(claude.callTool.mock.calls[0][0].model).toBe('claude-sonnet-5-5');
    }
  });

  it('marks empty brief keys in brief.meta.auto and sets demo expiry', async () => {
    const s = mkSession({ nhu_cau: 'ban-hang', ten_don_vi: 'A' });
    const r = await generateContent(makeTestDeps({ claude: fake([{ site: goodSite(), proposal }]) }), s, 's');
    expect(s.brief.meta?.auto).toEqual(['nganh', 'san_pham_chinh', 'khach_hang_muc_tieu', 'diem_manh', 'lien_he', 'mau_sac', 'muc_tieu_web', 'tham_khao']);
    expect(r.site.demo).toEqual({ badge: true, expires: '2026-12-08', checkoutUrl: '' });
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
    const orig = { ...defaultSite('tpl-thu-lead', BriefSchema.parse({ ten_don_vi: 'A' }), 'keep', new Date('2026-11-08')), demo: { badge: true, expires: '2026-12-01', checkoutUrl: 'https://pay' } };
    const claude = fake([{ site: { ...orig, siteId: 'other', template: 'tpl-ban-hang', demo: { badge: false, expires: '2030-01-01', checkoutUrl: '' }, brand: { name: 'Mới', color: '#abcdef' } } }]);
    const r = await reviseContent(makeTestDeps({ claude }), orig, 'đổi tên', []);
    expect(r.siteId).toBe('keep');
    expect(r.template).toBe('tpl-thu-lead');
    expect(r.demo).toEqual(orig.demo);
    expect(r.brand.name).toBe('Mới');
  });
  it('throws RevisionFailedError when output invalid after retry', async () => {
    const orig = defaultSite('tpl-ban-hang', BriefSchema.parse({}), 'k', new Date('2026-11-08'));
    const claude = fake([{ site: { junk: 1 } }]);
    await expect(reviseContent(makeTestDeps({ claude }), orig, 'x', [])).rejects.toBeInstanceOf(RevisionFailedError);
    expect(claude.callTool).toHaveBeenCalledTimes(2);
  });
});
