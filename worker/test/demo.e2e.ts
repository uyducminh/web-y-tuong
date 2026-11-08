import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Fixture images (/fixtures/img/*.svg) become the seeded KV asset, as generated sites only reference assets/...
const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../templates/fixtures/${name}.json`, import.meta.url)), 'utf8')
    .replace(/\/fixtures\/img\/[a-z0-9]+\.svg/g, 'assets/1-anh.png'));
// 1x1 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const FULL_MARKER = 'FULL-MARKER-e2e-9q';

async function seed(page: Page, id: string, template: string, site: any, over: Record<string, unknown> = {}) {
  const meta = { siteId: id, phone: '0900000000', leadKey: 'k'.repeat(32), handoffKey: 'h'.repeat(32), template,
    expires: '2099-01-01T00:00:00.000Z', revisions: 0, createdAt: '2026-11-08T00:00:00.000Z', name: site.brand.name,
    analysisReady: true, ...over };
  const res = await page.request.post('/__test/seed', { data: { entries: [
    { key: `site:${id}`, value: meta },
    { key: `sitejson:${id}`, value: { ...site, siteId: id, template, hero: { ...site.hero, image: 'assets/1-anh.png' },
      demo: { badge: true, expires: '2099-01-01', checkoutUrl: '' } } },
    { key: `analysis:${id}`, value: { free: { summary: 'x' }, full: { secret: FULL_MARKER } } },
    { key: `asset:${id}:assets/1-anh.png`, value: { mime: 'image/png', base64: PNG } },
  ] } });
  expect(res.status()).toBe(200);
}

const cases = [
  { id: 'e2e-shop-aaaaaa', template: 'tpl-ban-hang', fixture: 'shop-dac-san' },
  { id: 'e2e-lead-bbbbbb', template: 'tpl-thu-lead', fixture: 'landing-hoi-thao' },
];

for (const c of cases) {
  for (const width of [375, 1280]) {
    test(`${c.template} renders at ${width}px with no console errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
      await seed(page, c.id, c.template, fixture(c.fixture));
      await page.setViewportSize({ width, height: 900 });
      const res = await page.goto(`/d/${c.id}`); // 301 → /d/<id>/
      expect(res!.status()).toBe(200);
      expect(new URL(page.url()).pathname).toBe(`/d/${c.id}/`);
      expect(res!.headers()['x-robots-tag']).toBe('noindex, nofollow');
      await expect(page.locator('main section.sec').nth(2)).toBeAttached();
      expect(await page.locator('section.sec').count()).toBeGreaterThanOrEqual(3);
      await expect(page.locator('.demo-badge a')).toHaveAttribute('href', `http://127.0.0.1:8799/package/${c.id}`);
      const hero = page.locator('img.hero-img');
      await expect(hero).toHaveAttribute('src', 'assets/1-anh.png');
      expect(await hero.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(1);
      expect(await page.content()).not.toContain(FULL_MARKER);
      expect(errors).toEqual([]);
    });
  }
}

test('expired unpaid demo shows the 410 page with the contact phone', async ({ page }) => {
  await seed(page, 'e2e-old-cccccc', 'tpl-ban-hang', fixture('shop-dac-san'), { expires: '2020-01-01T00:00:00.000Z' });
  const res = await page.goto('/d/e2e-old-cccccc/');
  expect(res!.status()).toBe(410);
  await expect(page.locator('h1')).toHaveText('Bản dùng thử đã hết hạn');
  await expect(page.locator('body')).toContainText('0912345678');
});

test('map section: the Google Maps iframe is not blocked by the /d/ CSP', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // No live network: answer the map embed locally; the CSP check happens before the request either way.
  await page.route('https://www.google.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>map</p>' }));
  await page.addInitScript(() => {
    (window as any).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await seed(page, 'e2e-map-dddddd', 'tpl-gioi-thieu', fixture('htx-ca-phe'));
  expect((await page.goto('/d/e2e-map-dddddd/'))!.status()).toBe(200);
  const frame = page.locator('section.sec-map iframe.map-frame');
  await expect(frame).toHaveAttribute('src', /^https:\/\/www\.google\.com\/maps\/embed/);
  await expect.poll(() => page.frames().some((f) => f.url().startsWith('https://www.google.com/maps/embed'))).toBe(true);
  await expect.poll(async () => page.frame({ url: /google\.com\/maps\/embed/ })?.locator('p').textContent()).toBe('map');
  expect(await page.evaluate(() => (window as any).__csp)).toEqual([]);
  expect(errors).toEqual([]);
});
