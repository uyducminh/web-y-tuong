import type { SheetClient } from '../types';

/** Google Apps Script bridge (sheet-bridge/Code.gs). Never throws: failures are logged only. */
export function makeSheetClient(o: { url?: string; token?: string; fetchFn?: typeof fetch }): SheetClient {
  const fetchFn = o.fetchFn ?? fetch;
  async function post(payload: Record<string, unknown>): Promise<void> {
    if (!o.url) return;
    try {
      const r = await fetchFn(o.url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: o.token ?? '', ...payload }),
      });
      let j: any = null;
      try { j = await r.json(); } catch { /* non-JSON answer */ }
      if (!r.ok || j?.ok !== true) console.error('sheet bridge error', payload.action, r.status, j?.error ?? '');
    } catch (e) {
      console.error('sheet bridge failed', payload.action, e);
    }
  }
  return {
    append: (row) => post({ action: 'append', row }),
    update: (siteId, patch) => post({ action: 'update', siteId, patch }),
  };
}
