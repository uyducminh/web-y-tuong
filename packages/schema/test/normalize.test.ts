import { describe, it, expect } from 'vitest';
import { slugify, normalizePhone, formatVnd } from '../src/index';

describe('normalize', () => {
  it('slugify', () => {
    expect(slugify('HTX Cà phê Cầu Đất')).toBe('htx-ca-phe-cau-dat');
    expect(slugify('!!!')).toBe('site');
    expect(slugify('a'.repeat(80)).length).toBeLessThanOrEqual(30);
  });
  it('normalizePhone', () => {
    for (const p of ['0912 345 678', '+84912345678', '84912345678', '0912.345.678'])
      expect(normalizePhone(p)).toBe('0912345678');
    expect(normalizePhone('12345')).toBeNull();
  });
  it('formatVnd', () => {
    expect(formatVnd(180000)).toBe('180.000đ');
  });
});
