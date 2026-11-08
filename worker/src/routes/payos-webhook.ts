import { formatVnd } from '@sme/schema';
import type { Deps, SiteMeta } from '../types';
import { json, readJson } from '../http';
import { getJson, putJson } from '../kv';
import { quietly } from '../jobs';
import { assetPrefix, briefKey, bumpStat, demoUrl, docsKey, expKey, handoffUrl, isPaid, listKeys, paidKey } from '../sites';
import { type Order, orderKey, ORDER_TTL } from './checkout';

export const paidOrderKey = (code: number) => `paidorder:${code}`;
const OK = () => json({ ok: true });

/**
 * PayOS webhook. Unsigned/unknown/non-success notices answer 200 {ok:true} (so the URL-registration test webhook —
 * orderCode 123 — succeeds). After a VALID signature nothing may be lost silently: the team is told first (sheet +
 * Telegram) and the `paidorder:` marker is written last, so a retry after a failure repeats the notice (acceptable)
 * instead of dropping it; any failure alerts the team and answers 500 so PayOS can retry.
 */
export async function postPayosWebhook(req: Request, deps: Deps): Promise<Response> {
  const body = await readJson<any>(req);
  let valid = false;
  try { valid = deps.payos.verifyWebhook(body); } catch (e) { console.error('payos verify failed', e); }
  if (!valid) { console.warn('payos webhook: invalid signature'); return OK(); }
  const data = (body.data ?? {}) as Record<string, unknown>;
  try {
    await processPaid(deps, body.code, data);
    return OK();
  } catch (e) {
    console.error('payos webhook failed after a valid signature', e);
    await quietly(() => deps.notify.send(
      `CẢNH BÁO THANH TOÁN: lỗi xử lý thông báo PayOS đã xác thực – cần kiểm tra thủ công.\n`
      + `Mã đơn: ${String(data.orderCode)}\nSố tiền: ${String(data.amount)}\nMã tham chiếu: ${String(data.reference ?? '')}\n`
      + `Lỗi: ${(e as Error)?.message ?? e}`));
    return json({ ok: false }, 500);
  }
}

async function processPaid(deps: Deps, code: unknown, data: Record<string, unknown>): Promise<void> {
  if (code !== '00' || (data.code !== undefined && data.code !== '00')) {
    console.warn('payos webhook: not a success', code, data.code); return;
  }
  const orderCode = Number(data.orderCode);
  if (!Number.isSafeInteger(orderCode) || orderCode <= 0) { console.warn('payos webhook: bad orderCode', data.orderCode); return; }

  const order = await getJson<Order>(deps.kv, orderKey(orderCode));
  if (!order) { console.warn('payos webhook: unknown orderCode', orderCode); return; }
  const reference = typeof data.reference === 'string' ? data.reference : '';
  if (Number(data.amount) !== order.amount) {
    console.error('payos webhook: amount mismatch', orderCode, data.amount, order.amount);
    await quietly(() => deps.notify.send(
      `CẢNH BÁO THANH TOÁN: số tiền không khớp – cần kiểm tra thủ công.\nMã đơn: ${orderCode} (${order.siteId})\n`
      + `Nhận: ${String(data.amount)} – Đơn: ${formatVnd(order.amount)}\nMã tham chiếu: ${reference}`));
    return;
  }
  if (await deps.kv.get(paidOrderKey(orderCode)) !== null) return; // already fully processed

  const paid = { siteId: order.siteId, orderCode, packageId: order.packageId, amount: order.amount, reference, paidAt: deps.now().toISOString() };
  const alreadyPaid = await isPaid(deps, order.siteId);
  // Source of truth for "paid" (no TTL, never rewritten): cron and checkout read it.
  await putJson(deps.kv, paidKey(order.siteId), paid);
  const meta = await getJson<SiteMeta>(deps.kv, `site:${order.siteId}`);
  // Legacy mirror only; skipped when already paid so it cannot race revise's `revisions` update.
  if (meta && !alreadyPaid) await putJson(deps.kv, `site:${meta.siteId}`, { ...meta, paid: true });
  // Keep the customer's images (and the handoff inputs) forever: rewrite without TTL.
  for (const k of [...(await listKeys(deps.kv, assetPrefix(order.siteId))), briefKey(order.siteId), docsKey(order.siteId)]) {
    const v = await deps.kv.get(k);
    if (v !== null) await deps.kv.put(k, v);
  }
  if (meta) await quietly(() => deps.kv.delete(expKey(meta.expires, meta.siteId)));

  const pkgName = deps.config.packages.find((p) => p.id === order.packageId)?.name ?? order.packageId;
  const handoff = meta?.handoffKey ? handoffUrl(deps.config, meta.siteId, meta.handoffKey) : '';
  await quietly(() => deps.sheet.update(order.siteId, { trang_thai: 'da_thanh_toan', goi: pkgName, so_tien: String(order.amount), link_ban_giao: handoff }));
  const demo = meta ? demoUrl(deps.config, meta.siteId) : '(không tìm thấy thông tin demo)';
  await quietly(() => deps.notify.send(
    `ĐÃ THANH TOÁN: ${meta?.name ?? order.siteId} – ${meta?.phone ?? '(không rõ SĐT)'}\n`
    + `Gói: ${pkgName}\nSố tiền: ${formatVnd(order.amount)}\nMã đơn: ${orderCode}\nDemo: ${demo}\n`
    + (handoff ? `Bàn giao: ${handoff}\n` : '') + 'Cần liên hệ khách trong 24h.'));
  await bumpStat(deps, 'paid');
  // Last: marks the notice as handled (a failure before this point → 500 → PayOS retry → notice repeated).
  await putJson(deps.kv, paidOrderKey(orderCode), paid, ORDER_TTL);
}
