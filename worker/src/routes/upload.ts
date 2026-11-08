import { slugify } from '@sme/schema';
import type { Deps, Session } from '../types';
import { errorJson, json, readJson } from '../http';
import { putJson } from '../kv';
import { loadSession, SESSION_TTL as TTL, updateSession } from '../session-store';

export const MAX_FILES = 10;
export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_DOCS_CHARS = 20_000;
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
  const s = await loadSession(deps, sessionId);
  if (!s) return errorJson(404, NO_SESSION);
  if (s.uploads.length >= MAX_FILES) return errorJson(413, `Chỉ được tải lên tối đa ${MAX_FILES} ảnh.`);
  if (file.size > MAX_BYTES) return errorJson(413, 'Ảnh quá lớn. Mỗi ảnh tối đa 5MB.');
  const typeMsg = 'Chỉ nhận ảnh định dạng JPG, PNG hoặc WEBP.';
  if (!ALLOWED.has(file.type)) return errorJson(415, typeMsg);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_BYTES) return errorJson(413, 'Ảnh quá lớn. Mỗi ảnh tối đa 5MB.');
  const kind = sniff(bytes);
  if (!kind) return errorJson(415, typeMsg);

  const base = slugify((file.name || 'anh').replace(/\.[^.]*$/, '')) || 'anh';
  // Number from the FRESH upload list (read right before the write), never from the copy read before the body was parsed.
  const saved = await updateSession(deps, sessionId, (cur: Session) => {
    if (cur.uploads.length >= MAX_FILES) return null;
    const n = cur.uploads.length + 1;
    const path = `assets/${n}-${base}.${kind.ext}`;
    cur.uploads.push(path);
    return { n, path };
  });
  if (!saved) return errorJson(404, NO_SESSION);
  if (!saved.result) return errorJson(413, `Chỉ được tải lên tối đa ${MAX_FILES} ảnh.`);
  const { n, path } = saved.result;
  await putJson(deps.kv, `up:${sessionId}:${n}`, { path, mime: kind.mime, base64: toBase64(bytes) }, TTL);
  return json({ path });
}

export async function postDocs(req: Request, deps: Deps): Promise<Response> {
  const body = await readJson<{ sessionId?: unknown; text?: unknown }>(req);
  if (!body || typeof body.sessionId !== 'string' || typeof body.text !== 'string' || !body.text.trim()) {
    return errorJson(400, 'Yêu cầu không hợp lệ.');
  }
  const text = body.text;
  const saved = await updateSession(deps, body.sessionId, (cur: Session) => {
    cur.docsText = (cur.docsText ? `${cur.docsText}\n\n${text}` : text).slice(0, MAX_DOCS_CHARS);
  });
  if (!saved) return errorJson(404, NO_SESSION);
  const s = saved.s;
  return json({ length: s.docsText.length });
}
