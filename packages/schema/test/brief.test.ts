import { describe, it, expect } from 'vitest';
import { briefProgress, BRIEF_KEYS, BriefSchema, ProposalSchema } from '../src/index';

const pkg = (priceVnd: number) => ({
  summary: 's', problems: ['p'], solution: 'x',
  packages: [{ name: 'Cơ bản', priceVnd, items: ['a'] }],
  roadmap: [{ step: '1', desc: 'd' }],
});

describe('brief', () => {
  it('has 10 keys', () => expect(BRIEF_KEYS.length).toBe(10));
  it('progress', () => {
    const r = briefProgress({ ten_don_vi: 'A', nganh: 'B' });
    expect(r.filled).toBe(2);
    expect(r.total).toBe(10);
    expect(r.missing).toContain('san_pham_chinh');
    expect(r.missing).not.toContain('nganh');
  });
  it('empty strings and empty lien_he do not count', () => {
    expect(briefProgress({ ten_don_vi: ' ', lien_he: {} }).filled).toBe(0);
    expect(briefProgress({ lien_he: { phone: '0912345678' } }).filled).toBe(1);
  });
  it('meta.auto accepted', () => {
    expect(BriefSchema.safeParse({ meta: { auto: ['nganh'] } }).success).toBe(true);
  });
  it('proposal price floor', () => {
    expect(ProposalSchema.safeParse(pkg(10_000_000)).success).toBe(true);
    expect(ProposalSchema.safeParse(pkg(5_000_000)).success).toBe(false);
  });
});
