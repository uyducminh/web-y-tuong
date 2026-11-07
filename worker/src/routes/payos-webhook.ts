import { formatVnd } from '@sme/schema';
import type { Deps, SiteMeta } from '../types';
import { json, readJson } from '../http';
import { getJson, putJson } from '../kv';
import { pagesUrl, quietly } from '../jobs';
import { type Order, orderKey, ORDER_TTL } from './checkout';

export const paidOrderKey = (code: number) => `paidorder:${code}`;
const OK = () => json({ ok: true });

/**
 * PayOS webhook. Always answers 200 {ok:true} so PayOS never retries (and so the
 * URL-registration test webhook — orderCode 123 — succeeds); problems are logged only.
 */
export async function postPayosWebhook(req: Request, deps: Deps): Promise<Response> {
  try {
    await processWebhook(req, deps);
  } catch (e) {
    console.error('payos webhook failed', e);
  }
  return OK();
}

async function processWebhook(req: Request, deps: Deps): Promise<void> {
  const body = await readJson<any>(req);
  if (!deps.payos.verifyWebhook(body)) { console.warn('payos webhook: invalid signature'); return; }
  const data = body.data as Record<string, unknown>;
  if (body.code !== '00' || (data.code !== undefined && data.code !== '00')) {
    console.warn('payos webhook: not a success', body.code, data.code); return;
  }
  const orderCode = Number(data.orderCode);
  if (!Number.isSafeInteger(orderCode) || orderCode <= 0) { console.warn('payos webhook: bad orderCode', data.orderCode); return; }

  const order = await getJson<Order>(deps.kv, orderKey(orderCode));
  if (!order) { console.warn('payos webhook: unknown orderCode', orderCode); return; }
  if (await deps.kv.get(paidOrderKey(orderCode)) !== null) return; // already processed
  if (Number(data.amount) !== order.amount) {
    console.error('payos webhook: amount mismatch', orderCode, data.amount, order.amount); return;
  }

  const meta = await getJson<SiteMeta>(deps.kv, `site:${order.siteId}`);
  if (meta && !meta.paid) await putJson(deps.kv, `site:${meta.siteId}`, { ...meta, paid: true });
  await putJson(deps.kv, paidOrderKey(orderCode), {
    siteId: order.siteId, packageId: order.packageId, amount: order.amount,
    reference: typeof data.reference === 'string' ? data.reference : '', paidAt: deps.now().toISOString(),
  }, ORDER_TTL);

  const pkgName = deps.config.packages.find((p) => p.id === order.packageId)?.name ?? order.packageId;
  await quietly(() => deps.sheet.update(order.siteId, { trang_thai: 'da_thanh_toan', goi: pkgName, so_tien: String(order.amount) }));
  const demo = meta ? (meta.url ?? pagesUrl(deps.config, meta.repo)) : '(không tìm thấy thông tin demo)';
  await quietly(() => deps.notify.send(
    `ĐÃ THANH TOÁN: ${meta?.name ?? order.siteId} – ${meta?.phone ?? '(không rõ SĐT)'}\n`
    + `Gói: ${pkgName}\nSố tiền: ${formatVnd(order.amount)}\nMã đơn: ${orderCode}\nDemo: ${demo}\n`
    + 'Cần liên hệ khách trong 24h.'));
}
