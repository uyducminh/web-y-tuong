import type { Deps, SiteMeta } from '../types';
import { errorJson } from '../http';
import { getJson } from '../kv';
import { analysisKey, assetPrefix, briefKey, docsKey, listKeys } from '../sites';
import { escapeHtml as esc } from '../static/templates';
import { DEMO_HEADERS } from './demo';
import { safeEqual } from './leads';

type Img = { path: string; mime: string; base64: string };

/** A value as readable text: scalars as-is, arrays/objects as nested "label: value" lines. */
function readable(v: unknown, depth = 0): string {
  const pad = '  '.repeat(depth);
  if (v === null || v === undefined || v === '') return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' && x !== null ? `${pad}-\n${readable(x, depth + 1)}` : `${pad}- ${String(x)}`)).join('\n');
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>).map(([k, x]) => {
      if (x === null || x === undefined || x === '') return '';
      return typeof x === 'object' ? `${pad}${k}:\n${readable(x, depth + 1)}` : `${pad}${k}: ${String(x)}`;
    }).filter(Boolean).join('\n');
  }
  return `${pad}${String(v)}`;
}

/**
 * `GET /handoff/:siteId?key=<handoffKey>[&format=json]` — the post-payment handoff page for the team: brief, site.json,
 * the full analysis, docsText and the images. The key is compared in constant time; a missing/empty stored key never matches.
 */
export async function getHandoff(deps: Deps, siteId: string, url: URL): Promise<Response> {
  const meta = await getJson<SiteMeta>(deps.kv, `site:${siteId}`);
  if (!meta) return errorJson(404, 'Không tìm thấy trang này.');
  const key = url.searchParams.get('key') ?? '';
  if (!meta.handoffKey || !key || !safeEqual(key, meta.handoffKey)) return errorJson(403, 'Khoá xem không đúng.');

  const [brief, site, analysis, docsText] = await Promise.all([
    getJson<unknown>(deps.kv, briefKey(siteId)), getJson<unknown>(deps.kv, `sitejson:${siteId}`),
    getJson<unknown>(deps.kv, analysisKey(siteId)), getJson<string>(deps.kv, docsKey(siteId)),
  ]);
  const prefix = assetPrefix(siteId);
  const images: Img[] = [];
  for (const k of await listKeys(deps.kv, prefix)) {
    const a = await getJson<{ mime: string; base64: string }>(deps.kv, k);
    if (a) images.push({ path: k.slice(prefix.length), mime: a.mime, base64: a.base64 });
  }

  if (url.searchParams.get('format') === 'json') {
    return new Response(JSON.stringify({ siteId, name: meta.name, phone: meta.phone, brief, site, analysis, docsText: docsText ?? '', images }), {
      headers: { ...DEMO_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="handoff-${siteId}.json"` } });
  }

  const pre = (v: string) => `<pre>${esc(v)}</pre>`;
  const section = (title: string, body: string) => `<section><h2>${esc(title)}</h2>${body}</section>`;
  const dl = `?key=${encodeURIComponent(key)}&format=json`;
  const links = images.map((i) => {
    const href = `${deps.config.apiBase}/d/${siteId}/${i.path}`;
    return `<li><a href="${esc(href)}">${esc(i.path)}</a></li>`;
  }).join('');
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Bàn giao - ${esc(meta.name)}</title>
<style>body{font-family:system-ui,sans-serif;margin:16px auto;max-width:960px;line-height:1.5;padding:0 12px}pre{white-space:pre-wrap;word-break:break-word;background:#f6f6f6;padding:10px;border-radius:6px}a.btn{display:inline-block;background:#2E7D32;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none}</style></head><body>
<h1>Bàn giao: ${esc(meta.name)}</h1>
<p>SĐT: ${esc(meta.phone)} · Mã: ${esc(siteId)}</p>
<p><a class="btn" href="${esc(dl)}" download="handoff-${esc(siteId)}.json">Tải handoff-${esc(siteId)}.json</a></p>
${section('Brief', pre(readable(brief) || '(không có)'))}
${section('site.json', pre(site ? JSON.stringify(site, null, 2) : '(không có)'))}
${section('Phân tích đầy đủ', pre(analysis ? JSON.stringify(analysis, null, 2) : '(không có)'))}
${section('Tài liệu khách gửi', pre(docsText || '(không có)'))}
${section('Ảnh', links ? `<ul>${links}</ul>` : '<p>(không có ảnh)</p>')}
</body></html>`;
  return new Response(html, { headers: { ...DEMO_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } });
}
