import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS module without types
import { parseSheet, parsePrice, extractExcel, MAX_PRODUCTS, MAX_ROWS, MAX_SHEETS } from '../js/excel.js';
import { BANG_GIA, makeXlsx, XLSX } from './xlsx-fixture';

describe('parsePrice', () => {
  it('reads Vietnamese price formats', () => {
    expect(parsePrice('180.000đ')).toBe(180000);
    expect(parsePrice('180,000')).toBe(180000);
    expect(parsePrice('1,2 triệu')).toBe(1200000);
    expect(parsePrice('2 triệu')).toBe(2000000);
    expect(parsePrice('1.5tr')).toBe(1500000);
    expect(parsePrice('45k')).toBe(45000);
    expect(parsePrice(95000)).toBe(95000);
    expect(parsePrice('liên hệ')).toBeUndefined();
    expect(parsePrice('')).toBeUndefined();
  });
});

describe('parseSheet', () => {
  it('finds the header on row 3 ("Tên sản phẩm", "Đơn giá (VNĐ)"), parses prices, skips blank and "Tổng cộng" rows', () => {
    const { text, products } = parseSheet(BANG_GIA);
    expect(products).toEqual([
      { ten: 'Cà phê Arabica rang mộc', gia: 180000 },
      { ten: 'Cà phê Robusta Honey', gia: 150000 },
      { ten: 'Combo quà biếu Tết', gia: 1200000 },
      { ten: 'Trà atiso', gia: 95000 },
    ]);
    expect(text).toContain('Tên sản phẩm | Quy cách | Đơn giá (VNĐ)');
    expect(text).toContain('Cà phê Arabica rang mộc | Gói 500g | 180.000đ');
    expect(text).not.toMatch(/\n\n/);
  });

  it('70 rows → 60 products', () => {
    const rows = [['Mặt hàng', 'Giá'], ...Array.from({ length: 70 }, (_, i) => [`Sản phẩm số ${i + 1}`, 10000 + i])];
    const { products } = parseSheet(rows);
    expect(MAX_PRODUCTS).toBe(60);
    expect(products).toHaveLength(60);
    expect(products[59]).toEqual({ ten: 'Sản phẩm số 60', gia: 10059 });
  });

  it('no price column → products empty, text still filled', () => {
    const { text, products } = parseSheet([['Tên sản phẩm', 'Mô tả'], ['Mật ong rừng', 'Chai 500ml']]);
    expect(products).toEqual([]);
    expect(text).toContain('Mật ong rừng | Chai 500ml');
  });

  it('no header in the first 5 rows → no products; at most 200 rows of text', () => {
    const rows = [...Array.from({ length: 5 }, () => ['ghi chú']), ['Tên', 'Giá'], ['A', 1]];
    expect(parseSheet(rows).products).toEqual([]);
    const many = Array.from({ length: 300 }, (_, i) => [`dòng ${i}`]);
    const t = parseSheet(many).text;
    expect(MAX_ROWS).toBe(200);
    expect(t.split('\n')).toHaveLength(200);
  });
});

describe('extractExcel', () => {
  it('reads an .xlsx (max 3 sheets) with the npm SheetJS build', async () => {
    const file = makeXlsx({
      'Bảng giá': BANG_GIA,
      'Ghi chú': [['Giao hàng toàn quốc']],
      'Sheet3': [['Tên', 'Giá'], ['Trà túi lọc', '35.000đ']],
      'Sheet4': [['Tên', 'Giá'], ['Không đọc', '1đ']],
    });
    const { text, products } = await extractExcel(file, XLSX);
    expect(MAX_SHEETS).toBe(3);
    expect(products.map((p: { ten: string }) => p.ten)).toEqual([
      'Cà phê Arabica rang mộc', 'Cà phê Robusta Honey', 'Combo quà biếu Tết', 'Trà atiso', 'Trà túi lọc']);
    expect(text).toContain('Bảng giá');
    expect(text).toContain('Giao hàng toàn quốc');
    expect(text).not.toContain('Không đọc');
  });

  it('reads a UTF-8 .csv with Vietnamese text', async () => {
    const csv = 'Tên sản phẩm,Giá\nGạo ST25,"35.000đ"\nNước mắm Phú Quốc,120000\n';
    const { products } = await extractExcel(new File([csv], 'gia.csv', { type: 'text/csv' }), XLSX);
    expect(products).toEqual([{ ten: 'Gạo ST25', gia: 35000 }, { ten: 'Nước mắm Phú Quốc', gia: 120000 }]);
  });
});
