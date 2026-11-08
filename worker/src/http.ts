import type { Config } from './types';

export function getIp(req: Request): string {
  return req.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
}

export function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

export function errorJson(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return json({ error, ...extra }, status);
}

export async function readJson<T = any>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T; } catch { return null; }
}

/** The Worker's own origin (demos are served from it at /d/), from config.apiBase; '' if unset/invalid. */
export function workerOrigin(config: Config): string {
  try { return new URL(config.apiBase).origin; } catch { return ''; }
}

export function withCors(res: Response, config: Config, path: string): Response {
  let origin: string | null = null;
  if (path.startsWith('/api/')) origin = config.webOrigin;
  else if (path.startsWith('/lead/')) origin = workerOrigin(config);
  if (!origin) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(corsHeaders(origin))) out.headers.set(k, v);
  return out;
}
