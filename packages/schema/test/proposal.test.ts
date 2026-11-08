import { describe, it, expect } from 'vitest';
import { ProposalSchema } from '../src/index';

const pkg = (priceVnd: number) => ({
  summary: 's', problems: ['p'], solution: 'x',
  packages: [{ name: 'Cơ bản', priceVnd, items: ['a'] }],
  roadmap: [{ step: '1', desc: 'd' }],
});

describe('proposal', () => {
  it('price floor', () => {
    expect(ProposalSchema.safeParse(pkg(10_000_000)).success).toBe(true);
    expect(ProposalSchema.safeParse(pkg(5_000_000)).success).toBe(false);
  });
});
