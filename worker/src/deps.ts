import type { Config, Deps, Env, Publisher } from './types';
import { makeTurnstile } from './clients/turnstile';
import { makeClaudeClient } from './clients/claude';
import { makeGithubClient } from './clients/github';
import { makeGithubPublisher } from './publisher/github-publisher';
import { makePayosClient } from './clients/payos';
import { makeSheetClient } from './clients/sheet';
import { makeTelegramNotifier } from './clients/notify';

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** PACKAGES JSON → array of well-formed packages; anything invalid → [] / dropped. Price floor is enforced at checkout. */
function parsePackages(raw: string | undefined): Config['packages'] {
  const v = parseJson<unknown>(raw, []);
  if (!Array.isArray(v)) return [];
  return v.filter((p): p is Config['packages'][number] => !!p && typeof p === 'object'
    && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.priceVnd === 'number'
    && Array.isArray(p.items) && p.items.every((i: unknown) => typeof i === 'string'));
}

export function configFromEnv(env: Env): Config {
  return {
    webOrigin: env.WEB_ORIGIN ?? '',
    ghOrg: env.GH_ORG ?? '',
    chatModel: env.CHAT_MODEL || 'claude-haiku-5-5',
    genModel: env.GEN_MODEL || 'claude-sonnet-5-5',
    priceInPerMTok: parseJson(env.PRICE_IN_PER_MTOK, {}),
    priceOutPerMTok: parseJson(env.PRICE_OUT_PER_MTOK, {}),
    dailyCapUsd: env.DAILY_CAP_USD !== undefined && env.DAILY_CAP_USD !== '' && Number.isFinite(Number(env.DAILY_CAP_USD)) ? Number(env.DAILY_CAP_USD) : 10,
    packages: parsePackages(env.PACKAGES),
    allowTestPrice: env.ALLOW_TEST_PRICE === '1',
    publisher: env.PUBLISHER === 'cloudflare' ? 'cloudflare' : 'github',
    apiBase: env.API_BASE ?? '',
  };
}

const ni = () => { throw new Error('not implemented'); };

// Stub used when the publisher is not configured.
const publisherStub: Publisher = { create: async () => ni(), update: async () => ni(), status: async () => ni(), remove: async () => ni() };

/** Unbiased [a-z0-9] string via rejection sampling (252 = 7*36). */
export function randString(n: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  while (s.length < n) {
    for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) {
      if (b >= 252) continue;
      s += alphabet[b % 36];
      if (s.length === n) break;
    }
  }
  return s;
}

/** Real GitHub publisher when PUBLISHER=github and the App secrets are present; otherwise the stub. */
export function publisherFromEnv(env: Env, config: Config): Publisher {
  if (config.publisher !== 'github' || !env.GH_APP_ID || !env.GH_APP_PRIVATE_KEY || !env.GH_INSTALLATION_ID) return publisherStub;
  const gh = makeGithubClient({ appId: env.GH_APP_ID, privateKey: env.GH_APP_PRIVATE_KEY, installationId: env.GH_INSTALLATION_ID });
  return makeGithubPublisher({ gh, org: config.ghOrg, leadEndpoint: config.apiBase });
}

export function makeDeps(env: Env): Deps {
  const config = configFromEnv(env);
  return {
    kv: env.KV,
    now: () => new Date(),
    rand: randString,
    turnstile: makeTurnstile(env.TURNSTILE_SECRET as string | undefined),
    claude: makeClaudeClient({ apiKey: env.ANTHROPIC_API_KEY as string | undefined }), publisher: publisherFromEnv(env, config), 
    payos: makePayosClient({ clientId: env.PAYOS_CLIENT_ID, apiKey: env.PAYOS_API_KEY, checksumKey: env.PAYOS_CHECKSUM_KEY }),
    sheet: makeSheetClient({ url: env.SHEET_URL, token: env.SHEET_TOKEN }),
    notify: makeTelegramNotifier({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }),
    config,
  };
}
