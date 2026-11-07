// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { defaultSite, formatVnd, SECTION_TYPES, TEMPLATE_IDS } from '@sme/schema';
// @ts-ignore plain JS module
import { renderSite, safeUrl, formatVnd as jsFormatVnd, sections } from '../_shared/render.js';

const brief: any = { ten_don_vi: 'HTX Test', san_pham_chinh: 'Cà phê', lien_he: { phone: '0912345678', zalo: '0912345678', address: 'Đà Lạt' } };
const base: any = defaultSite('tpl-gioi-thieu', brief, 'site1', new Date('2026-11-08'));
const withProducts = (items: any[]) => ({ ...base, sections: [{ type: 'products', title: 'Sản phẩm', items }] });
let root: HTMLElement;
beforeEach(() => { document.body.innerHTML = '<div id="r"></div>'; root = document.getElementById('r')!; });

describe('safeUrl', () => {
  it('blocks dangerous schemes', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl(' JaVa\tScript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,x')).toBeNull();
    expect(safeUrl('//evil.com/x')).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
  });
  it('allows safe urls', () => {
    expect(safeUrl('https://zalo.me/0912345678')).toBe('https://zalo.me/0912345678');
    expect(safeUrl('tel:0912345678')).toBe('tel:0912345678');
    expect(safeUrl('mailto:a@b.vn')).toBe('mailto:a@b.vn');
    expect(safeUrl('assets/logo.png')).toBe('assets/logo.png');
  });
});

describe('formatVnd', () => {
  it('matches @sme/schema', () => {
    for (const n of [0, 5, 999, 1000, 180000, 10000000, 1234567.6]) expect(jsFormatVnd(n)).toBe(formatVnd(n));
  });
});

