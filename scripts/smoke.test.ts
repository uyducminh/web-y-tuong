import { describe, it, expect } from 'vitest';
import { normalizeBase, randomPhone } from './smoke';

describe('smoke helpers', () => {
  it('normalizeBase strips trailing slashes', () => {
    expect(normalizeBase(' https://a.b/// ')).toBe('https://a.b');
  });
  it('randomPhone is a valid VN mobile number', () => {
    expect(randomPhone()).toMatch(/^09\d{8}$/);
  });
});
