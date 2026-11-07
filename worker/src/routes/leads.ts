import type { Deps, SiteMeta } from '../types';
import { errorJson, getIp, json, readJson } from '../http';
import { getJson, incr, putJson } from '../kv';

type Lead = { at: string; fields: Record<string, string> };
const MAX_LEADS = 500, MAX_KEYS = 20, KEY_LEN = 50, VAL_LEN = 500, HOURLY_LIMIT = 10;

function ymdh(d: Date): string { return d.toISOString().slice(0, 13).replace(/[-T]/g, ''); }

function sanitize(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_KEYS) break;
    if (k === 'website' || (typeof v !== 'string' && typeof v !== 'number')) continue;
    const key = k.slice(0, KEY_LEN);
    if (!key) continue;
    out[key] = String(v).slice(0, VAL_LEN);
  }
  return out;
}

export async function postLead(req: Request, deps: Deps, siteId: string): Promise<Response> {
  const meta = await getJson<SiteMeta>(deps.kv, `site:${siteId}`);
  if (!meta) return errorJson(404, 'Không tìm thấy trang này.');
  const body = await readJson<Record<string, any>>(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return errorJson(400, 'Dữ liệu không hợp lệ.');
  if (typeof body.website === 'string' && body.website !== '') return json({ ok: true });
  const n = await incr(deps.kv, `leadrl:${siteId}:${getIp(req)}:${ymdh(deps.now())}`, 2 * 3600);
  if (n > HOURLY_LIMIT) return errorJson(429, 'Bạn gửi quá nhiều lần. Vui lòng thử lại sau.');
  // Demo form sends flat {name, phone, note, website}; also accept {fields: {...}}.
  const src = body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields) ? body.fields : body;
  const fields = sanitize(src);
  if (!Object.keys(fields).length) return errorJson(400, 'Vui lòng nhập thông tin.');
  const leads = (await getJson<Lead[]>(deps.kv, `leads:${siteId}`)) ?? [];
  leads.push({ at: deps.now().toISOString(), fields });
  await putJson(deps.kv, `leads:${siteId}`, leads.slice(-MAX_LEADS));
  return json({ ok: true });
}

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const csvCell = (s: string) => {
  const v = /^[=+\-@]/.test(s) ? "'" + s : s;
  return /[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
};

export async function getLeads(req: Request, deps: Deps, siteId: string, url: URL): Promise<Response> {
  const meta = await getJson<SiteMeta>(deps.kv, `site:${siteId}`);
  if (!meta) return errorJson(404, 'Không tìm thấy trang này.');
  if (!meta.leadKey || !safeEqual(url.searchParams.get('key') ?? '', meta.leadKey)) return errorJson(403, 'Khoá xem không đúng.');
  const leads = (await getJson<Lead[]>(deps.kv, `leads:${siteId}`)) ?? [];
  const cols: string[] = [];
  for (const l of leads) for (const k of Object.keys(l.fields)) if (!cols.includes(k)) cols.push(k);
  const header = [...cols, 'Thời gian'];
  const rows = [...leads].reverse().map((l) => [...cols.map((c) => l.fields[c] ?? ''), l.at]);

  if (url.searchParams.get('format') === 'csv') {
    const csv = '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
    return new Response(csv, { headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="leads-${siteId}.csv"`,
      'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer',
    } });
  }
  const csvHref = `?key=${encodeURIComponent(url.searchParams.get('key')!)}&format=csv`;
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Khách để lại thông tin - ${esc(meta.name)}</title>
<style>body{font-family:system-ui,sans-serif;margin:16px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f3f3f3}.wrap{overflow-x:auto}</style></head><body>
<h1>Khách để lại thông tin: ${esc(meta.name)}</h1><p>Tổng: ${leads.length} · <a href="${esc(csvHref)}">Tải CSV</a></p>
${leads.length ? `<div class="wrap"><table><thead><tr>${header.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${
  rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p>Chưa có khách nào để lại thông tin.</p>'}
</body></html>`;
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  } });
}
