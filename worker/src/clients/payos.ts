import { createHmac } from 'node:crypto';
import type { PayosClient } from '../types';

export const PAYOS_ENDPOINT = 'https://api-merchant.payos.vn/v2/payment-requests';
const DESC_MAX = 25;

const hmacHex = (key: string, s: string) => createHmac('sha256', key).update(s).digest('hex');

/** Constant-time string compare (length leak only). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** PayOS description: printable ASCII only (diacritics stripped, spaces kept), max 25 chars. */
export function payosDescription(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9 \-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, DESC_MAX).trim();
}

/** Webhook data → `k=v&...` with keys sorted; null/undefined → '', arrays/objects → JSON. */
export function webhookSignString(data: Record<string, unknown>): string {
  return Object.keys(data).sort().map((k) => {
    const v = data[k];
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `${k}=${s}`;
  }).join('&');
}

export function makePayosClient(o: { clientId?: string; apiKey?: string; checksumKey?: string; fetchFn?: typeof fetch }): PayosClient {
  const fetchFn = o.fetchFn ?? fetch;
  return {
    async createLink(l) {
      if (!o.clientId || !o.apiKey || !o.checksumKey) throw new Error('PayOS is not configured');
      const signature = hmacHex(o.checksumKey,
        `amount=${l.amount}&cancelUrl=${l.cancelUrl}&description=${l.description}&orderCode=${l.orderCode}&returnUrl=${l.returnUrl}`);
      const r = await fetchFn(PAYOS_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-client-id': o.clientId, 'x-api-key': o.apiKey },
        body: JSON.stringify({ orderCode: l.orderCode, amount: l.amount, description: l.description,
          cancelUrl: l.cancelUrl, returnUrl: l.returnUrl, signature }),
      });
      let j: any = null;
      try { j = await r.json(); } catch { /* handled below */ }
      const url = j?.data?.checkoutUrl;
      if (j?.code !== '00' || typeof url !== 'string' || !url) {
        throw new Error(`PayOS createLink failed: HTTP ${r.status} code=${j?.code} desc=${j?.desc}`);
      }
      return { checkoutUrl: url };
    },
    verifyWebhook(body) {
      if (!o.checksumKey || !body || typeof body !== 'object') return false;
      const { data, signature } = body as { data?: unknown; signature?: unknown };
      if (typeof signature !== 'string' || !data || typeof data !== 'object' || Array.isArray(data)) return false;
      return safeEqual(hmacHex(o.checksumKey, webhookSignString(data as Record<string, unknown>)), signature);
    },
  };
}
