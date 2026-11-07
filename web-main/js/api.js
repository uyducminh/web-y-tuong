// Gọi Worker API + lưu phiên. Dùng chung cho mọi trang.

function meta(name) {
  const el = document.querySelector(`meta[name="${name}"]`);
  return el ? (el.getAttribute('content') || '').trim() : '';
}

/** Địa chỉ Worker lấy từ <meta name="api-base">; để trống = cùng tên miền với trang. */
export const API_BASE = meta('api-base').replace(/\/+$/, '');
export const TURNSTILE_SITEKEY = meta('turnstile-sitekey');

const NETWORK_ERROR = 'Không kết nối được máy chủ. Vui lòng kiểm tra mạng và thử lại.';
const SERVER_ERROR = 'Hệ thống đang gặp sự cố. Vui lòng thử lại sau.';

/**
 * api('/api/chat', { json: {...} }) hoặc api('/api/upload', { form }) hoặc api('/api/status/x').
 * Luôn trả { ok, status, data } — không ném lỗi; data.error là câu báo lỗi tiếng Việt.
 */
export async function api(path, { json, form, timeoutMs = 60000 } = {}) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  const init = { method: json || form ? 'POST' : 'GET', signal: ctrl?.signal };
  if (json) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(json); }
  if (form) init.body = form;
  try {
    const res = await fetch(API_BASE + path, init);
    let data = null;
    try { data = await res.json(); } catch { /* không phải JSON */ }
    if (!data || typeof data !== 'object') data = {};
    if (!res.ok && typeof data.error !== 'string') data.error = SERVER_ERROR;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: NETWORK_ERROR } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// sessionStorage có thể bị chặn (chế độ riêng tư, WebView Zalo...) → dùng bộ nhớ tạm thay thế.
const memory = new Map();
const KEY = 'sme.session';

function rawGet(k) {
  try { const v = window.sessionStorage.getItem(k); if (v !== null) return v; } catch { /* bị chặn */ }
  return memory.has(k) ? memory.get(k) : null;
}
function rawSet(k, v) {
  memory.set(k, v);
  try { window.sessionStorage.setItem(k, v); } catch { /* bị chặn */ }
}

/** Phiên hiện tại: { sessionId?, jobId?, siteId?, revisionsLeft? } */
export function loadSession() {
  try { const v = JSON.parse(rawGet(KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
export function saveSession(patch) {
  const next = { ...loadSession(), ...patch };
  rawSet(KEY, JSON.stringify(next));
  return next;
}

/** Giống normalizePhone của @sme/schema: trả '0xxxxxxxxx' hoặc null. */
export function normalizePhone(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.startsWith('84')) d = '0' + d.slice(2);
  return /^0\d{9}$/.test(d) ? d : null;
}

/** 10000000 → '10.000.000đ' */
export function formatVnd(n) {
  return `${Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}đ`;
}

export const qs = (name) => new URLSearchParams(location.search).get(name) || '';

/** Tạo phần tử: h('p', { class: 'x', text: '...' }, child...) — chỉ dùng textContent, không innerHTML. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') el.textContent = v;
    else if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Chỉ cho phép link http(s) (link từ API) — tránh javascript: */
export const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
