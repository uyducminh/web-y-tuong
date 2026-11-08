import type { Analysis, BriefV2, SiteJson } from '@sme/schema';
import type { Deps, SiteMeta } from '../types';
import { getJson } from '../kv';
import { analysisKey, briefKey, demoUrl, isPaid, TRIAL_GONE, trialGone } from '../sites';
import { escapeHtml, goneHtml, notFoundHtml } from '../static/templates';
import { PACKAGE_FILES } from '../static/templates.gen';
import { sellablePackages } from './checkout';
import { demoRes } from './demo';

const SITE_ID = /^[a-z0-9-]{1,64}$/;
export const PACKAGE_PATH = /^\/package\/([a-z0-9-]{1,64})$/;
export const API_PACKAGE_PATH = /^\/api\/package\/([a-z0-9-]{1,64})$/;

/**
 * The package page loads html2canvas (cdnjs) and docx (jsdelivr) lazily, frames the same-origin /d/<id>/ demo to
 * screenshot it, and shows blob:/data: images. No inline script.
 */
export const PACKAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "frame-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

const html = (body: string, status: number) =>
  demoRes(body, status, { 'content-type': 'text/html; charset=utf-8', 'Content-Security-Policy': PACKAGE_CSP });
const jsonRes = (data: unknown, status = 200) =>
  demoRes(JSON.stringify(data), status, { 'content-type': 'application/json; charset=utf-8' });

const STATIC: Record<string, { body: string; type: string }> = {
  '/package/_/package.js': { body: PACKAGE_FILES.js, type: 'text/javascript; charset=utf-8' },
  '/package/_/package.css': { body: PACKAGE_FILES.css, type: 'text/css; charset=utf-8' },
};

/** `GET /package/:siteId` (the page) and `GET /package/_/package.{js,css}` (its static files). */
export async function getPackagePage(deps: Deps, path: string): Promise<Response> {
  const file = STATIC[path];
  if (file) return demoRes(file.body, 200, { 'content-type': file.type, 'X-Content-Type-Options': 'nosniff' });
  const m = PACKAGE_PATH.exec(path);
  if (!m) return html(notFoundHtml, 404);
  const meta = await getJson<SiteMeta>(deps.kv, `site:${m[1]}`);
  if (!meta) return html(notFoundHtml, 404);
  if (await trialGone(deps, meta)) return html(goneHtml(deps.config), 410);
  // The page is static: data (and `full`, only if paid) comes from /api/package/:id, rendered with textContent.
  return html(PACKAGE_FILES.html.split('{{PLATFORM}}').join(escapeHtml(deps.config.platformName)), 200);
}

/**
 * `GET /api/package/:siteId` → `{ site:{name, expires, paid}, demoUrl, analysis:{free, full?}|null, packages }`.
 * `full` is included ONLY when `paid:<siteId>` exists (isPaid); the query string is never read.
 */
export async function getPackageApi(deps: Deps, siteId: string): Promise<Response> {
  if (!SITE_ID.test(siteId)) return jsonRes({ error: 'Không tìm thấy bộ hồ sơ này.' }, 404);
  const meta = await getJson<SiteMeta>(deps.kv, `site:${siteId}`);
  if (!meta) return jsonRes({ error: 'Không tìm thấy bộ hồ sơ này.' }, 404);
  if (await trialGone(deps, meta)) return jsonRes({ error: TRIAL_GONE }, 410);
  const [paid, stored, site, brief] = await Promise.all([
    isPaid(deps, siteId), getJson<Analysis>(deps.kv, analysisKey(siteId)),
    getJson<SiteJson>(deps.kv, `sitejson:${siteId}`), getJson<BriefV2>(deps.kv, briefKey(siteId)),
  ]);
  // The unit's name, not the person's (SiteMeta.name is what they typed in "Tên của bạn").
  const name = [site?.brand?.name, brief?.ten_don_vi, meta.name].map((x) => (typeof x === 'string' ? x.trim() : '')).find(Boolean) ?? '';
  // Built field by field: never spread the stored object, so `full` cannot leak through a refactor.
  const analysis = stored && stored.free ? (paid ? { free: stored.free, full: stored.full } : { free: stored.free }) : null;
  return jsonRes({
    site: { name, expires: meta.expires, paid },
    demoUrl: demoUrl(deps.config, siteId),
    analysis,
    packages: sellablePackages(deps.config),
  });
}
