import type { SiteJson } from '@sme/schema';
import type { Deps, SiteMeta } from '../types';
import { getJson, putJson } from '../kv';
import { assetKey, packageUrl, trialGone } from '../sites';
import { demoHtml, goneHtml, notFoundHtml } from '../static/templates';
import { errorJson, json, readJson } from '../http';

export const DEMO_PATH = /^\/d\/([a-z0-9-]{1,64})(\/.*)?$/;
const ASSET_FILE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export const DEMO_CSP = "default-src 'self'; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'";

const DEMO_HEADERS = { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

function demoRes(body: BodyInit | null, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...DEMO_HEADERS, ...headers } });
}
const html = (body: string, status: number) =>
  demoRes(body, status, { 'content-type': 'text/html; charset=utf-8', 'Content-Security-Policy': DEMO_CSP });
const notFound = () => html(notFoundHtml, 404);

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * `GET /d/:siteId[/...]` — the self-hosted demo. The page lives at `/d/<id>/` (trailing slash) so render.js's relative
 * `site.json` and the site's `assets/...` images resolve under `/d/<id>/`; `/d/<id>` is a 301 to it.
 * Only `sitejson:` and `asset:` are read here: `analysis:` (and its `full` part) never is.
 */
export async function getDemo(deps: Deps, path: string): Promise<Response> {
  const m = DEMO_PATH.exec(path);
  if (!m) return notFound();
  const [, siteId, rest] = m;
  if (rest === undefined) return demoRes(null, 301, { Location: `/d/${siteId}/` });

  const isPage = rest === '/';
  const isSiteJson = rest === '/site.json';
  const file = rest.startsWith('/assets/') ? rest.slice('/assets/'.length) : null;
  if (!isPage && !isSiteJson && !(file !== null && ASSET_FILE.test(file) && !file.includes('..'))) return notFound();

  const meta = await getJson<SiteMeta>(deps.kv, `site:${siteId}`);
  if (!meta) return notFound();
  if (await trialGone(deps, meta)) return html(goneHtml(deps.config), 410);

  if (isPage) return html(demoHtml(meta.template, { leadEndpoint: deps.config.apiBase, platformName: deps.config.platformName }), 200);

  if (isSiteJson) {
    const site = await getJson<SiteJson>(deps.kv, `sitejson:${siteId}`);
    if (!site) return demoRes(JSON.stringify({ error: 'Không tìm thấy nội dung website.' }), 404, { 'content-type': 'application/json; charset=utf-8' });
    const out = { ...site, demo: { ...site.demo, checkoutUrl: packageUrl(deps.config, siteId) } };
    return demoRes(JSON.stringify(out), 200, { 'content-type': 'application/json; charset=utf-8' });
  }

  const asset = await getJson<{ mime: string; base64: string }>(deps.kv, assetKey(siteId, `assets/${file}`));
  if (!asset || typeof asset.base64 !== 'string' || !/^image\/(jpeg|png|webp)$/.test(asset.mime)) return notFound();
  return demoRes(b64ToBytes(asset.base64), 200, { 'content-type': asset.mime, 'X-Content-Type-Options': 'nosniff' });
}

/**
 * `POST /__test/seed` — e2e only. index.ts registers it ONLY when config.allowTestSeed (env ALLOW_TEST_SEED === '1',
 * never in wrangler.toml). Body `{ entries: [{ key, value }] }`; string values are stored as-is, others as JSON.
 */
export async function postTestSeed(req: Request, deps: Deps): Promise<Response> {
  if (!deps.config.allowTestSeed) return errorJson(404, 'Không tìm thấy đường dẫn này.');
  const body = await readJson<{ entries?: { key?: unknown; value?: unknown }[] }>(req);
  if (!body || !Array.isArray(body.entries)) return errorJson(400, 'entries required');
  for (const e of body.entries) {
    if (typeof e.key !== 'string' || !e.key) return errorJson(400, 'bad key');
    if (typeof e.value === 'string') await deps.kv.put(e.key, e.value);
    else await putJson(deps.kv, e.key, e.value);
  }
  return json({ ok: true, n: body.entries.length });
}
