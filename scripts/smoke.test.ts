import { describe, it, expect } from 'vitest';
import { ANSWERS, GENERIC_ANSWER, leaksFull, normalizeBase, pickAnswer, randomPhone, snippet } from './smoke';

describe('smoke helpers', () => {
  it('normalizeBase strips trailing slashes', () => {
    expect(normalizeBase(' https://a.b/// ')).toBe('https://a.b');
  });
  it('randomPhone is a valid VN mobile number', () => {
    expect(randomPhone()).toMatch(/^09\d{8}$/);
  });
  it('pickAnswer walks a step pool then repeats the last line; unknown steps use the generic answer', () => {
    const seen: Record<string, number> = {};
    expect(pickAnswer('don_vi', seen)).toBe(ANSWERS.don_vi![0]);
    expect(pickAnswer('don_vi', seen)).toBe(ANSWERS.don_vi![1]);
    expect(pickAnswer('don_vi', seen)).toBe(ANSWERS.don_vi![1]);
    expect(pickAnswer(undefined, {})).toBe(GENERIC_ANSWER);
    expect(pickAnswer('khong_co', {})).toBe(GENERIC_ANSWER);
  });
  it('leaksFull detects a "full" key but not the word in text', () => {
    expect(leaksFull('{"analysis":{"free":{},"full":{}}}')).toBe(true);
    expect(leaksFull('{"analysis":{"free":{"a":"full of tea"}}}')).toBe(false);
  });
  it('snippet flattens whitespace and truncates', () => {
    expect(snippet('a\n  b', 10)).toBe('a b');
    expect(snippet('x'.repeat(500)).length).toBe(200);
  });
});
