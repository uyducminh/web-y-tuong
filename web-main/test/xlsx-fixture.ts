import * as XLSX from 'xlsx';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Builds .xlsx bytes in memory from { sheetName: rows } — no committed binary. */
export function makeXlsxBytes(sheets: Record<string, unknown[][]>): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const [n, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), n);
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}
export function makeXlsx(sheets: Record<string, unknown[][]>, name = 'bang-gia.xlsx'): File {
  return new File([makeXlsxBytes(sheets)], name, { type: XLSX_MIME });
}
export { XLSX_MIME };

/** Bảng giá kiểu một HTX: 2 dòng tiêu đề chung, tiêu đề cột ở dòng 3, có dòng trống và dòng "Tổng cộng". */
export const BANG_GIA: unknown[][] = [
  ['HỢP TÁC XÃ CÀ PHÊ CẦU ĐẤT'],
  ['Bảng giá sỉ tháng 11/2026'],
  ['STT', 'Tên sản phẩm', 'Quy cách', 'Đơn giá (VNĐ)'],
  [1, 'Cà phê Arabica rang mộc', 'Gói 500g', '180.000đ'],
  [2, 'Cà phê Robusta Honey', 'Gói 500g', '150,000'],
  [],
  [3, 'Combo quà biếu Tết', 'Hộp', '1,2 triệu'],
  [4, 'Trà atiso', 'Hộp 20 túi', 95000],
  ['', 'Tổng cộng', '', '1.625.000đ'],
];

export { XLSX };
