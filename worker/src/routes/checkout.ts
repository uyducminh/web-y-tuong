import type { Config, Deps, SiteMeta } from '../types';
import { errorJson, json, readJson } from '../http';
import { getJson, putJson } from '../kv';
import { payosDescription } from '../clients/payos';
import { isPaid } from '../sites';

export const MIN_PACKAGE_VND = 10_000_000;
export const ORDER_TTL = 400 * 24 * 3600;
const MAX_TRIES = 5;

type Pkg = Config['packages'][number];
/** A package POST /api/checkout will sell: safe positive integer price, ≥ MIN_PACKAGE_VND unless allowTestPrice. */
export const isSellable = (p: Pkg, config: Config) =>
  Number.isSafeInteger(p.priceVnd) && p.priceVnd > 0 && (config.allowTestPrice || p.priceVnd >= MIN_PACKAGE_VND);
/** The packages pages may offer: exactly those checkout accepts, at the prices it charges (only from config.packages). */
export const sellablePackages = (config: Config) =>
  config.packages.filter((p) => isSellable(p, config)).map(({ id, name, priceVnd, items }) => ({ id, name, priceVnd, items }));

export type Order = { siteId: string; packageId: string; amount: number; createdAt: string };
export const orderKey = (code: number) => `order:${code}`;

const randDigits2 = () => crypto.getRandomValues(new Uint32Array(1))[0] % 100;

/** orderCode = (now % 1e9) * 100 + 2 random digits (< 1e11, safe integer); retries if order:<code> already exists. */
export async function newOrderCode(deps: Deps, rand2: () => number = randDigits2): Promise<number> {
  const base = (deps.now().getTime() % 1e9) * 100;
  for (let i = 0; i < MAX_TRIES; i++) {
    const code = base + (Math.floor(rand2()) % 100);
    if (code > 0 && Number.isSafeInteger(code) && (await deps.kv.get(orderKey(code))) === null) return code;
  }
  throw new Error('could not allocate a unique orderCode');
}

export async function postCheckout(req: Request, deps: Deps): Promise<Response> {
  const body = await readJson<{ siteId?: unknown; packageId?: unknown }>(req);
  if (!body || typeof body.siteId !== 'string' || typeof body.packageId !== 'string' || !body.siteId || !body.packageId) {
    return errorJson(400, 'Dữ liệu không hợp lệ.');
  }
  const meta = await getJson<SiteMeta>(deps.kv, `site:${body.siteId}`);
  if (!meta) return errorJson(404, 'Không tìm thấy bản dùng thử này.');
  if (await isPaid(deps, meta.siteId)) return errorJson(409, 'Bản dùng thử này đã được thanh toán. Đội ngũ sẽ liên hệ với bạn trong 24h.');

  // Prices come ONLY from config.packages — never from the request or the AI proposal.
  const pkg = deps.config.packages.find((p) => p.id === body.packageId);
  if (!pkg) return errorJson(400, 'Gói triển khai không tồn tại.');
  const amount = pkg.priceVnd;
  if (!isSellable(pkg, deps.config)) {
    console.error('package price rejected', pkg.id, amount);
    return errorJson(400, 'Gói triển khai này hiện chưa mở bán.');
  }

  const orderCode = await newOrderCode(deps);
  const order: Order = { siteId: meta.siteId, packageId: pkg.id, amount, createdAt: deps.now().toISOString() };
  await putJson(deps.kv, orderKey(orderCode), order, ORDER_TTL);

  const site = encodeURIComponent(meta.siteId);
  try {
    const { checkoutUrl } = await deps.payos.createLink({
      orderCode, amount, description: payosDescription(`SME ${meta.siteId}`),
      returnUrl: `${deps.config.webOrigin}/thanks.html?site=${site}`,
      cancelUrl: `${deps.config.webOrigin}/proposal.html?site=${site}`,
    });
    return json({ checkoutUrl });
  } catch (e) {
    console.error('payos createLink failed', e);
    await deps.kv.delete(orderKey(orderCode));
    return errorJson(502, 'Chưa tạo được liên kết thanh toán. Vui lòng thử lại sau ít phút.');
  }
}
