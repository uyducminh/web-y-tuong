import type { Brief, TemplateId } from '@sme/schema';

export type Msg = { role: 'user' | 'assistant'; content: string };

export type Config = {
  webOrigin: string; ghOrg: string; chatModel: string; genModel: string;
  priceInPerMTok: Record<string, number>; priceOutPerMTok: Record<string, number>;
  dailyCapUsd: number;
  packages: { id: string; name: string; priceVnd: number; items: string[] }[];
  allowTestPrice: boolean; publisher: 'github' | 'cloudflare'; apiBase: string;
};

export interface ClaudeClient {
  callTool<T>(o: { model: string; system: string; messages: Msg[];
    tool: { name: string; input_schema: object }; maxTokens: number })
    : Promise<{ input: T; usage: { input_tokens: number; output_tokens: number } }>;
}

export interface Publisher {
  create(o: { repoName: string; template: TemplateId; files: { path: string; base64: string }[] }): Promise<{ repo: string }>;
  update(repo: string, files: { path: string; base64: string }[], message: string): Promise<void>;
  status(repo: string): Promise<{ state: 'pending' | 'ready'; url?: string }>;
  remove(repo: string): Promise<void>;
}

export type SiteMeta = { siteId: string; repo: string; phone: string; leadKey: string; url?: string;
  expires: string; paid: boolean; revisions: number; createdAt: string; name: string;
  /** Set by the cron once an expired unpaid demo's repo has been deleted. */ removed?: boolean };

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
  brief: Brief; messages: { role: 'user' | 'assistant'; content: string }[];
  uploads: string[]; docsText: string; jobId?: string; siteId?: string };

export type Env = {
  KV: KVNamespace;
  WEB_ORIGIN?: string; GH_ORG?: string; CHAT_MODEL?: string; GEN_MODEL?: string;
  PRICE_IN_PER_MTOK?: string; PRICE_OUT_PER_MTOK?: string; DAILY_CAP_USD?: string;
  PACKAGES?: string; ALLOW_TEST_PRICE?: string; PUBLISHER?: string; API_BASE?: string;
  TURNSTILE_SECRET?: string;
  // GitHub App (secrets except GH_ORG): used when PUBLISHER=github
  GH_APP_ID?: string; GH_APP_PRIVATE_KEY?: string; GH_INSTALLATION_ID?: string;
  // Payments / team bridge (secrets)
  PAYOS_CLIENT_ID?: string; PAYOS_API_KEY?: string; PAYOS_CHECKSUM_KEY?: string;
  SHEET_URL?: string; SHEET_TOKEN?: string; TELEGRAM_BOT_TOKEN?: string; TELEGRAM_CHAT_ID?: string;
  [k: string]: unknown;
};
