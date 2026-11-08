// Đọc bảng tính (.xlsx, .xls, .csv) ngay trên trình duyệt. SheetJS được truyền vào (XLSX) để trang dùng bản cdnjs,
// còn test dùng bản npm: extractExcel(file, XLSX).
export const MAX_SHEETS = 3;
export const MAX_ROWS = 200;
export const MAX_PRODUCTS = 60;
const HEADER_SCAN = 5;

const norm = (v) => String(v ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
const lower = (v) => norm(v).toLowerCase();

const isPriceHeader = (s) => /(^|[^\p{L}])(đơn )?giá($|[^\p{L}])/u.test(s);
const isNameHeader = (s) => /(^|[^\p{L}])(tên|sản phẩm|mặt hàng)($|[^\p{L}])/u.test(s);

const isCodeHeader = (s) => /^(mã|stt)(?![\p{L}\d])/u.test(s);
const hasTen = (s) => /(^|[^\p{L}])tên($|[^\p{L}])/u.test(s);

/** Một cụm số "1.250.000" / "1,2" → số; `decimal` = cho phép dấu thập phân (khi có đơn vị triệu/nghìn). */
function toNumber(tok, decimal) {
  const m = /^(\d+)[.,](\d{1,2})$/.exec(tok);
  if (decimal && m) return Number(`${m[1]}.${m[2]}`);
  return Number(tok.replace(/[.,]/g, ''));
}

/**
 * Lấy CỤM SỐ ĐẦU TIÊN: "180.000đ" → 180000 · "180,000" → 180000 · "180.000 - 200.000đ" → 180000 ·
 * "1,2 triệu" → 1200000 · "45k" → 45000. Không đọc được → undefined.
 */
export function parsePrice(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
  const s = lower(v);
  const first = /\d(?:[\d.,]*\d)?/.exec(s);
  if (!first) return undefined;
  const rest = s.slice(first.index + first[0].length);
  const unit = /(?<![\p{L}])(triệu|tr|nghìn|ngàn|k)(?![\p{L}])/u.exec(rest);
  const n = toNumber(first[0], !!unit);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(unit ? n * (unit[1] === 'triệu' || unit[1] === 'tr' ? 1_000_000 : 1000) : n);
}

function columnsOf(row) {
  const cells = (row || []).map(lower);
  const price = cells.findIndex((c) => c && isPriceHeader(c));
  const names = cells.map((c, i) => i).filter((i) => i !== price && cells[i] && isNameHeader(cells[i]) && !isCodeHeader(cells[i]));
  const name = names.find((i) => hasTen(cells[i])) ?? names[0] ?? -1;
  return { name, price };
}

/** Trong 5 dòng đầu: ưu tiên dòng có CẢ cột tên và cột giá; không có thì dòng đầu tiên có cột tên. */
function findHeader(rows) {
  let nameOnly = null;
  for (let r = 0; r < Math.min(HEADER_SCAN, rows.length); r++) {
    const { name, price } = columnsOf(rows[r]);
    if (name < 0) continue;
    if (price >= 0) return { row: r, name, price };
    if (!nameOnly) nameOnly = { row: r, name, price: -1 };
  }
  return nameOnly;
}

/** rows: mảng 2 chiều của MỘT sheet → { text: 'cột | cột' mỗi dòng, products: [{ten, gia?}] }. */
export function parseSheet(rows) {
  const list = (Array.isArray(rows) ? rows : []).slice(0, MAX_ROWS).map((r) => (Array.isArray(r) ? r : []));
  const lines = [];
  for (const r of list) {
    const cells = r.map(norm);
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    if (cells.some(Boolean)) lines.push(cells.join(' | '));
  }
  const products = [];
  const head = findHeader(list);
  if (head && head.price >= 0) {
    for (const r of list.slice(head.row + 1)) {
      if (products.length >= MAX_PRODUCTS) break;
      const ten = norm(r[head.name]).slice(0, 200);
      if (!ten || /^tổng/.test(ten.toLowerCase())) continue;
      const gia = parsePrice(r[head.price]);
      products.push(gia === undefined ? { ten } : { ten, gia });
    }
  }
  return { text: lines.join('\n'), products };
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

export const isSheetFile = (file) => /\.(xlsx|xls|csv)$/i.test(file.name || '')
  || ['text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(file.type);

/** Đọc tối đa 3 sheet × 200 dòng; gộp chữ (kèm tên sheet) và tối đa 60 sản phẩm. */
export async function extractExcel(file, XLSX) {
  const buf = await readBuffer(file);
  const opts = { sheetRows: MAX_ROWS, cellDates: false };
  // CSV: giải mã UTF-8 trước (SheetJS đọc byte CSV như latin1 → hỏng dấu tiếng Việt).
  const wb = /\.csv$/i.test(file.name || '') || file.type === 'text/csv'
    ? XLSX.read(new TextDecoder('utf-8').decode(buf).replace(/^﻿/, ''), { ...opts, type: 'string' })
    : XLSX.read(new Uint8Array(buf), { ...opts, type: 'array' });
  const texts = [];
  const products = [];
  for (const name of wb.SheetNames.slice(0, MAX_SHEETS)) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false });
    const r = parseSheet(rows);
    if (r.text) texts.push(`[Bảng: ${norm(name)}]\n${r.text}`);
    for (const p of r.products) if (products.length < MAX_PRODUCTS) products.push(p);
  }
  return { text: texts.join('\n\n'), products };
}
