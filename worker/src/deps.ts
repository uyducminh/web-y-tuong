import type { Config, Deps, Env, Publisher, ClaudeClient, PayosClient, SheetClient, Notifier } from './types';
import { makeTurnstile } from './clients/turnstile';

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export function configFromEnv(env: Env): Config {
  return {
    webOrigin: env.WEB_ORIGIN ?? '',
    ghOrg: env.GH_ORG ?? '',
    chatModel: env.CHAT_MODEL || 'claude-haiku-5-5',
    genModel: env.GEN_MODEL || 'claude-sonnet-5-5',
    priceInPerMTok: parseJson(env.PRICE_IN_PER_MTOK, {}),
    priceOutPerMTok: parseJson(env.PRICE_OUT_PER_MTOK, {}),
    dailyCapUsd: Number(env.DAILY_CAP_USD ?? 10) || 10,
    packages: parseJson(env.PACKAGES, []),
    allowTestPrice: env.ALLOW_TEST_PRICE === '1',
    publisher: env.PUBLISHER === 'cloudflare' ? 'cloudflare' : 'github',
    apiBase: env.API_BASE ?? '',
  };
}

const ni = () => { throw new Error('not implemented'); };

// Stubs: later tasks replace these with real clients.
const claudeStub: ClaudeClient = { callTool: async () => ni() };
const publisherStub: Publisher = { create: async () => ni(), update: async () => ni(), status: async () => ni(), remove: async () => ni() };
const payosStub: PayosClient = { createLink: async () => ni(), verifyWebhook: () => ni() };
const sheetStub: SheetClient = { append: async () => ni(), update: async () => ni() };
const notifyStub: Notifier = { send: async () => ni() };

export function makeDeps(env: Env): Deps {
  return {
    kv: env.KV,
    now: () => new Date(),
    rand: (n: number) => {
      const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      let s = '';
      for (const b of bytes) s += alphabet[b % alphabet.length];
      return s;
    },
    turnstile: makeTurnstile(env.TURNSTILE_SECRET as string | undefined),
    claude: claudeStub, publisher: publisherStub, payos: payosStub, sheet: sheetStub, notify: notifyStub,
    config: configFromEnv(env),
  };
}