describe('renderSite', () => {
  it('escapes customer text', () => {
    renderSite({ ...base, hero: { title: '<img src=x onerror=alert(1)>', subtitle: '', cta: 'Liên hệ' } }, root);
    expect(root.querySelector('img[onerror]')).toBeNull();
    expect(root.textContent).toContain('<img src=x');
  });
  it('hides broken images', () => {
    renderSite({ ...base, hero: { ...base.hero, image: 'assets/hero.jpg' } }, root);
    const img = root.querySelector('.hero img') as HTMLImageElement;
    expect(img.getAttribute('loading')).toBe('lazy');
    img.dispatchEvent(new Event('error'));
    expect(img.hidden).toBe(true);
  });
  it('drops unsafe image urls', () => {
    renderSite({ ...base, hero: { ...base.hero, image: 'javascript:alert(1)' } }, root);
    expect(root.querySelector('.hero img')).toBeNull();
  });
  it('formats prices', () => {
    renderSite(withProducts([{ name: 'Cà phê', price: 180000 }]), root);
    expect(root.textContent).toContain('180.000đ');
  });
  it('shows demo badge only when enabled', () => {
    renderSite(base, root);
    expect(root.querySelector('.demo-badge')).not.toBeNull();
    renderSite({ ...base, demo: { ...base.demo, badge: false } }, root);
    expect(root.querySelector('.demo-badge')).toBeNull();
  });
  it('checkout link only if safe', () => {
    renderSite({ ...base, demo: { ...base.demo, checkoutUrl: 'https://pay.example/x' } }, root);
    expect(root.querySelector('.demo-badge a')!.getAttribute('href')).toBe('https://pay.example/x');
    renderSite({ ...base, demo: { ...base.demo, checkoutUrl: 'javascript:1' } }, root);
    expect(root.querySelector('.demo-badge a')).toBeNull();
  });
  it('unknown section types do not throw', () => {
    expect(() => renderSite({ ...base, sections: [{ type: 'unknown' }, { type: 'products' }, null] }, root)).not.toThrow();
    expect(root.querySelectorAll('.sec').length).toBe(0);
  });
  it('lead form has honeypot and posts JSON', async () => {
    const site = defaultSite('tpl-thu-lead', brief, 'abc', new Date('2026-11-08'));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    renderSite(site, root, { leadEndpoint: 'https://w.example' });
    expect(root.querySelector('form[data-lead] input[name=website]')).not.toBeNull();
    const form = root.querySelector('form[data-lead]') as HTMLFormElement;
    (form.querySelector('[name=name]') as HTMLInputElement).value = 'An';
    (form.querySelector('[name=phone]') as HTMLInputElement).value = '0912345678';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock.mock.calls[0][0]).toBe('https://w.example/lead/abc');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ name: 'An', phone: '0912345678', website: '' });
    expect(root.textContent).toContain('Đã gửi, chúng tôi sẽ liên hệ sớm');
    vi.unstubAllGlobals();
  });
  it('order button opens zalo and copies order', async () => {
    const site = defaultSite('tpl-ban-hang', brief, 'x', new Date('2026-11-08'));
    (site.sections[0] as any).items = [{ name: 'Cà phê', price: 180000 }];
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const open = vi.fn(); vi.stubGlobal('open', open);
    renderSite(site, root);
    (root.querySelector('.sec-order_zalo button') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(open.mock.calls[0][0]).toBe('https://zalo.me/0912345678');
    expect(writeText.mock.calls[0][0]).toContain('Cà phê');
    vi.unstubAllGlobals();
  });
  it('sets brand color, title and og tags', () => {
    renderSite({ ...base, brand: { ...base.brand, color: '#112233' }, seo: { title: 'T <b>', description: 'D' } }, root);
    expect(document.documentElement.style.getPropertyValue('--brand')).toBe('#112233');
    expect(document.title).toBe('T <b>');
    expect(document.querySelector('meta[property="og:title"]')!.getAttribute('content')).toBe('T <b>');
    expect(document.querySelector('meta[property="og:description"]')!.getAttribute('content')).toBe('D');
  });
  it('ignores invalid brand color', () => {
    document.documentElement.style.removeProperty('--brand');
    renderSite({ ...base, brand: { ...base.brand, color: 'red;}body{display:none' } }, root);
    expect(document.documentElement.style.getPropertyValue('--brand')).not.toContain('red');
  });
  it('re-render replaces content', () => {
    renderSite(base, root); renderSite(base, root);
    expect(root.querySelectorAll('.hero').length).toBe(1);
  });
  it('every template default renders non-empty sections only', () => {
    for (const t of TEMPLATE_IDS) {
      renderSite(defaultSite(t, brief, 's', new Date('2026-11-08')), root);
      for (const s of root.querySelectorAll('.sec')) expect(s.children.length).toBeGreaterThan(1);
      expect(root.querySelector('.hero')).not.toBeNull();
    }
  });
  it('has a renderer for each known section type', () => {
    for (const t of SECTION_TYPES) expect(typeof sections[t]).toBe('function');
  });
  it('renders faq, countdown, benefits, gallery, certs, testimonials, map', () => {
    renderSite({ ...base, sections: [
      { type: 'faq', title: 'FAQ', items: [{ q: 'Q1?', a: 'A1' }] },
      { type: 'countdown', title: 'CD', endsAt: '2099-01-01T00:00:00Z' },
      { type: 'benefits', title: 'B', items: [{ title: 'bt', desc: 'bd' }] },
      { type: 'gallery', title: 'G', images: ['a.jpg', 'javascript:x'] },
      { type: 'certs', title: 'C', items: [{ name: 'VietGAP' }] },
      { type: 'testimonials', title: 'T', items: [{ name: 'Lan', text: 'Tốt' }] },
      { type: 'map', title: 'M', },
    ] }, root);
    expect(root.querySelector('.sec-faq details')).not.toBeNull();
    expect(root.querySelector('.sec-countdown .cd')).not.toBeNull();
    expect(root.querySelectorAll('.sec-gallery img').length).toBe(1);
    expect(root.textContent).toContain('VietGAP');
    expect(root.textContent).toContain('Lan');
    expect(root.querySelector('.sec-map')).not.toBeNull(); // falls back to address
    vi.clearAllTimers();
  });
  it('map iframe only for https embed', () => {
    renderSite({ ...base, contact: { ...base.contact, mapEmbed: 'https://www.google.com/maps/embed?pb=1' }, sections: [{ type: 'map' }] }, root);
    expect(root.querySelector('.sec-map iframe')).not.toBeNull();
    renderSite({ ...base, contact: { ...base.contact, mapEmbed: 'javascript:1', address: '' }, sections: [{ type: 'map' }] }, root);
    expect(root.querySelector('.sec-map')).toBeNull();
  });
});
