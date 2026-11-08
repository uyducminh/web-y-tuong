// Tách chữ từ PDF/Word ngay trên trình duyệt. Thư viện được truyền vào (libs) để trang dùng bản CDN,
// còn test dùng bản npm: extractText(file, { pdfjs, mammoth }).
export const MAX_CHARS = 20000; // = giới hạn docsText ở Worker

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** 'pdf' | 'docx' | null — theo đuôi file trước, MIME sau (điện thoại hay gửi MIME rỗng). */
export function docKind(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf';
  if (name.endsWith('.docx') || file.type === DOCX_MIME) return 'docx';
  return null;
}

function readBuffer(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

function tidy(text) {
  return text
    .normalize('NFC')
    .replace(/\u0000/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_CHARS);
}

async function pdfText(buf, pdfjs) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  let out = '';
  try {
    for (let i = 1; i <= doc.numPages && out.length < MAX_CHARS; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        out += item.str + (item.hasEOL ? '\n' : '');
      }
      out += '\n\n';
    }
  } finally {
    await doc.destroy?.();
  }
  return out;
}

async function docxText(buf, mammoth) {
  const r = await mammoth.extractRawText({ arrayBuffer: buf, buffer: buf }) // trình duyệt đọc arrayBuffer, bản Node đọc buffer;
  return r.value || '';
}

export async function extractText(file, libs) {
  const kind = docKind(file);
  if (!kind) throw new Error('Chỉ đọc được tài liệu PDF hoặc Word (.docx).');
  const buf = await readBuffer(file);
  const raw = kind === 'pdf' ? await pdfText(buf, libs.pdfjs) : await docxText(buf, libs.mammoth);
  return tidy(raw);
}
