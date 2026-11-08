// Kiểm tra file ngay trên trình duyệt, thu nhỏ + bỏ EXIF, tải ảnh lên LẦN LƯỢT (phiên ở Worker cập nhật không nguyên tử),
// tách chữ PDF/Word rồi gửi phần chữ (tối đa 20.000 ký tự), đọc bảng tính Excel/CSV rồi gửi chữ + danh sách sản phẩm.
import { api } from './api.js';
import { docKind, extractText, MAX_CHARS } from './extract.js';
import { extractExcel, isSheetFile } from './excel.js';

export const MAX_IMAGES = 10;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DOC_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1 };
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/legacy/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/legacy/build/pdf.worker.min.mjs';
const MAMMOTH_URL = 'https://cdn.jsdelivr.net/npm/mammoth@1.13.0/mammoth.browser.min.js';
const SHEETJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
// SRI = sha384 của đúng file npm (mammoth@1.13.0 mammoth.browser.min.js, xlsx@0.18.5 dist/xlsx.full.min.js); scripts/sri.test.ts
// tính lại từ node_modules. pdf.js nạp bằng import() (module + worker) nên trình duyệt không hỗ trợ SRI cho nó.
const MAMMOTH_SRI = 'sha384-8NWE3bZDrmRI4IePMoQaEoLhAQ1MmRMJkdNgnGiHRFanTqsFKr0TmK6aSZvFJ/PO';
const SHEETJS_SRI = 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw';

function isImage(file) {
  // MIME là chính; một số điện thoại gửi MIME rỗng nên xét thêm đuôi file.
  return file.type ? !!IMAGE_TYPES[file.type] : IMAGE_EXT.test(file.name || '');
}

/** Chia file thành ảnh / tài liệu / bảng tính hợp lệ và danh sách lỗi tiếng Việt. Không gọi mạng. */
export function checkFiles(files, imagesAlready = 0) {
  const images = []; const docs = []; const sheets = []; const errors = [];
  for (const f of files) {
    const name = `“${f.name || 'file'}”`;
    if (isImage(f)) {
      if (f.size > MAX_IMAGE_BYTES) errors.push(`Ảnh ${name} quá lớn. Mỗi ảnh tối đa 5MB.`);
      else images.push(f);
    } else if (docKind(f)) {
      if (f.size > MAX_DOC_BYTES) errors.push(`Tài liệu ${name} quá lớn (tối đa 20MB).`);
      else docs.push(f);
    } else if (isSheetFile(f)) {
      if (f.size > MAX_DOC_BYTES) errors.push(`Bảng tính ${name} quá lớn (tối đa 20MB).`);
      else sheets.push(f);
    } else {
      errors.push(`Không nhận file ${name}. Ảnh chỉ nhận JPG, PNG hoặc WEBP; tài liệu nhận PDF, Word (.docx) hoặc Excel (.xlsx, .xls, .csv).`);
    }
  }
  const room = Math.max(0, MAX_IMAGES - imagesAlready);
  if (images.length > room) {
    errors.push(room === 0
      ? `Bạn đã gửi đủ ${MAX_IMAGES} ảnh, không gửi thêm được.`
      : `Chỉ gửi được tối đa ${MAX_IMAGES} ảnh. Bạn còn gửi được ${room} ảnh, các ảnh sau bị bỏ qua.`);
    images.length = room;
  }
  return { images, docs, sheets, errors };
}

export const MAX_SIDE = 1600;
const QUALITY = 0.85;

function decode(file) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(file, { imageOrientation: 'from-image' });
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    im.src = url;
  });
}
const toBlob = (canvas, type) => new Promise((r) => canvas.toBlob(r, type, QUALITY));

/**
 * Thu nhỏ ảnh (cạnh dài tối đa 1600px) và mã hoá lại bằng canvas ngay trên trình duyệt: ảnh nhẹ hơn cho 3G và
 * bỏ hết EXIF/GPS (vị trí chụp) vì bản dùng thử là công khai. JPG → JPEG chất lượng 0,85; PNG/WEBP → WEBP (giữ nền
 * trong suốt cho logo), trình duyệt không hỗ trợ WEBP thì JPEG nền trắng. Không giải mã được → gửi ảnh gốc
 * (Worker vẫn kiểm tra định dạng thật).
 */
