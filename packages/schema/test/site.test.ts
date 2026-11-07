import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SectionSchemas, SiteSchema, TEMPLATE_IDS, SECTION_TYPES, defaultSite } from '../src/index';

describe('site', () => {
  it('13 section types', () => expect(SECTION_TYPES.length).toBe(13));
  for (const t of TEMPLATE_IDS) {
    it(`defaultSite passes for ${t}`, () => {
      const s = defaultSite(t, {}, 'x');
      expect(SiteSchema.safeParse(s).success).toBe(true);
      expect(s.demo.badge).toBe(true);
      expect(s.template).toBe(t);
    });
  }
  it('rejects bad color', () => {
    const s = defaultSite('tpl-gioi-thieu', {}, 'x');
    s.brand.color = 'red';
    expect(SiteSchema.safeParse(s).success).toBe(false);
  });
  it('rejects unknown section type', () => {
    const s: any = defaultSite('tpl-gioi-thieu', {}, 'x');
    s.sections.push({ type: 'video' });
    expect(SiteSchema.safeParse(s).success).toBe(false);
  });
  it('uses brief data', () => {
    const s = defaultSite('tpl-ban-hang', { ten_don_vi: 'HTX A', lien_he: { phone: '0912 345 678' } }, 'x');
    expect(s.brand.name).toBe('HTX A');
    expect(s.contact.phone).toBe('0912345678');
  });
});

describe('per-type section contract', () => {
  const site = (sections: unknown[]) => ({ ...defaultSite('tpl-gioi-thieu', {}, 'x'), sections });

  it('all template site.json and fixtures validate against the strict section schemas', () => {
    const root = resolve(__dirname, '../../../templates');
    const files = [
      ...readdirSync(join(root, 'fixtures')).filter((f) => f.endsWith('.json')).map((f) => join(root, 'fixtures', f)),
      ...TEMPLATE_IDS.map((t) => join(root, t, 'site.json')),
    ];
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const f of files) {
      const r = SiteSchema.safeParse(JSON.parse(readFileSync(f, 'utf8')));
      expect(r.success, `${f}: ${r.success ? '' : JSON.stringify(r.error.issues.slice(0, 3))}`).toBe(true);
    }
  });

  it('rejects natural field-name guesses the renderer would silently drop', () => {
    const bad = [
      { type: 'about', title: 't', content: 'x' },
      { type: 'products', title: 't', items: [{ name: 'a', description: 'b' }] },
      { type: 'faq', title: 't', items: [{ question: 'q', answer: 'a' }] },
      { type: 'testimonials', title: 't', items: [{ quote: 'hay', author: 'An' }] },
      { type: 'benefits', title: 't', items: [{ name: 'x', description: 'y' }] },
      { type: 'products', title: 't', items: [{ name: 'a', price: '150.000đ' }] },
    ];
    for (const sec of bad) expect(SiteSchema.safeParse(site([sec])).success, JSON.stringify(sec)).toBe(false);
  });

  it('accepts the exact renderer fields', () => {
    const good = [
      { type: 'about', title: 't', body: 'b', image: 'assets/1.jpg' },
      { type: 'products', title: 't', items: [{ name: 'a', desc: 'b', price: 1000, image: 'https://x/y.jpg' }] },
      { type: 'faq', title: 't', items: [{ q: 'q', a: 'a' }] },
      { type: 'testimonials', title: 't', items: [{ text: 'hay', name: 'An' }] },
      { type: 'countdown', title: 't', endsAt: '2026-12-31T00:00:00Z' },
      { type: 'gallery', title: 't', images: ['assets/1.jpg'] },
    ];
    expect(SiteSchema.safeParse(site(good)).success).toBe(true);
  });

  it('has a schema for every section type', () => {
    expect(Object.keys(SectionSchemas).sort()).toEqual([...SECTION_TYPES].sort());
  });
});
