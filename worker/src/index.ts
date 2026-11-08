import type { Deps, Env } from './types';
import { makeDeps } from './deps';
import { corsHeaders, errorJson, withCors, workerOrigin } from './http';
import { createSession } from './routes/session';
import { postChat } from './routes/chat';
import { getBrief, postConfirm, postProducts } from './routes/brief';
import { postUpload, postDocs } from './routes/upload';
import { postGenerate, postRunJob } from './routes/generate';
import { getStatus } from './routes/status';
import { postRevise } from './routes/revise';
import { getProposal } from './routes/proposal';
import { postLead, getLeads } from './routes/leads';
import { postCheckout } from './routes/checkout';
import { runDaily } from './cron';
import { postPayosWebhook } from './routes/payos-webhook';
import { getDemo, postTestSeed } from './routes/demo';
import { getPackageApi, getPackagePage } from './routes/package';

type Handler = (req: Request, deps: Deps, ctx: ExecutionContext, url: URL) => Promise<Response>;
type Route = { method: string; path: string | RegExp; handler: Handler };

// Later tasks append routes here.
export const routes: Route[] = [
  { method: 'POST', path: '/api/session', handler: (req, deps) => createSession(req, deps) },
  { method: 'POST', path: '/api/chat', handler: (req, deps) => postChat(req, deps) },
  { method: 'POST', path: '/api/upload', handler: (req, deps) => postUpload(req, deps) },
  { method: 'POST', path: '/api/docs', handler: (req, deps) => postDocs(req, deps) },
  { method: 'GET', path: /^\/api\/brief\/[A-Za-z0-9]{1,64}$/, handler: (_req, deps, _ctx, url) => getBrief(deps, url.pathname.split('/')[3]) },
  { method: 'POST', path: '/api/brief/confirm', handler: (req, deps) => postConfirm(req, deps) },
  { method: 'POST', path: '/api/products', handler: (req, deps) => postProducts(req, deps) },
  { method: 'POST', path: '/api/generate', handler: (req, deps) => postGenerate(req, deps) },
  { method: 'POST', path: /^\/api\/jobs\/[A-Za-z0-9]{1,64}\/run$/, handler: (_req, deps, _ctx, url) => postRunJob(deps, url.pathname.split('/')[3]) },
  { method: 'GET', path: /^\/api\/status\/[A-Za-z0-9]{1,64}$/, handler: (_req, deps, _ctx, url) => getStatus(deps, url.pathname.split('/')[3]) },
  { method: 'POST', path: '/api/revise', handler: (req, deps) => postRevise(req, deps) },
  { method: 'GET', path: /^\/api\/proposal\/[a-z0-9-]{1,64}$/, handler: (_req, deps, _ctx, url) => getProposal(deps, url.pathname.split('/')[3]) },
  { method: 'POST', path: /^\/lead\/[A-Za-z0-9-]{1,64}$/, handler: (req, deps, _ctx, url) => postLead(req, deps, url.pathname.split('/')[2]) },
  { method: 'GET', path: /^\/leads\/[A-Za-z0-9-]{1,64}$/, handler: (req, deps, _ctx, url) => getLeads(req, deps, url.pathname.split('/')[2], url) },
  { method: 'POST', path: '/api/checkout', handler: (req, deps) => postCheckout(req, deps) },
  { method: 'POST', path: '/webhook/payos', handler: (req, deps) => postPayosWebhook(req, deps) },
  { method: 'GET', path: /^\/d\//, handler: (_req, deps, _ctx, url) => getDemo(deps, url.pathname) },
  { method: 'GET', path: /^\/api\/package\/[a-z0-9-]{1,64}$/, handler: (_req, deps, _ctx, url) => getPackageApi(deps, url.pathname.split('/')[3]) },
  { method: 'GET', path: /^\/package\//, handler: (_req, deps, _ctx, url) => getPackagePage(deps, url.pathname) },
];

/** e2e only: registered ONLY when env ALLOW_TEST_SEED === '1' (config.allowTestSeed); never set in wrangler.toml. */
const testSeedRoute: Route = { method: 'POST', path: '/__test/seed', handler: (req, deps) => postTestSeed(req, deps) };

export async function handle(req: Request, deps: Deps, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === 'OPTIONS') {
    const origin = path.startsWith('/lead/') ? workerOrigin(deps.config) : deps.config.webOrigin;
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  let res: Response;
  try {
    const table = deps.config.allowTestSeed ? [...routes, testSeedRoute] : routes;
    const r = table.find((x) => x.method === req.method && (typeof x.path === 'string' ? x.path === path : x.path.test(path)));
    res = r ? await r.handler(req, deps, ctx, url) : errorJson(404, 'Không tìm thấy đường dẫn này.');
  } catch (e) {
    console.error(e);
    res = errorJson(500, 'Hệ thống đang gặp sự cố. Vui lòng thử lại sau.');
  }
  return withCors(res, deps.config, path);
}

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => handle(req, makeDeps(env), ctx),
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runDaily(makeDeps(env)).catch((e) => console.error(e)));
  },
};
