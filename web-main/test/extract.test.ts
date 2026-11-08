import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import mammoth from 'mammoth';
// @ts-expect-error plain JS module without types
import { extractText, MAX_CHARS } from '../js/extract.js';
import { makeDocx } from './docx';

const libs = { pdfjs, mammoth };
const PDF = readFileSync(join(__dirname, 'fixtures/hop-tac-xa.pdf'));
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('extractText', () => {
  it('reads Vietnamese text from a PDF', async () => {
    const text = await extractText(new File([PDF], 'ho-so.pdf', { type: 'application/pdf' }), libs);
    expect(text).toContain('Hợp tác xã');
    expect(text).toContain('Cà phê');
    expect(text.length).toBeLessThanOrEqual(20000);
  });

  it('reads Vietnamese text from a DOCX', async () => {
    const bytes = await makeDocx(['Hợp tác xã Mây tre đan Phú Vinh', 'Sản phẩm: giỏ, khay, đèn mây.']);
    const text = await extractText(new File([bytes], 'gioi-thieu.docx', { type: DOCX_MIME }), libs);
    expect(text).toContain('Hợp tác xã');
    expect(text).toContain('đèn mây');
    expect(text.length).toBeLessThanOrEqual(20000);
  });

  it('caps the result at 20.000 characters (docsText limit)', async () => {
    expect(MAX_CHARS).toBe(20000);
    const long = Array.from({ length: 1000 }, (_, i) => `Hợp tác xã đoạn ${i}: ${'nội dung dài '.repeat(5)}`);
    const bytes = await makeDocx(long);
    const text = await extractText(new File([bytes], 'dai.docx', { type: '' }), libs);
    expect(text.startsWith('Hợp tác xã')).toBe(true);
    expect(text.length).toBe(20000);
  });

  it('rejects other file types with a Vietnamese message', async () => {
    await expect(extractText(new File(['x'], 'a.txt', { type: 'text/plain' }), libs)).rejects.toThrow(/PDF hoặc Word/);
  });
});
