import { slugify } from '@sme/schema';
import type { Deps, Session } from '../types';
import { errorJson, json, readJson } from '../http';
import { getJson, putJson } from '../kv';

const TTL = 7 * 24 * 3600;
export const MAX_FILES = 10;
export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_DOCS_CHARS = 8000;
const NO_SESSION = 'Không tìm thấy phiên trò chuyện. Vui lòng tải lại trang để bắt đầu lại.';
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

type Kind = { mime: string; ext: string };

export function sniff(b: Uint8Array): Kind | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 8 && png.every((v, i) => b[i] === v)) return { mime: 'image/png', ext: 'png' };
  const at = (o: number, s: string) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (b.length >= 12 && at(0, 'RIFF') && at(8, 'WEBP')) return { mime: 'image/webp', ext: 'webp' };
  return null;
}

export function toBase64(b: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < b.length; i += CHUNK) s += String.fromCharCode(...b.subarray(i, i + CHUNK));
  return btoa(s);
}

export async function postUpload(req: Request, deps: Deps): Promise<Response> {
  let form: FormData;
  try { form = await req.formData(); } catch { return errorJson(400, 'Yêu cầu không hợp lệ.'); }
  const sessionId = form.get('sessionId');
  const file = form.get('file');
  if (typeof sessionId !== 'string' || !sessionId || !file || typeof file === 'string') {
    return errorJson(400, 'Yêu cầu không hợp lệ.');
  }
  const s = await getJson<Session>(deps.kv, `sess:${sessionId}`);
  if (!s) return errorJson(404, NO_SESSION);
  if (s.uploads.length >= MAX_FILES) return errorJson(413, `Chỉ được tải lên tối đa ${MAX_FILES} ảnh.`);
  if (file.size > MAX_BYTES) return errorJson(413, 'Ảnh quá lớn. Mỗi ảnh tối đa 5MB.');
  const typeMsg = 'Chỉ nhận ảnh định dạng JPG, PNG hoặc WEBP.';
  if (!ALLOWED.has(file.type)) return errorJson(415, typeMsg);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_BYTES) return errorJson(413, 'Ảnh quá lớn. Mỗi ảnh tối đa 5MB.');
  const kind = sniff(bytes);
  if (!kind) return errorJson(415, typeMsg);

  const n = s.uploads.length + 1;
  const base = (file.name || 'anh').replace(/\.[^.]*$/, '');
  const path = `assets/${n}-${slugify(base) || 'anh'}.${kind.ext}`;
  await putJson(deps.kv, `up:${sessionId}:${n}`, { path, mime: kind.mime, base64: toBase64(bytes) }, TTL);
  s.uploads.push(path);
  await putJson(deps.kv, `sess:${sessionId}`, s, TTL);
  return json({ path });
}

export async function postDocs(req: Request, deps: Deps): Promise<Response> {
  const body = await readJson<{ sessionId?: unknown; text?: unknown }>(req);
  if (!body || typeof body.sessionId !== 'string' || typeof body.text !== 'string' || !body.text.trim()) {
    return errorJson(400, 'Yêu cầu không hợp lệ.');
  }
  const s = await getJson<Session>(deps.kv, `sess:${body.sessionId}`);
  if (!s) return errorJson(404, NO_SESSION);
  s.docsText = (s.docsText ? `${s.docsText}\n\n${body.text}` : body.text).slice(0, MAX_DOCS_CHARS);
  await putJson(deps.kv, `sess:${s.id}`, s, TTL);
  return json({ length: s.docsText.length });
}
