import type { Deps, Env } from './types';
import { makeDeps } from './deps';
import { corsHeaders, errorJson, withCors } from './http';
import { createSession } from './routes/session';
import { postChat } from './routes/chat';
import { postUpload, postDocs } from './routes/upload';
import { postGenerate } from './routes/generate';
import { getStatus } from './routes/status';
import { postRevise } from './routes/revise';
import { getProposal } from './routes/proposal';

type Handler = (req: Request, deps: Deps, ctx: ExecutionContext, url: URL) => Promise<Response>;
type Route = { method: string; path: string | RegExp; handler: Handler };

// Later tasks append routes here.
export const routes: Route[] = [
  { method: 'POST', path: '/api/session', handler: (req, deps) => createSession(req, deps) },
  { method: 'POST', path: '/api/chat', handler: (req, deps) => postChat(req, deps) },
  { method: 'POST', path: '/api/upload', handler: (req, deps) => postUpload(req, deps) },
  { method: 'POST', path: '/api/docs', handler: (req, deps) => postDocs(req, deps) },
  { method: 'POST', path: '/api/generate', handler: (req, deps, ctx) => postGenerate(req, deps, ctx) },
  { method: 'GET', path: /^\/api\/status\/[A-Za-z0-9]{1,64}$/, handler: (_req, deps, ctx, url) => getStatus(deps, ctx, url.pathname.split('/')[3]) },
  { method: 'POST', path: '/api/revise', handler: (req, deps) => postRevise(req, deps) },
  { method: 'GET', path: /^\/api\/proposal\/[a-z0-9-]{1,64}$/, handler: (_req, deps, _ctx, url) => getProposal(deps, url.pathname.split('/')[3]) },
];

export async function handle(req: Request, deps: Deps, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === 'OPTIONS') {
    const origin = path.startsWith('/lead/') ? `https://${deps.config.ghOrg.toLowerCase()}.github.io` : deps.config.webOrigin;
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  let res: Response;
  try {
    const r = routes.find((x) => x.method === req.method && (typeof x.path === 'string' ? x.path === path : x.path.test(path)));
    res = r ? await r.handler(req, deps, ctx, url) : errorJson(404, 'Không tìm thấy đường dẫn này.');
  } catch (e) {
    console.error(e);
    res = errorJson(500, 'Hệ thống đang gặp sự cố. Vui lòng thử lại sau.');
  }
  return withCors(res, deps.config, path);
}

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => handle(req, makeDeps(env), ctx),
};
