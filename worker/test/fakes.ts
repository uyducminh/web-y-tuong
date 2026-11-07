import { env } from 'cloudflare:test';
import type { Deps, Config } from '../src/types';

export const TEST_ORIGIN = 'https://web.test';

export const testConfig: Config = {
  webOrigin: TEST_ORIGIN, ghOrg: 'Demo-Org', chatModel: 'claude-haiku-5-5', genModel: 'claude-sonnet-5-5',
  priceInPerMTok: { 'claude-haiku-5-5': 1, 'claude-sonnet-5-5': 3 },
  priceOutPerMTok: { 'claude-haiku-5-5': 5, 'claude-sonnet-5-5': 15 },
  dailyCapUsd: 10,
  packages: [{ id: 'co-ban', name: 'Cơ bản', priceVnd: 10_000_000, items: ['Website'] }],
  allowTestPrice: false, publisher: 'github', apiBase: 'https://api.test',
};

const nope = (name: string) => () => { throw new Error(`fake ${name} not configured`); };

export function makeTestDeps(overrides: Partial<Deps> = {}): Deps & { _fixedNow: Date } {
  let n = 0;
  const fixedNow = new Date('2026-11-08T05:00:00.000Z');
  return {
    _fixedNow: fixedNow,
    kv: env.KV,
    now: () => fixedNow,
    rand: (len: number) => { n++; return (n.toString(36) + 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(4)).slice(0, len).padEnd(len, '0'); },
    turnstile: { verify: async (token: string) => token === 'good' },
    claude: { callTool: nope('claude') } as any,
    publisher: { create: nope('publisher.create'), update: nope('publisher.update'), status: nope('publisher.status'), remove: nope('publisher.remove') },
    payos: { createLink: nope('payos.createLink'), verifyWebhook: () => false },
    sheet: { append: async () => {}, update: async () => {} },
    notify: { send: async () => {} },
    config: testConfig,
    ...overrides,
  };
}
