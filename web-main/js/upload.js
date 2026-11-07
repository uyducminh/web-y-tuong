// Kiểm tra file ngay trên trình duyệt, tải ảnh lên LẦN LƯỢT (phiên ở Worker cập nhật không nguyên tử),
// tách chữ PDF/Word rồi gửi phần chữ (tối đa 8.000 ký tự).
import { api } from './api.js';
import { docKind, extractText, MAX_CHARS } from './extract.js';

export const MAX_IMAGES = 10;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DOC_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1 };
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/legacy/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/legacy/build/pdf.worker.min.mjs';
const MAMMOTH_URL = 'https://cdn.jsdelivr.net/npm/mammoth@1.13.0/mammoth.browser.min.js';

function isImage(file) {
  // MIME là chính; một số điện thoại gửi MIME rỗng nên xét thêm đuôi file.
  return file.type ? !!IMAGE_TYPES[file.type] : IMAGE_EXT.test(file.name || '');
}

/** Chia file thành ảnh / tài liệu hợp lệ và danh sách lỗi tiếng Việt. Không gọi mạng. */
export function checkFiles(files, imagesAlready = 0) {
  const images = []; const docs = []; const errors = [];
  for (const f of files) {
    const name = `“${f.name || 'file'}”`;
    if (isImage(f)) {
      if (f.size > MAX_IMAGE_BYTES) errors.push(`Ảnh ${name} quá lớn. Mỗi ảnh tối đa 5MB.`);
      else images.push(f);
    } else if (docKind(f)) {
      if (f.size > MAX_DOC_BYTES) errors.push(`Tài liệu ${name} quá lớn (tối đa 20MB).`);
      else docs.push(f);
    } else {
      errors.push(`Không nhận file ${name}. Ảnh chỉ nhận JPG, PNG hoặc WEBP; tài liệu nhận PDF hoặc Word (.docx).`);
    }
  }
  const room = Math.max(0, MAX_IMAGES - imagesAlready);
  if (images.length > room) {
    errors.push(room === 0
      ? `Bạn đã gửi đủ ${MAX_IMAGES} ảnh, không gửi thêm được.`
      : `Chỉ gửi được tối đa ${MAX_IMAGES} ảnh. Bạn còn gửi được ${room} ảnh, các ảnh sau bị bỏ qua.`);
    images.length = room;
  }
  return { images, docs, errors };
}

let libsPromise = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.crossOrigin = 'anonymous';
    s.onload = resolve; s.onerror = () => reject(new Error('load'));
    document.head.append(s);
  });
}
/** pdf.js + mammoth chỉ tải khi khách chọn tài liệu (tiết kiệm 3G). */
export function loadDocLibs() {
  if (!libsPromise) {
    libsPromise = Promise.all([
      import(/* @vite-ignore */ PDFJS_URL).then((m) => { m.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; return m; }),
      window.mammoth ? Promise.resolve(window.mammoth) : loadScript(MAMMOTH_URL).then(() => window.mammoth),
    ]).then(([pdfjs, mammoth]) => ({ pdfjs, mammoth }))
      .catch((e) => { libsPromise = null; throw e; });
  }
  return libsPromise;
}

/**
 * Gửi ảnh từng cái một rồi tới tài liệu. ui: { onImage(file, path), onDoc(file, chars), onError(msg), onProgress(text) }.
 * Trả về số ảnh đã tải lên thành công.
 */
export async function sendFiles({ images, docs }, sessionId, ui) {
  let sent = 0;
  for (let i = 0; i < images.length; i++) {
    const f = images[i];
    ui.onProgress(`Đang gửi ảnh ${i + 1}/${images.length}…`);
    const form = new FormData();
    form.append('sessionId', sessionId);
    form.append('file', f, f.name);
    const r = await api('/api/upload', { form, timeoutMs: 120000 });
    if (r.ok) { sent++; ui.onImage(f, r.data.path); }
    else {
      ui.onError(`Ảnh “${f.name}”: ${r.data.error}`);
      if (r.status === 413 && /tối đa/.test(r.data.error)) break; // hết chỗ
    }
  }
  for (const f of docs) {
    ui.onProgress(`Đang đọc tài liệu “${f.name}”…`);
    let text;
    try {
      text = await extractText(f, await loadDocLibs());
    } catch (e) {
      ui.onError(e && e.message === 'load'
        ? 'Không tải được công cụ đọc tài liệu. Vui lòng kiểm tra mạng và thử lại.'
        : `Không đọc được chữ trong “${f.name}”. Nếu là bản scan, bạn hãy chụp ảnh gửi thay thế.`);
      continue;
    }
    if (!text) { ui.onError(`Không tìm thấy chữ trong “${f.name}”. Nếu là bản scan, bạn hãy chụp ảnh gửi thay thế.`); continue; }
    const r = await api('/api/docs', { json: { sessionId, text: text.slice(0, MAX_CHARS) } });
    if (r.ok) ui.onDoc(f, text.length);
    else ui.onError(`Tài liệu “${f.name}”: ${r.data.error}`);
  }
  ui.onProgress('');
  return sent;
}
