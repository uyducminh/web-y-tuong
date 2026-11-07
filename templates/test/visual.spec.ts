import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, normalize } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SiteSchema, TEMPLATE_IDS } from '@sme/schema';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = readdirSync(join(ROOT, 'fixtures')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
const SHOTS = join(ROOT, 'test/__shots__');
const VIEWPORTS = [{ name: '375', width: 375, height: 800 }, { name: '1280', width: 1280, height: 900 }];
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

let server: Server;
let base = '';

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  server = createServer((req, res) => {
    const path = decodeURIComponent((req.url || '/').split('?')[0]);
    // /<template>/site.json?fixture=<name> -> fixture served as that template's site.json
    const fx = new URL(req.url || '/', 'http://x').searchParams.get('fixture');
    let file: string;
    const m = /^\/(tpl-[a-z-]+)\/site\.json$/.exec(path);
    if (m && fx && FIXTURES.includes(fx)) {
      const site = JSON.parse(readFileSync(join(ROOT, 'fixtures', `${fx}.json`), 'utf8'));
      site.template = m[1];
      res.writeHead(200, { 'content-type': MIME['.json'] }).end(JSON.stringify(site));
      return;
    }
    file = normalize(join(ROOT, path.endsWith('/') ? path + 'index.html' : path));
    if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => { server.close(); });

test('every fixture passes SiteSchema.parse', () => {
  expect(FIXTURES.length).toBeGreaterThanOrEqual(5);
  for (const f of FIXTURES) {
    expect(() => SiteSchema.parse(JSON.parse(readFileSync(join(ROOT, 'fixtures', `${f}.json`), 'utf8'))), f).not.toThrow();
  }
});

for (const tpl of TEMPLATE_IDS) {
  for (const fixture of FIXTURES) {
    for (const vp of VIEWPORTS) {
      test(`${tpl} x ${fixture} @${vp.name}`, async ({ page }) => {
        const errors: string[] = [];
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('pageerror', (e) => errors.push(String(e)));
        // keep the suite offline: external embeds (maps) are stubbed
        await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>stub</p>' }));
        await page.setViewportSize({ width: vp.width, height: vp.height });
        // the page fetches 'site.json' relative to its URL, so the fixture rides in the query string via a route
        await page.route(`**/${tpl}/site.json`, (r) => r.continue({ url: `${base}/${tpl}/site.json?fixture=${fixture}` }));
        await page.goto(`${base}/${tpl}/`);
        await page.waitForSelector('.hero');
        await page.waitForLoadState('networkidle');

        expect(await page.locator('.boot-error').count()).toBe(0);
        expect(await page.locator('section:empty').count()).toBe(0);
        const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(vp.width + 1);
        await page.screenshot({ path: join(SHOTS, `${tpl}__${fixture}__${vp.name}.png`), fullPage: true });
        expect(errors).toEqual([]);
      });
    }
  }
}
