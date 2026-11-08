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

const UNIT_MUL = { 'triệu': 1_000_000, tr: 1_000_000, 'nghìn': 1000, 'ngàn': 1000, k: 1000, 'đồng': 1, 'đ': 1, 'vnđ': 1, vnd: 1 };
// Số + đơn vị NGAY SAU nó (cho phép một dấu cách). Đơn vị dài đứng trước để "vnđ" không bị đọc thành số rồi "đ".
const PRICE_GROUP = /(\d(?:[\d.,]*\d)?)(?:\s?(triệu|nghìn|ngàn|đồng|vnđ|vnd|tr|k|đ)(?![\p{L}]))?/gu;

/**
 * Đơn vị chỉ áp cho số đứng ngay trước nó. Chọn cụm "số[đơn vị]" ĐẦU TIÊN trông như giá: có đơn vị, hoặc có dấu
 * phân cách nghìn, hoặc ≥ 1000; không có cụm nào như vậy thì lấy cụm đầu tiên.
 * "180.000đ" → 180000 · "180.000 - 200.000đ" → 180000 · "1,2 triệu" → 1200000 · "45k" → 45000 ·
 * "1.200.000đ (giảm còn 1 triệu)" → 1200000 · "Combo 3 hộp 450k" → 450000. Không đọc được → undefined.
 */
export function parsePrice(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
  const groups = [...lower(v).matchAll(PRICE_GROUP)].map((m) => {
    const unit = m[2];
    const decimal = !!unit && UNIT_MUL[unit] > 1;
    const n = toNumber(m[1], decimal) * (unit ? UNIT_MUL[unit] : 1);
    return { n, plausible: !!unit || /\d[.,]\d{3}(?!\d)/.test(m[1]) || n >= 1000 };
  }).filter((g) => Number.isFinite(g.n));
  const pick = groups.find((g) => g.plausible) ?? groups[0];
  return pick ? Math.round(pick.n) : undefined;
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
