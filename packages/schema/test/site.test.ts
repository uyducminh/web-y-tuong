import { describe, it, expect } from 'vitest';
import { SiteSchema, TEMPLATE_IDS, SECTION_TYPES, defaultSite } from '../src/index';

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
