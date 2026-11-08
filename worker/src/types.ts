import type { BriefV2, TemplateId } from '@sme/schema';

export type Msg = { role: 'user' | 'assistant'; content: string };

export type Config = {
  webOrigin: string; ghOrg: string; chatModel: string; genModel: string;
  priceInPerMTok: Record<string, number>; priceOutPerMTok: Record<string, number>;
  dailyCapUsd: number;
  packages: { id: string; name: string; priceVnd: number; items: string[] }[];
  allowTestPrice: boolean; publisher: 'github' | 'cloudflare'; apiBase: string;
  /** Shown on the 410 "trial expired" page. */ contactPhone: string;
  /** `<meta name=platform-name>` on /d/ (default "Web Làng"). */ platformName: string;
  /** Test-only KV seed route (ALLOW_TEST_SEED=1). Never set in wrangler.toml. */ allowTestSeed: boolean;
};

export interface ClaudeClient {
  callTool<T>(o: { model: string; system: string; messages: Msg[];
    tool: { name: string; input_schema: object }; maxTokens: number;
    /** Total budget for the call including retries (default 60s). */ timeoutMs?: number })
    : Promise<{ input: T; usage: { input_tokens: number; output_tokens: number } }>;
}

export interface Publisher {
  create(o: { repoName: string; template: TemplateId; files: { path: string; base64: string }[] }): Promise<{ repo: string }>;
  update(repo: string, files: { path: string; base64: string }[], message: string): Promise<void>;
  status(repo: string): Promise<{ state: 'pending' | 'ready'; url?: string }>;
  remove(repo: string): Promise<void>;
}

/**
 * `site:<siteId>`. The demo is served by the Worker from KV (`sitejson:`, `analysis:`, `asset:<id>:<path>`), no GitHub repo.
 * `paid` is legacy/compat only (the webhook still mirrors it): `paid:<siteId>` (sites.ts isPaid) is the only source of truth.
 */
export type SiteMeta = { siteId: string; phone: string; leadKey: string;
  /** Handoff link key (deps.rand(32)), created with the site record. */ handoffKey: string;
  template: TemplateId; expires: string; revisions: number; createdAt: string; name: string;
  /** true once the AI stage stored `analysis:<siteId>`. */ analysisReady: boolean;
  /** @deprecated compat only — never read for gating; use isPaid. */ paid?: boolean;
  /** Set by the cron once an expired unpaid demo has been taken down. */ removed?: boolean };

export type Job = { id: string; siteId: string; state: 'pending' | 'ready' | 'failed' | 'queued'; url?: string; error?: string };

export interface PayosClient {
  createLink(o: { orderCode: number; amount: number; description: string;
    returnUrl: string; cancelUrl: string }): Promise<{ checkoutUrl: string }>;
  verifyWebhook(body: unknown): boolean;
}

export interface SheetClient {
  append(row: Record<string, string | number>): Promise<void>;
  update(siteId: string, patch: Record<string, string>): Promise<void>;
}

export interface Notifier { send(text: string): Promise<void> }

export interface Deps {
  kv: KVNamespace; now(): Date; rand(n: number): string;  // rand: chuỗi [a-z0-9] dài n
  turnstile: { verify(token: string, ip: string): Promise<boolean> };
  claude: ClaudeClient; publisher: Publisher; payos: PayosClient;
  sheet: SheetClient; notify: Notifier; config: Config;
}

export type Session = { id: string; ip: string; createdAt: string; turns: number;
  brief: BriefV2; messages: { role: 'user' | 'assistant'; content: string }[];
  uploads: string[]; docsText: string; jobId?: string; siteId?: string };

export type Env = {
  KV: KVNamespace;
  WEB_ORIGIN?: string; GH_ORG?: string; CHAT_MODEL?: string; GEN_MODEL?: string;
  PRICE_IN_PER_MTOK?: string; PRICE_OUT_PER_MTOK?: string; DAILY_CAP_USD?: string;
  PACKAGES?: string; ALLOW_TEST_PRICE?: string; PUBLISHER?: string; API_BASE?: string;
  CONTACT_PHONE?: string; PLATFORM_NAME?: string; ALLOW_TEST_SEED?: string;
  TURNSTILE_SECRET?: string;
  // GitHub App (secrets except GH_ORG): used when PUBLISHER=github
  GH_APP_ID?: string; GH_APP_PRIVATE_KEY?: string; GH_INSTALLATION_ID?: string;
  // Payments / team bridge (secrets)
  PAYOS_CLIENT_ID?: string; PAYOS_API_KEY?: string; PAYOS_CHECKSUM_KEY?: string;
  SHEET_URL?: string; SHEET_TOKEN?: string; TELEGRAM_BOT_TOKEN?: string; TELEGRAM_CHAT_ID?: string;
  [k: string]: unknown;
};