export async function shrinkImage(file) {
  try {
    const src = await decode(file);
    const w0 = src.width, h0 = src.height;
    if (!w0 || !h0) return file;
    const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w0 * scale)); canvas.height = Math.max(1, Math.round(h0 * scale));
    const ctx = canvas.getContext('2d');
    const draw = (bg) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    };
    let blob = null;
    if (file.type !== 'image/jpeg' && !/\.jpe?g$/i.test(file.name || '')) { draw(null); blob = await toBlob(canvas, 'image/webp'); }
    if (!blob || blob.type !== 'image/webp') { draw('#fff'); blob = await toBlob(canvas, 'image/jpeg'); }
    if (src.close) src.close();
    if (!blob || blob.size > MAX_IMAGE_BYTES) return file;
    const base = (file.name || 'anh').replace(/\.[^.]*$/, '') || 'anh';
    return new File([blob], `${base}.${blob.type === 'image/webp' ? 'webp' : 'jpg'}`, { type: blob.type });
  } catch {
    return file;
  }
}

let libsPromise = null;
function loadScript(src, integrity) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.integrity = integrity; s.crossOrigin = 'anonymous';
    s.onload = resolve; s.onerror = () => reject(new Error('load'));
    document.head.append(s);
  });
}
/** pdf.js + mammoth chỉ tải khi khách chọn tài liệu (tiết kiệm 3G). */
export function loadDocLibs() {
  if (!libsPromise) {
    libsPromise = Promise.all([
      import(/* @vite-ignore */ PDFJS_URL).then((m) => { m.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; return m; }),
      window.mammoth ? Promise.resolve(window.mammoth) : loadScript(MAMMOTH_URL, MAMMOTH_SRI).then(() => window.mammoth),
    ]).then(([pdfjs, mammoth]) => ({ pdfjs, mammoth }))
      .catch((e) => { libsPromise = null; throw e; });
  }
  return libsPromise;
}

let sheetPromise = null;
/** SheetJS (cdnjs) chỉ tải khi khách chọn bảng tính. */
export function loadSheetJs() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!sheetPromise) {
    sheetPromise = loadScript(SHEETJS_URL, SHEETJS_SRI).then(() => {
      if (!window.XLSX) throw new Error('load');
      return window.XLSX;
    }).catch(() => { sheetPromise = null; throw new Error('load'); });
  }
  return sheetPromise;
}

/**
 * Gửi ảnh từng cái một rồi tới tài liệu, rồi bảng tính.
 * ui: { onImage(file, path), onDoc(file, chars), onSheet(file, {chars, products}), onError(msg), onProgress(text), onSessionLost() }.
 * 404 (phiên hết hạn) → gọi onSessionLost() rồi dừng hẳn.
 * Trả về số ảnh đã tải lên thành công.
 */
export async function sendFiles({ images, docs, sheets }, sessionId, ui) {
  let sent = 0;
  for (let i = 0; i < images.length; i++) {
    const f = images[i];
    ui.onProgress(`Đang gửi ảnh ${i + 1}/${images.length}…`);
    const up = await shrinkImage(f);
    const form = new FormData();
    form.append('sessionId', sessionId);
    form.append('file', up, up.name);
    const r = await api('/api/upload', { form, timeoutMs: 120000 });
    if (r.status === 404) { ui.onProgress(''); ui.onSessionLost(); return sent; } // phiên hết hạn: dừng, không gửi tiếp vào id cũ
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
    if (r.status === 404) { ui.onProgress(''); ui.onSessionLost(); return sent; }
    if (r.ok) ui.onDoc(f, text.length);
    else ui.onError(`Tài liệu “${f.name}”: ${r.data.error}`);
  }
  for (const f of sheets || []) {
    ui.onProgress(`Đang đọc bảng tính “${f.name}”…`);
    let XLSX;
    try { XLSX = await loadSheetJs(); } catch {
      ui.onError('Không tải được công cụ đọc bảng tính. Vui lòng kiểm tra mạng và thử lại, hoặc nhập sản phẩm và giá vào ô trò chuyện.');
      continue;
    }
    let data;
    try { data = await extractExcel(f, XLSX); } catch { data = null; }
    if (!data || (!data.text && !data.products.length)) {
      ui.onError(`Không đọc được bảng tính “${f.name}”. Bạn có thể nhập tên sản phẩm và giá vào ô trò chuyện.`);
      continue;
    }
    if (data.text) {
      const r = await api('/api/docs', { json: { sessionId, text: data.text.slice(0, MAX_CHARS) } });
      if (r.status === 404) { ui.onProgress(''); ui.onSessionLost(); return sent; }
      if (!r.ok) { ui.onError(`Bảng tính “${f.name}”: ${r.data.error}`); continue; }
    }
    let products = 0;
    if (data.products.length) {
      const r = await api('/api/products', { json: { sessionId, items: data.products } });
      if (r.status === 404) { ui.onProgress(''); ui.onSessionLost(); return sent; }
      if (r.ok) products = typeof r.data.count === 'number' ? r.data.count : data.products.length;
      else ui.onError(`Danh sách sản phẩm trong “${f.name}”: ${r.data.error}`);
    }
    ui.onSheet(f, { chars: data.text.length, products });
  }
  ui.onProgress('');
  return sent;
}
