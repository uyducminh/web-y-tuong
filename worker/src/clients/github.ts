/** Minimal GitHub App REST client: RS256 app JWT (WebCrypto) → cached installation token → JSON requests with retry. */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type GithubClientOpts = {
  appId: string; privateKey: string; installationId: string;
  fetch?: FetchLike; sleep?: (ms: number) => Promise<void>; nowMs?: () => number;
};

export interface GithubClient {
  /** JSON request against https://api.github.com. Throws GithubError on non-2xx (after retrying 5xx/429/network errors 3 times). */
  request<T = any>(method: string, path: string, body?: unknown): Promise<T>;
}

export class GithubError extends Error {
  constructor(public status: number, public path: string, message: string) {
    super(`GitHub ${status} ${path}: ${message}`);
    this.name = 'GithubError';
  }
}

const API = 'https://api.github.com';
const BASE_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'sme-mvp-builder',
};
const MAX_RETRIES = 3;

// Module-memory token cache (per isolate), keyed by installation id.
const tokenCache = new Map<string, { token: string; expiresMs: number }>();
export function _resetTokenCache(): void { tokenCache.clear(); }

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/\\n/g, '\n').replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

/** GitHub App JWT: iat = now-60 (clock skew), exp = now+540 (< 10 min). Key must be PKCS#8 ("BEGIN PRIVATE KEY"). */
export async function signAppJwt(appId: string, pem: string, nowSec: number): Promise<string> {
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const unsigned = `${b64urlJson({ alg: 'RS256', typ: 'JWT' })}.${b64urlJson({ iat: nowSec - 60, exp: nowSec + 540, iss: appId })}`;
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  return `${unsigned}.${b64url(sig)}`;
}

export function makeGithubClient(o: GithubClientOpts): GithubClient {
  const doFetch: FetchLike = o.fetch ?? ((u, i) => fetch(u, i));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const nowMs = o.nowMs ?? (() => Date.now());

  async function raw(method: string, path: string, auth: string, body?: unknown): Promise<{ status: number; data: any }> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
      let res: Response;
      try {
        res = await doFetch(`${API}${path}`, {
          method,
          headers: { ...BASE_HEADERS, Authorization: auth, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) { lastErr = e; continue; }
      const text = await res.text();
      let data: any = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (res.status >= 500 || res.status === 429) { lastErr = new GithubError(res.status, path, data?.message ?? ''); continue; }
      return { status: res.status, data };
    }
    throw lastErr;
  }

  async function token(): Promise<string> {
    const hit = tokenCache.get(o.installationId);
    if (hit && hit.expiresMs - 60_000 > nowMs()) return hit.token;
    const jwt = await signAppJwt(o.appId, o.privateKey, Math.floor(nowMs() / 1000));
    const path = `/app/installations/${o.installationId}/access_tokens`;
    const r = await raw('POST', path, `Bearer ${jwt}`);
    if (r.status < 200 || r.status >= 300 || !r.data?.token) throw new GithubError(r.status, path, r.data?.message ?? 'no token');
    tokenCache.set(o.installationId, { token: r.data.token, expiresMs: Date.parse(r.data.expires_at) });
    return r.data.token;
  }

  return {
    async request(method, path, body) {
      const r = await raw(method, path, `Bearer ${await token()}`, body);
      if (r.status === 401) tokenCache.delete(o.installationId);
      if (r.status < 200 || r.status >= 300) throw new GithubError(r.status, path, r.data?.message ?? '');
      return r.data;
    },
  };
}
