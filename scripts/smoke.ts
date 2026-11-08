// Usage: tsx scripts/smoke.ts <apiBase>      (e.g. https://sme-mvp-worker-staging.<acct>.workers.dev)
// Optional env: SMOKE_PHONE (default: random 09xxxxxxxx), SMOKE_LEAD_KEY (32-char key from the Sheet/Telegram to also read the CSV).
// Runs against a DEPLOYED staging worker (real Claude calls happen there). Needs Turnstile TEST secret on staging.
// Flow: session -> interview (until the brief allows confirm, max 30 turns) -> products -> confirm -> generate -> run to ready
//       -> /d/<id>/ 200 + site.json brand.name -> /api/package has no `full` -> lead 200 -> /handoff without key 403.
// Prints "SMOKE OK <demoUrl>" or exits non-zero naming the failing step.

export const TURNSTILE_TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'; // always passes with the test secret 1x0000...AA
export const UNIT_NAME = 'Hợp tác xã Chè Thái Nguyên Smoke';
export const MAX_TURNS = 30;
export const SMOKE_CONTACT_PHONE = '0912345678';

/** Scripted customer answers per interview step id (anything unknown falls back to GENERIC). */
export const ANSWERS: Record<string, string[]> = {
  don_vi: [
    `Mình là ${UNIT_NAME}, bán chè và trà đặc sản ở Thái Nguyên. Đơn vị là hợp tác xã.`,
    'Chúng mình ở xã Tân Cương, thành phố Thái Nguyên, làm ngành chè.',
  ],
  san_pham: [
    'Sản phẩm chính là chè búp sao thủ công 200g giá 150000 đồng và trà sen 100g giá 220000 đồng.',
    'Điểm khác biệt là chè sạch, sao thủ công, không hoá chất.',
  ],
  khach_hang: ['Khách hàng chủ yếu là người mua quà biếu và khách du lịch.'],
  muc_tieu: ['Mục tiêu của web là nhận đơn đặt hàng, khách nhắn qua Zalo.'],
  phong_cach: ['Mình thích cảm giác truyền thống, ấm áp, màu xanh lá.'],
  tham_khao: ['Mình chưa có web nào để tham khảo.'],
  tai_lieu: ['Mình chưa có tài liệu gì thêm.'],
  xac_nhan: [`Liên hệ của mình là ${SMOKE_CONTACT_PHONE}.`],
};
export const GENERIC_ANSWER = `Đúng rồi, bạn cứ làm theo như vậy. Liên hệ ${SMOKE_CONTACT_PHONE}.`;

/** Picks the scripted answer for `step`; the n-th time the same step is asked uses the n-th line (then the last one). */
export function pickAnswer(step: string | undefined, seen: Record<string, number>): string {
  const pool = (step && ANSWERS[step]) || [GENERIC_ANSWER];
  const n = step ? (seen[step] = (seen[step] ?? 0) + 1) : 1;
  return pool[Math.min(n - 1, pool.length - 1)]!;
}

/** True if the JSON text carries a `"full"` key anywhere (analysis.full must never reach an unpaid client). */
export function leaksFull(text: string): boolean {
  return /"full"\s*:/.test(text);
}

