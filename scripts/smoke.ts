// Usage: tsx scripts/smoke.ts <apiBase>      (e.g. https://sme-mvp-worker-staging.<acct>.workers.dev)
// Optional env: SMOKE_PHONE (default: random 09xxxxxxxx), SMOKE_LEAD_KEY (32-char key from the Sheet/Telegram to also read the CSV).
// Runs against a DEPLOYED staging worker (real Claude + GitHub calls happen there). Needs Turnstile TEST secret on staging.
// Prints "SMOKE OK <demoUrl>" or exits non-zero naming the failing step.

export const TURNSTILE_TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'; // always passes with the test secret 1x0000...AA
export const UNIT_NAME = 'Hợp tác xã Chè Thái Nguyên Smoke';

/** 1x1 transparent PNG. */
export const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export function randomPhone(rnd: () => number = Math.random): string {
  let s = '09';
  for (let i = 0; i < 8; i++) s += Math.floor(rnd() * 10);
  return s;
}

export function normalizeBase(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

class SmokeError extends Error {
  constructor(public step: string, msg: string) { super(msg); }
}

async function call(base: string, step: string, path: string, init?: RequestInit): Promise<{ status: number; data: any; text: string }> {
  let res: Response;
  try { res = await fetch(base + path, init); }
  catch (e) { throw new SmokeError(step, `network error: ${(e as Error).message}`); }
  const text = await res.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, data, text };
}

