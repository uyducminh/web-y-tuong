import type { Notifier } from '../types';

const TG_MAX = 4096;

/** Telegram Bot API sendMessage. No-op without token/chat; never throws. */
export function makeTelegramNotifier(o: { token?: string; chatId?: string; fetchFn?: typeof fetch }): Notifier {
  const fetchFn = o.fetchFn ?? fetch;
  return {
    async send(text) {
      if (!o.token || !o.chatId) return;
      try {
        const r = await fetchFn(`https://api.telegram.org/bot${o.token}/sendMessage`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: o.chatId, text: text.slice(0, TG_MAX) }),
        });
        if (!r.ok) console.error('telegram error', r.status);
      } catch (e) {
        console.error('telegram failed', e);
      }
    },
  };
}