/** Only the first (up to) 300 chars of a body, single line, for error messages. */
export function snippet(text: string, n = 200): string {
  return text.slice(0, n).replace(/\s+/g, ' ');
}

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
  expect('session', r.status === 200 && typeof r.data.sessionId === 'string', `status ${r.status}: ${snippet(r.text)}`);
  const sessionId: string = r.data.sessionId;

  log(`2/9 interview (until the brief allows confirm, max ${MAX_TURNS} turns)`);
  const seen: Record<string, number> = {};
  let step: string | undefined; let canConfirm = false; let turns = 0;
  while (turns < MAX_TURNS && !canConfirm) {
    const text = pickAnswer(step, seen);
    r = await call(base, `chat ${turns + 1}`, '/api/chat', postJson({ sessionId, text }));
    if (r.status === 409 && r.data.mustConfirm) break;
    expect(`chat ${turns + 1}`, r.status === 200, `status ${r.status}: ${snippet(r.text)}`);
    expect(`chat ${turns + 1}`, !r.data.capped, 'daily AI cap reached; retry after the cap resets or raise DAILY_CAP_USD');
    expect(`chat ${turns + 1}`, typeof r.data.reply === 'string' && r.data.reply.length > 0, `empty reply: ${snippet(r.text)}`);
    turns++;
    step = typeof r.data.step === 'string' ? r.data.step : (r.data.step?.id as string | undefined);
    canConfirm = r.data.canConfirm === true;
    log(`   turn ${turns}: step=${step ?? '?'} done=${(r.data.done ?? []).length}/8 canConfirm=${canConfirm}${r.data.missing?.length ? ` missing=${r.data.missing.join(',')}` : ''}`);
  }
  if (!canConfirm) log(`   AI did not complete the brief after ${turns} turns: confirming with the contact form (server defaults apply only from turn ${MAX_TURNS})`);

  log('3/9 products + confirm');
  r = await call(base, 'products', '/api/products', postJson({ sessionId, items: [{ ten: 'Chè búp sao thủ công 200g', gia: 150000 }, { ten: 'Trà sen 100g', gia: 220000 }] }));
  expect('products', r.status === 200 && r.data.count === 2, `status ${r.status}: ${snippet(r.text)}`);
  r = await call(base, 'brief', `/api/brief/${sessionId}`);
  expect('brief', r.status === 200, `status ${r.status}: ${snippet(r.text)}`);
  r = await call(base, 'confirm', '/api/brief/confirm', postJson({ sessionId, lien_he: { phone: SMOKE_CONTACT_PHONE } }));
  expect('confirm', r.status === 200 && r.data.ok === true, `status ${r.status}: ${snippet(r.text, 300)}`);

  log('4/9 upload one image');
  const form = new FormData();
  form.set('sessionId', sessionId);
  form.set('file', new Blob([Buffer.from(TINY_PNG_B64, 'base64')], { type: 'image/png' }), 'logo.png');
  r = await call(base, 'upload', '/api/upload', { method: 'POST', body: form });
  expect('upload', r.status === 200 && typeof r.data.path === 'string', `status ${r.status}: ${snippet(r.text)}`);

  log('5/9 generate trial package');
  r = await call(base, 'generate', '/api/generate', postJson({ sessionId, phone, name: 'Smoke Test' }));
  expect('generate', r.status === 200 && typeof r.data.jobId === 'string', `status ${r.status}: ${snippet(r.text, 300)} (phone ${phone})`);
  const jobId: string = r.data.jobId;

  log('6/9 run the job stage by stage (POST /api/jobs/:id/run, like the status page) until ready (max ~10 min)');
  let siteId = ''; let packageUrl = '';
  for (let i = 0; i < 120; i++) {
    r = await call(base, 'run', `/api/jobs/${jobId}/run`, postJson({}));
    expect('run', r.status === 200, `status ${r.status}: ${snippet(r.text)}`);
    if (r.data.state === 'failed') throw new SmokeError('run', `job failed: ${r.data.error ?? ''}`);
    if (r.data.state === 'queued') throw new SmokeError('run', 'daily AI cap reached (job queued); retry after the cap resets or raise DAILY_CAP_USD');
    if (r.data.state === 'ready') { siteId = r.data.siteId; packageUrl = r.data.url ?? ''; break; }
    await sleep(r.data.next === 'wait' || r.data.next === 'poll' ? 3000 : 200);
  }
  if (!siteId) { // another worker may be running the job: fall back to polling the status endpoint
    for (let i = 0; i < 60; i++) {
      r = await call(base, 'status', `/api/status/${jobId}`);
      expect('status', r.status === 200, `status ${r.status}: ${snippet(r.text)}`);
      if (r.data.state === 'failed') throw new SmokeError('status', `job failed: ${r.data.error ?? ''}`);
      if (r.data.state === 'ready') { siteId = r.data.siteId; packageUrl = r.data.url ?? ''; break; }
      await sleep(6000);
    }
  }
  expect('status', siteId, 'timed out waiting for state=ready');
  const demoUrl = `${base}/d/${siteId}/`;
  log(`   ready: demo ${demoUrl}  package ${packageUrl || `${base}/package/${siteId}`}`);

  log('7/9 demo page + site.json');
  const page = await call(base, 'demo page', `/d/${siteId}/`);
  expect('demo page', page.status === 200, `${demoUrl} returned ${page.status}`);
  const siteRes = await call(base, 'demo site.json', `/d/${siteId}/site.json`);
  expect('demo site.json', siteRes.status === 200, `site.json returned ${siteRes.status}`);
  const site = siteRes.data;
  expect('demo site.json', site && site.siteId === siteId, `siteId mismatch: expected ${siteId}, got ${site?.siteId}`);
  expect('demo site.json', typeof site.brand?.name === 'string' && site.brand.name.trim() !== '', 'brand.name is empty');
  if (site.brand.name !== UNIT_NAME) log(`   warning: brand.name "${site.brand.name}" differs from scripted "${UNIT_NAME}" (AI may not extract it verbatim)`);

  log('8/9 package API has no analysis.full (unpaid)');
  r = await call(base, 'package', `/api/package/${siteId}`);
  expect('package', r.status === 200, `status ${r.status}: ${snippet(r.text)}`);
  expect('package', !leaksFull(r.text) && !('full' in (r.data.analysis ?? {})), '/api/package returned analysis.full to an unpaid client');
  expect('package', r.data.site?.paid === false, 'site.paid should be false');

  log('9/9 lead + handoff guard');
  r = await call(base, 'lead', `/lead/${siteId}`, postJson({ name: 'Khách thử', phone: '0987654321', note: 'smoke test', website: '' }));
  expect('lead', r.status === 200 && r.data.ok === true, `status ${r.status}: ${snippet(r.text)}`);
  r = await call(base, 'handoff (no key)', `/handoff/${siteId}`);
  expect('handoff (no key)', r.status === 403, `expected 403 without key, got ${r.status}`);
  r = await call(base, 'csv (no key)', `/leads/${siteId}?format=csv`);
  expect('csv (no key)', r.status === 403, `expected 403 without key, got ${r.status}`);
  const key = env.SMOKE_LEAD_KEY;
  if (key) {
    r = await call(base, 'csv', `/leads/${siteId}?key=${encodeURIComponent(key)}&format=csv`);
    expect('csv', r.status === 200 && r.text.includes('Khách thử'), `status ${r.status}: ${snippet(r.text)}`);
  } else {
    log('   SMOKE_LEAD_KEY not set: CSV content check skipped (key is in the Sheet/Telegram message).');
  }
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