const postJson = (body: unknown): RequestInit => ({
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

function expect(step: string, cond: unknown, msg: string): asserts cond {
  if (!cond) throw new SmokeError(step, msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function smoke(apiBaseRaw: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  const base = normalizeBase(apiBaseRaw);
  const phone = env.SMOKE_PHONE || randomPhone();
  const log = (s: string) => console.log(`[smoke] ${s}`);

  log('1/9 create session');
  let r = await call(base, 'session', '/api/session', postJson({ turnstileToken: TURNSTILE_TEST_TOKEN }));
  expect('session', r.status === 200 && typeof r.data.sessionId === 'string', `status ${r.status}: ${r.text.slice(0, 200)}`);
  const sessionId: string = r.data.sessionId;

  const lines = [
    `Mình là ${UNIT_NAME}, bán chè và trà đặc sản ở Thái Nguyên, cần website để bán hàng online.`,
    'Khách hàng chủ yếu là người mua quà biếu và khách du lịch. Màu xanh lá. Liên hệ 0912345678.',
    'Điểm mạnh là chè sạch, sao thủ công. Mục tiêu web là nhận đơn đặt hàng.',
  ];
  for (let i = 0; i < lines.length; i++) {
    log(`${2 + i}/9 chat turn ${i + 1}`);
    r = await call(base, `chat ${i + 1}`, '/api/chat', postJson({ sessionId, text: lines[i] }));
    expect(`chat ${i + 1}`, r.status === 200 && typeof r.data.reply === 'string' && r.data.reply.length > 0,
      `status ${r.status}: ${r.text.slice(0, 200)}`);
  }

  log('5/9 upload one image');
  const form = new FormData();
  form.set('sessionId', sessionId);
  form.set('file', new Blob([Buffer.from(TINY_PNG_B64, 'base64')], { type: 'image/png' }), 'logo.png');
  r = await call(base, 'upload', '/api/upload', { method: 'POST', body: form });
  expect('upload', r.status === 200 && typeof r.data.path === 'string', `status ${r.status}: ${r.text.slice(0, 200)}`);

  log('6/9 generate demo');
  r = await call(base, 'generate', '/api/generate', postJson({ sessionId, phone, name: 'Smoke Test' }));
  expect('generate', r.status === 200 && typeof r.data.jobId === 'string', `status ${r.status}: ${r.text.slice(0, 300)} (phone ${phone})`);
  const jobId: string = r.data.jobId;

  log('7/9 run the job stage by stage (POST /api/jobs/:id/run, like the status page), then wait for ready (max ~10 min)');
  let demoUrl = ''; let siteId = '';
  for (let i = 0; i < 20; i++) {
    r = await call(base, 'run', `/api/jobs/${jobId}/run`, postJson({}));
    expect('run', r.status === 200, `status ${r.status}: ${r.text.slice(0, 200)}`);
    if (r.data.state === 'failed') throw new SmokeError('run', `job failed: ${r.data.error ?? ''}`);
    if (r.data.state === 'queued') throw new SmokeError('run', 'daily AI cap reached (job queued); retry after the cap resets or raise DAILY_CAP_USD');
    if (r.data.next === 'poll' || r.data.next === 'done') break;
    await sleep(r.data.next === 'wait' ? 3000 : 200);
  }
  for (let i = 0; i < 100; i++) {
    r = await call(base, 'status', `/api/status/${jobId}`);
    expect('status', r.status === 200, `status ${r.status}: ${r.text.slice(0, 200)}`);
    if (r.data.state === 'failed') throw new SmokeError('status', `job failed: ${r.data.error ?? ''}`);
    if (r.data.state === 'queued') throw new SmokeError('status', 'daily AI cap reached (job queued); retry after the cap resets or raise DAILY_CAP_USD');
    if (r.data.state === 'ready' && r.data.url) { demoUrl = r.data.url; siteId = r.data.siteId; break; }
    await sleep(6000);
  }
  expect('status', demoUrl && siteId, 'timed out waiting for state=ready');

  log(`8/9 fetch demo ${demoUrl} (GitHub Pages may need a minute)`);
  const pageUrl = demoUrl.endsWith('/') ? demoUrl : demoUrl + '/';
  // Pages renders client-side from site.json, so check the HTML is served (200) and site.json is valid.
  const getOk = async (u: string): Promise<Response | null> => {
    for (let i = 0; i < 30; i++) {
      try { const res = await fetch(u, { headers: { 'cache-control': 'no-cache' } }); if (res.ok) return res; } catch { /* retry */ }
      await sleep(10000);
    }
    return null;
  };
  const page = await getOk(pageUrl);
  expect('demo page', page, `${pageUrl} did not return 200`);
  const siteRes = await getOk(pageUrl + 'site.json');
  expect('demo site.json', siteRes, `${pageUrl}site.json did not return 200`);
  let site: any;
  try { site = JSON.parse(await siteRes.text()); } catch { throw new SmokeError('demo site.json', 'site.json is not valid JSON'); }
  expect('demo site.json', site && site.siteId === siteId, `siteId mismatch: expected ${siteId}, got ${site?.siteId}`);
  expect('demo site.json', typeof site.brand?.name === 'string' && site.brand.name.trim() !== '', 'brand.name is empty');
  if (site.brand.name !== UNIT_NAME) log(`warning: brand.name "${site.brand.name}" differs from scripted "${UNIT_NAME}" (AI may not extract it verbatim)`);

  log('9/9 lead + csv + revise');
  r = await call(base, 'lead', `/lead/${siteId}`, postJson({ name: 'Khách thử', phone: '0987654321', note: 'smoke test', website: '' }));
  expect('lead', r.status === 200 && r.data.ok === true, `status ${r.status}: ${r.text.slice(0, 200)}`);

  r = await call(base, 'csv (no key)', `/leads/${siteId}?format=csv`);
  expect('csv (no key)', r.status === 403, `expected 403 without key, got ${r.status}`);
  const key = env.SMOKE_LEAD_KEY;
  if (key) {
    r = await call(base, 'csv', `/leads/${siteId}?key=${encodeURIComponent(key)}&format=csv`);
    expect('csv', r.status === 200 && r.text.includes('Khách thử'), `status ${r.status}: ${r.text.slice(0, 200)}`);
  } else {
    log('SMOKE_LEAD_KEY not set: CSV content check skipped (key is in the Sheet/Telegram message).');
  }

  r = await call(base, 'revise', '/api/revise', postJson({ siteId, sessionId, request: 'Đổi tiêu đề trang chủ cho ngắn gọn hơn.' }));
  expect('revise', r.status === 200 && typeof r.data.jobId === 'string', `status ${r.status}: ${r.text.slice(0, 300)}`);
  return demoUrl;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const arg = process.argv[2];
  if (!arg || !/^https?:\/\//.test(arg)) { console.error('usage: tsx scripts/smoke.ts <apiBase>'); process.exit(2); }
  smoke(arg).then(
    (url) => { console.log(`SMOKE OK ${url}`); },
    (e) => {
      console.error(`SMOKE FAIL at step "${e instanceof SmokeError ? e.step : 'unknown'}": ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
