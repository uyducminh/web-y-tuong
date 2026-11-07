import { z } from 'zod';

export const ProposalSchema = z.object({
  summary: z.string(),
  problems: z.array(z.string()),
  solution: z.string(),
  packages: z.array(z.object({
    name: z.string(),
    priceVnd: z.number().int().min(10_000_000),
    items: z.array(z.string()),
  })),
  roadmap: z.array(z.object({ step: z.string(), desc: z.string() })),
});
export type Proposal = z.infer<typeof ProposalSchema>;
